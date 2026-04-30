// HTTP wrapper around the local nix-build code from the editor's
// `web/src/app/lib/buildModule.ts`. Deployed to Hetzner (Docker), called
// by the Vercel-hosted editor when LGX_BUILD_BACKEND=remote.
//
// Endpoints:
//   GET  /health        — liveness probe (returns "ok" when nix is in PATH)
//   POST /build         — body: CoreModuleSpec JSON; returns BuildResult JSON
//   GET  /built/:id     — returns the cached .lgx bytes for module <id>
//
// Auth: optional bearer token via LGX_BUILD_WORKER_TOKEN env var. The
// editor sends the same token in `Authorization: Bearer <token>`.

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// We DUPLICATE the codegen + buildModule logic here (rather than import
// from web/) to keep this service deployable as its own Docker image
// without dragging in the whole Next.js build. The two implementations
// must be kept in sync — they share the same CoreModuleSpec contract.
// TODO when this stabilizes: extract a shared package.

// ── Types (kept in sync with web/src/app/types.ts) ──────────────────────────

type ParamType = "string" | "number" | "boolean";
interface ModuleParam { name: string; type: ParamType; description?: string; cppType?: string }
interface CoreMethod {
  name: string; args: ModuleParam[]; returns: ParamType | "void";
  description?: string; body?: string; cppReturn?: string;
}
interface CoreModuleEvent { name: string; data: { name: string; type: ParamType }[]; description?: string }
interface CoreModuleTest { name: string; body: string; description?: string }
interface CoreStateField { name: string; cppType: string; initial?: string; description?: string }
interface CoreModuleSpec {
  id: string; name: string; version: string; description: string; category: string;
  dependencies: string[]; methods: CoreMethod[]; state: CoreStateField[];
  events?: CoreModuleEvent[]; tests?: CoreModuleTest[];
}

type BuildSuccess = {
  ok: true; storePath: string; durationMs: number;
  tests?: { ok: true; durationMs: number } | { ok: false; errors: string[]; stderrTail: string; durationMs: number };
};
type BuildFailure = { ok: false; phase: "compile" | "tests"; errors: string[]; stderrTail: string; durationMs: number };
type BuildResult = BuildSuccess | BuildFailure;

// ── Build infrastructure (kept in sync with web/.../buildModule.ts) ─────────

const NIX_BUILD_TIMEOUT_MS = 12 * 60 * 1000;
const BUILD_ROOT = path.join(os.tmpdir(), "lgx-builds");

const safeId = (raw: string): string =>
  (raw.match(/^[a-z][a-z0-9_]*$/) ? raw : "my_module").toLowerCase();
const buildDirFor = (id: string) => path.join(BUILD_ROOT, safeId(id));
const cachePathFor = (id: string) => path.join(BUILD_ROOT, `${safeId(id)}.lgx`);

const tail = (s: string, n: number) => s.split("\n").slice(-n).join("\n");

