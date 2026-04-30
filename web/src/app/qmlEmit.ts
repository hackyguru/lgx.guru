// Walk the canvas tree and emit QML source for the renderer + .lgx export.
// Targets Basecamp's allowed sandbox: QtQuick / Controls 2.15 / Layouts 1.15.
//
// Layout model: every node emits explicit x/y/width/height (px). Every node
// also carries a CommonStyle wrapper (background colour, border, radius,
// opacity, rotation) which becomes the outer Rectangle in QML; type-specific
// content (Text / Button / etc.) anchors inside that wrapper. Frames are
// bare Rectangles holding child nodes directly.
//
// Multi-page model: the app is wrapped in a top-level
//   Rectangle { id: app; property string currentPage; Loader { ... };
//               Component { id: _page_0; <page root> } ... }
// so Button.onClicked: app.navigate("<key>") can swap the visible page.

import { AppState, ButtonAction, CallModuleArg, CommonStyle, ImageFit, ModuleMethod, Node, PageData, Variable, VariableType } from "./types";
import { findModuleMethod } from "./modules/catalog";

// The id of the curated delivery primitive — referenced only by the shared
// relay's metadata, not by user UIs. UIs call DELIVERY_RELAY_ID instead.
export const DELIVERY_MODULE_ID = "delivery_module";

// The shared, pre-built relay's module id. UIs route every send/receive
// through this fixed name via callModule. Same .lgx ships with the editor
// (web/public/delivery_relay.lgx) and is installed once per Basecamp; all
// delivery-using widgets reuse it.
export const DELIVERY_RELAY_ID = "delivery_relay";

// How often the UI polls the relay's takeRecentMessages to drain queued
// inbound messages. 1s is the polling app's default and feels live without
// burning CPU. Configurable later if needed.
const DELIVERY_POLL_INTERVAL_MS = 1000;

const escapeStr = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

const indent = (depth: number) => "    ".repeat(depth);

// AI-generated patches sometimes splice expressions with unbalanced parens
// (or other syntactic damage). Because QML parses the whole Main.qml at
// load time, ONE bad spliced expression poisons the entire widget — preview
// errors out and Basecamp silently refuses to open the installed UI module.
// Try/catch can't help: parse-time errors fire before any handler runs.
//
// safeExpr validates the expression by trying to compile it as a JS
// expression. If it parses, the original is returned; otherwise we emit a
// fallback (defaulting to `null`) plus a console.log so the user can see
// what was dropped without the whole UI dying.
const safeExpr = (raw: string, fallback = "null"): string => {
  const s = raw.trim();
  if (!s) return fallback;
  try {
    // eslint-disable-next-line no-new-func
    new Function(`return (${s});`);
    return s;
  } catch {
    // Surface the dropped fragment in the runtime console so a user
    // inspecting via QML logs can see what we replaced.
    return `(function(){ console.log("[lgx] dropped malformed expression:", ${JSON.stringify(s)}); return ${fallback}; })()`;
  }
};


// Stable per-page key used in the QML navigation switch. We use the design-
// time page id (already a string of the form "n<ts>_<n>") sanitised so it's
// a safe QML identifier suffix.
const navKey = (pageId: string): string =>
  pageId.replace(/[^a-z0-9_]/gi, "_");
const compId = (idx: number): string => `_page_${idx}`;

// Variables become QML properties on the app Rectangle. We prefix with
// "var_" to dodge collisions with QML keywords / built-in properties, then
// sanitise the user-typed name. Repeated names get suffixed by index so
// the emitted QML stays valid.
const varPropName = (v: Variable, idx: number, used: Set<string>): string => {
  const slug = v.name.replace(/[^a-z0-9_]/gi, "_") || `v${idx}`;
  let name = `var_${slug}`;
  let n = 1;
  while (used.has(name)) { n++; name = `var_${slug}_${n}`; }
  used.add(name);
  return name;
};

const qmlPropertyType = (t: VariableType): string =>
  t === "number" ? "real" : t === "boolean" ? "bool" : "string";

// Render the user-supplied initial value as a QML literal of the right
// type. Bad numbers fall back to 0; bad booleans fall back to false.
//
// String initials are emitted inside DOUBLE-quoted QML strings so we use
// JSON.stringify, which escapes embedded `"`, `\`, control characters, etc.
// (`escapeStr` is single-quote-aware and would leave `"` unescaped — that
// closes the string early on values like `["a","b"]`.)
const qmlInitial = (v: Variable): string => {
  if (v.type === "number") {
    const n = parseFloat(v.initial);
    return Number.isFinite(n) ? String(n) : "0";
  }
  if (v.type === "boolean") {
    return v.initial === "true" ? "true" : "false";
  }
  return JSON.stringify(v.initial);
};

// Emit the QML value expression for a setVariable action's value field.
// String → quoted; number → parsed; boolean → true/false literal.
const setVariableExpr = (varType: VariableType, value: string): string => {
  if (varType === "number") {
    const n = parseFloat(value);
    return Number.isFinite(n) ? String(n) : "0";
  }
  if (varType === "boolean") return value === "true" ? "true" : "false";
  return `"${escapeStr(value)}"`;
};

// CommonStyle → QML property lines (without the geometry — caller emits that).
const styleLines = (s: CommonStyle, i: string): string[] => {
  const lines: string[] = [
    `${i}    color: '${escapeStr(s.backgroundColor)}'`,
    `${i}    radius: ${s.borderRadius}`,
  ];
  if (s.borderWidth > 0) {
    lines.push(`${i}    border.color: '${escapeStr(s.borderColor)}'`);
    lines.push(`${i}    border.width: ${s.borderWidth}`);
  }
  if (s.opacity !== 1) lines.push(`${i}    opacity: ${s.opacity}`);
  if (s.rotation !== 0) lines.push(`${i}    rotation: ${s.rotation}`);
  return lines;
};

