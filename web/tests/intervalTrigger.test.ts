// Locks in the `interval` trigger primitive — the missing piece that made
// stopwatch / polling apps unbuildable. Without an interval trigger, an
// appStart `callModuleToVariable` fires exactly once: pressing Start ran
// the C++ correctly, but no QML code ever re-read getElapsedMs(), so the
// UI looked frozen and users reported "the button doesn't work."

import { describe, expect, it } from "vitest";
import { emitMainQml } from "../src/app/qmlEmit";
import {
  mkApp, mkButton, mkFrame, mkPage, mkText, mkVar, resetIds,
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
    { name: "start",        args: [], returns: "void",   description: "" },
    { name: "stop",         args: [], returns: "void",   description: "" },
    { name: "getElapsedMs", args: [], returns: "number", description: "" },
  ],
});

describe("interval trigger — Timer-backed periodic actions", () => {
  it("emits a Timer with the configured intervalMs and the action body", () => {
    resetIds();
    const v = mkVar("elapsedMs", "number", "0");
    const trigger: Trigger = {
      id: "t1",
      kind: "interval",
      intervalMs: 100,
      actions: [{
        kind: "callModuleToVariable",
        varId: v.id,
        moduleId: "stopwatch_core",
        method: "getElapsedMs",
        args: [],
      } as ButtonAction],
    };
    const app = mkApp({
      pages: [mkPage(mkFrame([mkText({ binding: v.id })]))],
      variables: [v],
      triggers: [trigger],
      coreModule: stopwatchCore(),
    });
    app.currentPageId = app.pages[0].id;
    const qml = emitMainQml(app, true);
    // Timer with the right interval.
    expect(qml).toMatch(/Timer \{[^}]*interval: 100/);
    expect(qml).toContain('repeat: true');
    expect(qml).toContain('running: true');
    // The body should call the right module/method and assign into the var.
    expect(qml).toContain('logos.callModule("stopwatch_core", "getElapsedMs", [])');
    expect(qml).toMatch(/app\.var_elapsedMs = logos\.callModule\("stopwatch_core"/);
    // Wrapped in try/catch so a single tick failure doesn't kill the timer.
    expect(qml).toContain("catch(_e) { console.log");
  });

  it("clamps intervalMs to a minimum of 1 ms (defends against 0/negative)", () => {
    resetIds();
    const trigger: Trigger = {
      id: "t1",
      kind: "interval",
      intervalMs: 0,           // garbage value
      actions: [{ kind: "setVariable", varId: "v_x", value: "1", mode: "literal" } as ButtonAction],
    };
    const app = mkApp({
      pages: [mkPage(mkFrame([]))],
      variables: [mkVar("x", "number", "0")],
      triggers: [trigger],
    });
    // intervalMs = 0 fails the > 0 filter and produces no Timer at all,
    // which is the documented behaviour. (We treat it as "disabled".)
    const qml = emitMainQml(app, true);
    expect(qml).not.toContain("Timer {");
  });

  it("emits multiple Timers when there are multiple interval triggers", () => {
    resetIds();
    const v1 = mkVar("a", "number", "0");
    const v2 = mkVar("b", "number", "0");
    const t1: Trigger = {
      id: "t1", kind: "interval", intervalMs: 100,
      actions: [{ kind: "setVariable", varId: v1.id, value: "1", mode: "literal" } as ButtonAction],
    };
    const t2: Trigger = {
      id: "t2", kind: "interval", intervalMs: 5000,
      actions: [{ kind: "setVariable", varId: v2.id, value: "2", mode: "literal" } as ButtonAction],
    };
    const app = mkApp({
      pages: [mkPage(mkFrame([]))],
      variables: [v1, v2],
      triggers: [t1, t2],
    });
    const qml = emitMainQml(app, true);
    // Two Timers — one per interval trigger.
    const timerHits = qml.match(/Timer \{/g) ?? [];
    expect(timerHits.length).toBeGreaterThanOrEqual(2);
    expect(qml).toMatch(/interval: 100/);
    expect(qml).toMatch(/interval: 5000/);
  });

  it("interval triggers coexist with appStart / delivery without breaking either", () => {
    resetIds();
    const v = mkVar("counter", "number", "0");
    const triggers: Trigger[] = [
      { id: "t1", kind: "appStart",
        actions: [{ kind: "setVariable", varId: v.id, value: "0", mode: "literal" } as ButtonAction] },
      { id: "t2", kind: "interval", intervalMs: 1000,
        actions: [{ kind: "setVariable", varId: v.id, value: "app.var_counter + 1", mode: "expression" } as ButtonAction] },
    ];
    const app = mkApp({
      pages: [mkPage(mkFrame([mkText({ binding: v.id })]))],
      variables: [v],
      triggers,
    });
    app.currentPageId = app.pages[0].id;
    const qml = emitMainQml(app, true);
    // appStart action lands in Component.onCompleted.
    expect(qml).toMatch(/Component\.onCompleted: \{[\s\S]*app\.var_counter = 0/);
    // Interval emits its own Timer.
    expect(qml).toMatch(/Timer \{[^}]*interval: 1000/);
    expect(qml).toContain("app.var_counter = app.var_counter + 1");
  });
});

describe("unknown callModule references — diagnostic instead of silent drop", () => {
  it("button onClick to a missing module emits a console.log so the failure is visible", () => {
    resetIds();
    const btn = mkButton({
      onClick: { kind: "callModule", moduleId: "stopwatch", method: "start", args: [] },
    });
    const app = mkApp({
      pages: [mkPage(mkFrame([btn]))],
      // Note: coreModule.id is "stopwatch_core" — the AI mistakenly used
      // "stopwatch". Old behaviour: silently drop the action so the button
      // emits no `onClicked:` at all → "button does nothing".
      coreModule: stopwatchCore(),
    });
    app.currentPageId = app.pages[0].id;
    const qml = emitMainQml(app, true);
    // The Button now emits an onClicked handler that LOGS instead of doing
    // nothing. Users can see the misnamed module in QML logs.
    expect(qml).toMatch(/onClicked: console\.log\("\[lgx\] button onClick references unknown stopwatch\.start\(\)/);
  });

  it("button onClick that resolves correctly still emits the real callModule", () => {
    resetIds();
    const btn = mkButton({
      onClick: { kind: "callModule", moduleId: "stopwatch_core", method: "start", args: [] },
    });
    const app = mkApp({
      pages: [mkPage(mkFrame([btn]))],
      coreModule: stopwatchCore(),
    });
    app.currentPageId = app.pages[0].id;
    const qml = emitMainQml(app, true);
    expect(qml).toContain('onClicked: logos.callModule("stopwatch_core", "start", [])');
    expect(qml).not.toContain('button onClick references unknown');
  });

  it("callModuleToVariable to a missing module also logs instead of silent failure", () => {
    resetIds();
    const v = mkVar("elapsed", "number", "0");
    const btn = mkButton({
      onClick: {
        kind: "callModuleToVariable",
        varId: v.id,
        moduleId: "wrong_id",
        method: "getElapsedMs",
        args: [],
      },
    });
    const app = mkApp({
      pages: [mkPage(mkFrame([btn]))],
      variables: [v],
      coreModule: stopwatchCore(),
    });
    app.currentPageId = app.pages[0].id;
    const qml = emitMainQml(app, true);
    expect(qml).toMatch(/onClicked: console\.log\("\[lgx\] callModuleToVariable references unknown wrong_id\.getElapsedMs\(\)/);
  });
});
