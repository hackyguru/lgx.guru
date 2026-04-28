// Build a fresh delivery_test UI .lgx end-to-end using the editor's actual
// code paths (emitMainQml + exportLgx), then drop it into the user's
// LogosBasecamp plugins dir so we can verify the install state matches what
// the editor would produce.
//
// Run via vite-node (ships with vitest):
//   npx vite-node scripts/build-delivery-test.ts
//
// On success it prints both the manifest the editor produced and the path
// the .lgx was written to.

import { writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { gunzipSync } from "node:zlib";

import { TEMPLATES } from "../src/app/templates";
import { emitMainQml } from "../src/app/qmlEmit";
import { exportLgx, placeholderIcon } from "../src/app/lgxExport";
import type { AppState, Node } from "../src/app/types";
import { isContainer } from "../src/app/types";

// ── Build the AppState the same way applyTemplate does ─────────────────────

const tpl = TEMPLATES.find((t) => t.id === "delivery_test");
if (!tpl) throw new Error("delivery_test template not found");

const built = tpl.build();
const app: AppState = {
  pages: [{ id: "p_root", name: built.meta.name, root: built.root }],
  currentPageId: "p_root",
  variables: built.variables ?? [],
  modules: [],
  triggers: built.triggers ?? [],
};

// usesDelivery is checked at export to derive the UI's deps.
const usesDelivery =
  (app.triggers ?? []).some((t) => t.kind === "onMessageReceived") ||
  (function walk(n: Node): boolean {
    if (n.kind === "Button" && n.onClick?.kind === "sendMessage") return true;
    if (isContainer(n)) return n.children.some(walk);
    return false;
  })(app.pages[0].root);

if (!usesDelivery) throw new Error("delivery_test template should use delivery — fixture broken");

// ── Run the export pipeline ────────────────────────────────────────────────

const qmlSource = emitMainQml(app, true);
const result = await exportLgx({
  name: built.meta.name || "delivery_test",
  version: "0.1.0",
  description: built.meta.description,
  category: "example",
  author: "smoke",
  iconPng: placeholderIcon(),
  iconFilename: "icon.png",
  qmlSource,
  extraFiles: [],
  dependencies: ["delivery_relay"],
});

const outPath = join(tmpdir(), "lgx-smoke", result.filename);
mkdirSync(dirname(outPath), { recursive: true });
const lgxBytes = Buffer.from(await result.blob.arrayBuffer());
writeFileSync(outPath, lgxBytes);

// ── Verify manifest in the produced .lgx ───────────────────────────────────

const tar = gunzipSync(lgxBytes);
const readEntry = (path: string): string | null => {
  let off = 0;
  while (off + 512 <= tar.length) {
    const name = tar.subarray(off, off + 100).toString("utf8").replace(/\0+$/, "");
    if (!name) break;
    const sizeOct = tar.subarray(off + 124, off + 136).toString("utf8").replace(/[\0 ]+$/, "");
    const size = parseInt(sizeOct, 8) || 0;
    if (name === path) return tar.subarray(off + 512, off + 512 + size).toString("utf8");
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
};

const manifest = JSON.parse(readEntry("manifest.json")!);
console.log("\n── editor-produced manifest ─────────────────────");
console.log(JSON.stringify(manifest, null, 2));

// Hard checks — these are what catches "manifest looked OK but didn't have
// the right shape" issues.
const failures: string[] = [];
if (manifest.name !== "delivery_test") failures.push(`name expected delivery_test, got ${manifest.name}`);
if (manifest.type !== "ui_qml") failures.push(`type expected ui_qml, got ${manifest.type}`);
if (!manifest.dependencies?.includes("delivery_relay")) failures.push(`dependencies missing "delivery_relay": ${JSON.stringify(manifest.dependencies)}`);
if (!manifest.hashes?.root?.match(/^[a-f0-9]{64}$/)) failures.push(`hashes.root invalid`);

const hasMainQml = ["darwin-arm64", "linux-amd64", "linux-arm64"].every(
  (a) => readEntry(`variants/${a}/Main.qml`) !== null,
);
if (!hasMainQml) failures.push("Main.qml missing from one or more variants");

const qml = readEntry("variants/darwin-arm64/Main.qml")!;
if (!qml.includes(`logos.callModule("delivery_relay", "startDelivery"`)) failures.push("QML missing startDelivery bootstrap");
if (!qml.includes(`logos.callModule("delivery_relay", "sendMessage"`)) failures.push("QML missing sendMessage call");
if (!qml.includes(`logos.callModule("delivery_relay", "takeRecentMessages"`)) failures.push("QML missing takeRecentMessages poll");
if (!qml.includes("id: _deliveryStatusOverlay")) failures.push("QML missing status overlay");

if (failures.length > 0) {
  console.error("\n✗ Verification failed:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\n✓ manifest + QML pass all sanity checks");

// ── Install into Basecamp ──────────────────────────────────────────────────

const PLUGINS_DIR = join(homedir(), "Library", "Application Support", "Logos", "LogosBasecamp", "plugins");
const dest = join(PLUGINS_DIR, "delivery_test");

if (existsSync(dest)) {
  console.log(`\nremoving stale install at ${dest}`);
  rmSync(dest, { recursive: true, force: true });
}

// Mimic Basecamp's installer: extract manifest.json + variants/<arch>/* into
// the plugins/<name>/ directory, with the variant matching the host arch's
// files unpacked at the top level.
const ARCH = "darwin-arm64";   // we're on macOS arm64
mkdirSync(dest, { recursive: true });
writeFileSync(join(dest, "manifest.json"), readEntry("manifest.json")!, "utf8");
let off = 0;
while (off + 512 <= tar.length) {
  const name = tar.subarray(off, off + 100).toString("utf8").replace(/\0+$/, "");
  if (!name) break;
  const sizeOct = tar.subarray(off + 124, off + 136).toString("utf8").replace(/[\0 ]+$/, "");
  const size = parseInt(sizeOct, 8) || 0;
  const prefix = `variants/${ARCH}/`;
  if (name.startsWith(prefix) && size > 0) {
    const rel = name.slice(prefix.length);
    const fp = join(dest, rel);
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, tar.subarray(off + 512, off + 512 + size));
  }
  off += 512 + Math.ceil(size / 512) * 512;
}

console.log(`\n✓ installed to ${dest}`);
console.log(`  files: ${readdirSync(dest).join(", ")}`);

// ── Final sanity: read back the on-disk manifest and confirm deps ──────────

const installed = JSON.parse(readFileSync(join(dest, "manifest.json"), "utf8"));
console.log(`\n── installed manifest deps ──`);
console.log(`  ${JSON.stringify(installed.dependencies)}`);
if (!installed.dependencies?.includes("delivery_relay")) {
  console.error("✗ on-disk manifest lost its dependencies after install");
  process.exit(1);
}
console.log("\n✓ end-to-end smoke test passed");
console.log(`  source .lgx: ${outPath}`);
console.log(`  installed at: ${dest}`);

// ── ALSO smoke-test a hand-rolled app (not the template) ──────────────────
// This exercises the GUI codegen path on a different topology — a chat-style
// widget with a different topic, different variable names, and an inline
// trigger — to prove the editor's output isn't just-good-for-the-template.

console.log("\n── hand-rolled app smoke ────────────────────────");

import { newId } from "../src/app/types";
import { defaultStyle, newRoot } from "../src/app/types";
import type { ButtonNode, FrameNode, PageData, TextFieldNode, TextNode, Variable, Trigger } from "../src/app/types";

const customTopic = "/lgxguru-smoke/1/handrolled/text";
const inputId  = newId();
const lastId   = newId();
const handVars: Variable[] = [
  { id: inputId, name: "msg",        type: "string", initial: "" },
  { id: lastId,  name: "incoming",   type: "string", initial: "(none)" },
];
const handRoot: FrameNode = { ...newRoot(), id: newId(), children: [
  { id: newId(), kind: "TextField", x: 40, y: 40, width: 300, height: 30, hidden: false, locked: false,
    style: defaultStyle(), text: "", placeholder: "type", readOnly: false, pixelSize: 14, binding: inputId,
  } satisfies TextFieldNode,
  { id: newId(), kind: "Button",    x: 350, y: 40, width: 100, height: 30, hidden: false, locked: false,
    style: { ...defaultStyle(), backgroundColor: "#2563eb", borderRadius: 4 }, text: "Send",
    textColor: "#fff", fontWeight: "bold",
    onClick: { kind: "sendMessage", topic: customTopic, payload: "app.var_msg", payloadMode: "expression" },
  } satisfies ButtonNode,
  { id: newId(), kind: "Text",      x: 40, y: 90, width: 410, height: 30, hidden: false, locked: false,
    style: defaultStyle(), text: "(none)", pixelSize: 14, color: "#000", fontWeight: "normal",
    italic: false, textAlign: "left", fontFamily: "", letterSpacing: 0, lineHeight: 1, binding: lastId,
  } satisfies TextNode,
]};
const handPage: PageData = { id: newId(), name: "Smoke", root: handRoot };
const handTrigger: Trigger = {
  id: newId(),
  kind: "onMessageReceived",
  topic: customTopic,
  actions: [
    { kind: "setVariable", varId: lastId, value: "payload", mode: "expression" },
  ],
};
const handApp: AppState = {
  pages: [handPage],
  currentPageId: handPage.id,
  variables: handVars,
  modules: [],
  triggers: [handTrigger],
};

const handQml = emitMainQml(handApp, true);
const handRes = await exportLgx({
  name: "smoke_handrolled",
  version: "0.1.0",
  description: "smoke",
  category: "example",
  author: "smoke",
  iconPng: placeholderIcon(),
  iconFilename: "icon.png",
  qmlSource: handQml,
  extraFiles: [],
  dependencies: ["delivery_relay"],
});
const handBytes = Buffer.from(await handRes.blob.arrayBuffer());
const handTar = gunzipSync(handBytes);
const findEntry = (path: string): string => {
  let off = 0;
  while (off + 512 <= handTar.length) {
    const name = handTar.subarray(off, off + 100).toString("utf8").replace(/\0+$/, "");
    if (!name) break;
    const sizeOct = handTar.subarray(off + 124, off + 136).toString("utf8").replace(/[\0 ]+$/, "");
    const size = parseInt(sizeOct, 8) || 0;
    if (name === path) return handTar.subarray(off + 512, off + 512 + size).toString("utf8");
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return "";
};
const handManifest = JSON.parse(findEntry("manifest.json"));
const handFails: string[] = [];
if (!handManifest.dependencies?.includes("delivery_relay")) handFails.push("manifest missing delivery_relay dep");
const handMain = findEntry("variants/darwin-arm64/Main.qml");
if (!handMain.includes(`logos.callModule("delivery_relay", "startDelivery"`)) handFails.push("missing startDelivery bootstrap");
if (!handMain.includes(`subscribeToTopic", ["${customTopic}"]`)) handFails.push("missing subscribeToTopic with custom topic");
if (!handMain.includes(`sendMessage", ["${customTopic}", app.var_msg]`)) handFails.push("missing sendMessage routing the input variable");
if (!handMain.includes(`if (topic === "${customTopic}")`)) handFails.push("missing topic dispatch in Timer");
if (!handMain.includes("app.var_incoming = payload")) handFails.push("missing setVariable on inbound payload");
if (!handMain.includes("id: _deliveryStatusOverlay")) handFails.push("missing status overlay");
if (handFails.length > 0) {
  console.error("✗ hand-rolled smoke failed:");
  for (const f of handFails) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("✓ hand-rolled app generated valid QML + manifest");
console.log(`  topic: ${customTopic}`);
console.log(`  declared dep: ${JSON.stringify(handManifest.dependencies)}`);
console.log(`  size: ${handBytes.length} bytes`);