const geomLines = (n: Node, i: string): string[] => {
  const lines = [
    `${i}    x: ${n.x}`,
    `${i}    y: ${n.y}`,
    `${i}    width: ${n.width}`,
    `${i}    height: ${n.height}`,
  ];
  if (n.visibleWhen) lines.push(`${i}    visible: ${safeExpr(n.visibleWhen, "true")}`);
  return lines;
};

const textAlignToQml = (a: "left" | "center" | "right") =>
  a === "left" ? "Text.AlignLeft" : a === "right" ? "Text.AlignRight" : "Text.AlignHCenter";

const fontWeightToQml = (w: "normal" | "bold") =>
  w === "bold" ? "Font.Bold" : "Font.Normal";

const fitToQml = (f: ImageFit): string => {
  switch (f) {
    case "fill":        return "Image.Stretch";
    case "contain":     return "Image.PreserveAspectFit";
    case "cover":       return "Image.PreserveAspectCrop";
    case "none":        return "Image.Pad";
    case "scale-down":  return "Image.PreserveAspectFit";
  }
};

// Threaded through emitNode so per-node emitters that produce navigation /
// data references can resolve them. `varQmlByVarId` maps variable id →
// QML property name (with the "var_" prefix and dedupe applied).
// `extraMethods` lets the user's own core module's methods resolve in
// callModule actions even though they aren't in the static catalog.
interface EmitCtx {
  pages: PageData[];
  variables: Variable[];
  varQmlByVarId: Map<string, string>;
  varTypeByVarId: Map<string, VariableType>;
  extraMethods: Map<string, Map<string, ModuleMethod>>; // moduleId -> (methodName -> spec)
}

// Render a Button.onClick action as the QML expression body for `onClicked:`.
// Returns null if the action does nothing useful (none / dangling refs).
const onClickQml = (action: ButtonAction | undefined, ctx: EmitCtx): string | null => {
  if (!action || action.kind === "none") return null;
  if (action.kind === "navigate") {
    const target = ctx.pages.find((p) => p.id === action.pageId);
    return target ? `app.navigate("${navKey(target.id)}")` : null;
  }
  if (action.kind === "setVariable") {
    const prop = ctx.varQmlByVarId.get(action.varId);
    const type = ctx.varTypeByVarId.get(action.varId);
    if (!prop || !type) return null;
    // Expression mode splices the user's text as raw QML; literal mode
    // formats per the variable's type. Validate expression-mode strings so
    // an unbalanced paren doesn't break the whole Main.qml at parse time.
    const fallback = setVariableExpr(type, "");
    const value = action.mode === "expression"
      ? safeExpr(action.value || "", fallback)
      : setVariableExpr(type, action.value);
    return `app.${prop} = ${value}`;
  }
  if (action.kind === "openUrl") {
    if (!action.url) return null;
    return `Qt.openUrlExternally("${escapeStr(action.url)}")`;
  }
  if (action.kind === "callModule") {
    if (!action.moduleId || !action.method) return null;
    // Resolve against the static primitives catalog first, then the user's
    // own core-module methods for this project.
    const spec = findModuleMethod(action.moduleId, action.method)
      ?? ctx.extraMethods.get(action.moduleId)?.get(action.method);
    if (!spec) {
      // Silent drops here look like "the button does nothing" — exactly
      // the symptom that bit the stopwatch app. Surface a runtime log so
      // the user can see in Basecamp logs that the wiring references an
      // unknown module/method, instead of staring at a dead button.
      return `console.log("[lgx] button onClick references unknown ${action.moduleId}.${action.method}() — fix the wiring or rebuild the backend module")`;
    }
    // Render each declared arg using its declared type. Missing trailing
    // args are emitted as empty literals so the JS array shape matches the
    // method signature even if the user hasn't filled everything in.
    const argsExprs = spec.args.map((p, idx) => {
      const a: CallModuleArg = action.args[idx] ?? { value: "", mode: "literal" };
      const fb = p.type === "number" ? "0" : p.type === "boolean" ? "false" : '""';
      if (a.mode === "expression") return safeExpr(a.value || "", fb);
      if (p.type === "number") {
        const n = parseFloat(a.value);
        return Number.isFinite(n) ? String(n) : "0";
      }
      if (p.type === "boolean") return a.value === "true" ? "true" : "false";
      return `"${escapeStr(a.value)}"`;
    });
    return `logos.callModule("${escapeStr(action.moduleId)}", "${escapeStr(action.method)}", [${argsExprs.join(", ")}])`;
  }
  if (action.kind === "callModuleToVariable") {
    if (!action.moduleId || !action.method) return null;
    const prop = ctx.varQmlByVarId.get(action.varId);
    if (!prop) return null;
    const spec = findModuleMethod(action.moduleId, action.method)
      ?? ctx.extraMethods.get(action.moduleId)?.get(action.method);
    if (!spec) {
      return `console.log("[lgx] callModuleToVariable references unknown ${action.moduleId}.${action.method}() — variable will not update")`;
    }
    const argsExprs = spec.args.map((p, idx) => {
      const a: CallModuleArg = action.args[idx] ?? { value: "", mode: "literal" };
      const fb = p.type === "number" ? "0" : p.type === "boolean" ? "false" : '""';
      if (a.mode === "expression") return safeExpr(a.value || "", fb);
      if (p.type === "number") {
        const n = parseFloat(a.value);
        return Number.isFinite(n) ? String(n) : "0";
      }
      if (p.type === "boolean") return a.value === "true" ? "true" : "false";
      return `"${escapeStr(a.value)}"`;
    });
    // QML lets us assign module call's return into a property directly. The
    // user picked the variable; the callModule expression supplies the value.
    return `app.${prop} = logos.callModule("${escapeStr(action.moduleId)}", "${escapeStr(action.method)}", [${argsExprs.join(", ")}])`;
  }
  if (action.kind === "sendMessage") {
    const topic = action.topic.trim();
    if (!topic) return null;
    // Payload — literal mode quotes the user's text; expression mode splices
    // it raw so users can pass `app.var_input` or any QML expression. Validate
    // the expression form so a bad splice doesn't kill the whole handler.
    const payloadExpr = action.payloadMode === "expression"
      ? safeExpr(action.payload || "", '""')
      : `"${escapeStr(action.payload)}"`;
    // Route through the shared delivery_relay (sendMessage), NOT
    // delivery_module directly — the relay owns lifecycle + status and is
    // the same .lgx for every project. Comma-paired with sentCount bump so
    // the debug overlay reflects activity.
    return `(logos.callModule("${DELIVERY_RELAY_ID}", "sendMessage", ["${escapeStr(topic)}", ${payloadExpr}]), app.sentCount += 1)`;
  }
  if (action.kind === "appendToList") {
    const prop = ctx.varQmlByVarId.get(action.varId);
    if (!prop) return null;
    // Value to push — literal vs expression. Literal text is JSON-quoted so
    // it round-trips safely through stringify; expression text is validated
    // first so a malformed splice can't break Main.qml's parse.
    const valueExpr = action.mode === "expression"
      ? safeExpr(action.value || "", '""')
      : JSON.stringify(action.value);
    // Mutate-via-stringify pattern. Tolerates non-array / unparseable initial
    // values by falling back to []. Bound to a string variable; we re-encode
    // the array so List/Repeater (which JSON.parse(app.var_*)) can read it.
    return `app.${prop} = JSON.stringify((function(){ var _a=[]; try { var _p=JSON.parse(app.${prop}); if (Array.isArray(_p)) _a=_p; } catch(_e){} _a.push(${valueExpr}); return _a; })())`;
  }
  if (action.kind === "if") {
    // Composition primitive: branch on a JS condition. Empty condition is
    // treated as `true` so a freshly-added `if` block doesn't silently no-op.
    // Validate the condition at emit time so a malformed expression can't
    // break the surrounding QML parse — falls back to `false` (skip branch).
    // Also wrapped in try/catch so a runtime error in the body or condition
    // doesn't kill the whole handler.
    const cond = action.condition.trim() ? safeExpr(action.condition, "false") : "true";
    const body = actionBlockJs(action.actions, ctx);
    if (!body) return null;
    return `try { if (${cond}) { ${body} } } catch(_ifErr) { console.log("if condition error:", _ifErr) }`;
  }
  return null;
};

