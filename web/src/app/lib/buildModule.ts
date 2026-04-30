// Server-side: take a CoreModuleSpec from the AI factory, lay it down as a
// real source project, run `nix build '.#lgx-portable'`, and surface either
// the built .lgx or the compile errors. Persists per spec.id so subsequent
// rebuilds reuse the flake.lock + the nix store cache.
//
// Two backends:
//   - "local"  — run nix in-process (default; works for `pnpm dev` and for
//                the npx CLI distribution where users have nix installed).
//   - "remote" — POST the spec to a build worker (Hetzner-hosted Docker
//                image, see build-worker/) over HTTP. Used when the editor
//                is deployed to Vercel, which can't run nix itself.
// Selected via LGX_BUILD_BACKEND env var. Default = local.

import { spawn } from "child_process";
import { chmod, copyFile, mkdir, readdir, readFile, stat, unlink, writeFile } from "fs/promises";
import path from "path";
import os from "os";
import { generateCoreModuleFiles } from "../codegen/coreModule";
import type { CoreModuleSpec } from "../types";

const BUILD_BACKEND = (process.env.LGX_BUILD_BACKEND ?? "local").toLowerCase();
const BUILD_WORKER_URL = process.env.LGX_BUILD_WORKER_URL ?? "";
const BUILD_WORKER_TOKEN = process.env.LGX_BUILD_WORKER_TOKEN ?? "";

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
  // Set when the unit-test phase ran. ok=true means tests passed.
  // Skipped (undefined) when the framework didn't expose a `unit-tests`
  // attribute (older module-builder versions, or a flake variant).
  tests?: { ok: true; durationMs: number } | { ok: false; errors: string[]; stderrTail: string; durationMs: number };
}
export interface BuildFailure {
  ok: false;
  // Which phase failed: the main module compile, or the unit-tests build/run.
  phase: "compile" | "tests";
  errors: string[];      // parsed `error: ...` lines (or test-failure lines)
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

// Pre-flight lint: reject specs whose method bodies use the
// not-yet-supported inter-module-call surface (LogosAPI / m_api /
// callModule). Catches them in milliseconds instead of letting nix run
// for minutes only to fail with cryptic compiler errors. The error
// messages are tuned so the AI can self-correct in one retry.
function lintBodies(spec: CoreModuleSpec): string[] {
  const issues: string[] = [];
  for (const m of spec.methods) {
    const body = m.body ?? "";
    if (/\bm_api\b/.test(body)) {
      issues.push(
        `Method ${m.name}: references m_api. Custom universal modules don't have a LogosAPI hook — they're SELF-CONTAINED. ` +
        `Move cross-module orchestration to the UI layer (callModule actions on buttons, moduleEvent triggers) instead.`
      );
    }
    if (/\bLogosAPI\b/.test(body) || /\bLogosResult\b/.test(body)) {
      issues.push(
        `Method ${m.name}: references LogosAPI/LogosResult. The LogosAPI surface isn't exposed in lgx.guru-built modules. ` +
        `Make this method a self-contained pure function (or use std::* / Qt internals like QNetworkAccessManager). ` +
        `If the user wanted cross-module behavior, that belongs in the UI layer.`
      );
    }
    if (/->\s*callModule\b/.test(body) || /\bcallRemoteMethod\b/.test(body)) {
      issues.push(
        `Method ${m.name}: tries to call another module from inside C++ (callModule / callRemoteMethod). ` +
        `Not supported — restructure so this method does its work standalone, and have the UI do the cross-module orchestration.`
      );
    }
    // QObject-style C++ patterns the impl class can't support (it's a plain
    // C++ class, not a QObject). Catch these BEFORE nix runs so the error
    // message tells the AI exactly what to do — otherwise it sees a wall of
    // template gibberish and retries with the same broken pattern.
    if (/(?<!QObject::)\bconnect\s*\(/.test(body)) {
      issues.push(
        `Method ${m.name}: uses bare \`connect(...)\`, but the impl class is NOT a QObject. ` +
        `Use the explicit static form: \`QObject::connect(reply, &QNetworkReply::finished, reply, [this, reply]() { … })\`. ` +
        `The \`reply\` arg as the receiver context auto-disconnects when reply is deleted.`
      );
    }
    if (/\bQNetworkAccessManager\s*\(\s*this\b/.test(body)) {
      issues.push(
        `Method ${m.name}: \`QNetworkAccessManager(this)\` — passing \`this\` as parent. ` +
        `The impl class isn't a QObject*, so this fails to compile. ` +
        `Either: (a) declare a state field with cppType=QNetworkAccessManager and use d->m_<name>, or ` +
        `(b) instantiate it locally with no parent: \`QNetworkAccessManager mgr; auto* reply = mgr.get(req);\`.`
      );
    }
    if (/\bemit\s+\w+\s*\(/.test(body)) {
      issues.push(
        `Method ${m.name}: uses \`emit signalName(...)\`, but the impl class is NOT a QObject and has no signals. ` +
        `Cross-module events go through the UI layer (logos.callModule from QML on a polling Timer), not C++ signals.`
      );
    }
  }
  return issues;
}

// ── Public API: dispatch to the configured backend ─────────────────────────

export async function buildCoreModule(spec: CoreModuleSpec): Promise<BuildResult> {
  if (BUILD_BACKEND === "remote") return buildCoreModuleRemote(spec);
  if (BUILD_BACKEND === "disabled") {
    return {
      ok: false,
      phase: "compile",
      errors: [
        "Custom backend module builds are disabled in this deployment. " +
        "To use AI-built C++ modules, run lgx-builder locally:\n" +
        "    npx lgx-builder@latest\n" +
        "(requires nix; see https://lgx.guru/docs for setup).",
      ],
      stderrTail: "build_backend_module unavailable on this deployment",
      durationMs: 0,
    };
  }
  return buildCoreModuleLocal(spec);
}

export async function readBuiltLgx(id: string): Promise<Buffer | null> {
  if (BUILD_BACKEND === "remote") return readBuiltLgxRemote(id);
  if (BUILD_BACKEND === "disabled") return null;
  return readBuiltLgxLocal(id);
}

// ── Remote backend (HTTP → Hetzner build worker) ───────────────────────────

async function buildCoreModuleRemote(spec: CoreModuleSpec): Promise<BuildResult> {
  if (!BUILD_WORKER_URL) {
    return {
      ok: false,
      phase: "compile",
      errors: ["LGX_BUILD_BACKEND=remote but LGX_BUILD_WORKER_URL is unset (server misconfiguration)."],
      stderrTail: "config error",
      durationMs: 0,
    };
  }
  // Render the codegen here so the worker doesn't need its own copy of the
  // codegen module — keeps the source of truth single. The worker just
  // writes whatever files we send it, then runs nix.
  const rendered = generateCoreModuleFiles(spec).map((f) => ({
    path: f.path,
    base64: Buffer.from(f.data).toString("base64"),
  }));
  const started = Date.now();
  try {
    const res = await fetch(`${BUILD_WORKER_URL}/build`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(BUILD_WORKER_TOKEN ? { authorization: `Bearer ${BUILD_WORKER_TOKEN}` } : {}),
      },
      body: JSON.stringify({ ...spec, __files: rendered }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        phase: "compile",
        errors: [`build worker returned ${res.status}: ${text.slice(0, 500)}`],
        stderrTail: text.slice(-500),
        durationMs: Date.now() - started,
      };
    }
    return (await res.json()) as BuildResult;
  } catch (err) {
    return {
      ok: false,
      phase: "compile",
      errors: [`could not reach build worker at ${BUILD_WORKER_URL}: ${(err as Error).message}`],
      stderrTail: "network error",
      durationMs: Date.now() - started,
    };
  }
}

async function readBuiltLgxRemote(id: string): Promise<Buffer | null> {
  if (!BUILD_WORKER_URL) return null;
  try {
    const res = await fetch(`${BUILD_WORKER_URL}/built/${encodeURIComponent(id)}`, {
      headers: BUILD_WORKER_TOKEN ? { authorization: `Bearer ${BUILD_WORKER_TOKEN}` } : {},
    });
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch {
    return null;
  }
}

// ── Local backend (spawn `nix build` in-process) ───────────────────────────

async function buildCoreModuleLocal(spec: CoreModuleSpec): Promise<BuildResult> {
  const startedAt = Date.now();

  // Cheap pre-flight: bail out with a clear message before invoking nix
  // if the AI tried to call other modules from C++.
  const lintIssues = lintBodies(spec);
  if (lintIssues.length > 0) {
    return {
      ok: false,
      phase: "compile",
      errors: lintIssues,
      stderrTail: "lgx.guru pre-flight lint: cross-module C++ calls aren't supported. Module must be self-contained; compose at the UI layer.",
      durationMs: Date.now() - startedAt,
    };
  }

  const dir = await writeModuleSource(spec);
  const { code, stdout, stderr } = await runNixBuild(dir, ".#lgx-portable");
  const compileMs = Date.now() - startedAt;

  if (code !== 0) {
    return { ok: false, phase: "compile", errors: parseCompileErrors(stderr), stderrTail: tail(stderr, 40), durationMs: compileMs };
  }

  const storePath = stdout.trim().split("\n").filter(Boolean)[0];
  if (!storePath) {
    return { ok: false, phase: "compile", errors: ["nix build returned no output path"], stderrTail: tail(stderr, 40), durationMs: compileMs };
  }

  let entries: string[];
  try {
    entries = await readdir(storePath);
  } catch (err) {
    return { ok: false, phase: "compile", errors: [`could not read build output ${storePath}: ${(err as Error).message}`], stderrTail: tail(stderr, 40), durationMs: compileMs };
  }
  const lgx = entries.find((f) => f.endsWith(".lgx"));
  if (!lgx) {
    return { ok: false, phase: "compile", errors: [`no .lgx artifact in build output (saw: ${entries.join(", ") || "empty"})`], stderrTail: tail(stderr, 40), durationMs: compileMs };
  }

  // Copy out so a future nix-store --gc doesn't reclaim the artifact and
  // so /api/built-module/[id] has a stable path to serve from.
  const cachePath = cachePathFor(spec.id);
  try { await unlink(cachePath); } catch { /* ENOENT on first build */ }
  await copyFile(path.join(storePath, lgx), cachePath);
  try { await chmod(cachePath, 0o644); } catch { /* best effort */ }

  // ── Unit tests phase ────────────────────────────────────────────────────
  // The codegen always emits a tests/ dir, so logos-module-builder exposes
  // .#unit-tests as a flake output. We run it after the main build to
  // catch semantic bugs the compiler can't (assertion failures, wrong
  // return values, broken state transitions). Failures are surfaced with
  // phase:"tests" so the apply-patch retry loop can show them as test
  // errors specifically rather than compile errors.
  const testsStart = Date.now();
  const testsResult = await runNixBuild(dir, ".#unit-tests");
  const testsMs = Date.now() - testsStart;

  if (testsResult.code !== 0) {
    // Distinguish "tests target doesn't exist" (older module-builder, or
    // edge cases) from real test failures. Skipping is safer than failing
    // a successful module build over a missing target.
    if (/(unrecognized argument|attribute .*missing|does not provide|has no attribute).*unit-tests/i.test(testsResult.stderr)) {
      return {
        ok: true,
        lgxPath: cachePath,
        storePath,
        durationMs: compileMs + testsMs,
      };
    }
    return {
      ok: false,
      phase: "tests",
      errors: parseTestFailures(testsResult.stderr),
      stderrTail: tail(testsResult.stderr, 60),
      durationMs: compileMs + testsMs,
    };
  }

  return {
    ok: true,
    lgxPath: cachePath,
    storePath,
    durationMs: compileMs + testsMs,
    tests: { ok: true, durationMs: testsMs },
  };
}

function runNixBuild(dir: string, target: string): Promise<{ code: number; stdout: string; stderr: string }> {
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
        target,
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

// Pull failed-assertion lines out of logos-test-framework's output. The
// runner prints lines like "FAIL test_name (LOGOS_ASSERT_*)" or
// "Assertion failed: ..." which we surface to the AI for retry.
function parseTestFailures(stderr: string): string[] {
  const lines = stderr.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/\b(FAIL|Assertion failed|expected|got|LOGOS_ASSERT|test failed|abort)\b/i.test(l)) {
      // Include neighbouring lines for context.
      const ctx = (i > 0 ? lines[i - 1] + "\n" : "") + l + (i + 1 < lines.length ? "\n" + lines[i + 1] : "");
      out.push(ctx);
    }
  }
  // Dedupe + cap.
  const unique = Array.from(new Set(out));
  if (unique.length > 0) return unique.slice(-10);
  // Fallback: also try the regular compile-error parser in case tests
  // didn't compile (LOGOS_ASSERT used wrong, header missing, etc.).
  const compileErrs = parseCompileErrors(stderr);
  if (compileErrs.length > 0) return compileErrs.slice(-10);
  return [tail(stderr, 30)];
}

async function readBuiltLgxLocal(id: string): Promise<Buffer | null> {
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
