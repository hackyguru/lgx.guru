// Round-trips a SaveState through the projects.ts API to isolate whether
// the "drag Text → Save → Projects → come back → empty" bug lives in the
// storage layer. If THIS test passes, the storage round-trip is fine and
// the bug is somewhere in the editor's wiring (closures, race conditions,
// effect ordering).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub a localStorage backed by an in-memory Map. projects.ts also checks
// `typeof window === "undefined"` at the top of every helper, so we have
// to expose `window` too.
const installFakeLocalStorage = () => {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  };
  vi.stubGlobal("window", { localStorage });
  return store;
};

describe("projects.ts round-trip", () => {
  beforeEach(() => {
    installFakeLocalStorage();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    // Re-import on next test so module-level state is fresh.
    vi.resetModules();
  });

  it("createProject + saveProjectState + getProjectState round-trips a Text-bearing app", async () => {
    const projects = await import("../src/app/lib/projects");
    const meta = projects.createProject("My stopwatch");
    expect(meta.id).toMatch(/^p_/);
    expect(projects.listProjects()).toHaveLength(1);

    // Simulated SaveState representing "user dragged a Text".
    const saveState = {
      version: 2,
      pages: [{
        id: "page_1",
        name: "Home",
        root: {
          id: "root_1",
          kind: "Frame",
          x: 0, y: 0, width: 1024, height: 640,
          hidden: false, locked: false,
          style: {
            backgroundColor: "transparent",
            opacity: 1, borderColor: "transparent",
            borderWidth: 0, borderRadius: 0, rotation: 0,
          },
          children: [{
            id: "text_1",
            kind: "Text",
            text: "Hello world",
            x: 100, y: 100, width: 200, height: 30,
            hidden: false, locked: false,
            style: {
              backgroundColor: "transparent",
              opacity: 1, borderColor: "transparent",
              borderWidth: 0, borderRadius: 0, rotation: 0,
            },
            pixelSize: 16, color: "#000",
            fontWeight: "normal", italic: false,
            textAlign: "left", fontFamily: "",
            letterSpacing: 0, lineHeight: 1.2,
          }],
        },
      }],
      currentPageId: "page_1",
      variables: [],
      modules: [],
      triggers: [],
      moduleMeta: {
        name: "my_widget",
        version: "0.1.0",
        description: "A widget",
        category: "example",
        author: "",
      },
      iconBase64: "",
      iconFilename: "icon.png",
      collapsedIds: [],
    };

    projects.saveProjectState(meta.id, saveState);
    const reloaded = projects.getProjectState(meta.id) as typeof saveState;
    expect(reloaded).toEqual(saveState);
    // Specifically: the Text node survives the round-trip.
    expect(reloaded.pages[0].root.children).toHaveLength(1);
    expect(reloaded.pages[0].root.children[0].kind).toBe("Text");
    expect((reloaded.pages[0].root.children[0] as { text: string }).text).toBe("Hello world");
  });

  it("getProjectMeta still resolves after a save (the dashboard path)", async () => {
    const projects = await import("../src/app/lib/projects");
    const meta = projects.createProject("Test project");
    projects.saveProjectState(meta.id, { version: 2, pages: [] });
    const fresh = projects.getProjectMeta(meta.id);
    expect(fresh).not.toBeNull();
    expect(fresh!.id).toBe(meta.id);
    expect(fresh!.name).toBe("Test project");
  });

  it("save → reload sees the same state (the explicit Save button path)", async () => {
    const projects = await import("../src/app/lib/projects");
    const meta = projects.createProject("X");
    const state = { version: 2, pages: [{ id: "p", name: "Home", root: { children: [{ id: "t" }] } }], currentPageId: "p" };
    projects.saveProjectState(meta.id, state);
    // Simulate "navigate away then come back" — same window, same store.
    const reloaded = projects.getProjectState(meta.id);
    expect(reloaded).toEqual(state);
  });

  it("multiple saves overwrite cleanly — last-write-wins, no merge", async () => {
    const projects = await import("../src/app/lib/projects");
    const meta = projects.createProject("X");
    projects.saveProjectState(meta.id, { version: 2, pages: ["a"] });
    projects.saveProjectState(meta.id, { version: 2, pages: ["b"] });
    expect((projects.getProjectState(meta.id) as { pages: string[] }).pages).toEqual(["b"]);
  });
});