// True if the app uses the high-level delivery actions anywhere — drives
// the auto-bootstrap (createNode + start + per-topic subscribe) inside
// Component.onCompleted and the dependency auto-include at export time.
export const usesDelivery = (app: AppState): boolean => {
  // Triggers: any onMessageReceived means delivery is needed.
  if ((app.triggers ?? []).some((t) => t.kind === "onMessageReceived")) return true;
  // Actions: scan every page's Button.onClick + every trigger's action list.
  const actionUsesDelivery = (a: ButtonAction | undefined): boolean =>
    !!a && a.kind === "sendMessage";
  for (const t of app.triggers ?? []) {
    if (t.actions.some(actionUsesDelivery)) return true;
  }
  const walk = (n: Node): boolean => {
    if (n.kind === "Button" && actionUsesDelivery(n.onClick)) return true;
    if (n.kind === "Frame") return n.children.some(walk);
    return false;
  };
  return app.pages.some((p) => p.root.children.some(walk));
};

// All distinct content topics used by onMessageReceived triggers — drives
// the auto-subscribe calls. Empty topics are dropped (match-all subscribers
// don't need an explicit subscribe).
const subscribedTopics = (app: AppState): string[] => {
  const topics = new Set<string>();
  for (const t of app.triggers ?? []) {
    if (t.kind === "onMessageReceived" && t.topic && t.topic.trim()) {
      topics.add(t.topic.trim());
    }
  }
  return Array.from(topics);
};

// Resolve an input widget's two-way binding to its QML property name.
// Returns null if no binding or the bound variable was deleted.
const boundProp = (varId: string | undefined, ctx: EmitCtx): string | null => {
  if (!varId) return null;
  return ctx.varQmlByVarId.get(varId) ?? null;
};

// Common visibility line for any node's outer Rectangle. Returns "" if no
// visibleWhen is set.
const visibleLine = (n: Node, i: string): string | null => {
  if (!n.visibleWhen) return null;
  return `${i}    visible: ${n.visibleWhen}`;
};

