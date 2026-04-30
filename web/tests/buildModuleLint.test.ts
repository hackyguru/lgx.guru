// Pre-flight lint catches AI bodies that try to call other modules from
// C++ — that path isn't supported, and we want the rejection to come
// back fast (without spinning up nix) with a message clear enough that
// the AI fixes it on the next retry instead of looping.

import { describe, expect, it } from "vitest";
import { buildCoreModule } from "../src/app/lib/buildModule";
import type { CoreModuleSpec } from "../src/app/types";

const baseSpec = (body: string): CoreModuleSpec => ({
  id: "lint_probe",
  name: "Lint Probe",
  version: "1.0.0",
  description: "lint test",
  category: "test",
  dependencies: [],
  state: [],
  methods: [
    {
      name: "doThing",
      args: [],
      returns: "void",
      description: "thing",
      body,
    },
  ],
});

describe("pre-flight body lint", () => {
  it("rejects bodies that touch m_api", async () => {
    const r = await buildCoreModule(baseSpec(`m_api->callModule("foo", "bar", {});`));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.phase).toBe("compile");
      expect(r.errors.join("\n")).toMatch(/m_api/);
      // Should not have called nix — sub-second.
      expect(r.durationMs).toBeLessThan(500);
    }
  });

  it("rejects bodies that reference LogosAPI", async () => {
    const r = await buildCoreModule(baseSpec(`LogosAPI* api = nullptr; (void)api;`));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toMatch(/LogosAPI/);
  });

  it("rejects bodies that try to ->callModule(", async () => {
    const r = await buildCoreModule(baseSpec(`auto reply = something->callModule("x", "y", {});`));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toMatch(/callModule/);
  });

  it("allows clean self-contained bodies", async () => {
    // We don't want this test to actually invoke nix, but the lint should
    // pass cleanly. We verify by checking the result either succeeds OR
    // fails for a reason OTHER than the lint (i.e. the lint phase passed
    // and the build ran, even if it then errored). That's good enough —
    // we're only proving the lint isn't a false-positive.
    const spec = baseSpec(`std::string s = "hello"; (void)s;`);
    const r = await buildCoreModule(spec);
    if (!r.ok) {
      // If it failed, it must NOT be because of the lint stub.
      expect(r.stderrTail).not.toMatch(/lgx\.guru pre-flight lint/);
    }
  }, 600_000); // generous — could trigger a real nix build
});
