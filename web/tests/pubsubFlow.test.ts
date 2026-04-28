// End-to-end-ish pubsub simulation. We can't run real Qt/QML in node,
// but we can:
//   1) Emit Main.qml from the editor.
//   2) Strip out the JavaScript bodies from Component.onCompleted and
//      Timer.onTriggered (that's all our delivery wiring).
//   3) Run those JS bodies against a fake `logos` bridge — the same shape
//      the relay exposes — and assert that:
//        - Sender's sendMessage hits the relay.
//        - Receiver's Timer poll drains takeRecentMessages and dispatches
//          to onMessageReceived triggers, updating variables.
//
// This is a realistic-ish probe of the runtime contract without spinning
// up Basecamp. Catches: wrong relay name, wrong method names, wrong arg
// shapes, broken Timer body, broken topic dispatch.

import { describe, expect, it } from "vitest";
import { emitMainQml } from "../src/app/qmlEmit";
import { mkChatApp } from "./fixtures";

// Pull the body of a `Component.onCompleted: { ... }` block out of QML.
const extractOnCompleted = (qml: string): string => {
  const idx = qml.indexOf("Component.onCompleted: {");
  if (idx < 0) return "";
  let depth = 0;
  let i = qml.indexOf("{", idx);
  const start = i + 1;
  for (; i < qml.length; i++) {
    if (qml[i] === "{") depth++;
    else if (qml[i] === "}") {
      depth--;
      if (depth === 0) return qml.slice(start, i);
    }
  }
  return "";
};

// Pull the body of the first `Timer { ... onTriggered: { ... } }` block.
const extractTimerBody = (qml: string): string => {
  const tIdx = qml.indexOf("Timer {");
  if (tIdx < 0) return "";
  const oIdx = qml.indexOf("onTriggered: {", tIdx);
  if (oIdx < 0) return "";
  let depth = 0;
  let i = qml.indexOf("{", oIdx);
  const start = i + 1;
  for (; i < qml.length; i++) {
    if (qml[i] === "{") depth++;
    else if (qml[i] === "}") {
      depth--;
      if (depth === 0) return qml.slice(start, i);
    }
  }
  return "";
};

// A fake `app` Rectangle — only the props the emitted JS reads/writes.
interface FakeApp {
  deliveryStatus: number;
  sentCount: number;
  recvCount: number;
  // Allow setVariable assignment writes via `app.var_*`.
  [k: string]: number | string;
}

// Make a fake bridge per-instance, with a shared message bus connecting
// every instance — mimics the Logos network across two Basecamps.
const mkBus = () => {
  // Per-topic queue, drained per-listener.
  const subscribers: Set<{ topics: Set<string>; queue: { topic: string; payload: string; hash: string; timestamp: string }[] }> = new Set();
  const send = (topic: string, payload: string) => {
    for (const sub of subscribers) {
      if (sub.topics.has(topic)) {
        sub.queue.push({ topic, payload, hash: "h", timestamp: String(Date.now()) });
      }
    }
  };
  const join = () => {
    const sub = { topics: new Set<string>(), queue: [] as { topic: string; payload: string; hash: string; timestamp: string }[] };
    subscribers.add(sub);
    return sub;
  };
  return { send, join };
};

const mkInstance = (bus: ReturnType<typeof mkBus>) => {
  const sub = bus.join();
  let status = 0;
  const logos = {
    callModule: (mod: string, method: string, args: unknown[]) => {
      if (mod !== "delivery_relay") return null;
      switch (method) {
        case "startDelivery":         status = 2; return true;
        case "stopDelivery":          status = 0; return true;
        case "deliveryStatus":        return status;
        case "subscribeToTopic":      sub.topics.add(args[0] as string); return true;
        case "unsubscribeFromTopic":  sub.topics.delete(args[0] as string); return true;
        case "sendMessage":           bus.send(args[0] as string, args[1] as string); return true;
        case "takeRecentMessages": {
          const out = JSON.stringify(sub.queue);
          sub.queue = [];
          return out;
        }
      }
      return true;
    },
  };
  return { logos };
};

describe("two-instance pubsub flow against emitted QML logic", () => {
  it("sender's sendMessage lands in receiver's onMessageReceived → setVariable", () => {
    const topic = "/chat/1/text";
    const qml = emitMainQml(mkChatApp(topic), true);
    const onCompleted = extractOnCompleted(qml);
    const onTriggered = extractTimerBody(qml);
    expect(onCompleted).toContain("startDelivery");
    expect(onTriggered).toContain("takeRecentMessages");

    // Wire the sender's sendMessage statement out of the QML. Look for the
    // wrapped expression on the Send button.
    const sendMatch = qml.match(/\(logos\.callModule\("delivery_relay", "sendMessage", \[([^\]]+)\]\), app\.sentCount \+= 1\)/);
    expect(sendMatch).toBeTruthy();
    const sendArgsExpr = sendMatch![1]; // e.g. "/chat/1/text", app.var_messageInput

    const bus = mkBus();
    const sender = mkInstance(bus);
    const receiver = mkInstance(bus);

    // Bootstrap both: each runs its Component.onCompleted body. We exec the
    // emitted JS in a Function() with `logos` and `app` in scope.
    const bootstrap = (inst: { logos: typeof sender.logos }, app: FakeApp) => {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      new Function("logos", "app", onCompleted)(inst.logos, app);
    };

    const senderApp: FakeApp = { deliveryStatus: 0, sentCount: 0, recvCount: 0, var_messageInput: "hello world", var_lastMessage: "(none)" };
    const receiverApp: FakeApp = { deliveryStatus: 0, sentCount: 0, recvCount: 0, var_messageInput: "",            var_lastMessage: "(none)" };

    bootstrap(sender, senderApp);
    bootstrap(receiver, receiverApp);

    // Sender hits the Send button — exec the wrapped sendMessage expression.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function("logos", "app", `(logos.callModule("delivery_relay", "sendMessage", [${sendArgsExpr}]), app.sentCount += 1);`)(sender.logos, senderApp);

    expect(senderApp.sentCount).toBe(1);

    // Receiver's Timer fires — exec onTriggered against its bridge + app.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function("logos", "app", onTriggered)(receiver.logos, receiverApp);

    expect(receiverApp.recvCount).toBe(1);
    expect(receiverApp.var_lastMessage).toBe("hello world");
    expect(receiverApp.deliveryStatus).toBe(2);   // status poll inside Timer
  });

  it("messages on a non-matching topic don't trigger receiver's setVariable", () => {
    const qml = emitMainQml(mkChatApp("/chat/1/text"), true);
    const onCompleted = extractOnCompleted(qml);
    const onTriggered = extractTimerBody(qml);

    const bus = mkBus();
    const sender = mkInstance(bus);
    const receiver = mkInstance(bus);
    const senderApp: FakeApp = { deliveryStatus: 0, sentCount: 0, recvCount: 0, var_messageInput: "ignore me", var_lastMessage: "(none)" };
    const receiverApp: FakeApp = { deliveryStatus: 0, sentCount: 0, recvCount: 0, var_messageInput: "",         var_lastMessage: "(none)" };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function("logos", "app", onCompleted)(sender.logos, senderApp);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function("logos", "app", onCompleted)(receiver.logos, receiverApp);

    // Send on a *different* topic the receiver doesn't subscribe to.
    sender.logos.callModule("delivery_relay", "sendMessage", ["/other/1/text", "ignored"]);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function("logos", "app", onTriggered)(receiver.logos, receiverApp);

    expect(receiverApp.recvCount).toBe(0);
    expect(receiverApp.var_lastMessage).toBe("(none)");
  });
});
