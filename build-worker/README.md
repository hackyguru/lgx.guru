# lgx.guru build worker

HTTP wrapper around `nix build` for the lgx.guru editor's `build_backend_module` flow. Deployed to Hetzner (or any Linux box with nix). Called by the Vercel-hosted editor when `LGX_BUILD_BACKEND=remote`.

## Endpoints

- `GET /health` — liveness probe; returns `{ ok: true, nix: "/nix/var/.../bin/nix" }`.
- `POST /build` — body: `CoreModuleSpec` JSON (with rendered codegen files); returns `BuildResult` JSON.
- `GET /built/:id` — returns the cached `.lgx` bytes for module `<id>`.

## Env

| Variable | Purpose |
|---|---|
| `PORT` | Listening port (default `7878`). |
| `LGX_BUILD_WORKER_TOKEN` | Optional bearer token; when set, every request must send `Authorization: Bearer <token>`. **Required** for managed mode (Hetzner-exposed); optional for daemon mode (localhost-only). |
| `LGX_ALLOWED_ORIGINS` | Comma-sep CORS allowlist. Default `*`. For managed: `https://lgx.guru`. |

## Run locally (development)

```bash
pnpm install
pnpm dev
# -> http://localhost:7878/health
```

Point the editor at it:

```bash
cd ../web
LGX_BUILD_BACKEND=remote LGX_BUILD_WORKER_URL=http://localhost:7878 pnpm dev
```

## Deploy to Hetzner

```bash
docker build -t lgx-build-worker:latest .
docker run -d \
  --name lgx-build-worker \
  -p 7878:7878 \
  -e LGX_BUILD_WORKER_TOKEN=$(openssl rand -hex 32) \
  -e LGX_ALLOWED_ORIGINS=https://lgx.guru \
  --restart unless-stopped \
  lgx-build-worker:latest
```

Then on Vercel, set:

- `LGX_BUILD_BACKEND=remote`
- `LGX_BUILD_WORKER_URL=https://build.lgx.guru`
- `LGX_BUILD_WORKER_TOKEN=<same token as above>`

## Notes

- The first build of a module is **slow** (~5–10 min): nix downloads the entire Logos SDK and all transitive deps. Subsequent builds reuse the nix store and the per-module `flake.lock`, so they finish in seconds.
- The worker keeps build dirs in `/tmp/lgx-builds/<id>/`. Each module id gets a stable dir so nix's eval cache + flake.lock survive across builds.
- `.lgx` cache lives at `/tmp/lgx-builds/<id>.lgx`. Survives across requests but is wiped on container restart — that's fine for the current flow (the editor rebuilds on demand).
