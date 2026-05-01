// Client-side GitHub Actions build pipeline. Pushes a CoreModuleSpec's
// codegen output + the multi-arch workflow YAML + merge tool to a user's
// GitHub repo, triggers the workflow, polls for completion, and returns
// the merged multi-arch .lgx as a Blob ready to save.
//
// Runs entirely in the BROWSER — talks to api.github.com directly using
// the user's fine-grained PAT (stored in localStorage). The editor's
// Vercel functions are bypassed for builds, which:
//   - Eliminates the 10–60s Vercel function timeout problem (browser
//     can poll for 10+ min).
//   - Keeps the user's source on their own GitHub account; lgx.guru
//     never touches it.
//   - Makes the PAT trust transfer literal: user holds the token,
//     lgx.guru never sees it server-side.
//
// Compose with `generateCoreModuleFiles` in the codegen module to
// produce the file list, then pass it here along with the user's
// repo + token.

import type { CodegenFile } from "../codegen/coreModule";

// ── Workflow + merge-tool templates ────────────────────────────────────────
//
// Static text bundled with the editor at build time. Pushed verbatim to
// the user's repo on every build so the workflow always matches the
// editor version (drifting templates would mean the editor expects an
// artifact name the workflow doesn't produce).
//
// In production, these come from templates/github-actions/{build-lgx.yml,
// merge-lgx.mjs}. We embed them as string constants in githubTemplates.ts
// (regenerated via `pnpm sync-github-templates` after editing the
// originals) so they ship in the client bundle without any runtime
// fetch or webpack-loader plumbing.

import { BUILD_LGX_YML, MERGE_LGX_MJS } from "./githubTemplates";

// ── GitHub config ──────────────────────────────────────────────────────────

export interface GitHubConfig {
  // "owner/repo" — must already exist; the editor doesn't auto-create.
  // (Auto-create requires repo scope on the PAT, not just contents:write,
  // and the user might want to control where things live.)
  repo: string;
  // Fine-grained PAT scoped to the target repo with these permissions:
  //   - Contents:        Read & write   (push files)
  //   - Workflows:       Read & write   (push .github/workflows/*)
  //   - Actions:         Read           (poll runs, download artifacts)
  //   - Metadata:        Read           (always required)
  // Generate at: https://github.com/settings/personal-access-tokens
  token: string;
}

// ── Progress callbacks ─────────────────────────────────────────────────────

export type BuildPhase =
  | { kind: "pushing";    fileIndex: number; totalFiles: number; path: string }
  | { kind: "triggering" }
  | { kind: "queued" }
  | { kind: "running";    elapsedSec: number; jobName?: string }
  | { kind: "downloading" }
  | { kind: "done";       lgx: Blob }
  | { kind: "error";      message: string; failedJob?: string; logsUrl?: string };

export type ProgressFn = (phase: BuildPhase) => void;

// ── Internals: typed API helpers ──────────────────────────────────────────

const GH_BASE = "https://api.github.com";

function ghHeaders(token: string, accept = "application/vnd.github+json") {
  return {
    "Authorization": `Bearer ${token}`,
    "Accept": accept,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function ghFetch<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${GH_BASE}${path}`, {
    ...init,
    headers: { ...ghHeaders(token), ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub ${init?.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 500)}`);
  }
  // Many GitHub endpoints return 204 No Content with an empty body — most
  // notably workflow_dispatch. Calling .json() on an empty response throws
  // "Unexpected end of JSON input". Detect and return undefined so callers
  // that don't care about the body (T = unknown) work cleanly.
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return undefined as T;
  }
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

