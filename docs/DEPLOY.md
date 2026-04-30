# Deploy guide — lgx.guru three deployment modes

This repo supports three install modes from one codebase:

| Mode | Audience | Editor host | Build host | LLM key |
|---|---|---|---|---|
| **Managed** (`lgx.guru`) | casual users, public link | Vercel | Hetzner | ours |
| **npx package** (`npx lgx-builder`) | developers, full local | localhost | localhost (in-process) | user's |
| **Daemon mode** (planned, phase 2) | privacy-first | lgx.guru (cloud UI) | localhost (`lgx-daemon`) | user's |

Phase 1 (managed + npx) is what's documented below. Daemon mode is sketched in `build-worker/README.md`.

---

## Phase 1A — Managed deploy (`lgx.guru`)

### 1. DNS at GoDaddy

Domain bought at GoDaddy, DNS managed there too. Three records:

| Type | Name | Value | TTL |
|---|---|---|---|
| `A` | `@` | `76.76.21.21` (Vercel's apex IP) | 1 Hour |
| `CNAME` | `www` | `cname.vercel-dns.com.` | 1 Hour |
| `A` | `build` | `<your Hetzner IPv4>` | 1 Hour |

Notes:
- `@` is the apex (`lgx.guru`). GoDaddy doesn't allow CNAME at apex, so Vercel uses an A record. `76.76.21.21` is their stable anycast IP.
- `www` is the conventional subdomain; Vercel auto-redirects `www.lgx.guru` → `lgx.guru` once both are added in its dashboard.
- `build` is your Hetzner box. No CDN in front — Caddy on the box terminates TLS.

DNS propagation typically takes 5–60 min. After it resolves, Vercel issues TLS automatically.

(If you ever want CDN/DDoS/analytics, you can switch GoDaddy → Cloudflare DNS later by changing nameservers — no record reconfig needed since the values stay the same.)

### 2. Hetzner build worker

```bash
# On a fresh CPX21 (€5.83/mo, 4GB RAM, 80GB disk — recommended minimum):

# 1. Install Docker
curl -fsSL https://get.docker.com | sh

# 2. Clone + build the worker
git clone https://github.com/<you>/lgx-builder.git
cd lgx-builder/build-worker
docker build -t lgx-build-worker:latest .

# 3. Generate an auth token (save this — you'll set it on Vercel too)
TOKEN=$(openssl rand -hex 32)
echo "$TOKEN" > ~/lgx-build-worker.token
chmod 600 ~/lgx-build-worker.token

# 4. Run the container
docker run -d \
  --name lgx-build-worker \
  -p 127.0.0.1:7878:7878 \
  -v lgx-builds:/tmp/lgx-builds \
  -e LGX_BUILD_WORKER_TOKEN="$TOKEN" \
  -e LGX_ALLOWED_ORIGINS=https://lgx.guru \
  --restart unless-stopped \
  lgx-build-worker:latest

# 5. Caddy in front of it for TLS termination
sudo apt install -y caddy
sudo tee /etc/caddy/Caddyfile <<'EOF'
build.lgx.guru {
  reverse_proxy 127.0.0.1:7878
  encode gzip
}
EOF
sudo systemctl restart caddy

# 6. Verify
curl https://build.lgx.guru/health
# {"ok":true,"nix":"/nix/var/nix/profiles/default/bin/nix"}
```

### 3. Vercel project

```bash
# In ./web/
vercel link            # one-time, creates .vercel/project.json
vercel --prod          # deploys production

# Set env vars (in Vercel dashboard → Project → Settings → Environment Variables):
NVIDIA_API_KEY=...                  # or OPENAI_API_KEY
LGX_BUILD_BACKEND=remote
LGX_BUILD_WORKER_URL=https://build.lgx.guru
LGX_BUILD_WORKER_TOKEN=<same token as Hetzner>
NEXT_PUBLIC_RENDERER_URL=/renderer/index.html  # default; override if needed
```

### 4. Domain in Vercel

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

For full features (AI-built C++ modules), users also need:
- `nix` on PATH (https://nixos.org/download)
- Optionally `LGX_BUILD_BACKEND=local` (the default).

If they don't have nix, the editor still works — only `build_backend_module` returns a friendly "install nix locally" error.

---

## Phase 2 — Daemon mode (cloud UI + local builds)

**Status: architected, not yet shipped.** The pieces are in place:

- The build worker (`build-worker/`) already runs as a self-contained Docker image.
- The editor's `Builder` dispatch (`web/src/app/lib/buildModule.ts`) reads `LGX_BUILD_BACKEND` at server-bootstrap time.

To finish phase 2:

1. Make `LGX_BUILD_BACKEND` selectable per-request (e.g. via cookie set by the editor when daemon is detected) instead of server-bootstrap-only.
2. Add a small `lgx-daemon` CLI that wraps the build-worker Docker image (`lgx-daemon start` / `stop` / `status`).
3. In the editor, ping `http://localhost:7878/health` on load. Show a "🟢 Local daemon" pill when detected; route AI build calls to it.
4. Document install: `brew install lgx-daemon` (Homebrew tap) or `pnpm dlx lgx-daemon start`.

Roughly half a day of work. Defer until phase 1 has actual users asking for it.

---

## Cost reality

- **Vercel**: free tier (100 GB egress/mo) covers thousands of users. Pro is $20/mo per seat — only needed at scale or for team features.
- **Hetzner CPX21**: €5.83/mo. Handles dozens of concurrent builds easily. The first build of a fresh module is slow (~5–10 min, downloads SDK), subsequent builds for the same `id` reuse the nix store and finish in seconds.
- **Cloudflare**: DNS is free; CF Registrar is at-cost.
- **LLM**: NVIDIA NIM has a free tier; OpenAI/Anthropic charge per request. Budget ~$0.01–0.05 per `Ask AI` call depending on prompt size.

Total fixed monthly cost: ~€6 (Hetzner only). Variable: LLM usage.

---

## Local dev (unchanged from before)

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
