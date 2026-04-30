# lgx.guru build worker — runs nix-build inside Docker for the Vercel-hosted
# editor. Multi-stage so the runtime image stays focused: nixos/nix base
# (which ships with the nix daemon + experimental flakes already enabled)
# plus our small Hono server.

# ── deps + transpile stage ────────────────────────────────────────────────
FROM node:22-bookworm AS build-stage
WORKDIR /app
COPY package.json tsconfig.json ./
RUN corepack enable && corepack prepare pnpm@9 --activate \
    && pnpm install --frozen-lockfile=false
COPY src ./src
RUN pnpm build

# ── runtime stage ────────────────────────────────────────────────────────
FROM nixos/nix:2.24.10 AS runtime
# Allow flakes — the editor's flake.nix expects them.
RUN mkdir -p /etc/nix && \
    echo "experimental-features = nix-command flakes" >> /etc/nix/nix.conf && \
    echo "trusted-users = root" >> /etc/nix/nix.conf

# Install Node so we can run the built JS server. nixos/nix is a thin Alpine-
# like image; pull node from nixpkgs to keep the image self-consistent.
# `nix-env -iA` is the older command but still supported and doesn't trip the
# pure-eval check that `nix profile install nixpkgs#…` does on recent nix
# versions ("access to absolute path … forbidden in pure evaluation mode").
RUN nix-channel --add https://nixos.org/channels/nixpkgs-unstable nixpkgs && \
    nix-channel --update && \
    nix-env -iA nixpkgs.nodejs_22

WORKDIR /app
COPY --from=build-stage /app/dist ./dist
COPY --from=build-stage /app/node_modules ./node_modules
COPY package.json ./

# Pre-warm the nix store with logos-module-builder so the first user build
# isn't catastrophic on a cold worker. Optional — comment out for faster
# image builds during development.
# RUN nix build --no-link 'github:logos-co/logos-module-builder' || true

ENV PORT=7878
ENV NODE_ENV=production
EXPOSE 7878

CMD ["node", "dist/index.js"]
