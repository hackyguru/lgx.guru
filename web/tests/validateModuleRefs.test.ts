// Server-side validator that catches the stopwatch failure mode (AI
// invents method names like "start" when the core exposes "startStopwatch")
// inside the apply-patch loop, BEFORE the patch is committed. The AI sees
// the error in the next loop iteration and self-corrects — instead of the
// user discovering a dead button after Basecamp install.

import { describe, expect, it } from "vitest";
import {
  collectCallRefs,
  findUnwiredButtons,
  hasAnyBackend,
  renderUnwiredAdvisory,
  validateModuleRefs,
} from "../src/app/lib/validateModuleRefs";
import {
  mkApp, mkButton, mkFrame, mkPage, mkVar, resetIds,
} from "./fixtures";
import type { ButtonAction, CoreModuleSpec, Trigger } from "../src/app/types";

const stopwatchCore = (): CoreModuleSpec => ({
  id: "stopwatch_core",
  name: "Stopwatch",
  version: "0.1.0",
  description: "",
  category: "custom",
  dependencies: [],
  state: [],
  methods: [
    { name: "startStopwatch", args: [], returns: "void",   description: "" },
    { name: "stopStopwatch",  args: [], returns: "void",   description: "" },
    { name: "resetStopwatch", args: [], returns: "void",   description: "" },
    { name: "elapsedValue",   args: [], returns: "number", description: "" },
  ],
});

describe("collectCallRefs — exhaustive walk", () => {
  it("finds Button.onClick callModule actions", () => {
    resetIds();
    const btn = mkButton({
      onClick: { kind: "callModule", moduleId: "stopwatch_core", method: "startStopwatch", args: [] },
    });
    const app = mkApp({
      pages: [mkPage(mkFrame([btn]))],
      coreModule: stopwatchCore(),
    });
    const refs = collectCallRefs(app);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      kind: "callModule",
      moduleId: "stopwatch_core",
      method: "startStopwatch",
    });
  });

  it("recurses into Frame children and `if` action branches", () => {
    resetIds();
    const inner = mkButton({
      onClick: {
        kind: "if",
        condition: "true",
        actions: [
          { kind: "callModule", moduleId: "stopwatch_core", method: "stopStopwatch", args: [] } as ButtonAction,
        ],
      },
    });
    const outer = mkFrame([inner]);
    const app = mkApp({
      pages: [mkPage(mkFrame([outer]))],
      coreModule: stopwatchCore(),
    });
    const refs = collectCallRefs(app);
    expect(refs).toHaveLength(1);
    expect(refs[0].method).toBe("stopStopwatch");
  });

  it("finds trigger action callModuleToVariable + moduleEvent triggers themselves", () => {
    resetIds();
    const v = mkVar("e", "number", "0");
    const triggers: Trigger[] = [
      { id: "t1", kind: "interval", intervalMs: 100, actions: [
        { kind: "callModuleToVariable", varId: v.id, moduleId: "stopwatch_core", method: "elapsedValue", args: [] } as ButtonAction,
      ]},
      { id: "t2", kind: "moduleEvent", moduleId: "delivery_module", eventName: "messageReceived", actions: [] },
    ];
    const app = mkApp({
      pages: [mkPage(mkFrame([]))],
      variables: [v],
      triggers,
      coreModule: stopwatchCore(),
    });
    const refs = collectCallRefs(app);
    expect(refs).toHaveLength(2);
    expect(refs.find((r) => r.kind === "callModuleToVariable")).toBeTruthy();
    expect(refs.find((r) => r.kind === "moduleEvent" && r.method === "messageReceived")).toBeTruthy();
  });
});