const emitNode = (node: Node, depth: number, ctx: EmitCtx): string => {
  const i = indent(depth);

  switch (node.kind) {
    case "Frame": {
      const lines = [
        `${i}Rectangle {`,
        ...geomLines(node, i),
        ...styleLines(node.style, i),
      ];
      for (const c of node.children) {
        if (c.hidden) continue;
        lines.push(emitNode(c, depth + 1, ctx));
      }
      lines.push(`${i}}`);
      return lines.join("\n");
    }

    case "Rectangle": {
      return [
        `${i}Rectangle {`,
        ...geomLines(node, i),
        ...styleLines(node.style, i),
        `${i}}`,
      ].join("\n");
    }

    case "Text": {
      // If bound to an existing variable, the text is a property binding.
      // Otherwise emit the literal. Stringify non-string variables so all
      // types render correctly.
      const boundProp = node.binding ? ctx.varQmlByVarId.get(node.binding) : undefined;
      const boundType = node.binding ? ctx.varTypeByVarId.get(node.binding) : undefined;
      const textLine = boundProp
        ? boundType === "string"
          ? `${i}        text: app.${boundProp}`
          : `${i}        text: String(app.${boundProp})`
        : `${i}        text: '${escapeStr(node.text)}'`;
      const inner: (string | null)[] = [
        `${i}    Text {`,
        `${i}        anchors.fill: parent`,
        textLine,
        `${i}        font.pixelSize: ${node.pixelSize}`,
        `${i}        color: '${escapeStr(node.color)}'`,
        `${i}        font.weight: ${fontWeightToQml(node.fontWeight)}`,
        node.italic ? `${i}        font.italic: true` : null,
        `${i}        horizontalAlignment: ${textAlignToQml(node.textAlign)}`,
        `${i}        verticalAlignment: Text.AlignVCenter`,
        node.fontFamily ? `${i}        font.family: '${escapeStr(node.fontFamily)}'` : null,
        node.letterSpacing !== 0 ? `${i}        font.letterSpacing: ${node.letterSpacing}` : null,
        node.lineHeight !== 1 ? `${i}        lineHeight: ${node.lineHeight}` : null,
        node.lineHeight !== 1 ? `${i}        lineHeightMode: Text.ProportionalHeight` : null,
        `${i}    }`,
      ];
      return [
        `${i}Rectangle {`,
        ...geomLines(node, i),
        ...styleLines(node.style, i),
        ...inner.filter((l): l is string => l !== null),
        `${i}}`,
      ].join("\n");
    }

    case "Button": {
      const click = onClickQml(node.onClick, ctx);
      // Suppress the Button's default chrome ONLY when the user gave it an
      // explicit background (so Qt's grey theme doesn't cover our color).
      // For an unstyled button (transparent outer Rectangle) we keep Qt's
      // chrome, otherwise the button has nothing to render and shows as
      // bare floating text.
      const userStyledBg = node.style.backgroundColor !== "transparent";
      const inner: (string | null)[] = [
        `${i}    Button {`,
        `${i}        anchors.fill: parent`,
        `${i}        text: '${escapeStr(node.text)}'`,
        click ? `${i}        onClicked: ${click}` : null,
        userStyledBg ? `${i}        background: Item {}` : null,
        `${i}        contentItem: Text {`,
        `${i}            text: '${escapeStr(node.text)}'`,
        `${i}            color: '${escapeStr(node.textColor)}'`,
        `${i}            font.weight: ${fontWeightToQml(node.fontWeight)}`,
        `${i}            horizontalAlignment: Text.AlignHCenter`,
        `${i}            verticalAlignment: Text.AlignVCenter`,
        `${i}        }`,
        `${i}    }`,
      ];
      return [
        `${i}Rectangle {`,
        ...geomLines(node, i),
        ...styleLines(node.style, i),
        ...inner.filter((l): l is string => l !== null),
        `${i}}`,
      ].join("\n");
    }

    case "Image": {
      const inner: string[] = [
        `${i}    Image {`,
        `${i}        anchors.fill: parent`,
        `${i}        source: '${escapeStr(node.src)}'`,
        `${i}        fillMode: ${fitToQml(node.fit)}`,
        `${i}        clip: true`,
        `${i}    }`,
      ];
      return [
        `${i}Rectangle {`,
        ...geomLines(node, i),
        ...styleLines(node.style, i),
        ...inner,
        `${i}}`,
      ].join("\n");
    }

    case "TextField": {
      const bp = boundProp(node.binding, ctx);
      const inner: (string | null)[] = [
        `${i}    TextField {`,
        `${i}        anchors.fill: parent`,
        bp ? `${i}        text: app.${bp}` : `${i}        text: '${escapeStr(node.text)}'`,
        `${i}        placeholderText: '${escapeStr(node.placeholder)}'`,
        `${i}        readOnly: ${node.readOnly}`,
        `${i}        font.pixelSize: ${node.pixelSize}`,
        bp ? `${i}        onTextChanged: app.${bp} = text` : null,
        `${i}    }`,
      ];
      return [
        `${i}Rectangle {`,
        ...geomLines(node, i),
        ...styleLines(node.style, i),
        ...inner.filter((l): l is string => l !== null),
        `${i}}`,
      ].join("\n");
    }

    case "CheckBox": {
      const bp = boundProp(node.binding, ctx);
      const inner: (string | null)[] = [
        `${i}    CheckBox {`,
        `${i}        anchors.fill: parent`,
        `${i}        text: '${escapeStr(node.text)}'`,
        bp ? `${i}        checked: app.${bp}` : `${i}        checked: ${node.checked}`,
        `${i}        font.pixelSize: ${node.pixelSize}`,
        bp ? `${i}        onCheckedChanged: app.${bp} = checked` : null,
        `${i}    }`,
      ];
      return [
        `${i}Rectangle {`,
        ...geomLines(node, i),
        ...styleLines(node.style, i),
        ...inner.filter((l): l is string => l !== null),
        `${i}}`,
      ].join("\n");
    }

    case "Switch": {
      const bp = boundProp(node.binding, ctx);
      const inner: (string | null)[] = [
        `${i}    Switch {`,
        `${i}        anchors.fill: parent`,
        `${i}        text: '${escapeStr(node.text)}'`,
        bp ? `${i}        checked: app.${bp}` : `${i}        checked: ${node.checked}`,
        `${i}        font.pixelSize: ${node.pixelSize}`,
        bp ? `${i}        onCheckedChanged: app.${bp} = checked` : null,
        `${i}    }`,
      ];
      return [
        `${i}Rectangle {`,
        ...geomLines(node, i),
        ...styleLines(node.style, i),
        ...inner.filter((l): l is string => l !== null),
        `${i}}`,
      ].join("\n");
    }

    case "Slider": {
      const bp = boundProp(node.binding, ctx);
      const inner: (string | null)[] = [
        `${i}    Slider {`,
        `${i}        anchors.fill: parent`,
        `${i}        from: ${node.from}`,
        `${i}        to: ${node.to}`,
        bp ? `${i}        value: app.${bp}` : `${i}        value: ${node.value}`,
        `${i}        stepSize: ${node.stepSize}`,
        bp ? `${i}        onValueChanged: app.${bp} = value` : null,
        `${i}    }`,
      ];
      return [
        `${i}Rectangle {`,
        ...geomLines(node, i),
        ...styleLines(node.style, i),
        ...inner.filter((l): l is string => l !== null),
        `${i}}`,
      ].join("\n");
    }

    case "ProgressBar": {
      const inner: string[] = [
        `${i}    ProgressBar {`,
        `${i}        anchors.fill: parent`,
        `${i}        from: ${node.from}`,
        `${i}        to: ${node.to}`,
        `${i}        value: ${node.value}`,
        `${i}        indeterminate: ${node.indeterminate}`,
        `${i}    }`,
      ];
      return [
        `${i}Rectangle {`,
        ...geomLines(node, i),
        ...styleLines(node.style, i),
        ...inner,
        `${i}}`,
      ].join("\n");
    }

    case "TextArea": {
      const wrap = node.wrapMode === "word" ? "TextEdit.Wrap" : "TextEdit.NoWrap";
      const bp = boundProp(node.binding, ctx);
      const inner: (string | null)[] = [
        `${i}    TextArea {`,
        `${i}        anchors.fill: parent`,
        bp ? `${i}        text: app.${bp}` : `${i}        text: '${escapeStr(node.text)}'`,
        `${i}        placeholderText: '${escapeStr(node.placeholder)}'`,
        `${i}        readOnly: ${node.readOnly}`,
        `${i}        font.pixelSize: ${node.pixelSize}`,
        `${i}        wrapMode: ${wrap}`,
        bp ? `${i}        onTextChanged: app.${bp} = text` : null,
        `${i}    }`,
      ];
      return [
        `${i}Rectangle {`,
        ...geomLines(node, i),
        ...styleLines(node.style, i),
        ...inner.filter((l): l is string => l !== null),
        `${i}}`,
      ].join("\n");
    }

    case "RadioButton": {
      const inner: string[] = [
        `${i}    RadioButton {`,
        `${i}        anchors.fill: parent`,
        `${i}        text: '${escapeStr(node.text)}'`,
        `${i}        checked: ${node.checked}`,
        `${i}        font.pixelSize: ${node.pixelSize}`,
        `${i}    }`,
      ];
      return [
        `${i}Rectangle {`,
        ...geomLines(node, i),
        ...styleLines(node.style, i),
        ...inner,
        `${i}}`,
      ].join("\n");
    }

    case "SpinBox": {
      const inner: string[] = [
        `${i}    SpinBox {`,
        `${i}        anchors.fill: parent`,
        `${i}        from: ${node.from}`,
        `${i}        to: ${node.to}`,
        `${i}        value: ${node.value}`,
        `${i}        stepSize: ${node.stepSize}`,
        `${i}        editable: ${node.editable}`,
        `${i}    }`,
      ];
      return [
        `${i}Rectangle {`,
        ...geomLines(node, i),
        ...styleLines(node.style, i),
        ...inner,
        `${i}}`,
      ].join("\n");
    }

    case "BusyIndicator": {
      const inner: string[] = [
        `${i}    BusyIndicator {`,
        `${i}        anchors.fill: parent`,
        `${i}        running: ${node.running}`,
        `${i}    }`,
      ];
      return [
        `${i}Rectangle {`,
        ...geomLines(node, i),
        ...styleLines(node.style, i),
        ...inner,
        `${i}}`,
      ].join("\n");
    }

    case "ComboBox": {
      const items = node.model.map((m) => `'${escapeStr(m)}'`).join(", ");
      const inner: string[] = [
        `${i}    ComboBox {`,
        `${i}        anchors.fill: parent`,
        `${i}        model: [${items}]`,
        `${i}        currentIndex: ${node.currentIndex}`,
        `${i}        font.pixelSize: ${node.pixelSize}`,
        `${i}    }`,
      ];
      return [
        `${i}Rectangle {`,
        ...geomLines(node, i),
        ...styleLines(node.style, i),
        ...inner,
        `${i}}`,
      ].join("\n");
    }

    case "AnimatedImage": {
      const inner: string[] = [
        `${i}    AnimatedImage {`,
        `${i}        anchors.fill: parent`,
        `${i}        source: '${escapeStr(node.src)}'`,
        `${i}        fillMode: ${fitToQml(node.fit)}`,
        `${i}        playing: ${node.playing}`,
        `${i}        clip: true`,
        `${i}    }`,
      ];
      return [
        `${i}Rectangle {`,
        ...geomLines(node, i),
        ...styleLines(node.style, i),
        ...inner,
        `${i}}`,
      ].join("\n");
    }

    case "List": {
      // QML Repeater + Column/Row, parsing the bound variable as a JSON
      // array. The model expression tolerates non-JSON / undefined / non-
      // array values by falling back to [].
      //
      // Delegate has two modes:
      //   - plain Text — when no bubble styling is set
      //   - Text wrapped in a Rectangle with bg/radius/padding — chat-bubble
      //     style. Auto-sized to the text + padding.
      const dataProp = node.dataVar ? ctx.varQmlByVarId.get(node.dataVar) : undefined;
      const modelExpr = dataProp
        ? `(function(){ try { var v = JSON.parse(app.${dataProp}); return Array.isArray(v) ? v : []; } catch(e) { return []; } })()`
        : `[]`;
      const layout = node.direction === "horizontal" ? "Row" : "Column";
      const isBubble =
        node.itemBackgroundColor !== "transparent" ||
        node.itemBorderRadius > 0 ||
        node.itemPadding > 0;
      const delegateLines = isBubble
        ? [
            `${i}            delegate: Rectangle {`,
            `${i}                color: '${escapeStr(node.itemBackgroundColor)}'`,
            `${i}                radius: ${node.itemBorderRadius}`,
            `${i}                width: _bubbleText.implicitWidth + ${node.itemPadding * 2}`,
            `${i}                height: _bubbleText.implicitHeight + ${node.itemPadding * 2}`,
            `${i}                Text {`,
            `${i}                    id: _bubbleText`,
            `${i}                    anchors.centerIn: parent`,
            `${i}                    text: typeof modelData === "string" ? modelData : JSON.stringify(modelData)`,
            `${i}                    font.pixelSize: ${node.itemPixelSize}`,
            `${i}                    color: '${escapeStr(node.itemColor)}'`,
            `${i}                }`,
            `${i}            }`,
          ]
        : [
            `${i}            delegate: Text {`,
            `${i}                text: typeof modelData === "string" ? modelData : JSON.stringify(modelData)`,
            `${i}                font.pixelSize: ${node.itemPixelSize}`,
            `${i}                color: '${escapeStr(node.itemColor)}'`,
            `${i}            }`,
          ];
      const inner: string[] = [
        `${i}    ${layout} {`,
        `${i}        anchors.fill: parent`,
        `${i}        spacing: ${node.gap}`,
        `${i}        Repeater {`,
        `${i}            model: ${modelExpr}`,
        ...delegateLines,
        `${i}        }`,
        `${i}    }`,
      ];
      return [
        `${i}Rectangle {`,
        ...geomLines(node, i),
        ...styleLines(node.style, i),
        ...inner,
        `${i}}`,
      ].join("\n");
    }
  }
};

