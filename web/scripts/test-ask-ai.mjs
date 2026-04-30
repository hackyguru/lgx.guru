#!/usr/bin/env node
// Test harness for the Ask AI flow. Hits POST /api/apply-patch on the
// running dev server with synthetic AppState fixtures and prints the
// response so we can validate end-to-end flows without clicking through
// the browser.
//
// Usage:
//   node scripts/test-ask-ai.mjs                  # run the standard suite
//   node scripts/test-ask-ai.mjs --with-build     # also run the multi-step build test (slow + expensive)
//   node scripts/test-ask-ai.mjs "your prompt"    # ad-hoc: send your own prompt against the hello-world fixture
//   node scripts/test-ask-ai.mjs --app path.json "prompt"  # use a custom AppState (e.g. exported via Save)
//   node scripts/test-ask-ai.mjs --help
//
// Env:
//   LGX_ENDPOINT  Override the API URL (default http://localhost:3000/api/apply-patch)
//
// Cost: each non-build test uses a few thousand tokens. Build tests are
// minutes of nix work + ~10K tokens. Uses whichever LLM key is in
// web/.env.local — see /api/apply-patch for provider precedence.

import { readFile } from "node:fs/promises";

const ENDPOINT = process.env.LGX_ENDPOINT || "http://localhost:3000/api/apply-patch";
const TIMEOUT_MS = 15 * 60 * 1000;   // generous — first-time builds are slow

let _seq = 0;
const id = (prefix) => `${prefix}_${(++_seq).toString(36)}_${Date.now().toString(36).slice(-4)}`;

const defaultStyle = () => ({
  backgroundColor: "transparent",
  opacity: 1,
  borderColor: "transparent",
  borderWidth: 0,
  borderRadius: 0,
  rotation: 0,
});

const newRoot = () => ({
  id: id("f"),
  kind: "Frame",
  x: 0, y: 0, width: 800, height: 600,
  hidden: false, locked: false,
  style: defaultStyle(),
  children: [],
});

const newPage = (name = "Home") => ({ id: id("p"), name, root: newRoot() });

const newApp = () => {
  const home = newPage();
  return {
    pages: [home],
    currentPageId: home.id,
    variables: [],
    modules: [],
    triggers: [],
  };
};

// Fixture: a fresh app with a single "Hello World" Text node centered-ish.
// Most tests use this — it gives the AI something to target by id.
function helloApp() {
  const app = newApp();
  app.pages[0].root.children.push({
    id: id("n"),
    kind: "Text",
    x: 100, y: 100, width: 200, height: 30,
    hidden: false, locked: false,
    style: defaultStyle(),
    text: "Hello World",
    pixelSize: 16,
    color: "#1f2d3d",
    fontWeight: "normal",
    italic: false,
    textAlign: "left",
    fontFamily: "",
    letterSpacing: 0,
    lineHeight: 1.2,
  });
  return app;
}

// Fixture: helloApp + a fake London Time Fetcher coreModule already attached.
// Used to test the "wire to existing module event" path without spending
// minutes on an actual nix build.
function appWithTimeFetcher() {
  const app = helloApp();
  app.coreModule = {
    id: "london_time_fetcher",
    name: "London Time Fetcher",
    version: "0.1.0",
    description: "Fetches the current London time over HTTP and announces it.",
    category: "custom",
    dependencies: [],
    methods: [
      {
        name: "fetchLondonTime", args: [], returns: "boolean",
        description: "Fires off the fetch. Listen for londonTimeFetched for the result.",
        body: "/* stub */ return true;",
      },
      {
        name: "lastLondonTime", args: [], returns: "string",
        description: "Returns the most recent fetched London time, or empty string.",
        body: "return m_last;",
      },
    ],
    state: [{ name: "last", cppType: "QString", initial: "" }],
    events: [
      {
        name: "londonTimeFetched",
        data: [
          { name: "timeText", type: "string" },
          { name: "isoDateTime", type: "string" },
        ],
        description: "Fires when the current London time has been fetched successfully.",
      },
    ],
  };
  return app;
}

