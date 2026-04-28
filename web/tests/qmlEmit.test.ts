// Codegen tests for qmlEmit. These pin down the exact runtime contract the
// QML widget exposes — what it calls on `delivery_relay`, when it polls,
// how it tracks status. If any of these fail, the chat-app flow is broken.

import { describe, expect, it } from "vitest";
import { emitMainQml, usesDelivery, DELIVERY_RELAY_ID } from "../src/app/qmlEmit";
import { mkApp, mkButton, mkChatApp, mkFrame, mkPage, resetIds } from "./fixtures";

describe("usesDelivery", () => {
  it("returns false for a plain layout app", () => {
    expect(usesDelivery(mkApp())).toBe(false);
  });

  it("returns true when any sendMessage button exists", () => {
    resetIds();
    const btn = mkButton({
      onClick: { kind: "sendMessage", topic: "/x/1/y/text", payload: "hi", payloadMode: "literal" },
    });
    const app = mkApp({ pages: [mkPage(mkFrame([btn]))] });
    app.currentPageId = app.pages[0].id;
    expect(usesDelivery(app)).toBe(true);
  });

  it("returns true when an onMessageReceived trigger exists", () => {
    expect(usesDelivery(mkChatApp())).toBe(true);
  });
});

describe("emitMainQml — non-delivery app", () => {
  it("emits no delivery bootstrap, no Timer, no status overlay", () => {
    const qml = emitMainQml(mkApp(), true);
    expect(qml).not.toContain(DELIVERY_RELAY_ID);
    expect(qml).not.toContain("startDelivery");
    expect(qml).not.toContain("takeRecentMessages");
    expect(qml).not.toContain("_deliveryStatusOverlay");
    expect(qml).not.toContain("property int deliveryStatus");
  });
});

describe("emitMainQml — delivery app", () => {
  const qml = emitMainQml(mkChatApp("/chat/1/text"), true);

  it("declares delivery debug properties on the app Rectangle", () => {
    expect(qml).toContain("property int deliveryStatus: 0");
    expect(qml).toContain("property int sentCount: 0");
    expect(qml).toContain("property int recvCount: 0");
  });

  it("auto-bootstraps via the relay on Component.onCompleted", () => {
    expect(qml).toContain(`logos.callModule("${DELIVERY_RELAY_ID}", "startDelivery", [])`);
    expect(qml).toContain(`logos.callModule("${DELIVERY_RELAY_ID}", "subscribeToTopic", ["/chat/1/text"])`);
    // No direct delivery_module references — that's the relay's job.
    expect(qml).not.toContain(`logos.callModule("delivery_module"`);
  });

  it("emits a 1s polling Timer that updates status + drains queue", () => {
    expect(qml).toContain("interval: 1000");
    expect(qml).toContain(`app.deliveryStatus = logos.callModule("${DELIVERY_RELAY_ID}", "deliveryStatus", [])`);
    expect(qml).toContain(`logos.callModule("${DELIVERY_RELAY_ID}", "takeRecentMessages", [])`);
    expect(qml).toContain("app.recvCount += 1");
  });

  it("dispatches inbound messages to the matching trigger by topic", () => {
    expect(qml).toContain(`if (topic === "/chat/1/text")`);
    // The trigger's setVariable action lands in the dispatch block.
    expect(qml).toContain("app.var_lastMessage = payload");
  });

  it("wraps sendMessage so sentCount is incremented inline", () => {
    // expression-mode payload splices raw QML, comma-paired with sentCount++.
    expect(qml).toMatch(
      /\(logos\.callModule\("delivery_relay", "sendMessage", \["\/chat\/1\/text", app\.var_messageInput\]\), app\.sentCount \+= 1\)/,
    );
  });

  it("auto-injects the status overlay with id _deliveryStatusOverlay", () => {
    expect(qml).toContain("id: _deliveryStatusOverlay");
    expect(qml).toContain("z: 9999");
    // Status text mappings.
    expect(qml).toContain('"Off"');
    expect(qml).toContain('"Connecting…"');
    expect(qml).toContain('"Connected"');
    expect(qml).toContain('"Error"');
    // sent/recv counter binding.
    expect(qml).toContain('text: "↑" + app.sentCount + "  ↓" + app.recvCount');
  });
});

describe("emitMainQml — preview vs export", () => {
  it("preview includes the logos mock; export omits it", () => {
    const preview = emitMainQml(mkChatApp(), false);
    const exported = emitMainQml(mkChatApp(), true);
    expect(preview).toContain("Preview-only logos bridge mock");
    expect(exported).not.toContain("Preview-only logos bridge mock");
    // Export has the import block; preview does not.
    expect(exported).toMatch(/^import QtQuick 2\.15/);
    expect(preview).not.toMatch(/^import /);
  });
});
