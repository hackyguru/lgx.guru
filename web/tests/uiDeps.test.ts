// Locks in the UI .lgx's metadata.json `dependencies` derivation. Wrong
// deps mean Basecamp silently skips the install at dep-resolution — the
// UI never appears, and the user has no idea why. These tests pin every
// non-obvious case so the export shape doesn't drift.

import { describe, expect, it } from "vitest";
import { computeUiDeps } from "../src/app/lib/uiDeps";
import {
  mkApp, mkButton, mkFrame, mkPage, resetIds,
} from "./fixtures";
import type { ButtonAction, CoreModuleSpec } from "../src/app/types";

const stopwatchCore = (deps: string[] = []): CoreModuleSpec => ({
  id: "stopwatch_core",
  name: "Stopwatch",
  version: "0.1.0",
  description: "",
  category: "custom",
  dependencies: deps,
  state: [],
  methods: [
    { name: "startStopwatch", args: [], returns: "void", description: "" },
  ],
});

describe("computeUiDeps — UI .lgx metadata.json dependencies derivation", () => {
  it("returns the user-toggled primitives in declared order", () => {
    resetIds();
    const app = mkApp({
      modules: ["delivery_module", "polling_module"],
      pages: [mkPage(mkFrame([]))],
    });
    expect(computeUiDeps(app)).toEqual(["delivery_module", "polling_module"]);
  });

  it("auto-adds the user's custom core module id when present", () => {
    resetIds();
    const app = mkApp({
      modules: [],
      pages: [mkPage(mkFrame([]))],
      coreModule: stopwatchCore(),
    });
    expect(computeUiDeps(app)).toEqual(["stopwatch_core"]);
  });

  it("propagates the core's own dependencies transitively", () => {
    resetIds();
    const app = mkApp({
      modules: [],
      pages: [mkPage(mkFrame([]))],
      // The custom core itself depends on delivery_module + storage_module.
      // Both must appear in the UI's deps so Basecamp installs them too.
      coreModule: stopwatchCore(["delivery_module", "storage_module"]),
    });
    expect(computeUiDeps(app)).toEqual([
      "stopwatch_core",
      "delivery_module",
      "storage_module",
    ]);
  });

  it("dedupes when a primitive AND the core both reference the same id", () => {
    resetIds();
    const app = mkApp({
      modules: ["delivery_module"],
      pages: [mkPage(mkFrame([]))],
      coreModule: stopwatchCore(["delivery_module"]),  // duplicate
    });
    const deps = computeUiDeps(app);
    expect(deps.filter((d) => d === "delivery_module")).toHaveLength(1);
    // User-declared primitives come first; core + its transitive deps follow.
    expect(deps).toEqual(["delivery_module", "stopwatch_core"]);
  });

  it("auto-adds delivery_relay when the app uses sendMessage anywhere", () => {
    resetIds();
    const btn = mkButton({
      onClick: { kind: "sendMessage", topic: "/x/1/y/text", payload: "hi", payloadMode: "literal" } as ButtonAction,
    });
    const app = mkApp({
      modules: [],
      pages: [mkPage(mkFrame([btn]))],
    });
    expect(computeUiDeps(app)).toContain("delivery_relay");
  });

  it("never duplicates entries even with overlapping sources", () => {
    resetIds();
    // Stress the dedup logic: primitive includes the core id, the core
    // includes the same id in its own deps, AND a delivery action triggers
    // delivery_relay. None of these should produce duplicates.
    const btn = mkButton({
      onClick: { kind: "sendMessage", topic: "/x/1/y/text", payload: "hi", payloadMode: "literal" } as ButtonAction,
    });
    const app = mkApp({
      modules: ["delivery_relay", "stopwatch_core"],
      pages: [mkPage(mkFrame([btn]))],
      coreModule: stopwatchCore(["stopwatch_core", "delivery_relay"]),
    });
    const deps = computeUiDeps(app);
    expect(new Set(deps).size).toBe(deps.length);  // no duplicates
  });

  it("returns an empty list for a hello-world app with no modules / no core", () => {
    resetIds();
    const app = mkApp({
      modules: [],
      pages: [mkPage(mkFrame([]))],
    });
    expect(computeUiDeps(app)).toEqual([]);
  });

  it("ignores a coreModule with an empty/whitespace id (treats as no core)", () => {
    resetIds();
    const app = mkApp({
      modules: ["delivery_module"],
      pages: [mkPage(mkFrame([]))],
      coreModule: { ...stopwatchCore(), id: "   " },
    });
    expect(computeUiDeps(app)).toEqual(["delivery_module"]);
  });
});