async function ask(app, prompt) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, app }),
      signal: ctrl.signal,
    });
    const elapsed = Date.now() - start;
    let data;
    try {
      data = await res.json();
    } catch {
      data = { error: `non-JSON response (status ${res.status})` };
    }
    return { status: res.status, data, elapsed };
  } catch (err) {
    return { status: 0, data: { error: String(err) }, elapsed: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

const fmt = (v) => {
  const s = JSON.stringify(v);
  return s.length > 120 ? s.slice(0, 120) + "…" : s;
};

function printOps(ops = []) {
  if (ops.length === 0) {
    console.log("    (no operations)");
    return;
  }
  for (const o of ops) {
    const valueStr = o.op === "remove" ? "" : ` = ${fmt(o.value)}`;
    console.log(`    ${o.op.padEnd(8)} ${o.path}${valueStr}`);
  }
}

async function runCase(test) {
  console.log(`\n━━━ ${test.name} ━━━`);
  console.log(`prompt: ${test.prompt}`);
  const { status, data, elapsed } = await ask(test.app(), test.prompt);
  const elapsedStr = `${(elapsed / 1000).toFixed(1)}s`;

  if (status !== 200 || !data?.ok) {
    console.log(`✗ FAILED (HTTP ${status}, ${elapsedStr}): ${data?.error ?? "no error"}`);
    if (Array.isArray(data?.errors)) {
      console.log("  compile errors:");
      for (const e of data.errors) console.log(`    ${e}`);
    }
    if (Array.isArray(data?.operations) && data.operations.length > 0) {
      console.log("  AI tried these ops:");
      printOps(data.operations);
    }
    return { name: test.name, ok: false };
  }

  console.log(
    `✓ ${data.kind}, ${elapsedStr}, ${data.providerName}` +
    (data.attempts ? `, ${data.attempts} build attempt${data.attempts === 1 ? "" : "s"}` : "")
  );
  console.log(`  summary: ${data.summary}`);
  console.log("  operations:");
  printOps(data.operations);
  if (data.spec) {
    const ev = (data.spec.events ?? []).length;
    console.log(`  built spec: ${data.spec.id} — ${data.spec.methods?.length ?? 0} method(s), ${ev} event(s)`);
  }
  return { name: test.name, ok: true };
}

const SUITE = [
  {
    name: "Pure UI: page background → yellow",
    app: helloApp,
    prompt: "Make the page background yellow.",
  },
  {
    name: "Pure UI: center the Hello label horizontally",
    app: helloApp,
    prompt: "Center the Hello World label horizontally — the page is 800px wide.",
  },
  {
    name: "Add component: a Send button below the label",
    app: helloApp,
    prompt: "Add a button labelled 'Send' positioned 50px below the Hello World label.",
  },
  {
    name: "Wire existing module event → label binding",
    app: appWithTimeFetcher,
    prompt:
      "Show the London time in the Hello World label. Use the existing London Time Fetcher's londonTimeFetched event (timeText field) and call fetchLondonTime on app load.",
  },
];

const BUILD_SUITE = [
  {
    name: "Multi-step: build a tiny module + wire it to the label",
    app: helloApp,
    prompt:
      "Build a small synchronous module called 'greeter' with one method that returns the string 'Hello from C++'. Then bind the Hello World label to the result on app load.",
  },
];

async function adhoc(prompt, appPath) {
  const app = appPath
    ? JSON.parse(await readFile(appPath, "utf8"))
    : helloApp();
  await runCase({ name: "ad-hoc", app: () => app, prompt });
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Test harness for /api/apply-patch (Ask AI).

Usage:
  node scripts/test-ask-ai.mjs                  Run the standard test suite (4 fast tests, no builds).
  node scripts/test-ask-ai.mjs --with-build     Also run the multi-step build test (slow + ~minutes of nix).
  node scripts/test-ask-ai.mjs "your prompt"    Run a one-off prompt against the hello-world fixture.
  node scripts/test-ask-ai.mjs --app FILE "prompt"  Run a one-off prompt against a custom AppState JSON.
  node scripts/test-ask-ai.mjs --help           This message.

Env:
  LGX_ENDPOINT   Override the API URL (default ${ENDPOINT}).

Cost: each non-build test = a few thousand tokens. Build tests run nix +
~10K tokens each. Provider key from web/.env.local.
`);
    return;
  }

  const appIdx = args.indexOf("--app");
  let appPath;
  if (appIdx >= 0) {
    appPath = args[appIdx + 1];
    args.splice(appIdx, 2);
  }
  const withBuild = args.includes("--with-build");
  const flagless = args.filter((a) => !a.startsWith("--"));

  if (flagless.length > 0) {
    await adhoc(flagless.join(" "), appPath);
    return;
  }

  console.log(`Running Ask AI test suite against ${ENDPOINT}`);
  if (withBuild) console.log("Including --with-build cases (slow).");

  const tests = withBuild ? [...SUITE, ...BUILD_SUITE] : SUITE;
  const results = [];
  for (const t of tests) {
    results.push(await runCase(t));
  }

  console.log(`\n━━━ SUMMARY ━━━`);
  for (const r of results) {
    console.log(`  ${r.ok ? "✓" : "✗"}  ${r.name}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
