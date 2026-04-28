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
  | "AnimatedImage"
  | "List";

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
  // Optional QML-binding expression that controls runtime visibility. Empty
  // / undefined = always visible. Evaluated against the app's properties:
  // e.g. `app.var_active`, `app.var_count > 0`. Set via the inspector.
  visibleWhen?: string;
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
  // If set, Text.text is bound to the variable (by id) instead of the
  // literal `text` field. Lets users surface state like a counter / name.
  binding?: string;
}

// Behavior actions wired to interactive widgets (currently only Button).
// Optional on the node — undefined = "do nothing", same as { kind: "none" }.
//
// setVariable's `mode` decides how `value` is rendered into QML:
//   "literal"    → quoted string / parsed number / true|false
//   "expression" → spliced into QML as-is, so `app.var_count + 1` works
export type SetVariableMode = "literal" | "expression";
// callModule args: each carries its own literal/expression mode independent
// of the others (a method might accept a literal poll-id and an expression
// like `app.var_yes`).
export interface CallModuleArg {
  value: string;
  mode: SetVariableMode;
}
export type ButtonAction =
  | { kind: "none" }
  | { kind: "navigate"; pageId: string }
  | { kind: "setVariable"; varId: string; value: string; mode?: SetVariableMode }
  | { kind: "openUrl"; url: string }
  | { kind: "callModule"; moduleId: string; method: string; args: CallModuleArg[] }
  // High-level "publish a message via the delivery network" action. Hides
  // all the bootstrap (createNode, start) — the QML emitter wires those up
  // automatically the first time any sendMessage or onMessageReceived is
  // detected. `payloadMode` mirrors setVariable's literal/expression switch
  // so users can splice in a variable (`app.var_input`) as the payload.
  | { kind: "sendMessage"; topic: string; payload: string; payloadMode?: SetVariableMode }
  // Append a value onto a JSON-array variable. The variable's type is still
  // `string` — its content is a JSON-encoded array. The QML emitter parses,
  // pushes, and re-stringifies on each call. Used to build "log" / "list of
  // messages" patterns without making the user write the JSON expression.
  | { kind: "appendToList"; varId: string; value: string; mode?: SetVariableMode };

export interface ButtonNode extends BaseProps {
  kind: "Button";
  text: string;
  textColor: string;         // overrides default contentItem text color
  fontWeight: FontWeight;
  onClick?: ButtonAction;
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
  // Two-way bind to a string variable. text reads from it and updates write
  // back via onTextChanged. Compatible variable type: "string".
  binding?: string;
}

export interface CheckBoxNode extends BaseProps {
  kind: "CheckBox";
  text: string;          // label
  checked: boolean;
  pixelSize: number;
  binding?: string;      // boolean variable
}

export interface SwitchNode extends BaseProps {
  kind: "Switch";
  text: string;          // label
  checked: boolean;
  pixelSize: number;
  binding?: string;      // boolean variable
}

