// Edge cases for the codegen — proves the GUI-built apps (not just the
// Delivery test template) produce correctly wired QML. If any of these fail
// it means a class of user-built apps is silently broken.

import { describe, expect, it } from "vitest";
import { emitMainQml, usesDelivery } from "../src/app/qmlEmit";
import {
  mkApp, mkButton, mkFrame, mkPage, mkTextField, mkText, mkVar, resetIds,
} from "./fixtures";
import type { ButtonAction, Node, Trigger } from "../src/app/types";

describe("send-only widget (no onMessageReceived)", () => {
  it("emits bootstrap + sendMessage but no Timer poll body for receive dispatch", () => {
    resetIds();
    const btn = mkButton({
      onClick: { kind: "sendMessage", topic: "/notify/1/x/text", payload: "fired", payloadMode: "literal" },
    });
    const app = mkApp({
      pages: [mkPage(mkFrame([btn]))],
      currentPageId: "p_1",
    });
    app.currentPageId = app.pages[0].id;
    expect(usesDelivery(app)).toBe(true);
    const qml = emitMainQml(app, true);
    expect(qml).toContain('logos.callModule("delivery_relay", "startDelivery"');
    // Status Timer always runs when delivery is in use, even with no listeners.
    expect(qml).toContain('logos.callModule("delivery_relay", "deliveryStatus"');
    expect(qml).toContain('logos.callModule("delivery_relay", "takeRecentMessages"');
    // No `if (topic === "...")` dispatch lines because there are no triggers.
    expect(qml.match(/if \(topic === ".*"\) \{/g) ?? []).toHaveLength(0);
    // sendMessage is wrapped with sentCount++.
    expect(qml).toContain('app.sentCount += 1');
  });
});

describe("listen-only widget (no sendMessage button)", () => {
  it("emits bootstrap + Timer poll + dispatch even with zero send buttons", () => {
    resetIds();
    const lastVar = mkVar("lastMessage", "string", "(none)");
    const display = mkText({ binding: lastVar.id });
    const root = mkFrame([display]);
    const trigger: Trigger = {
      id: "trg_1",
      kind: "onMessageReceived",
      topic: "/feed/1/news/text",
      actions: [
        { kind: "setVariable", varId: lastVar.id, value: "payload", mode: "expression" } as ButtonAction,
      ],
    };
    const app = mkApp({
      pages: [mkPage(root)],
      variables: [lastVar],
      triggers: [trigger],
    });
    app.currentPageId = app.pages[0].id;
    expect(usesDelivery(app)).toBe(true);
    const qml = emitMainQml(app, true);
    expect(qml).toContain('logos.callModule("delivery_relay", "subscribeToTopic", ["/feed/1/news/text"]');
    expect(qml).toContain('if (topic === "/feed/1/news/text")');
    expect(qml).toContain('app.var_lastMessage = payload');
    // No sentCount writes because no Send button.
    expect(qml).not.toContain('app.sentCount += 1');
  });
});

describe("multi-topic widget (one app, three topics, three triggers)", () => {
  it("subscribes to every topic and routes incoming messages to the matching trigger", () => {
    resetIds();
    const v1 = mkVar("a"); const v2 = mkVar("b"); const v3 = mkVar("c");
    const btn1 = mkButton({ onClick: { kind: "sendMessage", topic: "/x/1/a/text", payload: "1", payloadMode: "literal" }});
    const btn2 = mkButton({ onClick: { kind: "sendMessage", topic: "/x/1/b/text", payload: "2", payloadMode: "literal" }});
    const btn3 = mkButton({ onClick: { kind: "sendMessage", topic: "/x/1/c/text", payload: "3", payloadMode: "literal" }});
    const triggers: Trigger[] = [
      { id: "t1", kind: "onMessageReceived", topic: "/x/1/a/text", actions: [{ kind: "setVariable", varId: v1.id, value: "payload", mode: "expression" } as ButtonAction] },
      { id: "t2", kind: "onMessageReceived", topic: "/x/1/b/text", actions: [{ kind: "setVariable", varId: v2.id, value: "payload", mode: "expression" } as ButtonAction] },
      { id: "t3", kind: "onMessageReceived", topic: "/x/1/c/text", actions: [{ kind: "setVariable", varId: v3.id, value: "payload", mode: "expression" } as ButtonAction] },
    ];
    const app = mkApp({
      pages: [mkPage(mkFrame([btn1, btn2, btn3]))],
      variables: [v1, v2, v3],
      triggers,
    });
    app.currentPageId = app.pages[0].id;
    const qml = emitMainQml(app, true);
    for (const t of ["/x/1/a/text", "/x/1/b/text", "/x/1/c/text"]) {
      expect(qml).toContain(`logos.callModule("delivery_relay", "subscribeToTopic", ["${t}"])`);
      expect(qml).toContain(`if (topic === "${t}")`);
    }
    expect(qml).toContain('app.var_a = payload');
    expect(qml).toContain('app.var_b = payload');
    expect(qml).toContain('app.var_c = payload');
  });
});

describe("input-bound chat shape (TextField → variable → sendMessage in expression mode)", () => {
  it("sends the variable's contents on click", () => {
    resetIds();
    const inp = mkVar("input", "string", "");
    const tf = mkTextField({ binding: inp.id });
    const btn = mkButton({
      onClick: { kind: "sendMessage", topic: "/chat/1/text", payload: "app.var_input", payloadMode: "expression" },
    });
    const app = mkApp({
      pages: [mkPage(mkFrame([tf, btn]))],
      variables: [inp],
    });
    app.currentPageId = app.pages[0].id;
    const qml = emitMainQml(app, true);
    // Expression-mode payload is spliced raw — references the bound variable.
    expect(qml).toMatch(
      /\(logos\.callModule\("delivery_relay", "sendMessage", \["\/chat\/1\/text", app\.var_input\]\), app\.sentCount \+= 1\)/,
    );
    // TextField two-way binding to the variable.
    expect(qml).toContain('text: app.var_input');
    expect(qml).toContain('onTextChanged: app.var_input = text');
  });
});

describe("non-delivery app stays untouched", () => {
  it("a counter app with only setVariable + Text bindings emits no delivery infrastructure", () => {
    resetIds();
    const count = mkVar("count", "number", "0");
    const display = mkText({ binding: count.id });
    const inc = mkButton({
      text: "+1",
      onClick: { kind: "setVariable", varId: count.id, value: "app.var_count + 1", mode: "expression" },
    });
    const app = mkApp({ pages: [mkPage(mkFrame([display, inc]))], variables: [count] });
    app.currentPageId = app.pages[0].id;
    const qml = emitMainQml(app, true);
    expect(qml).not.toContain("delivery_relay");
    expect(qml).not.toContain("Timer {");
    expect(qml).not.toContain("_deliveryStatusOverlay");
    expect(qml).not.toContain("property int deliveryStatus");
  });
});

describe("List node (Repeater backed by JSON-array variable)", () => {
  it("emits a Column + Repeater with model parsed from the bound variable", () => {
    resetIds();
    const items = mkVar("items", "string", '["alpha","beta","gamma"]');
    const list: Node = {
      id: "list_1", kind: "List",
      x: 10, y: 10, width: 200, height: 120,
      hidden: false, locked: false,
      style: { backgroundColor: "transparent", opacity: 1, borderColor: "transparent", borderWidth: 0, borderRadius: 0, rotation: 0 },
      dataVar: items.id,
      direction: "vertical",
      gap: 8,
      itemPixelSize: 14,
      itemColor: "#222",
      itemBackgroundColor: "transparent", itemBorderRadius: 0, itemPadding: 0,
    };
    const app = mkApp({
      pages: [mkPage(mkFrame([list]))],
      variables: [items],
    });
    app.currentPageId = app.pages[0].id;
    const qml = emitMainQml(app, true);
    expect(qml).toContain("Column {");
    expect(qml).toContain("spacing: 8");
    expect(qml).toContain("Repeater {");
    expect(qml).toContain("JSON.parse(app.var_items)");
    expect(qml).toContain("Array.isArray(v) ? v : []");
    // delegate text reads modelData.
    expect(qml).toContain("typeof modelData === \"string\" ? modelData : JSON.stringify(modelData)");
  });

  it("uses Row (not Column) when direction is horizontal", () => {
    resetIds();
    const items = mkVar("xs", "string", "[]");
    const list: Node = {
      id: "list_2", kind: "List",
      x: 0, y: 0, width: 200, height: 40,
      hidden: false, locked: false,
      style: { backgroundColor: "transparent", opacity: 1, borderColor: "transparent", borderWidth: 0, borderRadius: 0, rotation: 0 },
      dataVar: items.id,
      direction: "horizontal",
      gap: 4, itemPixelSize: 12, itemColor: "#000",
      itemBackgroundColor: "transparent", itemBorderRadius: 0, itemPadding: 0,
    };
    const app = mkApp({ pages: [mkPage(mkFrame([list]))], variables: [items] });
    app.currentPageId = app.pages[0].id;
    const qml = emitMainQml(app, true);
    expect(qml).toContain("Row {");
    expect(qml).not.toContain("Column {");
  });

  it("falls back to an empty model when no dataVar is bound", () => {
    resetIds();
    const list: Node = {
      id: "list_3", kind: "List",
      x: 0, y: 0, width: 200, height: 80,
      hidden: false, locked: false,
      style: { backgroundColor: "transparent", opacity: 1, borderColor: "transparent", borderWidth: 0, borderRadius: 0, rotation: 0 },
      direction: "vertical",
      gap: 6, itemPixelSize: 14, itemColor: "#000",
      itemBackgroundColor: "transparent", itemBorderRadius: 0, itemPadding: 0,
    };
    const app = mkApp({ pages: [mkPage(mkFrame([list]))] });
    app.currentPageId = app.pages[0].id;
    const qml = emitMainQml(app, true);
    expect(qml).toContain("model: []");
  });
});

describe("variable initial values escape correctly", () => {
  it("does not break QML when an initial contains double quotes (e.g. JSON array seed)", () => {
    resetIds();
    const v = mkVar("messages", "string", '["Welcome to chat","hi"]');
    const app = mkApp({
      pages: [mkPage(mkFrame([]))],
      variables: [v],
    });
    app.currentPageId = app.pages[0].id;
    const qml = emitMainQml(app, true);
    // The internal double quotes must be escaped — otherwise QML parses
    // `property string var_messages: "["` and chokes on the rest.
    expect(qml).toContain(
      'property string var_messages: "[\\"Welcome to chat\\",\\"hi\\"]"',
    );
  });

  it("escapes backslashes too", () => {
    resetIds();
    const v = mkVar("path", "string", "C:\\\\Users\\\\me");
    const app = mkApp({
      pages: [mkPage(mkFrame([]))],
      variables: [v],
    });
    app.currentPageId = app.pages[0].id;
    const qml = emitMainQml(app, true);
    expect(qml).toContain('property string var_path: "C:\\\\\\\\Users\\\\\\\\me"');
  });
});

describe("appendToList action (chat / log pattern)", () => {
  it("emits a parse/push/stringify mutation against the bound variable", () => {
    resetIds();
    const list = mkVar("messages", "string", "[]");
    const btn = mkButton({
      onClick: { kind: "appendToList", varId: list.id, value: "payload", mode: "expression" },
    });
    const app = mkApp({
      pages: [mkPage(mkFrame([btn]))],
      variables: [list],
    });
    app.currentPageId = app.pages[0].id;
    const qml = emitMainQml(app, true);
    // The mutation reads + parses the current value, pushes the expression
    // verbatim, re-stringifies, and writes back to the same prop.
    expect(qml).toContain("app.var_messages = JSON.stringify");
    expect(qml).toContain("JSON.parse(app.var_messages)");
    expect(qml).toContain("Array.isArray(_p)");
    expect(qml).toContain("_a.push(payload)");
  });

  it("JSON-quotes literal values so they round-trip safely", () => {
    resetIds();
    const list = mkVar("log", "string", "[]");
    const btn = mkButton({
      onClick: { kind: "appendToList", varId: list.id, value: 'hi"there', mode: "literal" },
    });
    const app = mkApp({
      pages: [mkPage(mkFrame([btn]))],
      variables: [list],
    });
    app.currentPageId = app.pages[0].id;
    const qml = emitMainQml(app, true);
    // Embedded double-quote is escaped (JSON.stringify's job).
    expect(qml).toContain('_a.push("hi\\"there")');
  });
});

describe("List node bubble delegate", () => {
  it("emits a Rectangle-wrapped delegate when bubble styling is set", () => {
    resetIds();
    const items = mkVar("messages", "string", '["hello"]');
    const list: import("../src/app/types").Node = {
      id: "list_1", kind: "List",
      x: 0, y: 0, width: 200, height: 200,
      hidden: false, locked: false,
      style: { backgroundColor: "transparent", opacity: 1, borderColor: "transparent", borderWidth: 0, borderRadius: 0, rotation: 0 },
      dataVar: items.id,
      direction: "vertical",
      gap: 6, itemPixelSize: 14, itemColor: "#fff",
      itemBackgroundColor: "#2563eb", itemBorderRadius: 12, itemPadding: 8,
    };
    const app = mkApp({ pages: [mkPage(mkFrame([list]))], variables: [items] });
    app.currentPageId = app.pages[0].id;
    const qml = emitMainQml(app, true);
    expect(qml).toContain("delegate: Rectangle {");
    expect(qml).toContain("color: '#2563eb'");
    expect(qml).toContain("radius: 12");
    expect(qml).toContain("_bubbleText.implicitWidth + 16");   // padding * 2
    expect(qml).toContain("Text {");
    expect(qml).toContain("id: _bubbleText");
  });

  it("emits a plain Text delegate when bubble styling is unset", () => {
    resetIds();
    const items = mkVar("messages", "string", "[]");
    const list: import("../src/app/types").Node = {
      id: "list_2", kind: "List",
      x: 0, y: 0, width: 200, height: 200,
      hidden: false, locked: false,
      style: { backgroundColor: "transparent", opacity: 1, borderColor: "transparent", borderWidth: 0, borderRadius: 0, rotation: 0 },
      dataVar: items.id,
      direction: "vertical",
      gap: 6, itemPixelSize: 14, itemColor: "#000",
      itemBackgroundColor: "transparent", itemBorderRadius: 0, itemPadding: 0,
    };
    const app = mkApp({ pages: [mkPage(mkFrame([list]))], variables: [items] });
    app.currentPageId = app.pages[0].id;
    const qml = emitMainQml(app, true);
    expect(qml).toContain("delegate: Text {");
    expect(qml).not.toContain("delegate: Rectangle {");
  });
});

describe("Button chrome — Qt default vs custom-styled", () => {
  it("default-styled button (transparent bg) keeps Qt's chrome — must NOT emit `background: Item {}`", () => {
    resetIds();
    const btn = mkButton({ text: "Click me" });   // default transparent bg
    const app = mkApp({ pages: [mkPage(mkFrame([btn]))] });
    app.currentPageId = app.pages[0].id;
    const qml = emitMainQml(app, true);
    // Without this suppression Qt's theme draws the button — that's what
    // makes a default button look like a button instead of bare text.
    expect(qml).not.toContain("background: Item {}");
  });

  it("custom-styled button (explicit bg color) suppresses Qt's chrome so our color shows", () => {
    resetIds();
    const btn = mkButton({
      text: "Send",
      style: { ...mkButton().style, backgroundColor: "#2563eb", borderRadius: 8 },
    });
    const app = mkApp({ pages: [mkPage(mkFrame([btn]))] });
    app.currentPageId = app.pages[0].id;
    const qml = emitMainQml(app, true);
    expect(qml).toContain("background: Item {}");
  });
});

describe("topic with special characters survives QML string emit", () => {
  it("emits valid QML JS even when the topic contains single quotes", () => {
    resetIds();
    const btn = mkButton({
      onClick: { kind: "sendMessage", topic: "/has 'quote'/1/text", payload: "x", payloadMode: "literal" },
    });
    const app = mkApp({ pages: [mkPage(mkFrame([btn]))] });
    app.currentPageId = app.pages[0].id;
    const qml = emitMainQml(app, true);
    // The escapeStr helper backslash-escapes single quotes for safety even
    // inside double-quoted strings (a no-op JS escape but harmless). The
    // result still parses to the original topic at runtime.
    expect(qml).toContain(String.raw`["/has \'quote\'/1/text", "x"]`);
  });
});
