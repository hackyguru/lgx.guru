// Atomic "wire live data into a Text" mutation. Replaces the user's 5-step
// dance (variable → ON LOAD trigger → ON EVENT trigger → action → binding)
// with one dispatch driven from the inspector's Source picker.
//
// Pure function: (AppState, spec) → next AppState. The Page component
// provides a callback that calls this and dispatches the result.

import {
  AppState, ButtonAction, FrameNode, Node, NodeId, Trigger, Variable, VariableType,
} from "../types";

// One of two kinds — the picker collapses methods + events into a single
// "Source" dropdown but the wiring strategy diverges.
export type LiveDataSource =
  | { kind: "method"; methodName: string; returns: VariableType }
  | {
      kind: "event";
      eventName: string;
      fieldIndex: number;
      fieldType: VariableType;
      // Optional companion method to fire on app start (e.g. "fetchLondonTime"
      // for the "londonTimeFetched" event). The picker auto-detects the
      // pairing via name heuristics; user can opt out.
      kickoffMethod?: string;
    };

export interface LiveDataSpec {
  textNodeId: NodeId;
  moduleId: string;
  source: LiveDataSource;
  // Suggested variable name (e.g. "time"). Uniquified against existing names
  // so wiring twice doesn't clobber.
  varNameHint: string;
}

let counter = 0;
const stableId = (): string => `${Date.now().toString(36)}_${(counter++).toString(36)}`;

const uniquify = (name: string, used: Set<string>): string => {
  if (!used.has(name)) return name;
  let i = 2;
  while (used.has(`${name}${i}`)) i++;
  return `${name}${i}`;
};

const initialFor = (t: VariableType): string =>
  t === "number" ? "0" : t === "boolean" ? "false" : "";

// Recursive: walk the tree and set node.binding for the first match.
const setTextBinding = (root: FrameNode, nodeId: NodeId, varId: string): FrameNode => ({
  ...root,
  children: root.children.map((c): Node => {
    if (c.kind === "Frame") return setTextBinding(c, nodeId, varId);
    if (c.id === nodeId && c.kind === "Text") return { ...c, binding: varId };
    return c;
  }),
});

export function wireLiveData(app: AppState, spec: LiveDataSpec): AppState {
  const usedNames = new Set(app.variables.map((v) => v.name));
  const varName = uniquify(spec.varNameHint, usedNames);
  const varType: VariableType =
    spec.source.kind === "method" ? spec.source.returns : spec.source.fieldType;

  const newVar: Variable = {
    id: `v_${stableId()}`,
    name: varName,
    type: varType,
    initial: initialFor(varType),
  };

  const newTriggers: Trigger[] = [];

  if (spec.source.kind === "method") {
    // Synchronous method: fetch on load, capture into the variable.
    newTriggers.push({
      id: `t_${stableId()}`,
      kind: "appStart",
      actions: [{
        kind: "callModuleToVariable",
        varId: newVar.id,
        moduleId: spec.moduleId,
        method: spec.source.methodName,
        args: [],
      } as ButtonAction],
    });
  } else {
    // Async event: catch payload field [fieldIndex] when the event fires.
    newTriggers.push({
      id: `t_${stableId()}`,
      kind: "moduleEvent",
      moduleId: spec.moduleId,
      eventName: spec.source.eventName,
      actions: [{
        kind: "setVariable",
        varId: newVar.id,
        value: `data[${spec.source.fieldIndex}]`,
        mode: "expression",
      } as ButtonAction],
    });
    // Optional kickoff: most async modules need someone to start the first
    // fetch. The picker pre-fills this when it detects a paired method.
    if (spec.source.kickoffMethod) {
      newTriggers.push({
        id: `t_${stableId()}`,
        kind: "appStart",
        actions: [{
          kind: "callModule",
          moduleId: spec.moduleId,
          method: spec.source.kickoffMethod,
          args: [],
        } as ButtonAction],
      });
    }
  }

  const nextPages = app.pages.map((p) => ({
    ...p,
    root: setTextBinding(p.root, spec.textNodeId, newVar.id),
  }));

  return {
    ...app,
    variables: [...app.variables, newVar],
    triggers: [...app.triggers, ...newTriggers],
    pages: nextPages,
  };
}

// Heuristic pairing: an event named `<base>Fetched` typically has a method
// `fetch<Base>` that kicks off the fetch. Matches the AI-builder's prompt
// patterns so most generated modules pair cleanly.
export function suggestKickoffMethod(
  eventName: string,
  methodCandidates: { name: string; argCount: number }[],
): string | undefined {
  const SUFFIXES = ["Fetched", "Received", "Updated", "Loaded", "Changed"];
  const PREFIXES = ["fetch", "refresh", "load", "update", "get"];
  for (const suffix of SUFFIXES) {
    if (!eventName.endsWith(suffix)) continue;
    const base = eventName.slice(0, -suffix.length);
    if (!base) continue;
    const Base = base.charAt(0).toUpperCase() + base.slice(1);
    for (const prefix of PREFIXES) {
      const candidate = prefix + Base;
      const match = methodCandidates.find((m) => m.name === candidate && m.argCount === 0);
      if (match) return match.name;
    }
  }
  return undefined;
}