describe("validateModuleRefs — exact-match enforcement", () => {
  it("accepts a fully valid app", () => {
    resetIds();
    const v = mkVar("e", "number", "0");
    const btn = mkButton({
      onClick: { kind: "callModule", moduleId: "stopwatch_core", method: "startStopwatch", args: [] },
    });
    const trigger: Trigger = {
      id: "t1", kind: "interval", intervalMs: 100, actions: [
        { kind: "callModuleToVariable", varId: v.id, moduleId: "stopwatch_core", method: "elapsedValue", args: [] } as ButtonAction,
      ],
    };
    const app = mkApp({
      pages: [mkPage(mkFrame([btn]))],
      variables: [v],
      triggers: [trigger],
      coreModule: stopwatchCore(),
    });
    const r = validateModuleRefs(app);
    expect(r.ok).toBe(true);
  });

  it("rejects a moduleId that doesn't exist (the stopwatch failure: 'stopwatch' instead of 'stopwatch_core')", () => {
    resetIds();
    const btn = mkButton({
      onClick: { kind: "callModule", moduleId: "stopwatch", method: "startStopwatch", args: [] },
    });
    const app = mkApp({
      pages: [mkPage(mkFrame([btn]))],
      coreModule: stopwatchCore(),
    });
    const r = validateModuleRefs(app);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.length).toBe(1);
      expect(r.errors[0]).toMatch(/moduleId "stopwatch" doesn't exist/);
      // Lists the available ids so the AI sees what it should use.
      expect(r.errors[0]).toMatch(/"stopwatch_core"/);
    }
  });

  it("rejects an invented method name with the available-methods list (the literal stopwatch bug)", () => {
    resetIds();
    const btn = mkButton({
      // The exact failure: AI used "start" but the C++ has "startStopwatch".
      onClick: { kind: "callModule", moduleId: "stopwatch_core", method: "start", args: [] },
    });
    const app = mkApp({
      pages: [mkPage(mkFrame([btn]))],
      coreModule: stopwatchCore(),
    });
    const r = validateModuleRefs(app);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]).toMatch(/method "start" not found on module "stopwatch_core"/);
      // The error spells out every real method so the AI can pick the right one.
      expect(r.errors[0]).toMatch(/"startStopwatch"/);
      expect(r.errors[0]).toMatch(/"stopStopwatch"/);
      expect(r.errors[0]).toMatch(/"elapsedValue"/);
    }
  });

  it("flags every bad ref in one validation pass (multiple errors)", () => {
    resetIds();
    const btn1 = mkButton({
      onClick: { kind: "callModule", moduleId: "stopwatch_core", method: "start", args: [] },
    });
    const btn2 = mkButton({
      onClick: { kind: "callModule", moduleId: "stopwatch_core", method: "stop", args: [] },
    });
    const btn3 = mkButton({
      onClick: { kind: "callModule", moduleId: "stopwatch_core", method: "reset", args: [] },
    });
    const app = mkApp({
      pages: [mkPage(mkFrame([btn1, btn2, btn3]))],
      coreModule: stopwatchCore(),
    });
    const r = validateModuleRefs(app);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toHaveLength(3);
    }
  });

  it("only flags NEW refs when prevApp is supplied — pre-existing bugs don't block unrelated edits", () => {
    resetIds();
    // Baseline app with one (broken) ref the user has been living with.
    const oldBtn = mkButton({
      onClick: { kind: "callModule", moduleId: "stopwatch_core", method: "oldBrokenMethod", args: [] },
    });
    const prevApp = mkApp({
      pages: [mkPage(mkFrame([oldBtn]))],
      coreModule: stopwatchCore(),
    });
    // A new patch adds a fresh button targeting a VALID method. The new ref
    // should pass validation even though the old broken ref still exists.
    const newBtn = mkButton({
      onClick: { kind: "callModule", moduleId: "stopwatch_core", method: "elapsedValue", args: [] },
    });
    const newApp = {
      ...prevApp,
      pages: [mkPage(mkFrame([oldBtn, newBtn]))],
    };
    newApp.currentPageId = newApp.pages[0].id;
    const r = validateModuleRefs(newApp, prevApp);
    expect(r.ok).toBe(true);
  });

  it("flags a NEW broken ref even when an old broken one is still present", () => {
    resetIds();
    const oldBtn = mkButton({
      onClick: { kind: "callModule", moduleId: "stopwatch_core", method: "oldBrokenMethod", args: [] },
    });
    const prevApp = mkApp({
      pages: [mkPage(mkFrame([oldBtn]))],
      coreModule: stopwatchCore(),
    });
    const freshlyBrokenBtn = mkButton({
      onClick: { kind: "callModule", moduleId: "stopwatch_core", method: "alsoMissing", args: [] },
    });
    const newApp = {
      ...prevApp,
      pages: [mkPage(mkFrame([oldBtn, freshlyBrokenBtn]))],
    };
    newApp.currentPageId = newApp.pages[0].id;
    const r = validateModuleRefs(newApp, prevApp);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // ONLY the new broken one — not the pre-existing one.
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toMatch(/alsoMissing/);
      expect(r.errors[0]).not.toMatch(/oldBrokenMethod/);
    }
  });

  it("validates moduleEvent triggers — both unknown moduleId and unknown event name", () => {
    resetIds();
    const triggers: Trigger[] = [
      { id: "t1", kind: "moduleEvent", moduleId: "delivery_module", eventName: "notARealEvent", actions: [] },
    ];
    const app = mkApp({
      pages: [mkPage(mkFrame([]))],
      triggers,
    });
    const r = validateModuleRefs(app);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]).toMatch(/event "notARealEvent" not found on module "delivery_module"/);
    }
  });
});