// Render an action sequence as a single QML/JS statement block. Used for
// both Button.onClick (a single action) and trigger handlers (a list).
const actionBlockJs = (actions: ButtonAction[], ctx: EmitCtx): string => {
  const stmts = actions.map((a) => onClickQml(a, ctx)).filter((s): s is string => !!s);
  if (stmts.length === 0) return "";
  // Each statement gets its own line; semicolons separate them.
  return stmts.map((s) => `${s};`).join(" ");
};

// Block of QML emitted on the app Rectangle that wires up app-load,
// module-event, and onMessageReceived triggers via Component.onCompleted.
// When the app uses any high-level delivery action (sendMessage or
// onMessageReceived), we also auto-emit the createNode + start + per-topic
// subscribe sequence so the user never has to think about lifecycle.
const triggersQml = (
  app: AppState,
  ctx: EmitCtx,
  indent: string,
): string[] => {
  const lines: string[] = [];
  const triggers = app.triggers ?? [];

  const onLoad = triggers.filter((t) => t.kind === "appStart");
  const onEvent = triggers.filter((t) => t.kind === "moduleEvent" && t.moduleId && t.eventName);
  const onMsg = triggers.filter((t) => t.kind === "onMessageReceived");
  const onInterval = triggers.filter((t) => t.kind === "interval" && (t.intervalMs ?? 0) > 0);
  const needsDelivery = usesDelivery(app);
  const topics = subscribedTopics(app);

  if (
    onLoad.length === 0 && onEvent.length === 0 && onMsg.length === 0
    && onInterval.length === 0 && !needsDelivery
  ) {
    return lines;
  }

  lines.push(``);
  lines.push(`${indent}Component.onCompleted: {`);

  // Auto-bootstrap delivery via the shared delivery_relay:
  //   1) startDelivery   → createNode + start (handled inside the relay)
  //   2) subscribeToTopic per content topic
  // Guarded behind `logos.callModule` so the preview iframe (mocked) is fine.
  // Wrapped in try/catch so a missing relay (not yet installed) doesn't kill
  // the rest of Component.onCompleted.
  if (needsDelivery) {
    lines.push(
      `${indent}    if (typeof logos !== "undefined" && logos.callModule) {`,
      `${indent}        try { logos.callModule("${DELIVERY_RELAY_ID}", "startDelivery", []); } catch(e) {}`,
    );
    for (const topic of topics) {
      lines.push(
        `${indent}        try { logos.callModule("${DELIVERY_RELAY_ID}", "subscribeToTopic", ["${escapeStr(topic)}"]); } catch(e) {}`,
      );
    }
    lines.push(`${indent}    }`);
  }

  // App-load triggers — concat all their action blocks.
  for (const t of onLoad) {
    const body = actionBlockJs(t.actions, ctx);
    if (body) lines.push(`${indent}    ${body}`);
  }

  // Raw module event subscriptions (legacy / power-user). Guard against the
  // bridge being absent so the preview iframe doesn't crash. Note: shipped
  // Basecamp does NOT expose onModuleEvent — these triggers are no-ops there
  // and only fire under the preview mock.
  for (const t of onEvent) {
    const body = actionBlockJs(t.actions, ctx);
    lines.push(
      `${indent}    if (typeof logos !== "undefined" && logos.onModuleEvent) {`,
      `${indent}        logos.onModuleEvent("${escapeStr(t.moduleId!)}", "${escapeStr(t.eventName!)}", function(data) {`,
      `${indent}            ${body}`,
      `${indent}        });`,
      `${indent}    }`,
    );
  }

  lines.push(`${indent}}`);

  // ── Delivery polling Timer (always emitted when delivery is in use).
  // Drives:
  //   - app.deliveryStatus (0 off / 1 connecting / 2 connected / 3 error)
  //   - app.recvCount (incremented per inbound message)
  //   - dispatch of each inbound message to onMessageReceived triggers
  //     by content topic, with `topic` and `payload` in scope of each block
  // The status overlay (auto-injected later) reads these properties.
  if (needsDelivery) {
    lines.push(``);
    lines.push(
      `${indent}Timer {`,
      `${indent}    interval: ${DELIVERY_POLL_INTERVAL_MS}`,
      `${indent}    running: true`,
      `${indent}    repeat: true`,
      `${indent}    onTriggered: {`,
      `${indent}        if (typeof logos === "undefined" || !logos.callModule) return;`,
      `${indent}        try { app.deliveryStatus = logos.callModule("${DELIVERY_RELAY_ID}", "deliveryStatus", []) || 0; } catch(e) {}`,
      `${indent}        var raw = "";`,
      `${indent}        try { raw = logos.callModule("${DELIVERY_RELAY_ID}", "takeRecentMessages", []) || ""; } catch(e) { return; }`,
      `${indent}        if (!raw) return;`,
      `${indent}        var msgs = [];`,
      `${indent}        try { msgs = JSON.parse(raw) || []; } catch(e) { return; }`,
      `${indent}        for (var _i = 0; _i < msgs.length; _i++) {`,
      `${indent}            var topic = msgs[_i].topic;`,
      `${indent}            var payload = msgs[_i].payload;`,
      `${indent}            app.recvCount += 1;`,
    );
    for (const t of onMsg) {
      const body = actionBlockJs(t.actions, ctx);
      const filter = (t.topic ?? "").trim();
      if (!body) continue;
      if (filter) {
        lines.push(`${indent}            if (topic === "${escapeStr(filter)}") { ${body} }`);
      } else {
        lines.push(`${indent}            ${body}`);
      }
    }
    lines.push(
      `${indent}        }`,
      `${indent}    }`,
      `${indent}}`,
    );
  }

  // ── Interval triggers — one Timer per trigger.
  // Each fires its action block every intervalMs while the widget is open.
  // The body is wrapped in try/catch so a single bad action doesn't stop
  // the timer; this is the canonical primitive for stopwatches, polling
  // module getters, periodic UI refreshes, etc.
  for (const t of onInterval) {
    const body = actionBlockJs(t.actions, ctx);
    if (!body) continue;
    const ms = Math.max(1, Math.floor(t.intervalMs ?? 1000));
    lines.push(
      ``,
      `${indent}Timer {`,
      `${indent}    interval: ${ms}`,
      `${indent}    running: true`,
      `${indent}    repeat: true`,
      `${indent}    onTriggered: { try { ${body} } catch(_e) { console.log("[lgx] interval trigger error:", _e) } }`,
      `${indent}}`,
    );
  }

  return lines;
};

