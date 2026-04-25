# lgx.guru

Visual builder for Logos Basecamp UI modules. Design QML widgets in the browser with drag-and-drop, see a live Qt-WASM preview, and export a `.lgx` package that installs into Basecamp.

## Repo layout

| Path | What |
|---|---|
| `web/` | Next.js editor — palette, canvas, layers panel, inspector, `.lgx` exporter |
| `renderer/` | Qt-WASM renderer (CMake project) used as the live preview iframe |
| `renderer/build/` | Pre-built WASM runtime (`qml-renderer.wasm` and friends) checked in so cloners don't need Qt installed to see the preview |
| `hello-world-ui/` | Reference Logos UI module — the canonical `.lgx` we validate our exporter against |

## Quick start

```bash
# 1. Install web deps
cd web
npm install

# 2. In one terminal — serve the Qt-WASM preview (COOP/COEP headers)
cd ../renderer
python3 serve.py 8765

# 3. In another terminal — start the editor
cd ../web
npm run dev
# → http://localhost:3000
```

Drag components onto the canvas, edit styles in the inspector, click **Export .lgx** to download a package you can drop into Basecamp's package manager.

## Rebuilding the renderer (only if you touch `renderer/src/`)

Requires Qt 6.7.x for WebAssembly + Emscripten. The pre-built `.wasm` in this repo was produced with Qt 6.7.3 + emsdk 3.1.50.

```bash
cd renderer
mkdir -p build && cd build
cmake -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE=$EMSDK/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake \
  -DCMAKE_PREFIX_PATH=$QT_DIR/wasm_singlethread \
  ..
ninja
```

## .lgx export format

The exporter produces a gzipped tar with the canonical layout from `logos-co/logos-package`:

```
manifest.json
variants/<arch>/Main.qml
variants/<arch>/<icon>.png
variants/<arch>/icons/<icon>.png
variants/<arch>/metadata.json
variants/<arch>/assets/...
```

Manifest hashes are SHA-256 Merkle trees over the variant contents — verified against the `lgx verify` CLI from `logos-co/logos-package`.
