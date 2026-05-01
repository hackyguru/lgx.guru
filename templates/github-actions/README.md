# lgx.guru build template — GitHub Actions multi-arch

Two files that get pushed into a user's GitHub repo on first build:

- **[`build-lgx.yml`](./build-lgx.yml)** — `.github/workflows/build-lgx.yml` in the repo. Matrix-builds the module on Ubuntu + macOS runners via `nix build .#lgx-portable`, uploads each per-arch `.lgx` as a workflow artifact, then a final `merge` job assembles them into a single multi-variant `.lgx` published as a GitHub Release asset.
- **[`merge-lgx.mjs`](./merge-lgx.mjs)** — `tools/merge-lgx.mjs` in the repo. ~250-line zero-dependency Node script that combines per-arch `.lgx` artifacts into one multi-variant `.lgx` with canonical Merkle hashes (matches `web/src/app/lgxExport.ts`).

## How it fits into the lgx.guru pipeline

```
┌────────────────┐   git push    ┌────────────────────┐
│ lgx.guru editor│ ─────────────▶│ user's GitHub repo │
│ (codegen runs  │  (rendered     │  - source/         │
│  here, sends   │   codegen +    │  - flake.nix       │
│  files via     │   workflow)    │  - .github/.../    │
│  GitHub API)   │                │    build-lgx.yml   │
└────────────────┘                │  - tools/          │
        ▲                         │    merge-lgx.mjs   │
        │                         └─────────┬──────────┘
        │                                   │ on push
        │                                   ▼
        │            ┌──────────────────────────────────────┐
        │            │ GitHub Actions matrix                │
        │            │  ubuntu-latest:  → linux-amd64.lgx   │
        │            │  macos-latest:   → darwin-arm64.lgx  │
        │            │                                      │
        │            │  merge job: variants → multi-arch    │
        │            │             → release asset          │
        │            └─────────────────────┬────────────────┘
        │                                  │
        │  poll Actions API + download     │
        └──────────────────────────────────┘
```

## Setup per user repo

The editor handles this automatically once the GitHub OAuth flow is wired (Phase 3). Manual steps if you want to test the workflow today:

1. Create a new GitHub repo (public is fine — keeps you under no GitHub Actions billing).
2. Copy `build-lgx.yml` to `.github/workflows/build-lgx.yml` in the repo.
3. Copy `merge-lgx.mjs` to `tools/merge-lgx.mjs` in the repo.
4. Drop your codegen output (the files normally produced by `web/src/app/codegen/coreModule.ts`) into the repo root: `flake.nix`, `metadata.json`, `CMakeLists.txt`, `src/`, `tests/`.
5. `git push`. Actions runs. ~5–10 min later (cold cache), check the **Releases** tab for `build-N` with the merged `.lgx` attached.

## Optional: Cachix binary cache

To skip rebuilding the Logos SDK from scratch on every cold runner (saves ~5 min on first build), set up a Cachix cache:

1. Sign up at https://cachix.org, create a cache (free tier is fine).
2. In the user's repo: Settings → Variables → Repository variables → `CACHIX_NAME` = your cache name.
3. Settings → Secrets → `CACHIX_AUTH_TOKEN` = a write token from cachix.

The workflow auto-detects this and pushes substituted derivations on every successful build. Subsequent cold runners pull pre-built artifacts in seconds.

## Implementation notes

- **Permissions**: the workflow needs `contents: write` to publish the release. The default `GITHUB_TOKEN` issued to the workflow has this; nothing extra to configure.
- **Matrix `fail-fast: false`**: when one arch fails, the other still produces an artifact. The `merge` job runs even on partial failure, so users get a single-arch `.lgx` instead of nothing — degraded but useful.
- **Caching**: `actions/cache` keyed on `flake.lock` hash. Same lockfile = warm cache hits, ~30s builds. New lockfile (e.g. user added a dep) = cold build, ~5–10 min.
- **Determinism**: the merge tool produces byte-stable output for a given input set — same hashes, same tar contents, same gzip. Round-trip-tested against `web/src/app/lgxExport.ts`'s canonical hashes.

## Status

- ✅ `build-lgx.yml` — written, untested in CI yet.
- ✅ `merge-lgx.mjs` — written, smoke-tested locally with both round-trip (single variant in/out, identical hashes) and multi-variant assembly (linux + darwin → multi-arch `.lgx`, valid manifest).
- ✅ Editor integration — `web/src/app/BuilderClient.tsx` exposes "Build via GitHub" in the export modal; client-side push + poll lives in `web/src/app/lib/githubBuilder.ts`.
- ☐ GitHub App + OAuth — for the user-facing "sign in with GitHub" install flow (Phase 3).
