// Starter widget templates — one click loads a working layout.
// Each template returns a partial save (root + suggested module metadata).
// Page applies it via applySaveState, leaving icon/filename/collapsedIds at
// their current defaults.

import {
  ButtonNode, CheckBoxNode, FrameNode, ImageNode, ListNode, Node, RectangleNode,
  SliderNode, SwitchNode, TextFieldNode, TextNode, Trigger, Variable,
  defaultNode, defaultStyle, newId, newRoot,
} from "./types";

export interface Template {
  id: string;
  name: string;
  description: string;
  // Templates that need state or behavior return variables / triggers too.
  // Omitted = preserve whatever the user already has (existing behavior for
  // pure-layout templates like Hello / Login / Card).
  build: () => {
    root: FrameNode;
    meta: { name: string; description: string };
    variables?: Variable[];
    triggers?: Trigger[];
  };
}

// Per-kind makers — wrap defaultNode and override only the props we care
// about. Each keeps the type-specific defaults (font sizes, fillMode etc.)
// so the templates stay short.
const txt = (overrides: Partial<TextNode>): TextNode =>
  ({ ...(defaultNode("Text") as TextNode), ...overrides });
const btn = (overrides: Partial<ButtonNode>): ButtonNode =>
  ({ ...(defaultNode("Button") as ButtonNode), ...overrides });
const rect = (overrides: Partial<RectangleNode>): RectangleNode =>
  ({ ...(defaultNode("Rectangle") as RectangleNode), ...overrides });
const tf = (overrides: Partial<TextFieldNode>): TextFieldNode =>
  ({ ...(defaultNode("TextField") as TextFieldNode), ...overrides });
const cb = (overrides: Partial<CheckBoxNode>): CheckBoxNode =>
  ({ ...(defaultNode("CheckBox") as CheckBoxNode), ...overrides });
const sw = (overrides: Partial<SwitchNode>): SwitchNode =>
  ({ ...(defaultNode("Switch") as SwitchNode), ...overrides });
const sl = (overrides: Partial<SliderNode>): SliderNode =>
  ({ ...(defaultNode("Slider") as SliderNode), ...overrides });
const img = (overrides: Partial<ImageNode>): ImageNode =>
  ({ ...(defaultNode("Image") as ImageNode), ...overrides });
const frame = (overrides: Partial<FrameNode> & { children: Node[] }): FrameNode =>
  ({ ...(defaultNode("Frame") as FrameNode), ...overrides });
const lst = (overrides: Partial<ListNode>): ListNode =>
  ({ ...(defaultNode("List") as ListNode), ...overrides });

// Build a root populated with the supplied children. ID is fresh so the
// template doesn't collide with a previously-loaded design.
const buildRoot = (children: Node[]): FrameNode => ({
  ...newRoot(),
  id: newId(),
  children,
});

