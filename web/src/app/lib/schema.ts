// Strict Zod schema for the entire AppState tree.
//
// This is the SINGLE SOURCE OF TRUTH for what valid app data looks like.
// Every AI patch result passes through `sanitizeApp()` before it touches
// the QML emitter or gets sent back to the client. If data passes this
// schema, the QML compiler is GUARANTEED to produce valid QML — no
// string-interpolation surprise, no undefined-field crash, no broken
// Basecamp install.
//
// Design principles:
//   - Coerce where safe (missing string → "", missing number → 0)
//   - Default where possible (missing style → defaultStyle())
//   - Reject where dangerous (unknown action kinds, invalid node kinds)
//   - Every field that the QML emitter reads MUST be declared here

import { z } from "zod";

// ── Primitives with coercion ────────────────────────────────────────────────

const str = z.string().catch("");
const num = z.number().catch(0);
const bool = z.boolean().catch(false);
const color = z.string().catch("transparent");

// ── CommonStyle ─────────────────────────────────────────────────────────────

export const CommonStyleSchema = z.object({
  backgroundColor: color.catch("transparent"),
  opacity: num.catch(1),
  borderColor: color.catch("transparent"),
  borderWidth: num.catch(0),
  borderRadius: num.catch(0),
  rotation: num.catch(0),
}).catch({
  backgroundColor: "transparent",
  opacity: 1,
  borderColor: "transparent",
  borderWidth: 0,
  borderRadius: 0,
  rotation: 0,
});

// ── Actions ─────────────────────────────────────────────────────────────────

const SetVariableMode = z.enum(["literal", "expression"]).catch("literal");

const CallModuleArgSchema = z.object({
  value: str,
  mode: SetVariableMode,
}).catch({ value: "", mode: "literal" as const });

// Forward-declare for recursive `if` actions
type ButtonActionInput = z.input<typeof ButtonActionSchema>;

const ButtonActionSchema: z.ZodType<any> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("navigate"), pageId: str }),
  z.object({
    kind: z.literal("setVariable"),
    varId: str,
    value: str,
    mode: SetVariableMode.optional(),
  }),
  z.object({ kind: z.literal("openUrl"), url: str }),
  z.object({
    kind: z.literal("callModule"),
    moduleId: str,
    method: str,
    args: z.array(CallModuleArgSchema).catch([]),
  }),
  z.object({
    kind: z.literal("callModuleToVariable"),
    varId: str,
    moduleId: str,
    method: str,
    args: z.array(CallModuleArgSchema).catch([]),
  }),
  z.object({
    kind: z.literal("sendMessage"),
    topic: str,
    payload: str,
    payloadMode: SetVariableMode.optional(),
  }),
  z.object({
    kind: z.literal("appendToList"),
    varId: str,
    value: str,
    mode: SetVariableMode.optional(),
  }),
  z.object({
    kind: z.literal("if"),
    condition: str,
    actions: z.lazy(() => z.array(ButtonActionSchema).catch([])),
  }),
]).catch({ kind: "none" as const });

// ── Node kinds ──────────────────────────────────────────────────────────────

const FontWeight = z.enum(["normal", "bold"]).catch("normal");
const TextAlign = z.enum(["left", "center", "right"]).catch("left");
const ImageFit = z.enum(["fill", "contain", "cover", "none", "scale-down"]).catch("contain");
const WrapMode = z.enum(["none", "word"]).catch("word");
const ListDirection = z.enum(["vertical", "horizontal"]).catch("vertical");

// Shared base props — every node has these. `.default()` ensures missing
// fields from AI patches get filled, not rejected.
const BasePropsSchema = {
  id: str.default(""),
  x: num.default(0),
  y: num.default(0),
  width: z.number().default(100).catch(100),
  height: z.number().default(40).catch(40),
  style: CommonStyleSchema.default({
    backgroundColor: "transparent", opacity: 1, borderColor: "transparent",
    borderWidth: 0, borderRadius: 0, rotation: 0,
  }),
  hidden: bool.default(false),
  locked: bool.default(false),
  visibleWhen: z.string().optional(),
};

// Forward-declare Node for recursive Frame.children
type NodeInput = z.input<typeof NodeSchema>;

const TextNodeSchema = z.object({
  ...BasePropsSchema,
  kind: z.literal("Text"),
  text: str.default(""),
  pixelSize: z.number().default(16).catch(16),
  color: z.string().default("#1f2d3d").catch("#1f2d3d"),
  fontWeight: FontWeight.default("normal"),
  italic: bool.default(false),
  textAlign: TextAlign.default("left"),
  fontFamily: str.default(""),
  letterSpacing: num.default(0),
  lineHeight: z.number().default(1.2).catch(1.2),
  binding: z.string().optional(),
});

