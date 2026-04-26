// Starter widget templates — one click loads a working layout.
// Each template returns a partial save (root + suggested module metadata).
// Page applies it via applySaveState, leaving icon/filename/collapsedIds at
// their current defaults.

import {
  ButtonNode, CheckBoxNode, FrameNode, ImageNode, Node, RectangleNode,
  SliderNode, SwitchNode, TextFieldNode, TextNode,
  defaultNode, defaultStyle, newId, newRoot,
} from "./types";

export interface Template {
  id: string;
  name: string;
  description: string;
  build: () => { root: FrameNode; meta: { name: string; description: string } };
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
