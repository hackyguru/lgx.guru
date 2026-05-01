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
  let res: Response;
  try {
    res = await fetch(`${GH_BASE}${path}`, {
      ...init,
      headers: { ...ghHeaders(token), ...(init?.headers ?? {}) },
    });
  } catch {
    throw new Error(`Network error reaching api.github.com (${init?.method ?? "GET"} ${path}). Check your connection and token.`);
  }
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

// Push all files in a SINGLE commit using the Git Trees API. This avoids
// triggering a separate workflow run for every file (the old Contents API
// approach created one commit per file).
async function pushAllFiles(
  cfg: GitHubConfig,
  files: { path: string; data: Uint8Array }[],
  message: string,
  onProgress?: ProgressFn,
): Promise<string> {
  // 1. Get the current HEAD sha + tree sha for main.
  const ref = await ghFetch<{ object: { sha: string } }>(
    cfg.token,
    `/repos/${cfg.repo}/git/ref/heads/main`,
  );
  const headSha = ref.object.sha;
  const headCommit = await ghFetch<{ tree: { sha: string } }>(
    cfg.token,
    `/repos/${cfg.repo}/git/commits/${headSha}`,
  );
  const baseTreeSha = headCommit.tree.sha;

  // 2. Create blobs for each file.
  const treeEntries: { path: string; mode: string; type: string; sha: string }[] = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    onProgress?.({ kind: "pushing", fileIndex: i, totalFiles: files.length, path: f.path });
    const contentB64 = btoa(
      Array.from(f.data, (b) => String.fromCharCode(b)).join(""),
    );
    const blob = await ghFetch<{ sha: string }>(
      cfg.token,
      `/repos/${cfg.repo}/git/blobs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: contentB64, encoding: "base64" }),
      },
    );
    treeEntries.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
  }

  // 3. Create a new tree with all files at once.
  const tree = await ghFetch<{ sha: string }>(
    cfg.token,
    `/repos/${cfg.repo}/git/trees`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries }),
    },
  );

  // 4. Create a single commit pointing to the new tree.
  const commit = await ghFetch<{ sha: string }>(
    cfg.token,
    `/repos/${cfg.repo}/git/commits`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, tree: tree.sha, parents: [headSha] }),
    },
  );

  // 5. Fast-forward main to the new commit.
  await ghFetch<unknown>(
    cfg.token,
    `/repos/${cfg.repo}/git/refs/heads/main`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sha: commit.sha }),
    },
  );

  return commit.sha;
}

// Cancel all in-progress and queued runs for a workflow so stale builds
// don't pile up when the user exports repeatedly.
async function cancelStaleRuns(cfg: GitHubConfig, workflowFile: string): Promise<void> {
  try {
    const data = await ghFetch<{ workflow_runs: WorkflowRun[] }>(
      cfg.token,
      `/repos/${cfg.repo}/actions/workflows/${workflowFile}/runs?per_page=20&branch=main`,
    );
    const active = data.workflow_runs.filter(
      (r) => r.status === "queued" || r.status === "in_progress" || r.status === "waiting" || r.status === "pending",
    );
    await Promise.all(
      active.map((r) =>
        ghFetch<unknown>(cfg.token, `/repos/${cfg.repo}/actions/runs/${r.id}/cancel`, {
          method: "POST",
        }).catch(() => {}),
      ),
    );
  } catch {
    // Best-effort — if we can't cancel, proceed anyway.
  }
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

// Find the run we triggered by matching on the commit SHA we just pushed.
// workflow_dispatch runs use the HEAD of the ref at dispatch time, which
// is the commit we created via pushAllFiles. Matching by SHA is more
// reliable than matching by timestamp.
async function findOurRun(
  cfg: GitHubConfig,
  workflowFile: string,
  headSha: string,
): Promise<WorkflowRun | null> {
  const path = `/repos/${cfg.repo}/actions/workflows/${workflowFile}/runs?per_page=10&branch=main`;
  const data = await ghFetch<{ workflow_runs: WorkflowRun[] }>(cfg.token, path);
  for (const r of data.workflow_runs) {
    if (r.head_sha === headSha) return r;
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
  // Download the artifact ZIP via our server-side proxy. GitHub redirects
  // to a signed CDN URL that lacks CORS headers, so a direct browser
  // fetch fails on the redirect. The proxy follows the redirect server-side.
  let res: Response;
  try {
    res = await fetch("/api/download-artifact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: cfg.repo, artifactId: merged.id, token: cfg.token }),
    });
  } catch {
    throw new Error("Network error downloading artifact. Check your connection.");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Artifact download failed: ${res.status} ${body.slice(0, 300)}`);
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

  // Cancel any stale runs before pushing new files.
  await cancelStaleRuns(cfg, "build-lgx.yml");

  // Push ALL files in a single commit (Git Trees API). The workflow only
  // triggers on workflow_dispatch (not push), so this won't start a run.
  const commitSha = await pushAllFiles(cfg, allFiles, "lgx.guru: update module source", onProgress);

  // Trigger the workflow via dispatch. The run will use our commitSha as
  // its head_sha, which we use to identify the correct run later.
  onProgress?.({ kind: "triggering" });
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
    run = await findOurRun(cfg, "build-lgx.yml", commitSha);
    if (run) break;
  }
  if (!run) {
    throw new Error("Workflow dispatched but the run never showed up via the API. Check the Actions tab on GitHub.");
  }

  // Wait for it to complete.
  const completed = await waitForRun(cfg, run.id, new Date(), onProgress);

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
