// Server-side validation of every callModule / callModuleToVariable /
// moduleEvent reference in an AppState. Used inside the apply-patch loop
// to reject AI patches that target a non-existent module or method BEFORE
// the patch is committed — so the AI sees the failure in the next loop
// iteration and self-corrects, instead of the user discovering a dead
// button after installing in Basecamp.
//
// The stopwatch incident motivated this: the AI invented method names
// ("start" instead of "startStopwatch") and our QML emitter silently
// dropped the unresolved actions. This validator catches the same class
// of error one step earlier, in the AI loop.

import { AppState, ButtonAction, Node } from "../types";
import { MODULE_CATALOG, findModuleSpec } from "../modules/catalog";

export interface CallRef {
  path: string;          // human-readable AppState location for the error msg
  kind: "callModule" | "callModuleToVariable" | "moduleEvent";
  moduleId: string;
  method: string;        // for moduleEvent this is the eventName
}

// Walk an action list (or a single Button.onClick action) and surface
// every callModule reference, recursing into `if` branches.
const walkActionList = (
  actions: ButtonAction[],
  pathPrefix: string,
  out: CallRef[],
): void => {
  (actions ?? []).forEach((a, i) => {
    const path = `${pathPrefix}[${i}]`;
    if (a.kind === "callModule" || a.kind === "callModuleToVariable") {
      if (a.moduleId && a.method) {
        out.push({ path, kind: a.kind, moduleId: a.moduleId, method: a.method });
      }
    } else if (a.kind === "if") {
      walkActionList(a.actions ?? [], `${path}.actions`, out);
    }
  });
};

const walkSingleAction = (
  action: ButtonAction | undefined,
  pathPrefix: string,
  out: CallRef[],
): void => {
  if (!action) return;
  if (action.kind === "callModule" || action.kind === "callModuleToVariable") {
    if (action.moduleId && action.method) {
      out.push({
        path: pathPrefix, kind: action.kind,
        moduleId: action.moduleId, method: action.method,
      });
    }
  } else if (action.kind === "if") {
    walkActionList(action.actions ?? [], `${pathPrefix}.actions`, out);
  }
};

const walkNode = (n: Node, pathPrefix: string, out: CallRef[]): void => {
  if (n.kind === "Button") {
    walkSingleAction(n.onClick, `${pathPrefix}.onClick`, out);
  } else if (n.kind === "Frame") {
    (n.children ?? []).forEach((c, i) => walkNode(c, `${pathPrefix}.children[${i}]`, out));
  }
};

// Collect every module-call reference in an AppState — Button.onClick
// (recursive), trigger actions, and moduleEvent triggers themselves.
export const collectCallRefs = (app: AppState): CallRef[] => {
  const out: CallRef[] = [];
  // Pages → root → children → buttons (recursively).
  (app.pages ?? []).forEach((p, pi) => {
    (p.root?.children ?? []).forEach((c, ci) => {
      walkNode(c, `pages[${pi}].children[${ci}]`, out);
    });
  });
  // Triggers — the trigger itself (for moduleEvent) plus its action list.
  (app.triggers ?? []).forEach((t, ti) => {
    if (t.kind === "moduleEvent" && t.moduleId && t.eventName) {
      out.push({
        path: `triggers[${ti}]`,
        kind: "moduleEvent",
        moduleId: t.moduleId,
        method: t.eventName,
      });
    }
    walkActionList(t.actions ?? [], `triggers[${ti}].actions`, out);
  });
  return out;
};

// Resolve a module id to a ModuleSpec by checking the primitives catalog
// first, then the user's own coreModule. Returns the methods + events
// available on that module, or null if the id is unknown.
const resolveModule = (id: string, coreModule: AppState["coreModule"]) => {
  const fromCatalog = findModuleSpec(id);
  if (fromCatalog) {
    return {
      id,
      methods: fromCatalog.methods.map((m) => m.name),
      events: (fromCatalog.events ?? []).map((e) => e.name),
    };
  }
  if (coreModule && coreModule.id === id) {
    return {
      id,
      methods: (coreModule.methods ?? []).map((m) => m.name),
      events: (coreModule.events ?? []).map((e) => e.name),
    };
  }
  return null;
};

// Render a list of every known module id — used in error messages so the
// AI can see what it should have referenced instead.
const knownModuleIds = (coreModule: AppState["coreModule"]): string[] => {
  const ids = MODULE_CATALOG.map((m) => m.id);
  if (coreModule?.id) ids.push(coreModule.id);
  return ids;
};

export interface ValidationFailure {
  ok: false;
  errors: string[];
}
export interface ValidationSuccess { ok: true }
export type ValidationResult = ValidationSuccess | ValidationFailure;

