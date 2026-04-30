#!/usr/bin/env node
// lgx-builder — runs the lgx.guru editor on the user's machine.
//
// Used as:
//   npx lgx-builder@latest            # latest published, on port 3000
//   npx lgx-builder@latest --port 4000
//   npx lgx-builder@latest --no-open
//
// Defaults to LGX_BUILD_BACKEND=local so AI-built C++ modules work out of
// the box (provided the user has nix installed). Auto-opens the browser
// at http://localhost:<port>/dashboard once the server is ready.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// When installed as a dependency, package.json's "files" ships /bin and the
// built /.next directory at the package root, so the next/standalone server
// is one level up from /bin.
const PKG_ROOT = path.resolve(__dirname, "..");

// Tiny CLI parser — no dependency on yargs/commander.
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = args[i + 1];
  // Boolean flag (no value follows): treat as true.
  if (!next || next.startsWith("--")) return true;
  return next;
};

const port = Number(flag("port", "3000"));
const noOpen = !!args.find((a) => a === "--no-open");
const help = !!args.find((a) => a === "--help" || a === "-h");

if (help) {
  process.stdout.write(`lgx-builder — local lgx.guru editor

Usage:
  npx lgx-builder              run on port 3000, open browser
  npx lgx-builder --port 4000  run on a different port
  npx lgx-builder --no-open    don't auto-open browser
  npx lgx-builder --help       show this

Requirements for AI-built C++ modules:
  - nix installed and on PATH (https://nixos.org/download)

Set LLM credentials before launching:
  export NVIDIA_API_KEY=...           # primary, recommended
  # or:
  export OPENAI_API_KEY=...
`);
  process.exit(0);
}

// Detect whether next is available. When run from a published npm package,
// next is bundled as a dep and resolves from PKG_ROOT/node_modules/next.
const NEXT_BIN = ["node_modules/.bin/next", "node_modules/next/dist/bin/next"]
  .map((p) => path.join(PKG_ROOT, p))
  .find(existsSync);

if (!NEXT_BIN) {
  console.error(
    "lgx-builder: cannot find next executable. " +
    "If you cloned the repo, run `pnpm install` in /web first.",
  );
  process.exit(1);
}

const env = {
  ...process.env,
  PORT: String(port),
  // Default to local builder so npx users get the full experience.
  LGX_BUILD_BACKEND: process.env.LGX_BUILD_BACKEND ?? "local",
};

if (!env.NVIDIA_API_KEY && !env.OPENAI_API_KEY) {
  console.warn(
    "\x1b[33m[lgx-builder] no LLM key found in env (NVIDIA_API_KEY or OPENAI_API_KEY).\n" +
    "             Visual editing works fine without it; ✦ Ask AI will return an error.\x1b[0m",
  );
}

const child = spawn(NEXT_BIN, ["start"], {
  cwd: PKG_ROOT,
  env,
  stdio: "inherit",
});

// Open the browser after a short delay so Next has time to bind. We could
// poll http://localhost:PORT/, but the delay is good enough for human-scale
// usage and doesn't add a dependency.
if (!noOpen) {
  setTimeout(() => {
    const url = `http://localhost:${port}/dashboard`;
    const cmd =
      process.platform === "darwin" ? "open" :
      process.platform === "win32" ? "start" :
      "xdg-open";
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
    // eslint-disable-next-line no-console
    console.log(`\n\x1b[36m  → ${url}\x1b[0m\n`);
  }, 1500);
}

const onSig = (sig) => {
  child.kill(sig);
  process.exit(0);
};
process.on("SIGINT",  () => onSig("SIGINT"));
process.on("SIGTERM", () => onSig("SIGTERM"));
child.on("exit", (code) => process.exit(code ?? 0));
