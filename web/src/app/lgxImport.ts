// Read .lgx files in the browser to extract the embedded design.json
// snapshot lgxExport bundles into each variant. Mirror format of the
// canonical packer (gzipped USTAR tar) — just enough parsing to find one
// well-known file.

import pako from "pako";

export interface TarEntry { path: string; data: Uint8Array; isDir: boolean }

const ascii = new TextDecoder("ascii");
const utf8  = new TextDecoder("utf-8");

// Minimal USTAR tar reader — pure ASCII headers, ignores extended fields.
function readTar(buf: Uint8Array): TarEntry[] {
  const out: TarEntry[] = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    // End-of-archive: a block of all-zero bytes.
    let allZero = true;
    for (let i = 0; i < 512; i++) {
      if (buf[off + i] !== 0) { allZero = false; break; }
    }
    if (allZero) break;

    const cstr = (start: number, len: number) => {
      const slice = buf.subarray(off + start, off + start + len);
      let end = 0;
      while (end < slice.length && slice[end] !== 0) end++;
      return ascii.decode(slice.subarray(0, end));
    };

    const name = cstr(0, 100);
    const sizeOct = cstr(124, 12).trim();
    const size = sizeOct ? parseInt(sizeOct, 8) : 0;
    const typeflag = String.fromCharCode(buf[off + 156]);
    const prefix = cstr(345, 155);
    const fullPath = (prefix ? prefix + "/" : "") + name;
    const isDir = typeflag === "5" || fullPath.endsWith("/");
    const data = isDir ? new Uint8Array(0) : buf.subarray(off + 512, off + 512 + size);

    out.push({
      path: fullPath.replace(/\/$/, ""),
      data,
      isDir,
    });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

export interface LgxContents {
  entries: TarEntry[];
  // Embedded editor snapshot, if the .lgx was exported from lgx.guru. None
  // for hand-built or vendored .lgx packages.
  designJson?: string;
}

export async function readLgx(file: File): Promise<LgxContents> {
  const ab = await file.arrayBuffer();
  const tarBytes = pako.ungzip(new Uint8Array(ab));
  const entries = readTar(tarBytes);

  // Any variants/<arch>/design.json works — they're identical in our exports.
  const design = entries.find((e) => /^variants\/[^/]+\/design\.json$/.test(e.path));
  return {
    entries,
    designJson: design ? utf8.decode(design.data) : undefined,
  };
}