// Auto-injected debug overlay shown when delivery is in use. Anchored to the
// top-right of the app, semi-transparent, so it never gets in the way of the
// user's layout but is always visible during testing. Shows status dot +
// label + sent/recv counters.
const deliveryStatusOverlayQml = (indent: string): string[] => [
  ``,
  `${indent}// Auto-injected delivery debug overlay (status + send/recv counters).`,
  `${indent}Rectangle {`,
  `${indent}    id: _deliveryStatusOverlay`,
  `${indent}    z: 9999`,
  `${indent}    anchors.top: parent.top`,
  `${indent}    anchors.right: parent.right`,
  `${indent}    anchors.topMargin: 8`,
  `${indent}    anchors.rightMargin: 8`,
  `${indent}    width: _statusRow.implicitWidth + 16`,
  `${indent}    height: 22`,
  `${indent}    radius: 11`,
  `${indent}    color: "#1f2d3d"`,
  `${indent}    opacity: 0.88`,
  `${indent}    Row {`,
  `${indent}        id: _statusRow`,
  `${indent}        anchors.centerIn: parent`,
  `${indent}        spacing: 8`,
  `${indent}        Rectangle {`,
  `${indent}            width: 8; height: 8; radius: 4`,
  `${indent}            anchors.verticalCenter: parent.verticalCenter`,
  `${indent}            color: app.deliveryStatus === 2 ? "#34a853"`,
  `${indent}                 : app.deliveryStatus === 1 ? "#fbbc04"`,
  `${indent}                 : app.deliveryStatus === 3 ? "#ea4335"`,
  `${indent}                 : "#9aa5b1"`,
  `${indent}        }`,
  `${indent}        Text {`,
  `${indent}            anchors.verticalCenter: parent.verticalCenter`,
  `${indent}            text: app.deliveryStatus === 0 ? "Off"`,
  `${indent}                : app.deliveryStatus === 1 ? "Connecting…"`,
  `${indent}                : app.deliveryStatus === 2 ? "Connected"`,
  `${indent}                : "Error"`,
  `${indent}            color: "white"`,
  `${indent}            font.pixelSize: 11`,
  `${indent}        }`,
  `${indent}        Text {`,
  `${indent}            anchors.verticalCenter: parent.verticalCenter`,
  `${indent}            text: "↑" + app.sentCount + "  ↓" + app.recvCount`,
  `${indent}            color: "#cbd5e1"`,
  `${indent}            font.pixelSize: 11`,
  `${indent}        }`,
  `${indent}    }`,
  `${indent}}`,
];