export interface SliderNode extends BaseProps {
  kind: "Slider";
  from: number;
  to: number;
  value: number;
  stepSize: number;
  binding?: string;      // number variable
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
  binding?: string;      // string variable
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

// Repeater-backed list: binds to a string variable that holds a JSON array,
// renders one item per element. v1 template is a Text — `dataVar`'s entries
// are stringified into Text.text. Layout flows vertically or horizontally
// with `gap` pixels between items. The Variable's `initial` value drives the
// design-time preview; at runtime the live variable does.
export type ListDirection = "vertical" | "horizontal";
export interface ListNode extends BaseProps {
  kind: "List";
  dataVar?: string;            // id of a string variable whose value is a JSON array
  direction: ListDirection;
  gap: number;                 // px between items
  itemPixelSize: number;
  itemColor: string;
  // Optional per-item "bubble" wrapper. When the bg is non-transparent OR
  // padding > 0 OR radius > 0, the delegate wraps the Text in a Rectangle
  // with these props — turning a plain text list into a chat-bubble list.
  itemBackgroundColor: string;
  itemBorderRadius: number;
  itemPadding: number;
}

export type Node =
  | TextNode | ButtonNode | RectangleNode | FrameNode | ImageNode
  | TextFieldNode | TextAreaNode | CheckBoxNode | RadioButtonNode | SwitchNode
  | SliderNode | SpinBoxNode | ProgressBarNode | BusyIndicatorNode
  | ComboBoxNode | AnimatedImageNode | ListNode;

export type LeafNode =
  | TextNode | ButtonNode | RectangleNode | ImageNode
  | TextFieldNode | TextAreaNode | CheckBoxNode | RadioButtonNode | SwitchNode
  | SliderNode | SpinBoxNode | ProgressBarNode | BusyIndicatorNode
  | ComboBoxNode | AnimatedImageNode | ListNode;

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
    case "List":
      return {
        id, kind, ...base, width: 240, height: 160,
        style: defaultStyle(),
        direction: "vertical",
        gap: 6,
        itemPixelSize: 14,
        itemColor: "#1f2d3d",
        itemBackgroundColor: "transparent",
        itemBorderRadius: 0,
        itemPadding: 0,
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

// ── Multi-page application model ────────────────────────────────────────────
//
// A widget is a list of named pages, one of which is the initial page when
// the widget loads. Pages each own a FrameNode tree. The editor switches
// between pages; the emitted QML wraps every page in a Loader-driven scene
// graph so navigation actions (Button.onClick = navigate) work at runtime.

export type PageId = string;

export interface PageData {
  id: PageId;
  name: string;
  root: FrameNode;
}

// Application-level variables — the storage layer behind bindings + actions.
// Each variable has a stable id, a user-edited name (sanitised at QML emit
// to a safe identifier), a type, and an `initial` string the QML emitter
// parses according to type. Booleans accept "true"/"false"; numbers accept
// any JS-parseable numeric string.
export type VariableType = "string" | "number" | "boolean";
export type VariableId = string;
export interface Variable {
  id: VariableId;
  name: string;
  type: VariableType;
  initial: string;
}
export const newVariable = (name = "var"): Variable => ({
  id: newId(),
  name,
  type: "string",
  initial: "",
});

// ── Logos modules catalog ──────────────────────────────────────────────────
//
// Backend modules (e.g. polling, filesharing, delivery) are exposed to the
// QML widget via a global bridge:
//
//   logos.callModule(moduleId, methodName, [arg1, arg2, ...])
//
// We don't QML-import them. The widget just declares each module it uses in
// metadata.json's `dependencies` array, then calls methods through the
// bridge. ModuleSpec captures everything the editor needs to wire UI to a
// module: the methods + arg shapes for picking from inspector, plus the
// id used by both the bridge and the dependency list.

export type ParamType = "string" | "number" | "boolean";
export interface ModuleParam {
  name: string;
  type: ParamType;
  description?: string;
}
export interface ModuleMethod {
  name: string;
  args: ModuleParam[];
  returns: ParamType | "void";
  description?: string;
}
// An async event a module emits via its eventResponse signal. Subscribed
// to via `logos.onModuleEvent(moduleId, eventName, cb)` from the widget.
// `data` documents the shape of the QVariantList payload the callback
// receives — purely informational; the editor doesn't typecheck against it.
export interface ModuleEvent {
  name: string;
  data: { name: string; type: ParamType }[];
  description?: string;
}
export interface ModuleSpec {
  id: string;            // used in logos.callModule(id, …) AND metadata.json deps
  name: string;          // display label
  description: string;
  methods: ModuleMethod[];
  events?: ModuleEvent[];
}
export type ModuleId = string;

// ── Core module authoring ──────────────────────────────────────────────────
//
// In addition to consuming pre-built primitives (delivery_module etc.), a
// project can ALSO author its own backend module — written in C++ and
// compiled to a `type: core` .lgx. The editor stores a CoreModuleSpec that
// drives both:
//   - the inspector callModule picker (so the UI can call its own module's
//     methods alongside the primitives),
//   - the source-project codegen at export time (CMakeLists, flake.nix,
//     metadata.json, the C++ interface + plugin skeleton).
//
// Method bodies are TODO at codegen time; the user fills them in C++.

export interface CoreMethod {
  name: string;
  args: ModuleParam[];
  returns: ParamType | "void";
  description?: string;
  // Optional C++ body. When set, the codegen splices this verbatim into
  // the .cpp instead of the TODO stub. Lets users iterate on the C++
  // without leaving the editor.
  body?: string;
}

// User-defined private state field on the C++ plugin class. `cppType` is
// pasted into the header verbatim (e.g. "QString", "int", "QHash<QString, PollState>")
// so users have full control over what they declare.
export interface CoreStateField {
  name: string;
  cppType: string;
  initial?: string;        // optional `= initial` initializer
  description?: string;
}

export interface CoreModuleSpec {
  // Stable id used as the QML callModule key, the metadata.json `name`,
  // and the C++ class/file prefix. Sanitised at codegen time.
  id: string;
  name: string;            // display label
  version: string;         // semver-ish, e.g. "0.1.0"
  description: string;
  category: string;        // e.g. "example"
  // Other modules this module depends on at runtime (e.g. ["delivery_module"]).
  dependencies: string[];
  methods: CoreMethod[];
  state: CoreStateField[];
}

export const newCoreModule = (): CoreModuleSpec => ({
  id: "my_module",
  name: "my_module",
  version: "0.1.0",
  description: "A custom Logos core module",
  category: "example",
  dependencies: [],
  methods: [],
  state: [],
});

export const newCoreMethod = (): CoreMethod => ({
  name: "doSomething",
  args: [],
  returns: "boolean",
  description: "",
});

export const newCoreStateField = (): CoreStateField => ({
  name: "myField",
  cppType: "QString",
  initial: "",
});

// ── Triggers (event-driven actions) ────────────────────────────────────────
//
// A trigger fires actions in response to something happening:
//   - "appStart" — when the widget loads (Component.onCompleted)
//   - "moduleEvent" — when a module emits a named event
//
// The action sequence is the same shape we use for Button.onClick, so the
// editor reuses one editor + qmlEmit also has one renderer for both.

export type TriggerKind = "appStart" | "moduleEvent" | "onMessageReceived";
export type TriggerId = string;
export interface Trigger {
  id: TriggerId;
  kind: TriggerKind;
  // moduleEvent only:
  moduleId?: string;
  eventName?: string;
  // onMessageReceived only — the content topic to listen on. The QML
  // emitter auto-subscribes to this topic and routes incoming messages to
  // this trigger's actions. Empty topic = match every received message.
  topic?: string;
  // The action sequence to run when the trigger fires. Reuses ButtonAction;
  // each entry runs in order. For onMessageReceived, the action block runs
  // with `payload` (decoded text) and `topic` in scope.
  actions: ButtonAction[];
}
export const newTrigger = (kind: TriggerKind = "appStart"): Trigger => ({
  id: newId(),
  kind,
  actions: [],
});

export interface AppState {
  pages: PageData[];
  currentPageId: PageId;
  variables: Variable[];
  // Primitive module ids (from the catalog) the widget depends on. Each
  // becomes a metadata.json dependency at export time and its methods
  // become callable via Button onClick → callModule.
  modules: ModuleId[];
  // Optional user-authored backend module that ships alongside the UI .lgx.
  // When set, its methods join the callModule picker and a separate
  // source-project bundle is produced on export.
  coreModule?: CoreModuleSpec;
  // Event-driven action handlers. See Trigger.
  triggers: Trigger[];
}

export const newPage = (name: string): PageData => ({
  id: newId(),
  name,
  root: newRoot(),
});

export const newApp = (): AppState => {
  const home = newPage("Home");
  return {
    pages: [home],
    currentPageId: home.id,
    variables: [],
    modules: [],
    triggers: [],
  };
};
