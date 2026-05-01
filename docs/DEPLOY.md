# Deploy guide — lgx.guru deployment modes

This repo supports two install modes from one codebase:

| Mode | Audience | Editor host | C++ module builds | LLM key |
|---|---|---|---|---|
| **Managed** (`lgx.guru`) | casual users, public link | Vercel | GitHub Actions (BYO PAT) | ours |
| **npx package** (`npx lgx-builder`) | developers, full local | localhost | localhost (in-process `nix build`) | user's |

Both modes share the same Next.js app. They differ only in `LGX_BUILD_BACKEND` and which artifact-build path the user takes when they have a custom C++ core module.

---

## Phase 1A — Managed deploy (`lgx.guru`)

### 1. DNS at GoDaddy

Domain bought at GoDaddy, DNS managed there too. Two records:

| Type | Name | Value | TTL |
|---|---|---|---|
| `A` | `@` | `76.76.21.21` (Vercel's apex IP) | 1 Hour |
| `CNAME` | `www` | `cname.vercel-dns.com.` | 1 Hour |

Notes:
- `@` is the apex (`lgx.guru`). GoDaddy doesn't allow CNAME at apex, so Vercel uses an A record. `76.76.21.21` is their stable anycast IP.
- `www` is the conventional subdomain; Vercel auto-redirects `www.lgx.guru` → `lgx.guru` once both are added in its dashboard.

DNS propagation typically takes 5–60 min. After it resolves, Vercel issues TLS automatically.

### 2. Vercel project

```bash
# In ./web/
vercel link            # one-time, creates .vercel/project.json
vercel --prod          # deploys production

# Set env vars (Vercel dashboard → Project → Settings → Environment Variables):
NVIDIA_API_KEY=...                  # or OPENAI_API_KEY
LGX_BUILD_BACKEND=disabled          # Vercel can't run nix
NEXT_PUBLIC_RENDERER_URL=/renderer/index.html  # default; override if needed
```

`LGX_BUILD_BACKEND=disabled` short-circuits the AI's `build_backend_module` tool with a friendly message pointing users at either:
- `npx lgx-builder@latest` for in-process builds with full AI iteration (compile + tests in the loop)
- The export-modal "Build via GitHub" path for cross-platform `.lgx` packaging (no compile feedback during AI iteration, but works without local nix)

### 3. Domain in Vercel

Vercel dashboard → Project → Settings → Domains → add `lgx.guru`. Vercel will issue TLS automatically once DNS resolves.

---

## Phase 1B — npx package distribution

The same `web/` is published to npm as `lgx-builder` so users can run:

```bash
npx lgx-builder@latest
```

### One-time setup

1. Flip `"private": true` → `false` in `web/package.json`.
2. Pick a public org/scope (e.g. publish as `@lgx/builder` instead of `lgx-builder` if `lgx-builder` is taken).
3. `npm login` with an account that has publish rights.

### Publish

```bash
cd web
pnpm build                        # produces .next/standalone
pnpm sync-renderer                # ensures public/renderer/ has fresh wasm
npm publish --access public
```

After publish, anyone can:

```bash
NVIDIA_API_KEY=... npx lgx-builder@latest
# → opens http://localhost:3000/dashboard
```

For full features (AI-built C++ modules with compile-error iteration), users also need:
- `nix` on PATH (https://nixos.org/download)
- Optionally `LGX_BUILD_BACKEND=local` (the default).

If they don't have nix, the editor still works — visual editing, AI for QML/triggers, and the GitHub Actions export path all function without it. Only the in-process `build_backend_module` tool returns a friendly "install nix locally or use Build via GitHub" error.

---

## Cross-platform .lgx via GitHub Actions

The export modal's "Build via GitHub" radio is the user-facing path that handles macOS + Linux builds without any server-side build infrastructure. See `templates/github-actions/README.md` for the workflow shape.

User flow:
1. User configures a fine-grained PAT in the export modal (stored in localStorage; never sent to lgx.guru's server).
2. Clicking Export pushes the codegen + workflow to their GitHub repo via the REST API.
3. Actions runs the matrix build (ubuntu + macos), uploads variant artifacts, the merge job fuses them into a single multi-arch `.lgx`.
4. The browser downloads the merged `.lgx` from the release artifact.

`web/src/app/lib/githubBuilder.ts` owns the client-side push/poll/download. The bundled workflow + merge tool live under `templates/github-actions/`.

---

## Cost reality

- **Vercel**: free tier (100 GB egress/mo) covers thousands of users. Pro is $20/mo per seat — only needed at scale or for team features.
- **GitHub Actions**: free for public repos; private repos get 2,000 minutes/mo on the free tier. Each cross-platform build uses ~5–10 min total (linux + darwin in parallel, plus a tiny merge job).
- **LLM**: NVIDIA NIM has a free tier; OpenAI/Anthropic charge per request. Budget ~$0.01–0.05 per `Ask AI` call depending on prompt size.

Total fixed monthly cost: $0. Variable: LLM usage.

---

## Local dev

```bash
# Terminal 1 — editor
cd web
pnpm install
NVIDIA_API_KEY=... pnpm dev
# → http://localhost:3000

# Terminal 2 (optional — for renderer iteration)
cd renderer && python3 serve.py 8765
# Then in terminal 1: NEXT_PUBLIC_RENDERER_URL=http://127.0.0.1:8765/index.html pnpm dev

# To rebuild the .wasm:
cd renderer/build
source /Users/guru/emsdk/emsdk_env.sh
ninja
cd ../../web
pnpm sync-renderer        # copies new wasm into public/renderer/
```
