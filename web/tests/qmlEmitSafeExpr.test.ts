// Defends the AI-patch failure mode where a malformed expression (typically
// unbalanced parens) gets spliced into Main.qml and breaks the entire QML
// parse — preview shows "Expected token ')'" and Basecamp silently refuses
// to open the installed UI module. The emitter must validate every
// expression splice site at codegen time and substitute a safe fallback so
// one bad action can't poison the whole widget.

import { describe, expect, it } from "vitest";
import { emitMainQml } from "../src/app/qmlEmit";
import {
  mkApp, mkButton, mkFrame, mkPage, mkText, mkVar, resetIds,
} from "./fixtures";
import type { ButtonAction, Trigger } from "../src/app/types";


describe("safeExpr defence — malformed AI-spliced expressions", () => {
  it("setVariable expression mode with unbalanced parens falls back to a console.log + safe default", () => {
    resetIds();
    const v = mkVar("price", "string", "");
    // Classic AI failure: forgot the closing `)` on JSON.parse(...).
    const bad: ButtonAction = {
      kind: "setVariable",
      varId: v.id,
      value: 'JSON.parse(logos.callModule("crypto_prices", "getPrices", []).btc',
      mode: "expression",
    };
    const trigger: Trigger = { id: "t1", kind: "appStart", actions: [bad] };
    const app = mkApp({
      pages: [mkPage(mkFrame([mkText({ binding: v.id })]))],
      variables: [v],
      triggers: [trigger],
    });
    app.currentPageId = app.pages[0].id;
    const qml = emitMainQml(app, true);
    // The malformed string must NOT appear unguarded — it should be inside
    // the dropped-expression console.log, not in an assignment RHS.
    expect(qml).toContain('dropped malformed expression');
    // And the safe fallback should be assigned into the variable.
    expect(qml).toMatch(/app\.var_price = \(function\(\)\{ console\.log/);
  });

  it("if condition with broken expression falls back to false (skips the branch)", () => {
    resetIds();
    const v = mkVar("count", "number", "0");
    const bad: ButtonAction = {
      kind: "if",
      condition: "((app.var_count > 0",  // missing two `)`
      actions: [{ kind: "setVariable", varId: v.id, value: "0", mode: "literal" } as ButtonAction],
    };
    const trigger: Trigger = { id: "t1", kind: "appStart", actions: [bad] };
    const app = mkApp({
      pages: [mkPage(mkFrame([]))],
      variables: [v],
      triggers: [trigger],
    });
    app.currentPageId = app.pages[0].id;
    const qml = emitMainQml(app, true);
    expect(qml).toContain('dropped malformed expression');
    // The condition position falls back to `false`, so the wrapped IIFE
    // returns false and the body never executes.
    expect(qml).toContain('return false;');
    expect(qml).toContain('"((app.var_count > 0"');
  });

  it("visibleWhen with bad expression falls back to true (visible) instead of breaking the parent Rectangle", () => {
    resetIds();
    const t = mkText({ visibleWhen: "app.var_x ===" }); // dangling rhs
    const app = mkApp({
      pages: [mkPage(mkFrame([t]))],
    });
    app.currentPageId = app.pages[0].id;
    const qml = emitMainQml(app, true);
    expect(qml).toContain('dropped malformed expression');
    // visibleWhen falls back to `true` so the node stays visible rather
    // than disappearing on a broken expression.
    expect(qml).toMatch(/visible: \(function\(\)\{.*return true;/);
  });

  it("a clean expression passes through untouched (no false positives)", () => {
    resetIds();
    const v = mkVar("count", "number", "0");
    const bad: ButtonAction = {
      kind: "setVariable",
      varId: v.id,
      value: "app.var_count + 1",
      mode: "expression",
    };
    const trigger: Trigger = { id: "t1", kind: "appStart", actions: [bad] };
    const app = mkApp({
      pages: [mkPage(mkFrame([]))],
      variables: [v],
      triggers: [trigger],
    });
    app.currentPageId = app.pages[0].id;
    const qml = emitMainQml(app, true);
    expect(qml).not.toContain('dropped malformed expression');
    expect(qml).toContain("app.var_count = app.var_count + 1");
  });

  it("emitted Main.qml stays parseable even with several malformed expressions in one app", () => {
    resetIds();
    const v1 = mkVar("a", "string", "");
    const v2 = mkVar("b", "string", "");
    const triggers: Trigger[] = [
      { id: "t1", kind: "appStart", actions: [
        { kind: "setVariable", varId: v1.id, value: "JSON.parse(", mode: "expression" } as ButtonAction,
        { kind: "if", condition: "(((app.var_a", actions: [
          { kind: "setVariable", varId: v2.id, value: "logos.callModule(", mode: "expression" } as ButtonAction,
        ] } as ButtonAction,
      ] },
    ];
    const app = mkApp({
      pages: [mkPage(mkFrame([mkButton({ onClick: {
        kind: "setVariable", varId: v1.id, value: "((", mode: "expression",
      } as ButtonAction })]))],
      variables: [v1, v2],
      triggers,
    });
    app.currentPageId = app.pages[0].id;
    const qml = emitMainQml(app, true);
    // Every malformed splice should have been caught — one log per call site.
    const droppedHits = qml.match(/dropped malformed expression/g) ?? [];
    expect(droppedHits.length).toBeGreaterThanOrEqual(3);
    // The raw fragment must never appear unguarded — only as a string
    // literal inside the safety IIFE's console.log argument. We check this
    // via the proxy that nothing outside a JSON.stringify'd literal contains
    // the bare substrings — they should always be `"((` or `"JSON.parse(`
    // (i.e. quoted) when present.
    expect(qml).not.toMatch(/= JSON\.parse\($/m);
    expect(qml).not.toMatch(/= \(\($/m);
    expect(qml).not.toMatch(/^\s*= logos\.callModule\($/m);
  });
});
