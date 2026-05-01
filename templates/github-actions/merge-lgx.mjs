#!/usr/bin/env node
// merge-lgx — combine per-arch single-variant .lgx files into one multi-arch
// .lgx that any Basecamp host can install regardless of OS.
//
// Usage:
//   node tools/merge-lgx.mjs <variants-dir> <output.lgx>
//
// Where <variants-dir> contains subdirs (one per arch) each holding a
// single-variant .lgx file. This is exactly what GitHub Actions'
// download-artifact action produces when you upload one artifact per
// matrix job named after the arch.
//
// Layout produced (matches logos-package's canonical lgx tar shape):
//   manifest.json
//   variants/
//   variants/darwin-arm64/<plugin>.dylib
//   variants/darwin-arm64/metadata.json
//   variants/linux-amd64/<plugin>.so
//   variants/linux-amd64/metadata.json
//   ... etc.
//
// Hashes use the canonical Merkle tree from logos-package's
// crypto/signing.cpp::computeMerkleTree:
//   leaf(dir)    = SHA256( for each file sorted by relPath:
//                          relPath + '\0' + sha256hex(content) + '\n' )
//   parent(map)  = SHA256( for each child sorted by name:
//                          name    + '\0' + childHash         + '\n' )
//   variants     = parent({ <arch>: leaf("variants/<arch>"), ... })
//   root         = parent({ variants: variantsHash, ... })
//
// manifest.json + manifest.sig are excluded from hashing (they describe
// the hash; they can't reference themselves).

import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

// ── tiny tar reader/writer (deterministic, USTAR) ─────────────────────────
//
// Same wire format as web/src/app/lgxExport.ts. Independent reimplementation
// so this script has zero deps beyond node:*.

const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");

function* readTar(buffer) {
  let off = 0;
  while (off + 512 <= buffer.length) {
    const header = buffer.subarray(off, off + 512);
    // Empty block = end of archive (two trailing zero blocks per spec).
    if (header.every((b) => b === 0)) break;

    const nameEnd = header.indexOf(0, 0, "ascii");
    const name = header.subarray(0, nameEnd >= 0 ? nameEnd : 100).toString("ascii");

    const sizeOctal = header.subarray(124, 124 + 11).toString("ascii").trim();
    const size = parseInt(sizeOctal || "0", 8);

    const typeflag = header[156];
    const isDir = typeflag === 0x35 || name.endsWith("/");

    off += 512;
    const data = isDir ? Buffer.alloc(0) : buffer.subarray(off, off + size);
    if (!isDir) {
      off += Math.ceil(size / 512) * 512;     // round up to 512 boundary
    }

    // Skip PAX/GNU extended headers — these are tar metadata about the
    // NEXT entry, not user files. BSD tar on macOS emits 'x' (per-file
    // extended) and 'g' (global) headers; some tools emit 'L'/'K' for
    // long names. They show up as fake "PaxHeader/<name>" directories
    // if you naively yield them.
    if (typeflag === 0x78 || typeflag === 0x67     // 'x', 'g'
     || typeflag === 0x4c || typeflag === 0x4b) {  // 'L', 'K'
      continue;
    }
    // Skip files whose path begins with "PaxHeader/" — same reason, just
    // the path-based variant some tar variants emit.
    if (/(^|\/)PaxHeader(\/|$)/.test(name)) continue;

    // Normalize: strip trailing slash (dir) AND any leading "./" that
    // some tar implementations (BSD tar on macOS) prepend.
    const normalized = name.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
    yield { path: normalized, isDir, data };
  }
}

function writeTarHeader(item) {
  const h = Buffer.alloc(512);
  let p = item.path.replace(/^\/+/, "").replace(/\/+$/, "");
  if (item.isDir) p += "/";
  if (p.length > 100) throw new Error(`tar path too long: ${p}`);
  h.write(p, 0, 100, "ascii");

  const writeOctal = (offset, len, value) => {
    const oct = value.toString(8);
    const padded = oct.padStart(len - 1, "0");
    h.write(padded, offset, len - 1, "ascii");
    h[offset + len - 1] = 0;
  };

  const mode = item.isDir ? 0o755 : 0o644;
  writeOctal(100, 8, mode);
  writeOctal(108, 8, 0);                             // uid
  writeOctal(116, 8, 0);                             // gid
  writeOctal(124, 12, item.isDir ? 0 : item.data.length);
  writeOctal(136, 12, 0);                            // mtime — deterministic

  // Checksum: spaces, then computed.
  for (let i = 148; i < 156; i++) h[i] = 0x20;

  h[156] = item.isDir ? 0x35 : 0x30;                 // typeflag
  h.write("ustar", 257, 5, "ascii");
  h[262] = 0;
  h[263] = 0x30;
  h[264] = 0x30;
  writeOctal(329, 8, 0);                             // devmajor
  writeOctal(337, 8, 0);                             // devminor

  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  const cs = sum.toString(8).padStart(6, "0");
  h.write(cs, 148, 6, "ascii");
  h[154] = 0;
  h[155] = 0x20;
  return h;
}

