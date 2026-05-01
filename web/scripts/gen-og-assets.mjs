#!/usr/bin/env node
/**
 * Generate lgx.guru's static brand assets — favicon set + OG share card.
 *
 * Why static: Next.js's app/opengraph-image conventions only attach to
 * App Router segments. Our landing page is Pages Router, and even the
 * App Router pages get hashed asset URLs in production that aren't
 * stable to reference from the Pages Router. Generating once at build
 * time and shipping under public/ gives us stable URLs both routers
 * can point at.
 *
 * Outputs (in public/):
 *   icon.svg                — favicon for modern browsers (the logo, untouched)
 *   favicon-32.png          — fallback for older clients
 *   favicon-16.png          — same, smaller
 *   apple-touch-icon.png    — 180x180 with ink-on-canvas padding (iOS home screen)
 *   og.png                  — 1200x630 OpenGraph share card
 *   twitter-image.png       — same image, named for Twitter Card metadata
 *
 * Run with: pnpm gen:og
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const publicDir = resolve(root, "public");
mkdirSync(publicDir, { recursive: true });

// ── Source logo ──────────────────────────────────────────────────────────
const logoSvg = readFileSync(resolve(publicDir, "lgx-logo.svg"), "utf8");
// Strip the XML preamble + style tag so we can safely inline the logo
// inside a larger composed SVG without conflicting style scopes.
const logoInline = logoSvg
  .replace(/<\?xml[^?]+\?>/, "")
  .replace(/<style[^>]*>[\s\S]*?<\/style>/, "");

// 1) icon.svg — straight copy of the logo, used as the modern-browser favicon.
copyFileSync(resolve(publicDir, "lgx-logo.svg"), resolve(publicDir, "icon.svg"));

// ── Helpers ──────────────────────────────────────────────────────────────
const writePng = async (svg, outName, width, height) => {
  const buf = await sharp(Buffer.from(svg)).resize(width, height).png().toBuffer();
  writeFileSync(resolve(publicDir, outName), buf);
  console.log(`  ✓ ${outName}  (${width}x${height})`);
};

// 2) Favicons — logo on transparent at common sizes. Using the source SVG
//    so the strokes scale crisply.
await writePng(logoSvg, "favicon-32.png", 32, 32);
await writePng(logoSvg, "favicon-16.png", 16, 16);

// 3) Apple touch icon — 180x180 with breathing room and a canvas background
//    so it sits well on iOS home screens (which apply rounded-rect mask).
const appleIconSvg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180">
  <rect width="180" height="180" fill="#ffffff"/>
  <g transform="translate(30, 30) scale(0.8)">
    ${logoInline.replace(/<svg[^>]*>/, "").replace(/<\/svg>$/, "")}
    <style>.cls-0 {fill:#615e5b;}.cls-1 {fill:#111111;}</style>
  </g>
</svg>`.trim();
await writePng(appleIconSvg, "apple-touch-icon.png", 180, 180);

// 4) OG share card — 1200x630, Titan vocabulary: warm sage backdrop, ink
//    headline with italic accent on "without writing code", lgx logo +
//    domain in mono. Designed once here so every social share platform
//    (X, LinkedIn, Slack, iMessage, etc.) gets a consistent preview.
const ogSvg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630">
  <defs>
    <style>
      .bg { fill: #f3efeb; }
      .ink { fill: #111111; font-family: 'Helvetica Neue', Arial, sans-serif; font-weight: 500; }
      .ink-muted { fill: #615e5b; font-family: 'Helvetica Neue', Arial, sans-serif; font-weight: 400; }
      .accent { fill: #615e5b; font-family: 'Helvetica Neue', Arial, sans-serif; font-weight: 500; font-style: italic; }
      .mono { fill: #615e5b; font-family: 'SF Mono', Menlo, monospace; font-weight: 500; letter-spacing: 0.14em; text-transform: uppercase; }
      .domain { fill: #111111; font-family: 'Helvetica Neue', Arial, sans-serif; font-weight: 500; letter-spacing: -0.02em; }
      .domain-mute { fill: #615e5b; }
      .grid-line { stroke: #d8d3cc; stroke-width: 1; opacity: 0.6; }
    </style>
  </defs>

  <!-- Background -->
  <rect class="bg" width="1200" height="630"/>

  <!-- Subtle dot grid for texture (top-right quadrant only) -->
  <g opacity="0.35">
    ${Array.from({ length: 12 }, (_, r) =>
      Array.from({ length: 16 }, (_, c) =>
        `<circle cx="${600 + c * 36}" cy="${36 + r * 36}" r="1.2" fill="#615e5b"/>`,
      ).join(""),
    ).join("")}
  </g>

  <!-- Logo top-left -->
  <g transform="translate(80, 80) scale(0.6)">
    ${logoInline.replace(/<svg[^>]*>/, "").replace(/<\/svg>$/, "")}
    <style>.cls-0 {fill:#615e5b;}.cls-1 {fill:#111111;}</style>
  </g>

  <!-- Eyebrow label -->
  <text class="mono" x="80" y="290" font-size="20">VISUAL BUILDER FOR LOGOS BASECAMP</text>

  <!-- Headline -->
  <text class="ink" x="80" y="370" font-size="76" letter-spacing="-2.2">Build Basecamp modules</text>
  <text class="accent" x="80" y="455" font-size="76" letter-spacing="-2.2">without writing code.</text>

  <!-- Footer divider + domain + tagline -->
  <line class="grid-line" x1="80" y1="540" x2="1120" y2="540"/>
  <text class="domain" x="80" y="585" font-size="32">
    lgx<tspan class="domain-mute">.guru</tspan>
  </text>
  <text class="ink-muted" x="1120" y="585" font-size="22" text-anchor="end">
    Drag, drop, ship — macOS &amp; Linux.
  </text>
</svg>`.trim();

await writePng(ogSvg, "og.png", 1200, 630);
await writePng(ogSvg, "twitter-image.png", 1200, 630);

console.log("\n✓ All assets generated under /public");
