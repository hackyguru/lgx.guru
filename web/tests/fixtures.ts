// Reusable AppState fixtures for codegen tests. Kept tiny and explicit so
// each test can compose only what it needs.

import {
  AppState, ButtonAction, ButtonNode, FrameNode, PageData,
  TextFieldNode, TextNode, Trigger, Variable,
  defaultStyle, newRoot,
} from "../src/app/types";

// Stable id helpers — tests don't need newId()'s timestamp uniqueness; using
// fixed strings makes assertion strings predictable too.
let n = 0;
const sid = (prefix: string) => `${prefix}_${++n}`;

export const resetIds = () => { n = 0; };

export const mkText = (over: Partial<TextNode> = {}): TextNode => ({
  id: sid("t"), kind: "Text",
  x: 0, y: 0, width: 100, height: 20,
  hidden: false, locked: false,
  style: defaultStyle(),
  text: "x", pixelSize: 12, color: "#000", fontWeight: "normal",
  italic: false, textAlign: "left",
  fontFamily: "", letterSpacing: 0, lineHeight: 1,
  ...over,
});

export const mkButton = (over: Partial<ButtonNode> = {}): ButtonNode => ({
  id: sid("b"), kind: "Button",
  x: 0, y: 0, width: 80, height: 24,
  hidden: false, locked: false,
  style: defaultStyle(),
  text: "Btn", textColor: "#fff", fontWeight: "normal",
  ...over,
});

export const mkTextField = (over: Partial<TextFieldNode> = {}): TextFieldNode => ({
  id: sid("tf"), kind: "TextField",
  x: 0, y: 0, width: 120, height: 24,
  hidden: false, locked: false,
  style: defaultStyle(),
  text: "", placeholder: "", readOnly: false, pixelSize: 12,
  ...over,
});

export const mkFrame = (children: FrameNode["children"] = [], over: Partial<FrameNode> = {}): FrameNode => ({
  ...newRoot(),
  id: sid("f"),
  children,
  ...over,
});

export const mkPage = (root: FrameNode, name = "Home"): PageData => ({
  id: sid("p"), name, root,
});

export const mkVar = (name: string, type: Variable["type"] = "string", initial = ""): Variable => ({
  id: sid("v"), name, type, initial,
});

export const mkApp = (over: Partial<AppState> = {}): AppState => {
  const home = mkPage(mkFrame([]));
  return {
    pages: [home],
    currentPageId: home.id,
    variables: [],
    modules: [],
    triggers: [],
    ...over,
  };
};

// Quick shortcut: a one-page app with a Send button on a topic + an
// onMessageReceived trigger that stores payload into a variable.
export const mkChatApp = (topic = "/chat/1/text"): AppState => {
  resetIds();
  const inputVar = mkVar("messageInput", "string", "");
  const lastVar  = mkVar("lastMessage",  "string", "(none)");
  const sendBtn = mkButton({
    text: "Send",
    onClick: { kind: "sendMessage", topic, payload: "app.var_messageInput", payloadMode: "expression" },
  });
  const tf = mkTextField({ binding: inputVar.id });
  const display = mkText({ binding: lastVar.id });
  const root = mkFrame([sendBtn, tf, display]);
  const home = mkPage(root, "Home");
  const trigger: Trigger = {
    id: sid("trg"),
    kind: "onMessageReceived",
    topic,
    actions: [
      { kind: "setVariable", varId: lastVar.id, value: "payload", mode: "expression" } as ButtonAction,
    ],
  };
  return {
    pages: [home],
    currentPageId: home.id,
    variables: [inputVar, lastVar],
    modules: [],
    triggers: [trigger],
  };
};
