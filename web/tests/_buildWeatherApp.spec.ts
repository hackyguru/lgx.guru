// One-off harness (run via vitest) that builds a weather-widget UI .lgx
// using the same codegen the editor uses, so we can install it into
// Basecamp without going through the browser. NOT a regression test —
// just a scriptable thin wrapper around emitMainQml + exportLgx.
//
// Run: npx vitest run tests/_buildWeatherApp.spec.ts
// Output: writes /tmp/london_weather_ui.lgx to disk.

import { describe, it, expect } from "vitest";
import { writeFile } from "node:fs/promises";
import { emitMainQml } from "../src/app/qmlEmit";
import { exportLgx, placeholderIcon } from "../src/app/lgxExport";
import {
  AppState, ButtonAction, CoreModuleSpec, FrameNode, PageData, TextNode, Trigger, Variable,
  defaultStyle,
} from "../src/app/types";

const out = "/tmp/london_weather_ui.lgx";

const id = (prefix: string, n: number) => `${prefix}_${n.toString(36)}`;

const home = (): PageData => {
  const root: FrameNode = {
    id: id("f", 1),
    kind: "Frame",
    x: 0, y: 0, width: 800, height: 600,
    hidden: false, locked: false,
    style: defaultStyle(),
    children: [],
  };
  const tempLabel: TextNode = {
    id: id("n", 1),
    kind: "Text",
    x: 240, y: 250, width: 320, height: 100,
    hidden: false, locked: false,
    style: defaultStyle(),
    text: "Loading…",
    pixelSize: 64,
    color: "#1f2d3d",
    fontWeight: "bold",
    italic: false,
    textAlign: "center",
    fontFamily: "",
    letterSpacing: 0,
    lineHeight: 1.0,
    binding: id("v", 1),
  };
  const subLabel: TextNode = {
    id: id("n", 2),
    kind: "Text",
    x: 240, y: 360, width: 320, height: 30,
    hidden: false, locked: false,
    style: defaultStyle(),
    text: "London, UK",
    pixelSize: 16,
    color: "#5a6770",
    fontWeight: "normal",
    italic: false,
    textAlign: "center",
    fontFamily: "",
    letterSpacing: 0,
    lineHeight: 1.0,
  };
  root.children.push(tempLabel, subLabel);
  return { id: id("p", 1), name: "Home", root };
};

const tempVar: Variable = {
  id: id("v", 1),
  name: "temperature",
  type: "string",
  initial: "Loading…",
};

// Mirror of the AI-built spec, sufficient for the editor's QML emitter to
// resolve `callModule(london_weather, refreshWeather)` actions.
const londonWeatherSpec: CoreModuleSpec = {
  id: "london_weather",
  name: "London Weather",
  version: "0.1.0",
  description: "Fetches the current London temperature from Open-Meteo.",
  category: "custom",
  dependencies: [],
  state: [],
  methods: [
    {
      name: "refreshWeather",
      args: [],
      returns: "boolean",
      description: "Trigger a fresh weather fetch.",
    },
  ],
  events: [
    {
      name: "weatherUpdated",
      data: [{ name: "tempText", type: "string" }],
      description: "Fires when a fresh temperature reading arrives.",
    },
  ],
};

const triggers: Trigger[] = [
  {
    id: id("t", 1),
    kind: "moduleEvent",
    moduleId: "london_weather",
    eventName: "weatherUpdated",
    actions: [{
      kind: "setVariable",
      varId: tempVar.id,
      value: "data[0]",
      mode: "expression",
    } as ButtonAction],
  },
  {
    id: id("t", 2),
    kind: "appStart",
    actions: [{
      kind: "callModule",
      moduleId: "london_weather",
      method: "refreshWeather",
      args: [],
    } as ButtonAction],
  },
];

const app: AppState = {
  pages: [home()],
  currentPageId: id("p", 1),
  variables: [tempVar],
  modules: [],
  triggers,
  coreModule: londonWeatherSpec,
};

describe("build weather UI .lgx", () => {
  it("writes the UI plugin to /tmp/london_weather_ui.lgx", async () => {
    const qmlSource = emitMainQml(app, true);
    expect(qmlSource).toContain("Loading…");

    const result = await exportLgx({
      name: "london_weather_ui",
      version: "0.1.0",
      description: "Displays the current London temperature, fetched by london_weather.",
      category: "example",
      author: "lgx.guru",
      iconPng: placeholderIcon(),
      iconFilename: "icon.png",
      qmlSource,
      dependencies: ["london_weather"],
    });

    const buf = Buffer.from(await result.blob.arrayBuffer());
    await writeFile(out, buf);
    expect(buf.length).toBeGreaterThan(500);
    // eslint-disable-next-line no-console
    console.log(`wrote ${out} (${buf.length} bytes)`);
  });
});