// Preview-only mock of the `logos` bridge. Lets users see live state
// changes inside the Qt-WASM iframe even though there's no real Basecamp
// behind it. The export skips this so the real bridge wins at runtime.
const logosMockQml = (indent: string): string[] => [
  ``,
  `${indent}// ── Preview-only logos bridge mock ───────────────────────────`,
  `${indent}// Resolved by QML scope from descendants as bare \`logos\`. In the`,
  `${indent}// real Basecamp host, this property is shadowed by the context`,
  `${indent}// property of the same name (we don't emit this on export).`,
  `${indent}// Mocks the *relay* surface — sendMessage echoes into a queue that`,
  `${indent}// takeRecentMessages drains, mirroring the real C++ relay so a`,
  `${indent}// single preview can demo pub/sub end-to-end.`,
  `${indent}property var logos: QtObject {`,
  `${indent}    property var _queue: []`,
  `${indent}    property int _status: 0`,
  `${indent}    function callModule(moduleId, method, args) {`,
  `${indent}        if (method === "startDelivery") { _status = 2; return true; }`,
  `${indent}        if (method === "stopDelivery")  { _status = 0; return true; }`,
  `${indent}        if (method === "deliveryStatus") return _status;`,
  `${indent}        if (method === "subscribeToTopic" || method === "unsubscribeFromTopic") return true;`,
  `${indent}        if (method === "sendMessage") {`,
  `${indent}            _queue.push({ topic: args[0], payload: args[1] || "", hash: "sim", timestamp: String(Date.now()) });`,
  `${indent}            return true;`,
  `${indent}        }`,
  `${indent}        if (method === "takeRecentMessages") {`,
  `${indent}            var json = JSON.stringify(_queue);`,
  `${indent}            _queue = [];`,
  `${indent}            return json;`,
  `${indent}        }`,
  `${indent}        return true; // generic catch-all for any other user method`,
  `${indent}    }`,
  `${indent}    function onModuleEvent(moduleId, eventName, callback) {`,
  `${indent}        // Real Basecamp doesn't expose this — kept as a no-op so legacy`,
  `${indent}        // 'on event' triggers don't crash the preview.`,
  `${indent}        return true;`,
  `${indent}    }`,
  `${indent}}`,
];

