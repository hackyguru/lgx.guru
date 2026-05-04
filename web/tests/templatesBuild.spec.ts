// Build every entry in TEMPLATES the same way the editor does (template
// -> AppState -> emitMainQml -> exportLgx), write each .lgx to
// /tmp/lgx-templates/, and assert the build doesn't throw. Lets us
// quickly verify whether a templates change broke any starter widget
// without having to click through them in the UI.
//
// After this passes, install on Basecamp via:
//   cp /tmp/lgx-templates/*.lgx "$HOME/Library/Application Support/Logos/LogosBasecamp/modules/"
// then launch Basecamp and click each widget tile.

import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEMPLATES } from "../src/app/templates";
import { emitMainQml } from "../src/app/qmlEmit";
import { exportLgx, placeholderIcon } from "../src/app/lgxExport";
import { computeUiDeps } from "../src/app/lib/uiDeps";
import { newId } from "../src/app/types";
import type { AppState } from "../src/app/types";

const OUT_DIR = join(tmpdir(), "lgx-templates");

describe("Every template builds a valid .lgx", () => {
  mkdirSync(OUT_DIR, { recursive: true });

  for (const tpl of TEMPLATES) {
    it(`${tpl.id}`, async () => {
      const built = tpl.build();

      // Mirror BuilderClient.applyTemplate: one page named after the
      // template, vars/triggers from the template (or empty default).
      const app: AppState = {
        pages: [{
          id: newId(),
          name: built.meta.name || "Home",
          root: built.root,
        }],
        currentPageId: "",
        variables: built.variables ?? [],
        modules: [],
        triggers: built.triggers ?? [],
      };
      app.currentPageId = app.pages[0].id;

      // Step 1: emit QML. Throws if the tree is malformed.
      const qml = emitMainQml(app, true);
      expect(qml.length).toBeGreaterThan(0);
      expect(qml).toMatch(/^import /m);

      // Step 2: pack the .lgx. Match the editor's real export — it walks
      // the app via computeUiDeps to surface every module the runtime
      // needs to be installed (e.g. delivery_relay for any sendMessage /
      // onMessageReceived widget). Hardcoding `dependencies: []` here
      // produced .lgx files that installed clean but never received
      // messages because Basecamp didn't know to bring up the relay.
      const result = await exportLgx({
        name: built.meta.name || tpl.id,
        version: "0.1.0",
        description: built.meta.description || tpl.description,
        category: "starter",
        author: "lgx.guru templates",
        iconPng: placeholderIcon(),
        iconFilename: "icon.png",
        qmlSource: qml,
        extraFiles: [],
        dependencies: computeUiDeps(app),
      });
      expect(result.blob.size).toBeGreaterThan(0);

      // Step 3: write to /tmp/lgx-templates/<id>.lgx for installation.
      const buf = Buffer.from(await result.blob.arrayBuffer());
      const outPath = join(OUT_DIR, `${tpl.id}.lgx`);
      writeFileSync(outPath, buf);
      console.log(`  ✓ ${tpl.id} → ${outPath} (${(buf.length / 1024).toFixed(1)} KB)`);
    });
  }
});
