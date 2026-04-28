# Tests + diagnostics

Two layers of tooling for "is delivery actually working?" troubleshooting.

## `npm test` — unit + simulation

Runs in node, no Basecamp needed. ~500ms total.

| File | What it pins down | Catches when broken |
| --- | --- | --- |
| `qmlEmit.test.ts` | The exact `callModule` routes, Timer poll body, status overlay, and `sendMessage` wrapping the editor emits. | Codegen drifted (wrong relay name, missing bootstrap, missing status hookup). |
| `lgxExport.test.ts` | Manifest shape: `name`, `type`, `manifestVersion`, `dependencies`, Merkle hashes, per-variant Main.qml. | Manifest regressions — already caught a real bug where root `dependencies` was hardcoded `[]`. |
| `deliveryRelay.test.ts` | The bundled `web/public/delivery_relay.lgx` static asset has the right manifest, declared deps, and dylib. | Nix build drift — wrong module name, missing dylib, wrong arch path. |
| `pubsubFlow.test.ts` | End-to-end: extracts `Component.onCompleted` and `Timer.onTriggered` JS bodies from the emitted QML, runs them against a fake `logos` bridge that mirrors the relay's surface, asserts sender → receiver flow with two instances on a shared bus. | Topic dispatch broken, wrong arg shape, wrong method name, Timer body broken. Closest thing to "did pub/sub work" without Basecamp. |

`npm run test:watch` for hot-reload while editing codegen.

## `npm run diagnose` — runtime inspection

Use when "messages aren't crossing." Prints:

1. **Running processes** — per-instance Basecamp + each loaded `logos_host` plugin. The summary line catches the most common failure: more Basecamp instances than `delivery_relay` hosts (older instances pre-date the relay install — quit and relaunch them).
2. **Installed UI plugins** — name, version, declared deps from the on-disk `manifest.json`. Lets you confirm the .lgx you exported actually made it through install with the right dep declarations.
3. **Installed core modules** — same shape, plus `✓` / `✗` for whether a `.dylib` is actually present in the variant dir.
4. **Cross-checks** — every UI's declared deps must resolve to an installed module/plugin. If not, the UI silently fails to load.
5. **Relaunch helpers** — the exact one-liners to quit everything and start fresh with two distinct ports.

Example healthy output:
```
Running Basecamp processes
  Basecamp instances:    2
  delivery_module hosts: 2
  delivery_relay hosts:  2
✓ all UI dependencies are installed
```

Example "user installed UI before relay was bundled":
```
delivery_relay hosts:  0  (expected 2 — older instances likely pre-date the relay install; quit and relaunch)
✗ missing dependencies:
    delivery_test → delivery_relay
```