// Push a single file. Uses the contents API which handles both create
// (no sha needed) and update (sha required). We always GET first to find
// out — saves a round trip when the file already exists with the same
// content (no-op).
async function pushFile(
  cfg: GitHubConfig,
  filePath: string,
  contentBytes: Uint8Array,
  message: string,
): Promise<void> {
  // Try to GET the existing file — if it exists, we get the sha needed
  // to update it. If 404, this is a create (no sha).
  let existingSha: string | undefined;
  try {
    const existing = await ghFetch<{ sha: string; content?: string }>(
      cfg.token,
      `/repos/${cfg.repo}/contents/${encodeURIComponent(filePath)}`,
    );
    existingSha = existing.sha;
  } catch (e) {
    if (!(e as Error).message.includes("404")) throw e;
  }

  const contentB64 = btoa(
    Array.from(contentBytes, (b) => String.fromCharCode(b)).join(""),
  );

  await ghFetch<unknown>(cfg.token, `/repos/${cfg.repo}/contents/${encodeURIComponent(filePath)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      content: contentB64,
      ...(existingSha ? { sha: existingSha } : {}),
    }),
  });
}

interface WorkflowRun {
  id: number;
  name?: string;
  status: "queued" | "in_progress" | "completed" | "waiting" | "pending";
  conclusion: "success" | "failure" | "cancelled" | "skipped" | "neutral" | "timed_out" | "action_required" | null;
  created_at: string;
  html_url: string;
  head_sha: string;
}

interface ArtifactsResponse {
  artifacts: { id: number; name: string; archive_download_url: string }[];
}

// Find the most recent run on `main` for this workflow, created after a
// known timestamp (so we don't mistakenly pick up an old run someone
// triggered manually).
async function findOurRun(
  cfg: GitHubConfig,
  workflowFile: string,
  triggeredAfter: Date,
): Promise<WorkflowRun | null> {
  const path = `/repos/${cfg.repo}/actions/workflows/${workflowFile}/runs?per_page=10&branch=main`;
  const data = await ghFetch<{ workflow_runs: WorkflowRun[] }>(cfg.token, path);
  // The runs list is descending by created_at. The first run with
  // created_at >= triggeredAfter is ours (workflow_dispatch creates a
  // run almost immediately).
  for (const r of data.workflow_runs) {
    if (new Date(r.created_at) >= triggeredAfter) return r;
  }
  return null;
}

// Poll a single run until it completes. Reports progress on every poll.
async function waitForRun(
  cfg: GitHubConfig,
  runId: number,
  startedAt: Date,
  onProgress?: ProgressFn,
): Promise<WorkflowRun> {
  for (let attempt = 0; attempt < 240; attempt++) {  // 240 * 5s = 20 min cap
    const run = await ghFetch<WorkflowRun>(cfg.token, `/repos/${cfg.repo}/actions/runs/${runId}`);
    const elapsedSec = Math.floor((Date.now() - startedAt.getTime()) / 1000);
    if (run.status === "completed") return run;
    if (onProgress) {
      if (run.status === "queued" || run.status === "waiting" || run.status === "pending") {
        onProgress({ kind: "queued" });
      } else {
        onProgress({ kind: "running", elapsedSec });
      }
    }
    await sleep(5000);
  }
  throw new Error(`Workflow run ${runId} didn't complete within 20 minutes`);
}

// Fetch the merged-lgx artifact (produced by the workflow's `merge` job)
// and unzip it. Artifacts are returned as a ZIP containing the original
// file(s). For our workflow, one .lgx is inside.
async function downloadMergedLgx(
  cfg: GitHubConfig,
  runId: number,
): Promise<Blob> {
  const list = await ghFetch<ArtifactsResponse>(
    cfg.token,
    `/repos/${cfg.repo}/actions/runs/${runId}/artifacts`,
  );
  const merged = list.artifacts.find((a) => a.name === "merged-lgx");
  if (!merged) {
    throw new Error("merged-lgx artifact not found in workflow run output");
  }
  // Download the artifact ZIP. GitHub redirects to a signed CDN URL;
  // fetch follows redirects automatically, but the response is the ZIP.
  const res = await fetch(
    `${GH_BASE}/repos/${cfg.repo}/actions/artifacts/${merged.id}/zip`,
    { headers: ghHeaders(cfg.token) },
  );
  if (!res.ok) {
    throw new Error(`Artifact download failed: ${res.status}`);
  }
  const zipBytes = new Uint8Array(await res.arrayBuffer());

  // Unzip in-browser. The ZIP contains exactly one .lgx file. We avoid
  // adding jszip — the merge artifact is small (< 1MB typically) and a
  // single-file ZIP is easy to unpack manually if needed. For now we use
  // DecompressionStream which is widely supported in modern browsers.
  const lgxBytes = await unzipFirstFile(zipBytes);
  return new Blob([new Uint8Array(lgxBytes)], { type: "application/octet-stream" });
}

// Minimal single-file ZIP reader. Handles the common case where a GitHub
// Actions artifact ZIP contains a single uncompressed or deflate'd file —
// which is what `actions/upload-artifact` produces.
async function unzipFirstFile(zip: Uint8Array): Promise<Uint8Array> {
  // ZIP local file header: 4-byte signature 0x04034b50 (PK\x03\x04)
  if (zip.length < 30 || zip[0] !== 0x50 || zip[1] !== 0x4b || zip[2] !== 0x03 || zip[3] !== 0x04) {
    throw new Error("Artifact response was not a ZIP archive");
  }
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const compressionMethod = dv.getUint16(8, true);
  const compressedSize = dv.getUint32(18, true);
  const uncompressedSize = dv.getUint32(22, true);
  const fileNameLength = dv.getUint16(26, true);
  const extraFieldLength = dv.getUint16(28, true);
  const dataStart = 30 + fileNameLength + extraFieldLength;
  const compressed = zip.subarray(dataStart, dataStart + compressedSize);

  if (compressionMethod === 0) {
    // Stored (no compression).
    return compressed.slice(0, uncompressedSize);
  }
  if (compressionMethod === 8) {
    // Deflate. Use the browser's DecompressionStream("deflate-raw") to
    // avoid a JS dep.
    const stream = new Blob([new Uint8Array(compressed)]).stream()
      .pipeThrough(new DecompressionStream("deflate-raw"));
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }
  throw new Error(`Unsupported ZIP compression method: ${compressionMethod}`);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Public entry point ────────────────────────────────────────────────────

export async function pushAndBuild(
  cfg: GitHubConfig,
  files: CodegenFile[],
  onProgress?: ProgressFn,
): Promise<Blob> {
  // Validate config early so the caller sees a clear error rather than
  // an opaque GitHub 401 down the line.
  if (!cfg.repo || !cfg.repo.includes("/")) {
    throw new Error(`Invalid repo "${cfg.repo}" — expected "owner/repo"`);
  }
  if (!cfg.token) {
    throw new Error("GitHub PAT not set");
  }

  // The full file set we push: codegen output + workflow YAML +
  // merge tool. The codegen lives at the repo root; the workflow goes
  // under .github/workflows/, the merge tool under tools/.
  const enc = new TextEncoder();
  const allFiles: { path: string; data: Uint8Array }[] = [
    ...files.map((f) => ({ path: f.path, data: f.data })),
    { path: ".github/workflows/build-lgx.yml", data: enc.encode(BUILD_LGX_YML) },
    { path: "tools/merge-lgx.mjs",              data: enc.encode(MERGE_LGX_MJS) },
  ];

  // Push every file. PUT /contents handles both create + update.
  for (let i = 0; i < allFiles.length; i++) {
    const f = allFiles[i];
    onProgress?.({ kind: "pushing", fileIndex: i, totalFiles: allFiles.length, path: f.path });
    await pushFile(cfg, f.path, f.data, `lgx.guru: build ${f.path}`);
  }

  // Trigger the workflow. We record the timestamp first so we can
  // disambiguate the run we just created from any earlier ones.
  onProgress?.({ kind: "triggering" });
  const triggeredAt = new Date();
  // Tiny pause — sometimes the timestamp on GitHub's side is slightly
  // behind, and a too-tight `created_at >= triggeredAt` filter can miss
  // our own run.
  await sleep(500);
  await ghFetch<unknown>(
    cfg.token,
    `/repos/${cfg.repo}/actions/workflows/build-lgx.yml/dispatches`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "main" }),
    },
  );

  // GitHub creates the run lazily — sometimes takes 1–3s before it's
  // visible via the runs API. Poll until we find it.
  let run: WorkflowRun | null = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    await sleep(2000);
    run = await findOurRun(cfg, "build-lgx.yml", triggeredAt);
    if (run) break;
  }
  if (!run) {
    throw new Error("Workflow dispatched but the run never showed up via the API. Check the Actions tab on GitHub.");
  }

  // Wait for it to complete.
  const completed = await waitForRun(cfg, run.id, triggeredAt, onProgress);

  // Did it succeed? The workflow's merge job runs `if: always() &&
  // contains(needs.build.result, 'success')`, so a partial-platform
  // failure can still produce an artifact (Linux-only or macOS-only).
  // Check for *any* artifact rather than insisting on a green run.
  if (completed.conclusion === "success" || completed.conclusion === "neutral") {
    onProgress?.({ kind: "downloading" });
    const lgx = await downloadMergedLgx(cfg, completed.id);
    onProgress?.({ kind: "done", lgx });
    return lgx;
  }

  // Hard failure — both platforms failed or the merge job itself errored.
  // Surface the run URL so the user can drill into Actions logs.
  onProgress?.({
    kind: "error",
    message: `Workflow run ${completed.conclusion ?? "failed"}. Open the Actions tab on GitHub to see logs.`,
    logsUrl: completed.html_url,
  });
  throw new Error(`Workflow ${completed.conclusion}; see ${completed.html_url}`);
}