describe("findUnwiredButtons + renderUnwiredAdvisory — flag dead Buttons", () => {
  it("flags Buttons with no onClick at all", () => {
    resetIds();
    const btn = mkButton({ text: "Start" });   // onClick: undefined
    const app = mkApp({
      pages: [mkPage(mkFrame([btn]))],
      coreModule: stopwatchCore(),
    });
    const u = findUnwiredButtons(app);
    expect(u).toHaveLength(1);
    expect(u[0].text).toBe("Start");
  });

  it("flags Buttons whose onClick is { kind: 'none' }", () => {
    resetIds();
    const btn = mkButton({ text: "Stop", onClick: { kind: "none" } });
    const app = mkApp({
      pages: [mkPage(mkFrame([btn]))],
      coreModule: stopwatchCore(),
    });
    expect(findUnwiredButtons(app)).toHaveLength(1);
  });

  it("does NOT flag Buttons that are wired to callModule / setVariable / navigate", () => {
    resetIds();
    const wired = mkButton({
      text: "Start",
      onClick: { kind: "callModule", moduleId: "stopwatch_core", method: "startStopwatch", args: [] },
    });
    const setter = mkButton({
      text: "Inc",
      onClick: { kind: "setVariable", varId: "v_x", value: "1", mode: "literal" } as ButtonAction,
    });
    const navigator = mkButton({
      text: "Go",
      onClick: { kind: "navigate", pageId: "p_x" },
    });
    const app = mkApp({
      pages: [mkPage(mkFrame([wired, setter, navigator]))],
      coreModule: stopwatchCore(),
    });
    expect(findUnwiredButtons(app)).toEqual([]);
  });

  it("recurses into Frame children", () => {
    resetIds();
    const inner = mkButton({ text: "Reset" });
    const outerFrame = mkFrame([inner]);
    const app = mkApp({
      pages: [mkPage(mkFrame([outerFrame]))],
      coreModule: stopwatchCore(),
    });
    const u = findUnwiredButtons(app);
    expect(u).toHaveLength(1);
    expect(u[0].text).toBe("Reset");
  });

  it("renderUnwiredAdvisory: returns null when there are no unwired buttons", () => {
    resetIds();
    const wired = mkButton({
      onClick: { kind: "callModule", moduleId: "stopwatch_core", method: "startStopwatch", args: [] },
    });
    const app = mkApp({
      pages: [mkPage(mkFrame([wired]))],
      coreModule: stopwatchCore(),
    });
    expect(renderUnwiredAdvisory(app)).toBeNull();
  });

  it("renderUnwiredAdvisory: returns null when there's no backend (don't pester users without one)", () => {
    resetIds();
    // Pure-static decorative widget — no coreModule, no enabled primitives.
    const btn = mkButton({ text: "Doesn't matter" });
    const app = mkApp({
      pages: [mkPage(mkFrame([btn]))],
    });
    expect(renderUnwiredAdvisory(app)).toBeNull();
  });

  it("renderUnwiredAdvisory: lists each unwired button with its text + path AND the available methods (the literal stopwatch fix)", () => {
    resetIds();
    const start = mkButton({ text: "Start" });
    const stop  = mkButton({ text: "Stop"  });
    const reset = mkButton({ text: "Reset" });
    const app = mkApp({
      pages: [mkPage(mkFrame([start, stop, reset]))],
      coreModule: stopwatchCore(),
    });
    const adv = renderUnwiredAdvisory(app);
    expect(adv).not.toBeNull();
    expect(adv).toMatch(/3 Buttons have no onClick wired/);
    expect(adv).toContain('"Start"');
    expect(adv).toContain('"Stop"');
    expect(adv).toContain('"Reset"');
    // Must surface the actual backend methods the AI should wire to.
    expect(adv).toContain("startStopwatch");
    expect(adv).toContain("stopStopwatch");
    expect(adv).toContain("resetStopwatch");
    // And spell out the exact action shape the AI needs to emit.
    expect(adv).toMatch(/callModule|callModuleToVariable/);
  });

  it("hasAnyBackend: true when a coreModule exists OR primitives are enabled", () => {
    resetIds();
    expect(hasAnyBackend(mkApp({ pages: [mkPage(mkFrame([]))] }))).toBe(false);
    expect(hasAnyBackend(mkApp({ pages: [mkPage(mkFrame([]))], modules: ["delivery_module"] }))).toBe(true);
    expect(hasAnyBackend(mkApp({ pages: [mkPage(mkFrame([]))], coreModule: stopwatchCore() }))).toBe(true);
  });
});
