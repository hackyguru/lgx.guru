"use client";

// Per-browser GitHub settings: which repo to push specs to + the PAT used
// to authenticate. Stored in localStorage so they're isolated per browser
// and never reach lgx.guru's server. This is the "BYO PAT" MVP — Phase 3
// will replace this with a GitHub App OAuth install flow.

const REPO_KEY = "lgx.guru/v1/github/repo";
const TOKEN_KEY = "lgx.guru/v1/github/token";

export interface GitHubSettings {
  repo: string;     // "owner/repo" — empty string if not configured
  token: string;    // fine-grained PAT — empty string if not configured
}

export const emptySettings: GitHubSettings = { repo: "", token: "" };

export function readGitHubSettings(): GitHubSettings {
  if (typeof window === "undefined") return emptySettings;
  return {
    repo:  window.localStorage.getItem(REPO_KEY)  ?? "",
    token: window.localStorage.getItem(TOKEN_KEY) ?? "",
  };
}

export function writeGitHubSettings(s: GitHubSettings): void {
  if (typeof window === "undefined") return;
  if (s.repo)  window.localStorage.setItem(REPO_KEY,  s.repo);
  else         window.localStorage.removeItem(REPO_KEY);
  if (s.token) window.localStorage.setItem(TOKEN_KEY, s.token);
  else         window.localStorage.removeItem(TOKEN_KEY);
}

export function isGitHubConfigured(s: GitHubSettings): boolean {
  return !!s.repo && s.repo.includes("/") && !!s.token;
}

// Quick PAT validation — confirms the token is valid and has the
// expected permissions on the configured repo. Returns null if all
// looks good, or a human-readable error message describing what's
// missing. Useful for the Settings panel's "Test connection" button.
export async function probeGitHubAccess(s: GitHubSettings): Promise<string | null> {
  if (!s.repo || !s.repo.includes("/")) return "Repo must be in 'owner/repo' format";
  if (!s.token) return "PAT is empty";

  // Verify the token can read the repo + its actions config.
  const headers = {
    "Authorization": `Bearer ${s.token}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${s.repo}`, { headers });
  } catch (e) {
    return `Network error reaching api.github.com: ${(e as Error).message}`;
  }
  if (res.status === 401) return "PAT is invalid (401 Unauthorized)";
  if (res.status === 403) return "PAT lacks read access to this repo (403 Forbidden)";
  if (res.status === 404) return `Repo "${s.repo}" not found, or PAT can't see it (404)`;
  if (!res.ok) return `Unexpected status ${res.status} from GitHub`;

  // Check Actions is enabled — without it, workflow_dispatch will silently no-op.
  const repoInfo = await res.json() as { archived?: boolean; disabled?: boolean };
  if (repoInfo.archived) return "Repo is archived — Actions can't run on archived repos";
  if (repoInfo.disabled) return "Repo is disabled";

  return null;  // ✓ all good
}
