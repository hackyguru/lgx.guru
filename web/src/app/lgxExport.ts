// Pack the generated UI into an .lgx file matching the canonical layout
// produced by logos-co/logos-package's `lgx` CLI. Verified against the
// reference hello_world build at hello-world-ui/result-portable/.
//
// Container: gzipped USTAR tar, deterministic (mtime=0, uid/gid=0, blank
// uname/gname). Layout per variant:
//
//   manifest.json                                       (root)
//   variants/                                           (dir)
//   variants/<arch>/                                    (dir)
//   variants/<arch>/Main.qml
//   variants/<arch>/<icon>.png                          (matches manifest.icon)
//   variants/<arch>/icons/                              (dir)
//   variants/<arch>/icons/<icon>.png
//   variants/<arch>/metadata.json
//
// Hashes use the canonical Merkle tree from logos-package's
// src/crypto/signing.cpp::computeMerkleTree:
//   leaf(dir)    = SHA256( for each file sorted by relPath:
//                          relPath + '\0' + sha256hex(content) + '\n' )
//   parent(map)  = SHA256( for each child sorted by name:
//                          name    + '\0' + childHash         + '\n' )
//   variants     = parent({ <arch>: leaf("variants/<arch>"), ... })
//   root         = parent({ variants: variantsHash, ... })
//
// Manifest excludes itself and manifest.sig from hashing.

import pako from "pako";

export interface ExportConfig {
  name: string;          // e.g. "my_widget" — lowercased
  version: string;       // e.g. "0.1.0"
  description: string;
  category: string;      // e.g. "example"
  iconPng: Uint8Array;   // raw PNG bytes
  iconFilename: string;  // basename only, e.g. "widget.png"
  qmlSource: string;     // full Main.qml including imports
  author?: string;
  // Extra files to bundle alongside Main.qml inside each variant.
  // `rel` is the variant-relative path (e.g. "assets/photo_0.png").
  extraFiles?: { rel: string; data: Uint8Array }[];
}

const ARCHES = ["darwin-arm64", "linux-amd64", "linux-arm64"] as const;

const enc = new TextEncoder();
const textBytes = (s: string) => enc.encode(s);

