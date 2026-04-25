// Component model. Every node has explicit absolute coordinates relative to
// its parent's content area, plus an explicit size — the canvas is a free-
// positioning plane. Containers (Frame) hold children at the children's own
// (x, y).
//
// Every node also carries a CommonStyle sub-object covering the universal
// "look" properties (background, opacity, border, corner radius, rotation).
// Type-specific props live alongside `style` on each kind (e.g. Text adds
// font/colour fields).
//
// QML emits this directly: each node becomes a Rectangle wrapper carrying the
// CommonStyle, with type-specific content (Text/Button) anchored inside, or
// children for Frame.

export type NodeKind =
  | "Text" | "Button" | "Rectangle" | "Frame" | "Image"
  | "TextField" | "TextArea" | "CheckBox" | "RadioButton" | "Switch"
  | "Slider" | "SpinBox" | "ProgressBar" | "BusyIndicator" | "ComboBox"
  | "AnimatedImage";

export type NodeId = string;

// Universal style properties — applied to every node's outer wrapper.
export interface CommonStyle {
  backgroundColor: string;   // CSS color, "transparent" by default
  opacity: number;           // 0..1
  borderColor: string;
  borderWidth: number;
  borderRadius: number;
  rotation: number;          // degrees clockwise
}

export const defaultStyle = (): CommonStyle => ({
  backgroundColor: "transparent",
  opacity: 1,
  borderColor: "transparent",
  borderWidth: 0,
  borderRadius: 0,
  rotation: 0,
});

export interface BaseProps {
  id: NodeId;
  kind: NodeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  style: CommonStyle;
  // Layers-panel toggles. `hidden` skips rendering in the canvas and is
  // dropped from the QML emit (the .lgx export won't ship hidden content).
  // `locked` keeps the node visible but blocks drag/resize on the canvas.
  hidden: boolean;
  locked: boolean;
}

export type FontWeight = "normal" | "bold";
export type TextAlign = "left" | "center" | "right";

export interface TextNode extends BaseProps {
  kind: "Text";
  text: string;
  pixelSize: number;
  color: string;             // text colour (separate from style.backgroundColor)
  fontWeight: FontWeight;
  italic: boolean;
  textAlign: TextAlign;
  fontFamily: string;        // empty string = engine default
  letterSpacing: number;     // px (Qt: pixel mode)
  lineHeight: number;        // multiplier; 1.0 = single
}

export interface ButtonNode extends BaseProps {
  kind: "Button";
  text: string;
  textColor: string;         // overrides default contentItem text color
  fontWeight: FontWeight;
}

export interface RectangleNode extends BaseProps {
  kind: "Rectangle";
  // No type-specific props — Rectangle's appearance is entirely the
  // CommonStyle (backgroundColor + border + radius).
}

// CSS object-fit values; map cleanly to Qt's Image.fillMode.
export type ImageFit = "fill" | "contain" | "cover" | "none" | "scale-down";

export interface ImageNode extends BaseProps {
  kind: "Image";
  // Data URL during editing ("data:image/...;base64,..."). Rewritten to a
  // relative "assets/<filename>" path at .lgx export time.
  src: string;
  fit: ImageFit;
}

export interface TextFieldNode extends BaseProps {
  kind: "TextField";
  text: string;          // initial value
  placeholder: string;
  readOnly: boolean;
  pixelSize: number;
}

export interface CheckBoxNode extends BaseProps {
  kind: "CheckBox";
  text: string;          // label
  checked: boolean;
  pixelSize: number;
}

export interface SwitchNode extends BaseProps {
  kind: "Switch";
  text: string;          // label
  checked: boolean;
  pixelSize: number;
}

export interface SliderNode extends BaseProps {
  kind: "Slider";
  from: number;
  to: number;
  value: number;
  stepSize: number;
}

export interface ProgressBarNode extends BaseProps {
  kind: "ProgressBar";
  from: number;
  to: number;
  value: number;
  indeterminate: boolean;
}

export interface FrameNode extends BaseProps {
  kind: "Frame";
  children: Node[];
}

// QML wrap mode flags from TextEdit.wrapMode (used by TextArea).
export type WrapMode = "none" | "word";

export interface TextAreaNode extends BaseProps {
  kind: "TextArea";
  text: string;
  placeholder: string;
  readOnly: boolean;
  pixelSize: number;
  wrapMode: WrapMode;
}

export interface RadioButtonNode extends BaseProps {
  kind: "RadioButton";
  text: string;          // label
  checked: boolean;
  pixelSize: number;
  // Note: Qt enforces "only one of a ButtonGroup is checked at a time" via
  // ButtonGroup. Wiring multiple RadioButtons to a single group requires the
  // user to add ButtonGroup manually post-export — out of scope for the MVP.
}

export interface SpinBoxNode extends BaseProps {
  kind: "SpinBox";
  from: number;
  to: number;
  value: number;
  stepSize: number;
  editable: boolean;     // typing allowed in the value field, not just +/-
}

export interface BusyIndicatorNode extends BaseProps {
  kind: "BusyIndicator";
  running: boolean;
}

export interface ComboBoxNode extends BaseProps {
  kind: "ComboBox";
  model: string[];       // dropdown options
  currentIndex: number;
  pixelSize: number;
}

export interface AnimatedImageNode extends BaseProps {
  kind: "AnimatedImage";
  // Like Image but plays GIF / animated WebP frames. We share the data-URL
  // / "assets/<file>" indirection with ImageNode at .lgx export time.
  src: string;
  fit: ImageFit;
  playing: boolean;
}

