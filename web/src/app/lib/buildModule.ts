// Server-side: take a CoreModuleSpec from the AI factory, lay it down as a
// real source project, run `nix build '.#lgx-portable'`, and surface either
// the built .lgx or the compile errors. Persists per spec.id so subsequent
// rebuilds reuse the flake.lock + the nix store cache.
//
// Server-only — relies on child_process + the user's local nix install.

import { spawn } from "child_process";
import { chmod, copyFile, mkdir, readdir, readFile, stat, unlink, writeFile } from "fs/promises";
import path from "path";
import os from "os";
import { generateCoreModuleFiles } from "../codegen/coreModule";
import type { CoreModuleSpec } from "../types";

// First build of a fresh module downloads all the Logos SDK deps —
// 5–10 minutes on a slow link. Cap generously.
const NIX_BUILD_TIMEOUT_MS = 12 * 60 * 1000;

const BUILD_ROOT = path.join(os.tmpdir(), "lgx-builds");

const safeId = (raw: string): string =>
  (raw.match(/^[a-z][a-z0-9_]*$/) ? raw : "my_module").toLowerCase();

const buildDirFor = (id: string): string => path.join(BUILD_ROOT, safeId(id));
const cachePathFor = (id: string): string => path.join(BUILD_ROOT, `${safeId(id)}.lgx`);

export interface BuildSuccess {
  ok: true;
  lgxPath: string;       // server-side cached path
  storePath: string;     // /nix/store/... — for debugging
  durationMs: number;
}
export interface BuildFailure {
  ok: false;
  errors: string[];      // parsed `error: ...` lines
  stderrTail: string;    // last few lines of stderr for debugging
  durationMs: number;
}
export type BuildResult = BuildSuccess | BuildFailure;

// Materialize the codegen files into the build dir. Persisted per id so
// rebuilds reuse the flake.lock and nix's eval cache — fresh dirs would
// re-resolve the Logos SDK on every attempt.
export async function writeModuleSource(spec: CoreModuleSpec): Promise<string> {
  const dir = buildDirFor(spec.id);
  await mkdir(dir, { recursive: true });
  const files = generateCoreModuleFiles(spec);
  for (const f of files) {
    const target = path.join(dir, f.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(f.data));
  }
  return dir;
}

export async function buildCoreModule(spec: CoreModuleSpec): Promise<BuildResult> {
  const startedAt = Date.now();
  const dir = await writeModuleSource(spec);
  const { code, stdout, stderr } = await runNixBuild(dir);
  const durationMs = Date.now() - startedAt;

  if (code !== 0) {
    return { ok: false, errors: parseCompileErrors(stderr), stderrTail: tail(stderr, 40), durationMs };
  }

  const storePath = stdout.trim().split("\n").filter(Boolean)[0];
  if (!storePath) {
    return { ok: false, errors: ["nix build returned no output path"], stderrTail: tail(stderr, 40), durationMs };
  }

  let entries: string[];
  try {
    entries = await readdir(storePath);
  } catch (err) {
    return { ok: false, errors: [`could not read build output ${storePath}: ${(err as Error).message}`], stderrTail: tail(stderr, 40), durationMs };
  }
  const lgx = entries.find((f) => f.endsWith(".lgx"));
  if (!lgx) {
    return { ok: false, errors: [`no .lgx artifact in build output (saw: ${entries.join(", ") || "empty"})`], stderrTail: tail(stderr, 40), durationMs };
  }

  // Copy out so a future nix-store --gc doesn't reclaim the artifact and
  // so /api/built-module/[id] has a stable path to serve from. Two
  // gotchas: nix store files are mode 444, and Node's copyFile preserves
  // the source mode — so without unlinking first, the second build trips
  // EACCES trying to overwrite the read-only cache file. Unlink + chmod
  // makes overwrites safe regardless of the source's mode bits.
  const cachePath = cachePathFor(spec.id);
  try { await unlink(cachePath); } catch { /* ENOENT on first build */ }
  await copyFile(path.join(storePath, lgx), cachePath);
  try { await chmod(cachePath, 0o644); } catch { /* best effort */ }

  return { ok: true, lgxPath: cachePath, storePath, durationMs };
}

function runNixBuild(dir: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // Pin PATH explicitly so `nix` resolves even when the dev server was
    // launched without the user's full shell PATH (some IDE-launched dev
    // servers strip /nix/var/nix/profiles/default/bin).
    const PATH = [
      "/nix/var/nix/profiles/default/bin",
      `${process.env.HOME ?? ""}/.nix-profile/bin`,
      process.env.PATH ?? "",
    ].filter(Boolean).join(":");

    const child = spawn(
      "nix",
      [
        // Belt-and-suspenders: enable flakes locally so a user's stock
        // nix.conf without `experimental-features = nix-command flakes`
        // still resolves the .#<output> attribute syntax.
        "--extra-experimental-features", "nix-command flakes",
        "build",
        ".#lgx-portable",
        "--no-link",
        "--print-out-paths",
      ],
      {
        cwd: dir,
        env: { ...process.env, PATH },
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => { stdout += b.toString(); });
    child.stderr.on("data", (b) => { stderr += b.toString(); });

    const timer = setTimeout(() => {
      stderr += `\n[lgx.guru] nix build timed out after ${NIX_BUILD_TIMEOUT_MS / 1000}s\n`;
      child.kill("SIGTERM");
    }, NIX_BUILD_TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        code: -1,
        stdout,
        stderr: `${stderr}\n[lgx.guru] failed to spawn nix: ${err.message}\n`,
      });
    });
  });
}

// Pull `error: ...` lines out of nix/cmake/g++ stderr. Compilers vary in
// shape but all use `error:` so this catches the common surface cleanly.
// Falls back to the last 30 lines if no obvious error markers exist.
function parseCompileErrors(stderr: string): string[] {
  const lines = stderr.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/error:/i.test(line)) continue;
    // Include the previous line if it looks like a compiler source-pointer
    // (the pre-error line typically carries line/column context).
    const prev = i > 0 ? lines[i - 1] : "";
    const ctx = prev && !/^\s*$/.test(prev) ? `${prev}\n` : "";
    out.push(`${ctx}${line}`);
  }
  return out.length > 0 ? out : [tail(stderr, 30)];
}

function tail(s: string, n: number): string {
  return s.split("\n").slice(-n).join("\n");
}

export async function readBuiltLgx(id: string): Promise<Buffer | null> {
  try {
    const p = cachePathFor(id);
    await stat(p);
    return await readFile(p);
  } catch {
    return null;
  }
}

export function builtLgxFilename(id: string): string {
  return `${safeId(id)}.lgx`;
}