function lintBodies(spec: CoreModuleSpec): string[] {
  const issues: string[] = [];
  for (const m of spec.methods) {
    const body = m.body ?? "";
    if (/\bm_api\b/.test(body)) {
      issues.push(`Method ${m.name}: references m_api. Custom universal modules don't have a LogosAPI hook.`);
    }
    if (/\bLogosAPI\b/.test(body) || /\bLogosResult\b/.test(body)) {
      issues.push(`Method ${m.name}: references LogosAPI/LogosResult. Make this method self-contained.`);
    }
    if (/->\s*callModule\b/.test(body) || /\bcallRemoteMethod\b/.test(body)) {
      issues.push(`Method ${m.name}: tries to call another module from inside C++. Not supported.`);
    }
    // QObject-style C++ patterns the impl class can't support — catch
    // before nix wastes 5 min on a guaranteed compile failure.
    if (/(?<!QObject::)\bconnect\s*\(/.test(body)) {
      issues.push(
        `Method ${m.name}: bare \`connect(...)\` won't work — impl class isn't a QObject. ` +
        `Use \`QObject::connect(reply, &QNetworkReply::finished, reply, lambda)\`.`
      );
    }
    if (/\bQNetworkAccessManager\s*\(\s*this\b/.test(body)) {
      issues.push(
        `Method ${m.name}: \`QNetworkAccessManager(this)\` fails — impl class isn't QObject*. ` +
        `Use a Private state field, or instantiate locally with no parent.`
      );
    }
    if (/\bemit\s+\w+\s*\(/.test(body)) {
      issues.push(
        `Method ${m.name}: \`emit signalName(...)\` — impl class is plain C++, no signals. ` +
        `Cross-module events go through the UI layer (QML polling Timer + callModule).`
      );
    }
  }
  return issues;
}

function parseCompileErrors(stderr: string): string[] {
  const lines = stderr.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/error:/i.test(line)) continue;
    const prev = i > 0 ? lines[i - 1] : "";
    const ctx = prev && !/^\s*$/.test(prev) ? `${prev}\n` : "";
    out.push(`${ctx}${line}`);
  }
  return out.length > 0 ? out : [tail(stderr, 30)];
}

function parseTestFailures(stderr: string): string[] {
  const lines = stderr.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/\b(FAIL|Assertion failed|expected|got|LOGOS_ASSERT|test failed|abort)\b/i.test(l)) {
      const ctx = (i > 0 ? lines[i - 1] + "\n" : "") + l + (i + 1 < lines.length ? "\n" + lines[i + 1] : "");
      out.push(ctx);
    }
  }
  const unique = Array.from(new Set(out));
  if (unique.length > 0) return unique.slice(-10);
  const compileErrs = parseCompileErrors(stderr);
  if (compileErrs.length > 0) return compileErrs.slice(-10);
  return [tail(stderr, 30)];
}

