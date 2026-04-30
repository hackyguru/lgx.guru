// Compute the UI .lgx's metadata.json `dependencies` array. The UI must
// declare every module Basecamp has to install alongside it for the QML's
// `logos.callModule(...)` to resolve at runtime. Missing a dep means
// Basecamp silently skips the UI install on dep-resolution.
//
// Single source of truth — kept here as a pure function so the export
// path and tests share one definition.

import { AppState } from "../types";
import { usesDelivery, DELIVERY_RELAY_ID } from "../qmlEmit";

// Returns the deduped, ordered list of module ids to embed in the UI
// .lgx's metadata.json `dependencies`. Order is intentional:
//   1. user-toggled primitives                (app.modules)
//   2. user's own custom backend module       (app.coreModule.id)
//   3. transitive deps declared by that core  (app.coreModule.dependencies)
//   4. delivery_relay if the app uses sendMessage / onMessageReceived
// Dedup is by first occurrence — keeps the user's intent in (1) ahead of
// transitively-included entries from (3).
export const computeUiDeps = (app: AppState): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (id: string) => {
    const t = id.trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };

  for (const id of app.modules ?? []) add(id);

  const core = app.coreModule;
  const hasCore = !!core && core.id.trim().length > 0;
  if (hasCore) {
    add(core!.id);
    // Transitive: any modules the core itself declares it needs at runtime
    // become UI-level deps too. Today our codegen forces self-contained
    // C++ modules so this list is usually empty, but propagating it now
    // future-proofs us for when inter-module C++ calls work and avoids a
    // class of "core ships but its dep doesn't" install failures.
    for (const id of core!.dependencies ?? []) add(id);
  }

  if (usesDelivery(app)) add(DELIVERY_RELAY_ID);

  return out;
};
