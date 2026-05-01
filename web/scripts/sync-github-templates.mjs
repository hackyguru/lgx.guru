#!/usr/bin/env node
// Read templates/github-actions/{build-lgx.yml, merge-lgx.mjs} and emit a
// TS file exporting them as string constants. Run after editing those
// templates so the editor's bundled copy stays current.
//
// Usage:
//   pnpm sync-github-templates

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");
const SRC = path.join(REPO, "templates", "github-actions");
const OUT = path.join(REPO, "web", "src", "app", "lib", "githubTemplates.ts");

const yml = readFileSync(path.join(SRC, "build-lgx.yml"), "utf-8");
const mjs = readFileSync(path.join(SRC, "merge-lgx.mjs"), "utf-8");

// Use String.raw with backtick escapes so any backticks/$-braces in the
// templates pass through cleanly. We escape ` and ${ ourselves.
const escape = (s) =>
  s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

const ts = `// AUTO-GENERATED — do not edit by hand.
// Run \`pnpm sync-github-templates\` after editing files under
// templates/github-actions/ to refresh this.
//
// Bundled copies of the GitHub Actions workflow + merge tool that
// the editor pushes to a user's repo when "Build via GitHub" is
// selected in Export.

export const BUILD_LGX_YML = \`${escape(yml)}\`;

export const MERGE_LGX_MJS = \`${escape(mjs)}\`;
`;

writeFileSync(OUT, ts);
console.log(`Wrote ${OUT} (${yml.length + mjs.length} bytes from templates/github-actions/)`);