// Validate every module-call reference. If `prevApp` is supplied, only
// flag refs that are NEW in `app` (introduced by the current patch) —
// pre-existing broken refs from earlier conversation turns shouldn't
// block an unrelated edit.
export const validateModuleRefs = (
  app: AppState,
  prevApp?: AppState,
): ValidationResult => {
  const refs = collectCallRefs(app);
  const prevRefs = prevApp ? collectCallRefs(prevApp) : [];
  // A ref is "new" if its (path, kind, moduleId, method) tuple wasn't in
  // the pre-patch app. Path-keyed comparison lets us detect "AI rewrote
  // this onClick to a different module" too.
  const seenKey = (r: CallRef) => `${r.path}|${r.kind}|${r.moduleId}|${r.method}`;
  const prevKeys = new Set(prevRefs.map(seenKey));
  const newRefs = refs.filter((r) => !prevKeys.has(seenKey(r)));

  const errors: string[] = [];
  for (const ref of newRefs) {
    const mod = resolveModule(ref.moduleId, app.coreModule);
    if (!mod) {
      errors.push(
        `At ${ref.path}: moduleId "${ref.moduleId}" doesn't exist. ` +
        `Available module ids: ${knownModuleIds(app.coreModule).map((s) => `"${s}"`).join(", ")}.`
      );
      continue;
    }
    if (ref.kind === "moduleEvent") {
      if (!mod.events.includes(ref.method)) {
        errors.push(
          `At ${ref.path}: event "${ref.method}" not found on module "${ref.moduleId}". ` +
          `Available events: ${mod.events.length > 0 ? mod.events.map((s) => `"${s}"`).join(", ") : "(this module has no events)"}.`
        );
      }
    } else {
      if (!mod.methods.includes(ref.method)) {
        errors.push(
          `At ${ref.path}: method "${ref.method}" not found on module "${ref.moduleId}". ` +
          `Available methods: ${mod.methods.map((s) => `"${s}"`).join(", ")}.`
        );
      }
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
};

// ── Unwired-button advisory ─────────────────────────────────────────────────
//
// A Button with no onClick (or onClick.kind === "none") is dead on the page
// — clicking it does nothing. That's almost always a wiring bug when the
// project has a backend module. The stopwatch incident hit this exactly:
// AI emitted Start/Stop/Reset as bare Buttons with no handlers because the
// callModule lookups silently dropped (now caught by validateModuleRefs).
// This advisory walks the page tree post-patch and surfaces unwired
// buttons so the AI loop is prompted to wire them in the next iteration.

export interface UnwiredButton {
  path: string;     // e.g. "pages[0].children[3]"
  text: string;     // the button's display text — anchors the AI's mental model
}

const walkForUnwiredButtons = (
  children: Node[],
  pathPrefix: string,
  out: UnwiredButton[],
): void => {
  children.forEach((c, i) => {
    const path = `${pathPrefix}[${i}]`;
    if (c.kind === "Button") {
      const ac = c.onClick;
      if (!ac || ac.kind === "none") out.push({ path, text: c.text });
    } else if (c.kind === "Frame") {
      walkForUnwiredButtons(c.children, `${path}.children`, out);
    }
  });
};

export const findUnwiredButtons = (app: AppState): UnwiredButton[] => {
  const out: UnwiredButton[] = [];
  (app.pages ?? []).forEach((page, pi) => {
    walkForUnwiredButtons(page.root?.children ?? [], `pages[${pi}].children`, out);
  });
  return out;
};

// True when the project has any backend the user might want to wire to —
// either a custom core module OR any toggled primitive module.
export const hasAnyBackend = (app: AppState): boolean =>
  !!app.coreModule || (app.modules?.length ?? 0) > 0;

// Render a one-shot advisory string for the apply-patch / build-backend
// tool results. Returns null when there's nothing to advise. The format
// is tuned so the AI can act on it directly: it lists the unwired buttons
// by text + path AND the available methods on the backend module(s) so
// the AI doesn't have to hunt for what to wire to.
export const renderUnwiredAdvisory = (app: AppState): string | null => {
  const unwired = findUnwiredButtons(app);
  if (unwired.length === 0 || !hasAnyBackend(app)) return null;

  const lines: string[] = [];
  lines.push(
    `${unwired.length} Button${unwired.length === 1 ? " has" : "s have"} no onClick wired:`,
  );
  for (const u of unwired) {
    lines.push(`  - "${u.text}" at ${u.path}`);
  }
  if (app.coreModule) {
    lines.push(
      `Custom backend "${app.coreModule.id}" exposes: ${(app.coreModule.methods ?? []).map((m) => `${m.name}(${(m.args ?? []).map((a) => a.type).join(", ")}) -> ${m.returns}`).join(", ") || "(no methods declared)"}.`,
    );
  }
  if (app.modules && app.modules.length > 0) {
    lines.push(`Enabled primitive modules: ${app.modules.map((m) => `"${m}"`).join(", ")}.`);
  }
  lines.push(
    `Wire each Button to either a callModule / callModuleToVariable action ` +
    `(targeting the right method on the right module), or set its onClick to ` +
    `{ kind: "none" } ONLY if it is intentionally decorative. Do NOT ship buttons ` +
    `that look interactive but do nothing — that's how the stopwatch widget ` +
    `looked broken.`
  );
  return lines.join("\n");
};