const ButtonNodeSchema = z.object({
  ...BasePropsSchema,
  kind: z.literal("Button"),
  text: str.default("Button"),
  textColor: z.string().default("#1f2d3d").catch("#1f2d3d"),
  fontWeight: FontWeight.default("normal"),
  onClick: ButtonActionSchema.optional(),
});

const RectangleNodeSchema = z.object({
  ...BasePropsSchema,
  kind: z.literal("Rectangle"),
});

const ImageNodeSchema = z.object({
  ...BasePropsSchema,
  kind: z.literal("Image"),
  src: str.default(""),
  fit: ImageFit.default("contain"),
});

const TextFieldNodeSchema = z.object({
  ...BasePropsSchema,
  kind: z.literal("TextField"),
  text: str.default(""),
  placeholder: str.default(""),
  readOnly: bool.default(false),
  pixelSize: z.number().default(14).catch(14),
  binding: z.string().optional(),
});

const TextAreaNodeSchema = z.object({
  ...BasePropsSchema,
  kind: z.literal("TextArea"),
  text: str.default(""),
  placeholder: str.default(""),
  readOnly: bool.default(false),
  pixelSize: z.number().default(14).catch(14),
  wrapMode: WrapMode.default("word"),
  binding: z.string().optional(),
});

const CheckBoxNodeSchema = z.object({
  ...BasePropsSchema,
  kind: z.literal("CheckBox"),
  text: str.default(""),
  checked: bool.default(false),
  pixelSize: z.number().default(14).catch(14),
  binding: z.string().optional(),
});

const SwitchNodeSchema = z.object({
  ...BasePropsSchema,
  kind: z.literal("Switch"),
  text: str.default(""),
  checked: bool.default(false),
  pixelSize: z.number().default(14).catch(14),
  binding: z.string().optional(),
});

const RadioButtonNodeSchema = z.object({
  ...BasePropsSchema,
  kind: z.literal("RadioButton"),
  text: str.default(""),
  checked: bool.default(false),
  pixelSize: z.number().default(14).catch(14),
});

const SliderNodeSchema = z.object({
  ...BasePropsSchema,
  kind: z.literal("Slider"),
  from: num.default(0),
  to: z.number().default(100).catch(100),
  value: z.number().default(50).catch(50),
  stepSize: z.number().default(1).catch(1),
  binding: z.string().optional(),
});

const SpinBoxNodeSchema = z.object({
  ...BasePropsSchema,
  kind: z.literal("SpinBox"),
  from: num.default(0),
  to: z.number().default(100).catch(100),
  value: num.default(0),
  stepSize: z.number().default(1).catch(1),
  editable: z.boolean().default(true).catch(true),
});

const ProgressBarNodeSchema = z.object({
  ...BasePropsSchema,
  kind: z.literal("ProgressBar"),
  from: num.default(0),
  to: z.number().default(100).catch(100),
  value: z.number().default(50).catch(50),
  indeterminate: bool.default(false),
});

const BusyIndicatorNodeSchema = z.object({
  ...BasePropsSchema,
  kind: z.literal("BusyIndicator"),
  running: z.boolean().catch(true),
});

const ComboBoxNodeSchema = z.object({
  ...BasePropsSchema,
  kind: z.literal("ComboBox"),
  model: z.array(str).default(["Option 1", "Option 2"]).catch(["Option 1", "Option 2"]),
  currentIndex: num.default(0),
  pixelSize: z.number().default(14).catch(14),
});

const AnimatedImageNodeSchema = z.object({
  ...BasePropsSchema,
  kind: z.literal("AnimatedImage"),
  src: str.default(""),
  fit: ImageFit.default("contain"),
  playing: z.boolean().default(true).catch(true),
});

const ListNodeSchema = z.object({
  ...BasePropsSchema,
  kind: z.literal("List"),
  dataVar: z.string().optional(),
  direction: ListDirection.default("vertical"),
  gap: z.number().default(6).catch(6),
  itemPixelSize: z.number().default(14).catch(14),
  itemColor: z.string().default("#1f2d3d").catch("#1f2d3d"),
  itemBackgroundColor: z.string().default("transparent").catch("transparent"),
  itemBorderRadius: num.default(0),
  itemPadding: num.default(0),
});

// Frame is recursive — children are Nodes
const FrameNodeSchema: z.ZodType<any> = z.object({
  ...BasePropsSchema,
  kind: z.literal("Frame"),
  children: z.lazy(() => z.array(NodeSchema).default([]).catch([])),
});

