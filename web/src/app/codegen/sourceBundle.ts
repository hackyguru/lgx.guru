// Pack a set of generated files into a gzipped USTAR tar bundle suitable
// for downloading from the browser. Reuses pako for gzip; tar header
// writing mirrors lgxExport.ts's deterministic writer (USTAR magic,
// mtime=0, uid/gid=0). The output unpacks via `tar -xzf` on macOS/Linux.

import pako from "pako";
import type { CodegenFile } from "./coreModule";

const enc = new TextEncoder();

const tarPad = (size: number) => Math.ceil(size / 512) * 512;

const writeAscii = (out: Uint8Array, off: number, s: string, max: number) => {
  const b = enc.encode(s);
  for (let i = 0; i < Math.min(b.length, max); i++) out[off + i] = b[i];
};

const writeOctal = (out: Uint8Array, off: number, size: number, value: number) => {
  const padded = value.toString(8).padStart(size - 1, "0");
  for (let i = 0; i < size - 1; i++) out[off + i] = padded.charCodeAt(i);
  out[off + size - 1] = 0;
};

interface TarItem { path: string; data: Uint8Array; isDir: boolean }

const writeHeader = (item: TarItem, prefixDir: string): Uint8Array => {
  const h = new Uint8Array(512);
  let path = (prefixDir ? `${prefixDir}/` : "") + item.path.replace(/^\/+/, "");
  if (item.isDir && !path.endsWith("/")) path += "/";
  if (path.length > 100) throw new Error(`tar path too long: ${path}`);
  writeAscii(h, 0, path, 100);
  writeOctal(h, 100, 8, item.isDir ? 0o755 : 0o644);
  writeOctal(h, 108, 8, 0);                                  // uid
  writeOctal(h, 116, 8, 0);                                  // gid
  writeOctal(h, 124, 12, item.isDir ? 0 : item.data.length); // size
  writeOctal(h, 136, 12, 0);                                 // mtime
  for (let i = 148; i < 156; i++) h[i] = 0x20;               // checksum spaces
  h[156] = item.isDir ? 0x35 : 0x30;                          // typeflag
  writeAscii(h, 257, "ustar", 5); h[262] = 0;                 // magic
  h[263] = 0x30; h[264] = 0x30;                               // version "00"
  writeOctal(h, 329, 8, 0);
  writeOctal(h, 337, 8, 0);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  const cs = sum.toString(8).padStart(6, "0");
  for (let i = 0; i < 6; i++) h[148 + i] = cs.charCodeAt(i);
  h[154] = 0; h[155] = 0x20;
  return h;
};

// Build a gzipped tar containing every input file. `topDir` becomes the
// archive's single top-level folder (so `tar -xzf foo.tar.gz` produces
// `topDir/...` rather than scattering files into the cwd).
export function packTarGz(files: CodegenFile[], topDir: string): Blob {
  // Collect implicit parent dirs so the tar carries explicit dir entries
  // for every nesting level — friendlier to old extractors.
  const allDirs = new Set<string>();
  for (const f of files) {
    const parts = f.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      allDirs.add(parts.slice(0, i).join("/"));
    }
  }
  const items: TarItem[] = [
    { path: "", data: new Uint8Array(0), isDir: true }, // top dir itself
    ...[...allDirs].sort().map((d) => ({ path: d, data: new Uint8Array(0), isDir: true })),
    ...files.map((f) => ({ path: f.path, data: f.data, isDir: false })),
  ];
  // Sort lexicographically (with dir slashes) for deterministic output.
  const norm = (it: TarItem) => (it.isDir ? it.path + "/" : it.path);
  items.sort((a, b) => norm(a).localeCompare(norm(b)));

  let total = 1024; // two trailing zero blocks
  for (const it of items) total += 512 + (it.isDir ? 0 : tarPad(it.data.length));
  const out = new Uint8Array(total);
  let off = 0;
  for (const it of items) {
    out.set(writeHeader(it, topDir), off);
    off += 512;
    if (!it.isDir && it.data.length > 0) {
      out.set(it.data, off);
      off += tarPad(it.data.length);
    }
  }
  const gz = pako.gzip(out);
  return new Blob([new Uint8Array(gz)], { type: "application/gzip" });
}
