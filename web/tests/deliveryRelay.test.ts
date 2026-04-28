// Sanity checks on the bundled delivery_relay.lgx static asset. If the
// nix-built output drifts (rename, missing dylib, wrong arch path), this
// test catches it before the user installs a broken artifact.

import { describe, expect, it } from "vitest";
import { gunzipSync } from "zlib";
import { readFileSync } from "fs";
import { resolve } from "path";

const RELAY_PATH = resolve(__dirname, "..", "public", "delivery_relay.lgx");

const tarEntries = (lgx: Buffer): { name: string; size: number }[] => {
  const tar = gunzipSync(lgx);
  const entries: { name: string; size: number }[] = [];
  let off = 0;
  while (off + 512 <= tar.length) {
    const name = tar.subarray(off, off + 100).toString("utf8").replace(/\0+$/, "");
    if (!name) break;
    const sizeOct = tar.subarray(off + 124, off + 136).toString("utf8").replace(/[\0 ]+$/, "");
    const size = parseInt(sizeOct, 8) || 0;
    entries.push({ name, size });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
};

const readEntry = (lgx: Buffer, path: string): Buffer | null => {
  const tar = gunzipSync(lgx);
  let off = 0;
  while (off + 512 <= tar.length) {
    const name = tar.subarray(off, off + 100).toString("utf8").replace(/\0+$/, "");
    if (!name) break;
    const sizeOct = tar.subarray(off + 124, off + 136).toString("utf8").replace(/[\0 ]+$/, "");
    const size = parseInt(sizeOct, 8) || 0;
    if (name === path) return Buffer.from(tar.subarray(off + 512, off + 512 + size));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
};

describe("bundled delivery_relay.lgx", () => {
  const lgx = readFileSync(RELAY_PATH);

  it("contains the canonical files at the expected paths", () => {
    const names = tarEntries(lgx).map((e) => e.name);
    expect(names).toContain("manifest.json");
    expect(names.some((n) => n.startsWith("variants/"))).toBe(true);
    // At least one arch dylib must be present.
    expect(names.some((n) => n.endsWith("delivery_relay_plugin.dylib"))).toBe(true);
  });

  it("manifest declares name=delivery_relay, type=core, deps=[delivery_module]", () => {
    const m = JSON.parse(readEntry(lgx, "manifest.json")!.toString("utf8"));
    expect(m.name).toBe("delivery_relay");
    expect(m.type).toBe("core");
    expect(m.dependencies).toEqual(["delivery_module"]);
    expect(m.manifestVersion).toBe("0.2.0");
  });

  it("manifest's main maps each variant to a non-empty plugin filename", () => {
    const m = JSON.parse(readEntry(lgx, "manifest.json")!.toString("utf8"));
    expect(typeof m.main).toBe("object");
    for (const [arch, file] of Object.entries(m.main)) {
      expect(arch).toMatch(/^(darwin|linux|windows)-(arm64|amd64|x86_64)$/);
      expect(file).toMatch(/_plugin\.(dylib|so|dll)$/);
    }
  });

  it("manifest hashes cover root + variants + every variant arch", () => {
    const m = JSON.parse(readEntry(lgx, "manifest.json")!.toString("utf8"));
    expect(m.hashes.root).toMatch(/^[a-f0-9]{64}$/);
    expect(m.hashes.variants).toMatch(/^[a-f0-9]{64}$/);
    for (const arch of Object.keys(m.main)) {
      expect(m.hashes[`variants/${arch}`]).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});