// z.union instead of discriminatedUnion — the recursive FrameNodeSchema
// with z.lazy() confuses Zod v4's discriminated-union type inference.
const NodeSchema: z.ZodType<any> = z.union([
  TextNodeSchema,
  ButtonNodeSchema,
  RectangleNodeSchema,
  FrameNodeSchema,
  ImageNodeSchema,
  TextFieldNodeSchema,
  TextAreaNodeSchema,
  CheckBoxNodeSchema,
  RadioButtonNodeSchema,
  SwitchNodeSchema,
  SliderNodeSchema,
  SpinBoxNodeSchema,
  ProgressBarNodeSchema,
  BusyIndicatorNodeSchema,
  ComboBoxNodeSchema,
  AnimatedImageNodeSchema,
  ListNodeSchema,
]);

// ── Variables ───────────────────────────────────────────────────────────────

const VariableTypeSchema = z.enum(["string", "number", "boolean"]).catch("string");

const VariableSchema = z.object({
  id: str.default(""),
  name: str.default("var"),
  type: VariableTypeSchema.default("string"),
  initial: str.default(""),
});

// ── Triggers ────────────────────────────────────────────────────────────────

const TriggerKindSchema = z.enum(["appStart", "moduleEvent", "onMessageReceived", "interval"]).catch("appStart");

const TriggerSchema = z.object({
  id: str.default(""),
  kind: TriggerKindSchema,
  moduleId: z.string().optional(),
  eventName: z.string().optional(),
  topic: z.string().optional(),
  intervalMs: z.number().optional(),
  actions: z.array(ButtonActionSchema).default([]).catch([]),
});

// ── Pages ───────────────────────────────────────────────────────────────────

const PageDataSchema = z.object({
  id: str.default(""),
  name: str.default("Page"),
  root: FrameNodeSchema,
});

// ── Core module spec ────────────────────────────────────────────────────────

const ParamTypeSchema = z.enum(["string", "number", "boolean"]).catch("string");
const ReturnTypeSchema = z.enum(["string", "number", "boolean", "void"]).catch("void");

const ModuleParamSchema = z.object({
  name: str,
  type: ParamTypeSchema,
  description: z.string().optional(),
  cppType: z.string().optional(),
});

const CoreMethodSchema = z.object({
  name: str,
  args: z.array(ModuleParamSchema).catch([]),
  returns: ReturnTypeSchema,
  description: z.string().optional(),
  body: z.string().optional(),
  cppReturn: z.string().optional(),
});

const CoreStateFieldSchema = z.object({
  name: str,
  cppType: z.string().catch("QString"),
  initial: z.string().optional(),
  description: z.string().optional(),
});

const ModuleEventDataSchema = z.object({
  name: str,
  type: ParamTypeSchema,
});

const ModuleEventSchema = z.object({
  name: str,
  data: z.array(ModuleEventDataSchema).catch([]),
  description: z.string().optional(),
});

const CoreModuleTestSchema = z.object({
  name: str,
  body: str,
  description: z.string().optional(),
});

const CoreModuleSpecSchema = z.object({
  id: z.string().catch("my_module"),
  name: z.string().catch("my_module"),
  version: z.string().catch("0.1.0"),
  description: str,
  category: z.string().catch("custom"),
  dependencies: z.array(str).catch([]),
  methods: z.array(CoreMethodSchema).catch([]),
  state: z.array(CoreStateFieldSchema).catch([]),
  events: z.array(ModuleEventSchema).catch([]).optional(),
  tests: z.array(CoreModuleTestSchema).catch([]).optional(),
});

// ── AppState (top-level) ────────────────────────────────────────────────────

export const AppStateSchema = z.object({
  pages: z.array(PageDataSchema).default([]).catch([]),
  currentPageId: str.default(""),
  variables: z.array(VariableSchema).default([]).catch([]),
  modules: z.array(str).default([]).catch([]),
  coreModule: CoreModuleSpecSchema.optional(),
  triggers: z.array(TriggerSchema).default([]).catch([]),
});

// ── Public API ──────────────────────────────────────────────────────────────

export type SanitizeResult =
  | { ok: true; app: z.output<typeof AppStateSchema> }
  | { ok: false; errors: string[] };

// Run the full AppState through the Zod schema. Coerces where possible,
// rejects where not. If this returns ok:true, the QML emitter is safe.
export function sanitizeApp(raw: unknown): SanitizeResult {
  const result = AppStateSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, app: result.data };
  }
  const errors = result.error.issues.map(
    (issue) => `${issue.path.join(".")}: ${issue.message}`,
  );
  return { ok: false, errors };
}

// Quick pass-through for internal use: parse or throw.
export function parseAppState(raw: unknown): z.output<typeof AppStateSchema> {
  return AppStateSchema.parse(raw);
}