export const TEMPLATES: Template[] = [
  {
    id: "blank",
    name: "Blank",
    description: "Empty canvas — start from scratch.",
    build: () => ({
      root: buildRoot([]),
      meta: { name: "my_widget", description: "A widget built with lgx.guru" },
    }),
  },

  {
    id: "hello",
    name: "Hello world",
    description: "Centered greeting — the smallest possible widget.",
    build: () => ({
      root: buildRoot([
        txt({
          x: 220, y: 220, width: 360, height: 56,
          text: "Hello, world!", pixelSize: 36, color: "#18181b",
          fontWeight: "bold", textAlign: "center",
        }),
        txt({
          x: 220, y: 282, width: 360, height: 24,
          text: "Built with lgx.guru", pixelSize: 13, color: "#71717a",
          textAlign: "center",
        }),
      ]),
      meta: { name: "hello_world", description: "A friendly hello." },
    }),
  },

  {
    id: "login",
    name: "Login form",
    description: "Card with email + password fields, remember-me, and a sign-in button.",
    build: () => ({
      root: buildRoot([
        frame({
          x: 220, y: 60, width: 360, height: 380,
          style: { ...defaultStyle(), backgroundColor: "#ffffff", borderColor: "#e4e4e7", borderWidth: 1, borderRadius: 12 },
          children: [
            txt({ x: 24, y: 28, width: 312, height: 36,
              text: "Sign in", pixelSize: 24, color: "#18181b",
              fontWeight: "bold", textAlign: "center" }),
            txt({ x: 24, y: 64, width: 312, height: 20,
              text: "Sign in to continue.", pixelSize: 12, color: "#71717a",
              textAlign: "center" }),
            tf({ x: 24, y: 110, width: 312, height: 38,
              placeholder: "Email", pixelSize: 14 }),
            tf({ x: 24, y: 156, width: 312, height: 38,
              placeholder: "Password", pixelSize: 14 }),
            cb({ x: 24, y: 204, width: 200, height: 24,
              text: "Remember me", pixelSize: 13 }),
            btn({ x: 24, y: 240, width: 312, height: 42,
              text: "Sign in", textColor: "#ffffff", fontWeight: "bold",
              style: { ...defaultStyle(), backgroundColor: "#2563eb", borderRadius: 6 } }),
            txt({ x: 24, y: 304, width: 312, height: 20,
              text: "Forgot password?", pixelSize: 12, color: "#2563eb",
              textAlign: "center" }),
          ],
        }),
      ]),
      meta: { name: "login_form", description: "A simple login form." },
    }),
  },

  {
    id: "card",
    name: "Media card",
    description: "Image + title + description + action button.",
    build: () => ({
      root: buildRoot([
        frame({
          x: 220, y: 60, width: 360, height: 420,
          style: { ...defaultStyle(), backgroundColor: "#ffffff", borderColor: "#e4e4e7", borderWidth: 1, borderRadius: 12 },
          children: [
            img({ x: 0, y: 0, width: 360, height: 200, fit: "cover" }),
            txt({ x: 20, y: 220, width: 320, height: 28,
              text: "Card title", pixelSize: 18, color: "#18181b", fontWeight: "bold" }),
            txt({ x: 20, y: 252, width: 320, height: 80,
              text: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Pellentesque vehicula.",
              pixelSize: 13, color: "#71717a", lineHeight: 1.45 }),
            btn({ x: 20, y: 350, width: 320, height: 40,
              text: "Read more", textColor: "#ffffff", fontWeight: "bold",
              style: { ...defaultStyle(), backgroundColor: "#18181b", borderRadius: 6 } }),
          ],
        }),
      ]),
      meta: { name: "media_card", description: "A media card with an image." },
    }),
  },

  {
    id: "toolbar",
    name: "Toolbar",
    description: "Top bar with a logo and nav buttons.",
    build: () => ({
      root: buildRoot([
        frame({
          x: 0, y: 0, width: 800, height: 56,
          style: { ...defaultStyle(), backgroundColor: "#ffffff", borderColor: "#e4e4e7", borderWidth: 1 },
          children: [
            txt({ x: 16, y: 16, width: 96, height: 24,
              text: "lgx.guru", pixelSize: 16, color: "#18181b", fontWeight: "bold" }),
            btn({ x: 140, y: 12, width: 80, height: 32, text: "Home" }),
            btn({ x: 228, y: 12, width: 80, height: 32, text: "Docs" }),
            btn({ x: 316, y: 12, width: 80, height: 32, text: "Pricing" }),
            btn({ x: 680, y: 12, width: 100, height: 32, text: "Sign in",
              textColor: "#ffffff", fontWeight: "bold",
              style: { ...defaultStyle(), backgroundColor: "#2563eb", borderRadius: 6 } }),
          ],
        }),
      ]),
      meta: { name: "toolbar_widget", description: "A simple navigation toolbar." },
    }),
  },

  {
    id: "delivery_test",
    name: "Delivery test (pub/sub)",
    description: "Send + receive on a shared content topic. Install on two Basecamp instances to verify messages cross between them.",
    build: () => {
      // Stable ids for the variables so the trigger / Button / Text can
      // reference them by id without us having to chase auto-generated values.
      const inputVarId = newId();
      const lastMsgVarId = newId();
      const logVarId = newId();
      const topic = "/lgxguru/1/delivery-test/text";
      const variables: Variable[] = [
        { id: inputVarId,   name: "messageInput", type: "string", initial: "" },
        { id: lastMsgVarId, name: "lastMessage",  type: "string", initial: "(none yet)" },
        { id: logVarId,     name: "log",          type: "string", initial: "" },
      ];
      // On every received message: stash the latest payload and prepend it
      // to the running log so users can visually confirm cross-instance flow.
      const triggers: Trigger[] = [
        {
          id: newId(),
          kind: "onMessageReceived",
          topic,
          actions: [
            { kind: "setVariable", varId: lastMsgVarId, value: "payload",                         mode: "expression" },
            { kind: "setVariable", varId: logVarId,     value: 'payload + "\\n" + app.var_log',   mode: "expression" },
          ],
        },
      ];
      return {
        root: buildRoot([
          // Header
          txt({
            x: 40, y: 32, width: 720, height: 32,
            text: "Delivery test", pixelSize: 22, color: "#18181b",
            fontWeight: "bold", textAlign: "left",
          }),
          txt({
            x: 40, y: 64, width: 720, height: 36,
            text: `Install this widget on two Basecamp instances. Whatever you send from one will appear on the other.\nTopic: ${topic}`,
            pixelSize: 12, color: "#71717a", lineHeight: 1.4,
          }),

          // Sender card
          frame({
            x: 40, y: 124, width: 720, height: 132,
            style: { ...defaultStyle(), backgroundColor: "#ffffff", borderColor: "#e4e4e7", borderWidth: 1, borderRadius: 10 },
            children: [
              txt({ x: 16, y: 12, width: 360, height: 22,
                text: "Send a message", pixelSize: 14, color: "#18181b", fontWeight: "bold" }),
              tf({ x: 16, y: 44, width: 540, height: 40,
                placeholder: "Type a message and press Send", pixelSize: 14,
                binding: inputVarId }),
              btn({ x: 568, y: 44, width: 136, height: 40,
                text: "Send", textColor: "#ffffff", fontWeight: "bold",
                style: { ...defaultStyle(), backgroundColor: "#2563eb", borderRadius: 8 },
                onClick: { kind: "sendMessage", topic, payload: "app.var_messageInput", payloadMode: "expression" } }),
              txt({ x: 16, y: 92, width: 688, height: 28,
                text: "Hint: open a second Basecamp window with the same widget — what you send here lands there.",
                pixelSize: 11, color: "#a1a1aa" }),
            ],
          }),

          // Receiver card
          frame({
            x: 40, y: 276, width: 720, height: 232,
            style: { ...defaultStyle(), backgroundColor: "#ffffff", borderColor: "#e4e4e7", borderWidth: 1, borderRadius: 10 },
            children: [
              txt({ x: 16, y: 12, width: 360, height: 22,
                text: "Last received", pixelSize: 14, color: "#18181b", fontWeight: "bold" }),
              txt({ x: 16, y: 36, width: 688, height: 28,
                text: "(none yet)", pixelSize: 18, color: "#0f172a",
                fontWeight: "bold", binding: lastMsgVarId }),
              rect({ x: 16, y: 76, width: 688, height: 1,
                style: { ...defaultStyle(), backgroundColor: "#e4e4e7" } }),
              txt({ x: 16, y: 88, width: 360, height: 22,
                text: "Log", pixelSize: 12, color: "#71717a" }),
              txt({ x: 16, y: 108, width: 688, height: 108,
                text: "", pixelSize: 12, color: "#27272a",
                lineHeight: 1.4, binding: logVarId }),
            ],
          }),
        ]),
        meta: {
          name: "delivery_test",
          description: "Pub/sub verification widget — sends + receives on a shared content topic.",
        },
        variables,
        triggers,
      };
    },
  },

  {
    id: "chat",
    name: "Chat (pub/sub bubbles)",
    description: "Name + message TextFields + Send + bubble list. Each bubble is prefixed with the sender's name so multiple users on the same topic stay distinguishable.",
    build: () => {
      // Stable ids so trigger / button / list reference them by id without
      // us chasing auto-generated values.
      const messagesVarId = newId();
      const inputVarId    = newId();
      const userNameVarId = newId();
      const topic = "/lgxguru/1/chat/json";

      const variables: Variable[] = [
        // Sender identity. Defaults to a random `user-XXXX` so two browser
        // sessions look distinct even before either user customises it.
        // Bound to a TextField at the top so users can type their name.
        { id: userNameVarId, name: "userName",     type: "string", initial: `user-${Math.random().toString(36).slice(2, 6)}` },
        // What the message TextField is bound to.
        { id: inputVarId,    name: "messageInput", type: "string", initial: "" },
        // The chat history. Held as a string whose value is a JSON array
        // of formatted "<name>: <text>" strings, pushed onto by the on-
        // message trigger and rendered by the List. Initial gives the
        // canvas a 2-row preview before any real messages arrive.
        { id: messagesVarId, name: "messages",     type: "string", initial: '["Welcome to chat","Type a message and press Send"]' },
      ];

      // Receive: parse the JSON envelope `{from, text}`, format a single
      // line for the bubble. Wrapped in an IIFE so non-JSON payloads (e.g.
      // raw text from older clients) still appear instead of breaking the
      // expression.
      const formatExpr =
        '(function(){ try { var p = JSON.parse(payload); '
        + 'return (p.from || "?") + ": " + (p.text || ""); } '
        + 'catch(e) { return payload; } })()';

      const triggers: Trigger[] = [
        {
          id: newId(),
          kind: "onMessageReceived",
          topic,
          actions: [
            { kind: "appendToList", varId: messagesVarId, value: formatExpr, mode: "expression" },
          ],
        },
      ];

      // Send: wrap user input + name in a JSON envelope so the receiver can
      // attribute each message. JSON.stringify is in QML's V4 JS engine.
      const sendPayload =
        'JSON.stringify({from: app.var_userName, text: app.var_messageInput})';

      return {
        root: buildRoot([
          // Header bar
          frame({
            x: 0, y: 0, width: 1024, height: 56,
            style: { ...defaultStyle(), backgroundColor: "#0f172a" },
            children: [
              txt({ x: 20, y: 18, width: 200, height: 22,
                text: "Chat", pixelSize: 18, color: "#ffffff", fontWeight: "bold" }),
              txt({ x: 230, y: 22, width: 600, height: 16,
                text: `topic: ${topic} — install on two Basecamps and pick a different name on each`,
                pixelSize: 11, color: "#94a3b8" }),
            ],
          }),

          // Name strip — a single TextField bound to userName. Sits between
          // the header and the chat list so it's visible but unobtrusive.
          txt({ x: 20, y: 72, width: 70, height: 28,
            text: "Your name:", pixelSize: 12, color: "#475569" }),
          tf({
            x: 92, y: 70, width: 220, height: 30,
            placeholder: "you", pixelSize: 13, binding: userNameVarId,
            style: { ...defaultStyle(), backgroundColor: "#ffffff", borderColor: "#cbd5e1", borderWidth: 1, borderRadius: 6 },
          }),

          // Bubble list — left edge is the user's view of the conversation.
          lst({
            x: 20, y: 110, width: 984, height: 460,
            style: { ...defaultStyle(), backgroundColor: "#f8fafc", borderColor: "#e2e8f0", borderWidth: 1, borderRadius: 8 },
            dataVar: messagesVarId,
            direction: "vertical",
            gap: 8,
            itemPixelSize: 14,
            itemColor: "#ffffff",
            itemBackgroundColor: "#2563eb",
            itemBorderRadius: 14,
            itemPadding: 10,
          }),

          // Input row.
          tf({
            x: 20, y: 586, width: 820, height: 40,
            placeholder: "Type a message…", pixelSize: 14, binding: inputVarId,
            style: { ...defaultStyle(), backgroundColor: "#ffffff", borderColor: "#cbd5e1", borderWidth: 1, borderRadius: 8 },
          }),
          btn({
            x: 856, y: 586, width: 148, height: 40,
            text: "Send", textColor: "#ffffff", fontWeight: "bold",
            style: { ...defaultStyle(), backgroundColor: "#2563eb", borderRadius: 8 },
            onClick: { kind: "sendMessage", topic, payload: sendPayload, payloadMode: "expression" },
          }),
        ]),
        meta: {
          name: "chat",
          description: "Pub/sub chat — every received message appears as a bubble, prefixed with the sender's name.",
        },
        variables,
        triggers,
      };
    },
  },

  {
    id: "settings",
    name: "Settings panel",
    description: "A grouped list of toggles and a slider.",
    build: () => ({
      root: buildRoot([
        frame({
          x: 200, y: 40, width: 400, height: 440,
          style: { ...defaultStyle(), backgroundColor: "#ffffff", borderColor: "#e4e4e7", borderWidth: 1, borderRadius: 12 },
          children: [
            txt({ x: 20, y: 20, width: 360, height: 28,
              text: "Settings", pixelSize: 18, color: "#18181b", fontWeight: "bold" }),
            // Row 1 — Switch + label
            txt({ x: 20, y: 80, width: 240, height: 22, text: "Notifications", pixelSize: 13, color: "#27272a" }),
            sw({ x: 320, y: 78, width: 60, height: 28, checked: true }),
            rect({ x: 20, y: 120, width: 360, height: 1, style: { ...defaultStyle(), backgroundColor: "#e4e4e7" } }),
            // Row 2
            txt({ x: 20, y: 140, width: 240, height: 22, text: "Auto-update", pixelSize: 13, color: "#27272a" }),
            sw({ x: 320, y: 138, width: 60, height: 28, checked: false }),
            rect({ x: 20, y: 180, width: 360, height: 1, style: { ...defaultStyle(), backgroundColor: "#e4e4e7" } }),
            // Row 3 — Checkbox
            cb({ x: 20, y: 198, width: 240, height: 24, text: "Send anonymous metrics", checked: true }),
            rect({ x: 20, y: 240, width: 360, height: 1, style: { ...defaultStyle(), backgroundColor: "#e4e4e7" } }),
            // Row 4 — Slider
            txt({ x: 20, y: 258, width: 240, height: 22, text: "Volume", pixelSize: 13, color: "#27272a" }),
            sl({ x: 20, y: 286, width: 360, height: 28, from: 0, to: 100, value: 60 }),
          ],
        }),
      ]),
      meta: { name: "settings_panel", description: "Settings widget with toggles." },
    }),
  },
];