function runNixBuild(dir: string, target: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const PATH = [
      "/nix/var/nix/profiles/default/bin",
      `${process.env.HOME ?? ""}/.nix-profile/bin`,
      process.env.PATH ?? "",
    ].filter(Boolean).join(":");
    const child = spawn(
      "nix",
      [
        "--extra-experimental-features", "nix-command flakes",
        "build", target, "--no-link", "--print-out-paths",
      ],
      { cwd: dir, env: { ...process.env, PATH } },
    );
    let stdout = "", stderr = "";
    child.stdout.on("data", (b) => { stdout += b.toString(); });
    child.stderr.on("data", (b) => { stderr += b.toString(); });
    const timer = setTimeout(() => {
      stderr += `\n[lgx.guru] nix build timed out after ${NIX_BUILD_TIMEOUT_MS / 1000}s\n`;
      child.kill("SIGTERM");
    }, NIX_BUILD_TIMEOUT_MS);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n[lgx.guru] failed to spawn nix: ${err.message}\n` });
    });
  });
}

// Codegen — replicated from web/src/app/codegen/coreModule.ts so the worker
// is self-contained. When the codegen schema changes, both copies need
// updating until we extract a shared package.
async function writeModuleSource(spec: CoreModuleSpec): Promise<string> {
  const dir = buildDirFor(spec.id);
  await mkdir(dir, { recursive: true });
  // The build worker doesn't ship the codegen — instead, the editor sends
  // *already-generated* files via the spec's `files` extension. To avoid
  // duplicating codegen here, we expect the spec to have been extended at
  // the editor with a `__files: { path, base64 }[]` field. See the editor
  // wrapper that prepares the request.
  const files = (spec as unknown as { __files?: { path: string; base64: string }[] }).__files;
  if (!files) {
    throw new Error("Spec missing __files (editor must serialize codegen output before sending).");
  }
  for (const f of files) {
    const target = path.join(dir, f.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(f.base64, "base64"));
  }
  return dir;
}

async function buildCoreModule(spec: CoreModuleSpec): Promise<BuildResult> {
  const startedAt = Date.now();
  const lintIssues = lintBodies(spec);
  if (lintIssues.length > 0) {
    return {
      ok: false, phase: "compile", errors: lintIssues,
      stderrTail: "lgx.guru pre-flight lint",
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
  try { entries = await readdir(storePath); } catch (err) {
    return { ok: false, phase: "compile", errors: [`could not read build output: ${(err as Error).message}`], stderrTail: tail(stderr, 40), durationMs: compileMs };
  }
  const lgx = entries.find((f) => f.endsWith(".lgx"));
  if (!lgx) {
    return { ok: false, phase: "compile", errors: [`no .lgx artifact in build output (saw: ${entries.join(", ")})`], stderrTail: tail(stderr, 40), durationMs: compileMs };
  }
  const cachePath = cachePathFor(spec.id);
  try { await unlink(cachePath); } catch { /* fine */ }
  await copyFile(path.join(storePath, lgx), cachePath);
  try { await chmod(cachePath, 0o644); } catch { /* fine */ }

  const testsStart = Date.now();
  const testsResult = await runNixBuild(dir, ".#unit-tests");
  const testsMs = Date.now() - testsStart;
  if (testsResult.code !== 0) {
    if (/(unrecognized argument|attribute .*missing|does not provide|has no attribute).*unit-tests/i.test(testsResult.stderr)) {
      return { ok: true, storePath, durationMs: compileMs + testsMs };
    }
    return {
      ok: false, phase: "tests",
      errors: parseTestFailures(testsResult.stderr),
      stderrTail: tail(testsResult.stderr, 60),
      durationMs: compileMs + testsMs,
    };
  }
  return { ok: true, storePath, durationMs: compileMs + testsMs, tests: { ok: true, durationMs: testsMs } };
}

// ── HTTP server ────────────────────────────────────────────────────────────

const TOKEN = process.env.LGX_BUILD_WORKER_TOKEN ?? "";
const PORT = Number(process.env.PORT ?? 7878);

const app = new Hono();

// CORS so the editor (lgx.guru, localhost:3000, etc.) can call us. Configurable
// via env in production. For daemon mode we'd allow * — the user is the only
// one who can reach localhost:7878 anyway.
const ALLOWED_ORIGINS = (process.env.LGX_ALLOWED_ORIGINS ?? "*").split(",").map((s) => s.trim());
app.use("/*", cors({ origin: ALLOWED_ORIGINS, allowHeaders: ["content-type", "authorization"] }));

// Auth middleware — bearer token if configured. No-op when LGX_BUILD_WORKER_TOKEN
// is unset (useful for the daemon flavor where users run on their own machine).
app.use("/build", async (c, next) => {
  if (!TOKEN) return next();
  const auth = c.req.header("authorization") ?? "";
  if (auth !== `Bearer ${TOKEN}`) return c.text("unauthorized", 401);
  return next();
});
app.use("/built/*", async (c, next) => {
  if (!TOKEN) return next();
  const auth = c.req.header("authorization") ?? "";
  if (auth !== `Bearer ${TOKEN}`) return c.text("unauthorized", 401);
  return next();
});

app.get("/health", async (c) => {
  // Probe nix availability — useful for deploy verification.
  const which = await new Promise<string>((resolve) => {
    const p = spawn("which", ["nix"]);
    let out = "";
    p.stdout.on("data", (b) => { out += b.toString(); });
    p.on("close", () => resolve(out.trim()));
    p.on("error", () => resolve(""));
  });
  return c.json({ ok: true, nix: which || null });
});

app.post("/build", async (c) => {
  let spec: CoreModuleSpec;
  try { spec = await c.req.json() as CoreModuleSpec; }
  catch { return c.json({ ok: false, error: "Malformed JSON body" }, 400); }
  const result = await buildCoreModule(spec);
  return c.json(result);
});

app.get("/built/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const p = cachePathFor(id);
    await stat(p);
    const buf = await readFile(p);
    return new Response(buf, {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${safeId(id)}.lgx"`,
      },
    });
  } catch {
    return c.text("not found", 404);
  }
});

serve({ fetch: app.fetch, port: PORT, hostname: "0.0.0.0" }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`[lgx build-worker] listening on http://0.0.0.0:${info.port}`);
  // eslint-disable-next-line no-console
  console.log(`  auth: ${TOKEN ? "bearer token required" : "open (no token)"}`);
  // eslint-disable-next-line no-console
  console.log(`  cors origins: ${ALLOWED_ORIGINS.join(", ")}`);
});