// Emit a Main.qml ready for either the live preview (no imports — the
// renderer prepends them) or the .lgx export (with imports).
//
// Wraps every page in a Component, picks the initial page via a Loader
// switch, and exposes app.navigate("<navKey>") for Button onClick actions.
export const emitMainQml = (app: AppState, forExport: boolean): string => {
  // Resolve dedup'd QML property names for each variable up-front so both
  // the property declarations and any references resolve to the same name.
  const usedNames = new Set<string>();
  const varQmlByVarId = new Map<string, string>();
  const varTypeByVarId = new Map<string, VariableType>();
  app.variables.forEach((v, idx) => {
    varQmlByVarId.set(v.id, varPropName(v, idx, usedNames));
    varTypeByVarId.set(v.id, v.type);
  });

  // Index the user's own core module methods so callModule actions
  // targeting them (with potentially-non-catalog ids) resolve at emit time.
  const extraMethods: Map<string, Map<string, ModuleMethod>> = new Map();
  if (app.coreModule) {
    const m = new Map<string, ModuleMethod>();
    for (const cm of app.coreModule.methods) {
      m.set(cm.name, { name: cm.name, args: cm.args, returns: cm.returns, description: cm.description });
    }
    extraMethods.set(app.coreModule.id, m);
  }

  const ctx: EmitCtx = {
    pages: app.pages,
    variables: app.variables,
    varQmlByVarId,
    varTypeByVarId,
    extraMethods,
  };
  const initialPage =
    app.pages.find((p) => p.id === app.currentPageId) ?? app.pages[0];

  // App Rectangle dimensions match the initial page's root — every page is
  // expected to share the canvas size (the editor syncs them to the iframe).
  const w = initialPage.root.width;
  const h = initialPage.root.height;

  const lines: string[] = [];
  lines.push(`Rectangle {`);
  lines.push(`    id: app`);
  lines.push(`    width: ${w}`);
  lines.push(`    height: ${h}`);
  lines.push(`    color: "transparent"`);
  lines.push(``);
  lines.push(`    property string currentPage: "${navKey(initialPage.id)}"`);
  lines.push(`    function navigate(key) { app.currentPage = key; }`);
  // Delivery debug state — driven by the polling Timer + sendMessage emit.
  // Always emitted when delivery is in use so the auto-injected status
  // overlay has properties to read.
  if (usesDelivery(app)) {
    lines.push(`    property int deliveryStatus: 0    // 0 off / 1 connecting / 2 connected / 3 error`);
    lines.push(`    property int sentCount: 0`);
    lines.push(`    property int recvCount: 0`);
  }
  // App-level state — emitted as Qt properties so QML bindings + setters work.
  for (const v of app.variables) {
    const prop = varQmlByVarId.get(v.id)!;
    lines.push(`    property ${qmlPropertyType(v.type)} ${prop}: ${qmlInitial(v)}`);
  }
  // Preview only: a mock bridge lets users see triggers + callModule
  // produce live updates inside the iframe.
  if (!forExport) {
    for (const l of logosMockQml(`    `)) lines.push(l);
  }
  // Trigger handlers — Component.onCompleted runs appStart sequences,
  // auto-bootstraps delivery (when used), and registers event listeners.
  for (const l of triggersQml(app, ctx, `    `)) lines.push(l);
  lines.push(``);
  lines.push(`    Loader {`);
  lines.push(`        anchors.fill: parent`);
  lines.push(`        sourceComponent: {`);
  app.pages.forEach((p, idx) => {
    lines.push(`            if (app.currentPage === "${navKey(p.id)}") return ${compId(idx)};`);
  });
  lines.push(`            return ${compId(0)};`);
  lines.push(`        }`);
  lines.push(`    }`);

  app.pages.forEach((p, idx) => {
    lines.push(``);
    lines.push(`    Component {`);
    lines.push(`        id: ${compId(idx)}`);
    // The page root is itself a Frame (Rectangle in QML). Emit it at depth 2
    // so it sits inside the Component at the right indent. Its x/y/w/h match
    // the app's by construction (iframe-resize sync), so it tiles perfectly
    // even though we don't use anchors.fill here.
    lines.push(emitNode(p.root, 2, ctx));
    lines.push(`    }`);
  });

  // Debug overlay — last child so it stacks above the Loader/page content.
  if (usesDelivery(app)) {
    for (const l of deliveryStatusOverlayQml(`    `)) lines.push(l);
  }

  lines.push(`}`);

  const body = lines.join("\n");
  if (!forExport) return body;
  const imports = [
    "import QtQuick 2.15",
    "import QtQuick.Controls 2.15",
    "import QtQuick.Layouts 1.15",
    "",
  ].join("\n");
  return imports + "\n" + body + "\n";
};
