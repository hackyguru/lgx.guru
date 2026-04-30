#!/usr/bin/env node
// Copy the Qt-WASM renderer's runtime artifacts from renderer/build/ into
// web/public/renderer/ so Next.js (and Vercel) serve them as static files.
//
// Run after every `ninja` rebuild:
//   pnpm sync-renderer        (or: npm run sync-renderer)
//
// We copy a fixed allowlist of runtime files instead of the whole build dir
// because CMake leaves a lot of internal cruft (CMakeFiles/, *.cmake, etc.)
// that would bloat the deploy.

import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SRC = path.join(REPO_ROOT, "renderer", "build");
const DST = path.join(REPO_ROOT, "web", "public", "renderer");

const RUNTIME_FILES = [
  "index.html",          // custom postMessage bridge
  "qml-renderer.html",   // Qt's default (kept for parity)
  "qml-renderer.js",     // Qt loader
  "qml-renderer.wasm",   // the binary
  "qtloader.js",         // Qt's loader helper
  "qtlogo.svg",          // Qt's logo (referenced by qml-renderer.html)
];

const main = async () => {
  try {
    await stat(SRC);
  } catch {
    console.error(`sync-renderer: source dir not found: ${SRC}`);
    console.error(`Build the renderer first: cd renderer/build && ninja`);
    process.exit(1);
  }

  await mkdir(DST, { recursive: true });

  let copied = 0;
  for (const f of RUNTIME_FILES) {
    const src = path.join(SRC, f);
    const dst = path.join(DST, f);
    try {
      await stat(src);
    } catch {
      console.warn(`sync-renderer: missing ${f} (skipping)`);
      continue;
    }
    await copyFile(src, dst);
    copied += 1;
    console.log(`  ${f}`);
  }
  console.log(`sync-renderer: copied ${copied}/${RUNTIME_FILES.length} files to ${path.relative(REPO_ROOT, DST)}/`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