function buildTar(items) {
  const norm = (it) => {
    let p = it.path.replace(/^\/+/, "").replace(/\/+$/, "");
    if (it.isDir) p += "/";
    return p;
  };
  const sorted = [...items].sort((a, b) => {
    const na = norm(a), nb = norm(b);
    return na < nb ? -1 : na > nb ? 1 : 0;
  });

  const chunks = [];
  for (const it of sorted) {
    chunks.push(writeTarHeader(it));
    if (!it.isDir && it.data.length > 0) {
      chunks.push(it.data);
      const pad = Math.ceil(it.data.length / 512) * 512 - it.data.length;
      if (pad > 0) chunks.push(Buffer.alloc(pad));
    }
  }
  // Two trailing zero blocks = end-of-archive marker.
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

// ── Merkle-tree hashing (matches lgxExport.ts) ─────────────────────────────

function leafDirHash(files) {
  if (files.length === 0) return "";
  const sorted = [...files].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const parts = [];
  for (const f of sorted) {
    parts.push(Buffer.from(f.rel, "utf-8"));
    parts.push(Buffer.from([0]));
    parts.push(Buffer.from(sha256Hex(f.data), "utf-8"));
    parts.push(Buffer.from([0x0a]));
  }
  return sha256Hex(Buffer.concat(parts));
}

function parentDirHash(children) {
  const keys = Object.keys(children).sort();
  if (keys.length === 0) return "";
  const parts = [];
  for (const k of keys) {
    parts.push(Buffer.from(k, "utf-8"));
    parts.push(Buffer.from([0]));
    parts.push(Buffer.from(children[k], "utf-8"));
    parts.push(Buffer.from([0x0a]));
  }
  return sha256Hex(Buffer.concat(parts));
}

// ── extract a single .lgx into { variantArch, files: [{rel, data}] } ──────

function extractLgx(lgxPath) {
  const gzipped = readFileSync(lgxPath);
  const tar = gunzipSync(gzipped);
  const variants = {};   // arch → [{ rel: "<filename>", data }]
  let topManifest = null;

  for (const entry of readTar(tar)) {
    if (entry.isDir) continue;
    if (entry.path === "manifest.json") {
      topManifest = JSON.parse(entry.data.toString("utf-8"));
      continue;
    }
    const m = entry.path.match(/^variants\/([^/]+)\/(.+)$/);
    if (!m) continue;
    const arch = m[1];
    const rel = m[2];
    if (!variants[arch]) variants[arch] = [];
    variants[arch].push({ rel, data: entry.data });
  }

  if (!topManifest) {
    throw new Error(`No manifest.json found in ${lgxPath}`);
  }
  return { topManifest, variants };
}

// ── merge ──────────────────────────────────────────────────────────────────

function mergeLgx(inputPaths, outputPath) {
  if (inputPaths.length === 0) {
    throw new Error("No input .lgx files supplied");
  }

  const allVariants = {};         // arch → file list
  const mergedMain = {};          // arch → main filename
  let merged = null;              // first input's manifest used as base

  for (const p of inputPaths) {
    const { topManifest, variants } = extractLgx(p);
    if (merged === null) {
      merged = JSON.parse(JSON.stringify(topManifest));
    } else {
      // Sanity check — these fields should agree across inputs.
      for (const k of ["name", "version", "type", "category"]) {
        if (topManifest[k] !== merged[k]) {
          console.warn(
            `[merge-lgx] WARN: ${p} disagrees on ${k}: ${topManifest[k]} vs ${merged[k]} (taking the first)`,
          );
        }
      }
    }
    // Collect main entries from each input.
    if (topManifest.main && typeof topManifest.main === "object") {
      for (const arch of Object.keys(topManifest.main)) {
        mergedMain[arch] = topManifest.main[arch];
      }
    }
    // Collect variant directories.
    for (const arch of Object.keys(variants)) {
      if (allVariants[arch]) {
        console.warn(`[merge-lgx] WARN: variant ${arch} appears in multiple inputs; using last`);
      }
      allVariants[arch] = variants[arch];
    }
  }

  // Recompute hashes. Per-variant leaf hashes first.
  const variantHashes = {};
  for (const arch of Object.keys(allVariants)) {
    variantHashes[arch] = leafDirHash(allVariants[arch]);
  }
  const variantsHash = parentDirHash(variantHashes);
  const rootHash = parentDirHash({ variants: variantsHash });

  // Assemble final manifest (same field order as lgxExport for cosmetic
  // diff stability; values match the new merged variant set).
  const finalManifest = {
    author: merged.author ?? "",
    category: merged.category,
    dependencies: merged.dependencies ?? [],
    description: merged.description,
    hashes: {
      root: rootHash,
      variants: variantsHash,
      ...Object.fromEntries(
        Object.entries(variantHashes).map(([a, h]) => [`variants/${a}`, h]),
      ),
    },
    icon: merged.icon ?? "",
    main: mergedMain,
    manifestVersion: merged.manifestVersion ?? "0.2.0",
    name: merged.name,
    type: merged.type,
    version: merged.version,
    view: merged.view ?? "",
  };

  // Render manifest deterministically (alphabetically sorted keys, 2-space
  // indent). nlohmann::json default — what shipped .lgx files use.
  const manifestSorted = {};
  for (const k of Object.keys(finalManifest).sort()) {
    const v = finalManifest[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const inner = {};
      for (const ik of Object.keys(v).sort()) inner[ik] = v[ik];
      manifestSorted[k] = inner;
    } else {
      manifestSorted[k] = v;
    }
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifestSorted, null, 2), "utf-8");

  // Build tar entries: manifest.json, variants/ dir, per-arch dir + files.
  const items = [
    { path: "manifest.json", isDir: false, data: manifestBytes },
    { path: "variants",      isDir: true,  data: Buffer.alloc(0) },
  ];
  for (const arch of Object.keys(allVariants).sort()) {
    items.push({ path: `variants/${arch}`, isDir: true, data: Buffer.alloc(0) });
    for (const f of allVariants[arch]) {
      items.push({
        path: `variants/${arch}/${f.rel}`,
        isDir: false,
        data: f.data,
      });
    }
  }

  const tarBytes = buildTar(items);
  const gzBytes = gzipSync(tarBytes, { level: 9 });

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, gzBytes);

  // Report.
  console.log(`[merge-lgx] wrote ${outputPath}`);
  console.log(`  size: ${(gzBytes.length / 1024).toFixed(1)} KB`);
  console.log(`  variants: ${Object.keys(allVariants).sort().join(", ")}`);
  console.log(`  main: ${JSON.stringify(mergedMain)}`);
  console.log(`  rootHash: ${rootHash}`);
}

// ── CLI ────────────────────────────────────────────────────────────────────

const [, , inputArg, outputArg] = process.argv;
if (!inputArg || !outputArg) {
  console.error("Usage: merge-lgx.mjs <variants-dir-or-glob> <output.lgx>");
  process.exit(2);
}

// Find every .lgx under the input dir, recursively. (GitHub Actions'
// download-artifact unpacks each artifact into its own subdir under the
// path you give, so we walk one level deep.)
function findLgxFiles(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...findLgxFiles(p));
    } else if (ent.name.endsWith(".lgx")) {
      out.push(p);
    }
  }
  return out;
}

let inputs;
try {
  const st = statSync(inputArg);
  inputs = st.isDirectory() ? findLgxFiles(inputArg) : [inputArg];
} catch (e) {
  console.error(`Cannot stat ${inputArg}: ${e.message}`);
  process.exit(1);
}

if (inputs.length === 0) {
  console.error(`No .lgx files found under ${inputArg}`);
  process.exit(1);
}

console.log(`[merge-lgx] inputs:`);
for (const p of inputs) console.log(`  ${p}`);

mergeLgx(inputs, outputArg);