const sha256Hex = async (data: Uint8Array): Promise<string> => {
  const buf = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

const concatBytes = (parts: Uint8Array[]): Uint8Array => {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
};

// SHA256( for each file sorted by relPath: relPath + '\0' + sha256hex(content) + '\n' )
const leafDirHash = async (
  files: { rel: string; data: Uint8Array }[],
): Promise<string> => {
  if (files.length === 0) return "";
  const sorted = [...files].sort((a, b) =>
    a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0
  );
  const parts: Uint8Array[] = [];
  for (const f of sorted) {
    parts.push(textBytes(f.rel));
    parts.push(new Uint8Array([0]));
    parts.push(textBytes(await sha256Hex(f.data)));
    parts.push(new Uint8Array([0x0a]));
  }
  return sha256Hex(concatBytes(parts));
};

// SHA256( for each child sorted: name + '\0' + childHash + '\n' )
const parentDirHash = async (
  children: Record<string, string>,
): Promise<string> => {
  const keys = Object.keys(children).sort();
  if (keys.length === 0) return "";
  const parts: Uint8Array[] = [];
  for (const k of keys) {
    parts.push(textBytes(k));
    parts.push(new Uint8Array([0]));
    parts.push(textBytes(children[k]));
    parts.push(new Uint8Array([0x0a]));
  }
  return sha256Hex(concatBytes(parts));
};

// ── Tar writer (USTAR, deterministic) ───────────────────────────────────────

interface TarItem { path: string; isDir: boolean; data: Uint8Array }

const tarPad = (size: number) => Math.ceil(size / 512) * 512;

const writeAscii = (out: Uint8Array, off: number, s: string, max: number) => {
  const b = textBytes(s);
  for (let i = 0; i < Math.min(b.length, max); i++) out[off + i] = b[i];
};

// Write zero-padded octal "%0(size-1)o\0". Matches lgx writeOctal exactly.
const writeOctal = (out: Uint8Array, off: number, size: number, value: number) => {
  const oct = value.toString(8);
  const padded = oct.padStart(size - 1, "0");
  for (let i = 0; i < size - 1; i++) out[off + i] = padded.charCodeAt(i);
  out[off + size - 1] = 0;
};

const writeHeader = (item: TarItem): Uint8Array => {
  const h = new Uint8Array(512);
  // Path normalization: strip leading/trailing slashes; add trailing '/' for dirs
  let path = item.path.replace(/^\/+/, "").replace(/\/+$/, "");
  if (item.isDir) path += "/";

  // USTAR can split path into prefix(155) + name(100). We don't expect long
  // paths here, so use the simple case: prefix empty, name = path.
  if (path.length > 100) throw new Error(`tar path too long: ${path}`);
  writeAscii(h, 0, path, 100);

  const mode = item.isDir ? 0o755 : 0o644;
  writeOctal(h, 100, 8, mode);
  writeOctal(h, 108, 8, 0);                                  // uid
  writeOctal(h, 116, 8, 0);                                  // gid
  writeOctal(h, 124, 12, item.isDir ? 0 : item.data.length); // size
  writeOctal(h, 136, 12, 0);                                 // mtime

  // Checksum field initialised to spaces, recalculated below.
  for (let i = 148; i < 156; i++) h[i] = 0x20;

  h[156] = item.isDir ? 0x35 : 0x30;                          // typeflag '5' or '0'
  // linkname (157-256) zeros
  writeAscii(h, 257, "ustar", 5); h[262] = 0;                 // magic
  h[263] = 0x30; h[264] = 0x30;                               // version "00"
  // uname (265-296), gname (297-328) blank
  writeOctal(h, 329, 8, 0);                                   // devmajor
  writeOctal(h, 337, 8, 0);                                   // devminor
  // prefix (345-499) empty

  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  // Checksum field: 6 octal digits + null + space (lgx writes "%06o\0 ")
  const cs = sum.toString(8).padStart(6, "0");
  for (let i = 0; i < 6; i++) h[148 + i] = cs.charCodeAt(i);
  h[154] = 0;
  h[155] = 0x20;
  return h;
};

const buildTar = (items: TarItem[]): Uint8Array => {
  // Sort lexicographically by NORMALISED path (with trailing slash for dirs).
  // Matches DeterministicTarWriter::finalize().
  const norm = (it: TarItem) => {
    let p = it.path.replace(/^\/+/, "").replace(/\/+$/, "");
    if (it.isDir) p += "/";
    return p;
  };
  const sorted = [...items].sort((a, b) => {
    const na = norm(a), nb = norm(b);
    return na < nb ? -1 : na > nb ? 1 : 0;
  });
  let total = 1024; // two trailing zero blocks
  for (const it of sorted) total += 512 + (it.isDir ? 0 : tarPad(it.data.length));
  const out = new Uint8Array(total);
  let off = 0;
  for (const it of sorted) {
    out.set(writeHeader(it), off);
    off += 512;
    if (!it.isDir && it.data.length > 0) {
      out.set(it.data, off);
      off += tarPad(it.data.length);
    }
  }
  return out;
};

// ── Manifest builder ────────────────────────────────────────────────────────

interface Manifest {
  author: string;
  category: string;
  dependencies: string[];
  description: string;
  hashes: Record<string, string>;
  icon: string;
  main: Record<string, string>;
  manifestVersion: string;
  name: string;
  type: string;
  version: string;
  view: string;
}

// Match nlohmann::json default object serialization: keys alphabetically
// sorted, 2-space indent. This is what logos-package writes; matching it
// keeps cosmetic diffs to zero (hashes don't depend on manifest bytes
// since manifest.json is excluded from the Merkle tree, but consistent
// formatting is friendlier to anyone diffing the bundles).
const manifestJson = (m: Manifest): string => {
  const ordered: Record<string, unknown> = {};
  for (const k of Object.keys(m).sort()) {
    const v = (m as unknown as Record<string, unknown>)[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const inner: Record<string, unknown> = {};
      for (const ik of Object.keys(v as Record<string, unknown>).sort()) {
        inner[ik] = (v as Record<string, unknown>)[ik];
      }
      ordered[k] = inner;
    } else {
      ordered[k] = v;
    }
  }
  return JSON.stringify(ordered, null, 2);
};

// ── Public API ──────────────────────────────────────────────────────────────

export interface ExportResult {
  blob: Blob;
  filename: string;
  manifest: Manifest;
}

export const exportLgx = async (cfg: ExportConfig): Promise<ExportResult> => {
  // Per-variant metadata.json (mirrors what hello-world-ui ships inside its
  // variant — keeps the icon path keyed under "icons/").
  const metadata = {
    name: cfg.name,
    version: cfg.version,
    type: "ui_qml",
    category: cfg.category,
    description: cfg.description,
    view: "Main.qml",
    icon: `icons/${cfg.iconFilename}`,
    dependencies: [],
    nix: {
      packages: { build: [], runtime: [] },
      external_libraries: [],
      cmake: {
        find_packages: [], extra_sources: [],
        extra_include_dirs: [], extra_link_libraries: [],
      },
    },
  };
  const metadataBytes = textBytes(JSON.stringify(metadata, null, 2));
  const qmlBytes = textBytes(cfg.qmlSource);

  // Files inside each variant — same set for every arch since QML is
  // architecture-independent. Icon is duplicated at variant root because
  // manifest.icon (a basename) resolves to variants/<arch>/<basename>.
  const extraFiles = cfg.extraFiles ?? [];
  const variantFiles = (): { rel: string; data: Uint8Array }[] => [
    { rel: "Main.qml", data: qmlBytes },
    { rel: cfg.iconFilename, data: cfg.iconPng },
    { rel: `icons/${cfg.iconFilename}`, data: cfg.iconPng },
    { rel: "metadata.json", data: metadataBytes },
    ...extraFiles,
  ];

  // Collect every parent directory that needs an explicit tar dir entry
  // (the canonical lgx writer emits all parents). For default content this
  // is variants/<arch>/icons; with assets/ extras it also picks that up.
  const parentDirs = (relPaths: string[]): string[] => {
    const set = new Set<string>();
    for (const p of relPaths) {
      const parts = p.split("/");
      for (let i = 1; i < parts.length; i++) {
        set.add(parts.slice(0, i).join("/"));
      }
    }
    return [...set];
  };
  const variantDirs = parentDirs(variantFiles().map((f) => f.rel));

  // Compute Merkle hashes per variant.
  const variantHashes: Record<string, string> = {};
  for (const arch of ARCHES) {
    variantHashes[arch] = await leafDirHash(variantFiles());
  }
  const variantsHash = await parentDirHash(variantHashes);
  const rootHash = await parentDirHash({ variants: variantsHash });

  const manifest: Manifest = {
    author: cfg.author ?? "",
    category: cfg.category,
    dependencies: [],
    description: cfg.description,
    hashes: {
      root: rootHash,
      variants: variantsHash,
      ...Object.fromEntries(
        Object.entries(variantHashes).map(([a, h]) => [`variants/${a}`, h]),
      ),
    },
    icon: cfg.iconFilename,
    main: {},
    manifestVersion: "0.2.0",
    name: cfg.name,
    type: "ui_qml",
    version: cfg.version,
    view: "Main.qml",
  };

  // Assemble tar entries: manifest, parent dirs, per-variant files.
  const items: TarItem[] = [
    { path: "manifest.json", isDir: false, data: textBytes(manifestJson(manifest)) },
    { path: "variants",      isDir: true,  data: new Uint8Array(0) },
  ];
  for (const arch of ARCHES) {
    items.push({ path: `variants/${arch}`, isDir: true, data: new Uint8Array(0) });
    for (const dir of variantDirs) {
      items.push({ path: `variants/${arch}/${dir}`, isDir: true, data: new Uint8Array(0) });
    }
    for (const f of variantFiles()) {
      items.push({
        path: `variants/${arch}/${f.rel}`,
        isDir: false,
        data: f.data,
      });
    }
  }

  const tarBytes = buildTar(items);
  const gzBytes = pako.gzip(tarBytes);
  const blob = new Blob([new Uint8Array(gzBytes)], { type: "application/octet-stream" });
  const filename = `logos-${cfg.name}-module.lgx`;
  return { blob, filename, manifest };
};

// 1×1 transparent PNG — placeholder so users without a custom icon still
// get a valid .lgx. They can swap the icon in later.
export const placeholderIcon = (): Uint8Array => {
  const b64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
