// Sanity checks on the .lgx export pipeline. The exporter packs files +
// generates a manifest with Merkle hashes; tests verify the shape rather
// than the bytes (Merkle tree changes whenever any file changes).

import { describe, expect, it } from "vitest";
import { gunzipSync } from "zlib";
import { exportLgx, placeholderIcon } from "../src/app/lgxExport";

// Read a single file out of an .lgx (gzipped USTAR tar). Pure-JS, since
// node has gunzip but not tar — and the format here is simple enough.
const readFromLgx = async (blob: Blob, path: string): Promise<string | null> => {
  const buf = Buffer.from(await blob.arrayBuffer());
  const tar = gunzipSync(buf);
  let off = 0;
  while (off + 512 <= tar.length) {
    const name = tar.subarray(off, off + 100).toString("utf8").replace(/\0+$/, "");
    if (!name) break;
    const sizeOct = tar.subarray(off + 124, off + 136).toString("utf8").replace(/[\0 ]+$/, "");
    const size = parseInt(sizeOct, 8) || 0;
    if (name === path || name.endsWith("/" + path)) {
      return tar.subarray(off + 512, off + 512 + size).toString("utf8");
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
};

const baseConfig = (over: Partial<Parameters<typeof exportLgx>[0]> = {}) => ({
  name: "testapp",
  version: "0.1.0",
  description: "test",
  category: "example",
  author: "",
  iconPng: placeholderIcon(),
  iconFilename: "icon.png",
  qmlSource: "import QtQuick 2.15\nRectangle {}\n",
  extraFiles: [],
  dependencies: [] as string[],
  ...over,
});

describe("exportLgx manifest", () => {
  it("ships a manifestVersion 0.2.0 with the right name + ui_qml type", async () => {
    const { blob } = await exportLgx(baseConfig());
    const manifest = JSON.parse((await readFromLgx(blob, "manifest.json"))!);
    expect(manifest.name).toBe("testapp");
    expect(manifest.type).toBe("ui_qml");
    expect(manifest.manifestVersion).toBe("0.2.0");
  });

  it("propagates dependencies array to the manifest", async () => {
    const { blob } = await exportLgx(baseConfig({
      dependencies: ["delivery_relay"],
    }));
    const manifest = JSON.parse((await readFromLgx(blob, "manifest.json"))!);
    expect(manifest.dependencies).toEqual(["delivery_relay"]);
  });

  it("declares Merkle hashes for every variant", async () => {
    const { blob } = await exportLgx(baseConfig());
    const manifest = JSON.parse((await readFromLgx(blob, "manifest.json"))!);
    expect(manifest.hashes.root).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.hashes.variants).toMatch(/^[a-f0-9]{64}$/);
    // We ship 3 variants; each must hash.
    for (const arch of ["darwin-arm64", "linux-amd64", "linux-arm64"]) {
      expect(manifest.hashes[`variants/${arch}`]).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("includes Main.qml in every variant directory", async () => {
    const { blob } = await exportLgx(baseConfig({ qmlSource: "// hello\n" }));
    for (const arch of ["darwin-arm64", "linux-amd64", "linux-arm64"]) {
      const qml = await readFromLgx(blob, `variants/${arch}/Main.qml`);
      expect(qml).toContain("// hello");
    }
  });
});