export type Node =
  | TextNode | ButtonNode | RectangleNode | FrameNode | ImageNode
  | TextFieldNode | TextAreaNode | CheckBoxNode | RadioButtonNode | SwitchNode
  | SliderNode | SpinBoxNode | ProgressBarNode | BusyIndicatorNode
  | ComboBoxNode | AnimatedImageNode;

export type LeafNode =
  | TextNode | ButtonNode | RectangleNode | ImageNode
  | TextFieldNode | TextAreaNode | CheckBoxNode | RadioButtonNode | SwitchNode
  | SliderNode | SpinBoxNode | ProgressBarNode | BusyIndicatorNode
  | ComboBoxNode | AnimatedImageNode;

export const isContainer = (n: Node): n is FrameNode => n.kind === "Frame";

let counter = 0;
export const newId = (): NodeId => `n${Date.now()}_${counter++}`;

// Sensible default size + position for newly-dropped nodes. The canvas
// caller usually overrides x/y based on drop coordinates.
export const defaultNode = (kind: NodeKind): Node => {
  const id = newId();
  const base = { x: 40, y: 40, hidden: false, locked: false };
  switch (kind) {
    case "Text":
      return {
        id, kind, ...base, width: 160, height: 28,
        style: defaultStyle(),
        text: "Hello",
        pixelSize: 16,
        color: "#1f2d3d",
        fontWeight: "normal",
        italic: false,
        textAlign: "left",
        fontFamily: "",
        letterSpacing: 0,
        lineHeight: 1.2,
      };
    case "Button":
      return {
        id, kind, ...base, width: 120, height: 36,
        style: defaultStyle(),
        text: "Click me",
        textColor: "#1f2d3d",
        fontWeight: "normal",
      };
    case "Rectangle":
      return {
        id, kind, ...base, width: 200, height: 120,
        style: { ...defaultStyle(), backgroundColor: "#dfe3e8", borderRadius: 6 },
      };
    case "Frame":
      return {
        id, kind, ...base, width: 320, height: 200,
        style: defaultStyle(),
        children: [],
      };
    case "Image":
      // Tiny checkered placeholder so the node has something to render
      // until the user uploads. Replaced via the inspector or palette flow.
      return {
        id, kind, ...base, width: 200, height: 120,
        style: defaultStyle(),
        src: PLACEHOLDER_IMAGE_DATA_URL,
        fit: "contain",
      };
    case "TextField":
      return {
        id, kind, ...base, width: 200, height: 32,
        style: defaultStyle(),
        text: "", placeholder: "Enter text…", readOnly: false, pixelSize: 14,
      };
    case "CheckBox":
      return {
        id, kind, ...base, width: 140, height: 28,
        style: defaultStyle(),
        text: "Check me", checked: false, pixelSize: 14,
      };
    case "Switch":
      return {
        id, kind, ...base, width: 140, height: 28,
        style: defaultStyle(),
        text: "Toggle", checked: false, pixelSize: 14,
      };
    case "Slider":
      return {
        id, kind, ...base, width: 200, height: 28,
        style: defaultStyle(),
        from: 0, to: 100, value: 50, stepSize: 1,
      };
    case "ProgressBar":
      return {
        id, kind, ...base, width: 200, height: 8,
        style: defaultStyle(),
        from: 0, to: 100, value: 50, indeterminate: false,
      };
    case "TextArea":
      return {
        id, kind, ...base, width: 240, height: 96,
        style: defaultStyle(),
        text: "", placeholder: "Enter text…", readOnly: false,
        pixelSize: 14, wrapMode: "word",
      };
    case "RadioButton":
      return {
        id, kind, ...base, width: 140, height: 28,
        style: defaultStyle(),
        text: "Option", checked: false, pixelSize: 14,
      };
    case "SpinBox":
      return {
        id, kind, ...base, width: 120, height: 32,
        style: defaultStyle(),
        from: 0, to: 100, value: 0, stepSize: 1, editable: true,
      };
    case "BusyIndicator":
      return {
        id, kind, ...base, width: 32, height: 32,
        style: defaultStyle(),
        running: true,
      };
    case "ComboBox":
      return {
        id, kind, ...base, width: 180, height: 32,
        style: defaultStyle(),
        model: ["Option 1", "Option 2", "Option 3"],
        currentIndex: 0,
        pixelSize: 14,
      };
    case "AnimatedImage":
      return {
        id, kind, ...base, width: 200, height: 120,
        style: defaultStyle(),
        src: PLACEHOLDER_IMAGE_DATA_URL,
        fit: "contain",
        playing: true,
      };
  }
};

// 8×8 light-grey checker pattern PNG, base64 — neutral placeholder.
export const PLACEHOLDER_IMAGE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAQ0lEQVQ4y+3RsQ0AIBADMW5/aMb9N6MUiYKHxN1c6Vp7PWtyD2A7YHs9YDtgez1gO2B7PWA7YHs9YDtgez1gO2B7PUgL3YEC0o2Mh2sAAAAASUVORK5CYII=";

// Root frame fills the canvas; defaults are overridden where used.
export const newRoot = (): FrameNode => ({
  id: newId(),
  kind: "Frame",
  x: 0,
  y: 0,
  width: 1024,
  height: 640,
  style: defaultStyle(),
  hidden: false,
  locked: false,
  children: [],
});
