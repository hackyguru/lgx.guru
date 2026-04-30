import type { NextConfig } from "next";

// Cross-Origin headers for the Qt-WASM renderer. SharedArrayBuffer (used
// internally by the Qt-WASM runtime even in singlethread mode for some
// paths) requires a "cross-origin isolated" context, which means the page
// must serve these two headers. Without them, Qt-WASM aborts at boot.
//
// Scoped to /renderer/* — applying COEP globally would break embedding
// any cross-origin resource elsewhere (e.g. our LLM responses, OAuth
// redirects in the future, etc.).
const nextConfig: NextConfig = {
  // Standalone bundle (a tree-shaken minimal node_modules + a server.js
  // entrypoint) so `npx lgx-builder` ships ~80MB instead of ~400MB. Vercel
  // also picks this up cleanly. No effect on `pnpm dev`.
  output: "standalone",
  async headers() {
    return [
      {
        source: "/renderer/:path*",
        headers: [
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
          { key: "Cross-Origin-Opener-Policy",   value: "same-origin" },
          // The 31MB wasm: cache aggressively but always revalidate so a
          // rebuild + redeploy invalidates immediately when the file mtime
          // changes (Next.js sets ETag automatically).
          { key: "Cache-Control", value: "no-cache" },
        ],
      },
    ];
  },
};

export default nextConfig;
