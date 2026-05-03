// Server endpoint for the "Ask AI" flow. The user describes a change in
// plain English; the LLM returns a JSON Patch (RFC 6902) against AppState;
// the server applies the patch and returns the new state. The client just
// dispatches a single `commit` so it lands as one undo step.
//
// Provider precedence is shared with /api/build-module — OpenAI > NVIDIA.

import OpenAI from "openai";
import type { NextRequest } from "next/server";
import { applyPatch, type Operation } from "fast-json-patch";
import { renderUnwiredAdvisory, validateModuleRefs } from "../../lib/validateModuleRefs";
import { MODULE_CATALOG } from "../../modules/catalog";
import { buildCoreModule, type BuildResult } from "../../lib/buildModule";
import { sanitizeApp } from "../../lib/schema";
import type { AppState, CoreModuleSpec, ModuleSpec } from "../../types";

export const runtime = "nodejs";
// Builds can take minutes; raise the cap accordingly. JSON-patch path
// completes well under this in practice.
export const maxDuration = 300;

const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
// Default OpenAI model — pick one that's widely available on most accounts.
// Override per-deploy with OPENAI_MODEL env var (e.g. `gpt-5`, `o3-mini`).
const DEFAULT_OPENAI_MODEL = "gpt-4o";
const DEFAULT_NVIDIA_MODEL = "z-ai/glm-5.1";

interface LLM { client: OpenAI; model: string; providerName: "OpenAI" | "NVIDIA" }

function pickProvider(modelOverride?: string): LLM | null {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    return {
      client: new OpenAI({ apiKey: openaiKey }),
      model: modelOverride || process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
      providerName: "OpenAI",
    };
  }
  const nvidiaKey = process.env.NVIDIA_API_KEY;
  if (nvidiaKey) {
    return {
      client: new OpenAI({ apiKey: nvidiaKey, baseURL: NVIDIA_BASE_URL }),
      model: modelOverride || process.env.NVIDIA_MODEL || DEFAULT_NVIDIA_MODEL,
      providerName: "NVIDIA",
    };
  }
  return null;
}

const moduleDocs = (coreModule?: CoreModuleSpec): string => {
  const all: ModuleSpec[] = [
    ...MODULE_CATALOG,
    ...(coreModule ? [{
      id: coreModule.id,
      name: `${coreModule.name || coreModule.id} (this project's custom backend)`,
      description: coreModule.description,
      methods: (coreModule.methods ?? []).map((m) => ({
        name: m.name, args: m.args ?? [], returns: m.returns, description: m.description,
      })),
      events: coreModule.events ?? [],
    }] : []),
  ];
  const lines: string[] = [];
  for (const m of all) {
    lines.push(`## \`${m.id}\` — ${m.name}`);
    if (m.description) lines.push(m.description);
    if (m.methods.length > 0) {
      lines.push("Methods:");
      for (const method of m.methods) {
        const args = (method.args ?? []).map((a) => `${a.name}: ${a.type}`).join(", ");
        lines.push(`  - ${method.name}(${args}) -> ${method.returns}${method.description ? ` — ${method.description}` : ""}`);
      }
    }
    if (m.events && m.events.length > 0) {
      lines.push("Events:");
      for (const ev of m.events) {
        const fields = (ev.data ?? []).map((d) => `${d.name}: ${d.type}`).join(", ");
        lines.push(`  - ${ev.name} { ${fields} }${ev.description ? ` — ${ev.description}` : ""}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
};

const SYSTEM_PROMPT = `You are the design assistant inside lgx.guru — a no-code visual builder. The user describes a change to their app; you call ONE of the two tools below.

# Pick the right tool

- \`apply_patch\` — for any change to the visual layout, wiring, or app state: move/resize/recolor components, add/edit triggers, set bindings, wire button onClicks, add variables, change text, add new components. Triggers ARE first-class — adding moduleEvent / appStart / onMessageReceived triggers is just a JSON Patch op against /triggers. Use this tool aggressively. Quick (<5s).
- \`build_backend_module\` — when the user asks for BACKEND BEHAVIOR that no existing module exposes: fetching from URLs, parsing/transforming external data, custom protocol logic, anything that requires writing C++. This compiles real C++ via nix and takes 30s–10min. After a successful build the new module replaces /coreModule and its methods/events are available for follow-up apply_patch calls.

# Multi-step requests

You CAN AND SHOULD call multiple tools in sequence within one user turn. The conversation supports it — each tool result is fed back to you and you can call another tool.

Canonical multi-step pattern when the user wants to build AND wire ("build a london time fetcher and show the time in the title label"):
1. Call \`build_backend_module\` first. The tool result will include the new module's methods and events.
2. Then call \`apply_patch\` to wire the UI to those methods/events: add a variable, add the moduleEvent + appStart triggers, replace the target Text's binding.

# Wiring obligation — buttons must DO something
After \`build_backend_module\` succeeds, every existing Button on the canvas must be wired. The tool result includes a \`next_steps\` advisory that lists every unwired Button (one whose \`onClick\` is missing or \`{ kind: "none" }\`) along with the available backend methods. **You MUST emit a follow-up \`apply_patch\` that wires each listed Button** — typically:
- \`Start\` button → \`{ kind: "callModule", moduleId: "<core id>", method: "<start method>", args: [] }\`
- \`Stop\`  button → \`{ kind: "callModule", moduleId: "<core id>", method: "<stop method>",  args: [] }\`
- "Update / refresh / show" button → \`{ kind: "callModuleToVariable", varId: "<v_id>", moduleId: "<core id>", method: "<getter>", args: [] }\`

For values that **change over time** (a stopwatch ticking, a polled price), also add an \`interval\` trigger that re-pulls the value every N ms — see the "Show LIVE data" pattern below. Without that, the button runs the C++ correctly but the UI display never updates and the widget looks broken.

The same wiring obligation applies after \`apply_patch\` itself: if a patch added new Buttons but left them with no \`onClick\`, the next \`apply_patch\` must wire them. The server's \`next_steps\` advisory will keep telling you they're unwired until you do.

Only set \`onClick: { kind: "none" }\` if a Button is **intentionally decorative** (e.g. a label styled as a button). Never leave a Button looking interactive but doing nothing.

CRITICAL: You MUST NOT stop (return no tool_calls) until the UI is fully wired to the backend. After building a module, you MUST call apply_patch to:
1. Add variables for every piece of data the module returns.
2. Add an appStart trigger that calls the module's init/fetch method.
3. If data updates over time, add an interval trigger that polls the getter every N ms.
4. Wire every Button's onClick to the matching callModule action.
5. Bind Text nodes to the variables so the user can see the data.

If you stop after build_backend_module without wiring the UI, the app will be DEAD — buttons do nothing, no data displays, the user sees a blank widget. This is the #1 bug users report. ALWAYS follow a build with apply_patch wiring.

When you stop, the user gets a summary aggregated from each tool's summary line, so make sure each summary is concrete and one sentence.

# AppState shape (for apply_patch path construction)
- /pages[n]/id, /pages[n]/name, /pages[n]/root
- /pages[n]/root/children[n] — a node (Text/Button/TextField/Frame/...)
- /currentPageId
- /variables[n] — { id, name, type: "string"|"number"|"boolean", initial }
- /modules — array of enabled module ids (e.g. "delivery_module")
- /coreModule — user's custom backend module spec. Don't patch this directly; use build_backend_module to (re)create it via nix compilation.
- /triggers[n] — { id, kind, moduleId?, eventName?, topic?, actions: [...] } — patch /triggers/- to add new ones.

# Node fields (most common)
- All nodes: id, kind, x, y, width, height, hidden, locked, style { backgroundColor, opacity, borderColor, borderWidth, borderRadius, rotation }
- Text: text, pixelSize, color, fontWeight, italic, textAlign, fontFamily, letterSpacing, lineHeight, binding (variable id)
- Button: text, textColor, fontWeight, onClick (action)
- TextField/TextArea: text, placeholder, readOnly, pixelSize, binding (string variable id)
- Frame: children (array of nodes)
- Rectangle: (style only)
- ProgressBar: from, to, value, indeterminate
- Slider: from, to, value, stepSize, binding
- CheckBox/Switch/RadioButton: text, checked, pixelSize, binding (boolean variable id)
- Image: src, fit
- AnimatedImage: src, fit, playing
- ComboBox: model, currentIndex
- SpinBox: from, to, value, stepSize
- BusyIndicator: running
- List: data, direction, itemTemplate

# Action kinds (for button onClick + trigger actions)
- { kind: "none" }
- { kind: "navigate", pageId }
- { kind: "setVariable", varId, value, mode: "literal"|"expression" }
- { kind: "openUrl", url }
- { kind: "callModule", moduleId, method, args: [{value, mode}] }
- { kind: "callModuleToVariable", varId, moduleId, method, args }
- { kind: "sendMessage", topic, payload, payloadMode: "literal"|"expression" }
- { kind: "appendToList", varId, value, mode }
- { kind: "if", condition, actions: [...] }

# Trigger kinds
- "appStart" — fires when widget loads. Use for initial fetch / setup.
- "interval" — fires every \`intervalMs\` milliseconds while the widget is open. Required field: \`intervalMs\` (positive integer). Use this for **polling** any module getter, stopwatch ticks, periodic UI refreshes — anywhere you need "happen every N ms". Without an interval trigger, callModule getters fire once and never refresh, and the UI looks frozen.
- "moduleEvent" — fires when a module emits an event. moduleId + eventName required. Inside actions, data[0], data[1], ... reference the event payload fields in declared order.
- "onMessageReceived" — delivery_module messages. topic required. Inside actions, payload + topic in scope.

# Patch format
Return an object with:
- operations: array of { op, path, value? } where op is "add" | "replace" | "remove"
- summary: one-sentence plain-English description of what changed

Path syntax: JSON Pointer. Use "/-" suffix to append to an array (e.g. "/variables/-" appends a new variable). Use numeric indexes for replace/remove.

# Common patterns

## Show data from a module event in a Text component
1. Add a variable: { op: "add", path: "/variables/-", value: { id: "v_<random>", name: "<sane>", type: "<from event field>", initial: "" } }
2. Add a moduleEvent trigger: { op: "add", path: "/triggers/-", value: { id: "t_<random>", kind: "moduleEvent", moduleId: "<id>", eventName: "<event>", actions: [{ kind: "setVariable", varId: "<the new var id>", value: "data[<field index>]", mode: "expression" }] } }
3. If the event is async (typical), add an appStart trigger: { op: "add", path: "/triggers/-", value: { id: "t_<random>", kind: "appStart", actions: [{ kind: "callModule", moduleId: "<id>", method: "<fetch method>", args: [] }] } }
4. Replace the Text node's binding: { op: "replace", path: "/pages/0/root/children/<n>/binding", value: "<the new var id>" }

## Show data from a module method in a Text component
1. Add variable as above
2. Add appStart trigger with callModuleToVariable action: { id, kind: "appStart", actions: [{ kind: "callModuleToVariable", varId, moduleId, method, args: [] }] }
3. Set Text binding

## Show LIVE data from a module getter (stopwatch tick, periodic poll, anything that changes over time)
A single appStart \`callModuleToVariable\` only fires once. For values that **change over time** — stopwatch elapsed ms, fetched price, anything the C++ updates internally — you MUST also add an \`interval\` trigger that re-pulls the value every N ms. Without this, pressing Start runs \`start()\` correctly but the UI looks frozen because nothing re-reads \`getElapsedMs()\`.
1. Add variable: { op: "add", path: "/variables/-", value: { id: "v_<random>", name: "elapsedMs", type: "number", initial: "0" } }
2. Add interval trigger: { op: "add", path: "/triggers/-", value: { id: "t_<random>", kind: "interval", intervalMs: 100, actions: [{ kind: "callModuleToVariable", varId: "<v_id>", moduleId: "<core id>", method: "getElapsedMs", args: [] }] } }
3. Bind a Text node's binding to the variable so it auto-updates as the timer ticks.

## moduleId AND method — both exact-match, no guessing
Every \`callModule\` / \`callModuleToVariable\` action and every \`moduleEvent\` trigger requires BOTH a \`moduleId\` and a \`method\` (or \`eventName\`) that EXACTLY match what's listed in \`# Available modules\` below. The server validates every patch and rejects any reference whose id or method isn't found — your tool result will come back with \`{ ok: false, error: "method 'start' not found on 'stopwatch_core'. Available methods: 'startStopwatch', 'stopStopwatch', ..." }\`. When that happens, fix the call and resubmit.

Common mistakes to avoid:
- Inventing module-id variants: "stopwatch" when the core's id is "stopwatch_core"; "logos_stopwatch" when it's just "stopwatch_core".
- Inventing method-name variants: "start" when the method is "startStopwatch"; "getElapsed" when it's "elapsedValue"; "fetch" when it's "refreshWeather".
- Inventing methods that don't exist at all. If the user's request needs a method the module doesn't expose, either (a) call \`build_backend_module\` again with the new method added, or (b) compose existing methods at the UI layer.

The id and the methods are the EXACT strings from the module's docs section. Copy them character-for-character.

## Wire a button click to update a variable
{ op: "replace", path: "/pages/0/root/children/<n>/onClick", value: { kind: "setVariable", varId, value: "<expression>", mode: "expression" } }

## Move/resize/recolor existing components
- Position: { op: "replace", path: "/pages/0/root/children/<n>/x", value: <new x> }
- Background color: { op: "replace", path: "/pages/0/root/children/<n>/style/backgroundColor", value: "#ffff00" }
- Text content: { op: "replace", path: "/pages/0/root/children/<n>/text", value: "..." }

## Add a new component
{ op: "add", path: "/pages/0/root/children/-", value: { id: "n_<random>", kind: "Text", x: 100, y: 100, width: 200, height: 30, hidden: false, locked: false, style: { backgroundColor: "transparent", opacity: 1, borderColor: "transparent", borderWidth: 0, borderRadius: 0, rotation: 0 }, text: "Hello", pixelSize: 16, color: "#000", fontWeight: "normal", italic: false, textAlign: "left", fontFamily: "", letterSpacing: 0, lineHeight: 1.2 } }

# Hard rules for apply_patch
- Never reply in plain text — always call one of the two tools.
- Generate fresh ids using format like "v_a3f", "t_9k2", "n_x7y" — short alphanumeric, no collision with existing ids in the AppState.
- Use absolute paths starting with /. Use existing array indexes (0-based) when targeting a specific item by position.
- When adding nested structures (a new node, a new trigger), include ALL required fields. Missing fields silently break the editor.
- The user's *current* AppState comes in the user message — read it carefully to find the right ids and paths.
- For position changes, prefer the centre of the active page (currentPageId). Page width is typically 800px; height typically 600px. Components default to (40, 40).
- summary must be one sentence, plain language ("Centered the Hello label and made the page background yellow"). No technical jargon, no markdown.

# Backend module context (Universal Module — used by build_backend_module)

lgx.guru's codegen produces a Universal Module: a pure C++ implementation class wrapped at build time by \`logos-cpp-generator\`, which emits the QML/IPC dispatch glue. This is the only shape shipped Basecamp's LogosProviderObject runtime actually accepts — the legacy Q_INVOKABLE plugin shape silently fails with "Invalid response".

## What gets generated

- \`src/<id>_impl.h\` — pure C++ class \`<Pascal(id)>Impl\` with public methods declared in *standard* types (\`std::string\`, \`double\`, \`bool\`, \`void\`).
- \`src/<id>_impl.cpp\` — implementation. May use Qt freely inside.
- \`metadata.json\` with \`"interface": "universal"\`.
- \`flake.nix\` with \`preConfigure\` running the generator.
- \`CMakeLists.txt\` with the generated dispatch sources in SOURCES.

## Type mapping (spec → generated C++ signatures)

The spec's argument/return types map to standard C++:

| Spec type | C++ argument | C++ return |
|---|---|---|
| \`string\` | \`const std::string&\` | \`std::string\` |
| \`number\` | \`double\` | \`double\` |
| \`boolean\` | \`bool\` | \`bool\` |
| \`void\` (return) | — | \`void\` |

## State

Every \`state\` field — Qt-typed (\`QString\`, \`QNetworkAccessManager\`) and std-typed (\`bool\`, \`int64_t\`, \`std::string\`, \`std::vector<…>\`) alike — lives inside the codegen-emitted private \`Private\` pimpl class in the .cpp. Access in bodies is **uniform**: always \`d->m_<name>\`. Never write \`m_<name>\` standalone — that field is in Private, not on the impl class itself, and the build will fail with "no member named 'm_X'".

## Method bodies (the \`body\` field)

Spliced verbatim into the .cpp. You can use Qt freely (QNetworkAccessManager, QJsonDocument, QString, QTimer, QHash, QVector, QDateTime, QDebug — codegen auto-injects #includes + cmake links). Public method signatures stay pure C++; convert at the boundary:

- QString → return value: \`return q.toStdString();\`
- std::string → QString: \`QString::fromStdString(s)\` or \`QString::fromUtf8(s.data(), int(s.size()))\`
- Numbers: double ↔ QString via \`QString::number(d, 'f', 1).toStdString()\`

## C++ → QML data path (CRITICAL)

Shipped Basecamp's \`logos.callModule\` is the ONLY reliable C++→QML data path. \`onModuleEvent\` exists in the in-browser editor preview but is a no-op in real Basecamp. So:

1. Cache the latest value in state (\`QString m_last\` or \`std::string m_last\` — both go in Private regardless).
2. Update \`d->m_last\` whenever fresh data arrives (sync return, async network reply, etc.).
3. Expose a synchronous getter, e.g. \`std::string lastX()\` returning \`d->m_last.toStdString()\` (or the cached value directly).
4. The QML side polls the getter via \`logos.callModule(...)\` and stores the result in a variable.

For network-fetching modules, the canonical shape is:
- state field: \`{ name: "last", cppType: "QString", initial: 'QStringLiteral("Loading...")' }\`
- method \`refreshX()\` returns void — kicks off async QNetworkAccessManager request; on reply, assigns d->m_last
- method \`lastX()\` returns string — \`return d->m_last.toStdString();\`

Without a sync getter, the UI cannot display module state in production.

## ASCII-only return values

The dispatch chain double-encodes UTF-8 somewhere along the std::string round trip — non-ASCII bytes ("°", "…", emoji) come out as mojibake. Keep returned strings ASCII (\`"14.2 C"\`, not \`"14.2 °C"\`); QML can render any glyph by formatting around the value.

## Network fetches

Use \`QNetworkAccessManager\` async with a connect-to-finished lambda. Never block. On reply success, parse the body and assign \`d->m_last\`. Optionally also \`emit eventResponse(...)\` for editor-preview parity — but the production read path is the getter + QML polling.

- All state — Qt-typed (\`QNetworkAccessManager\`, \`QTimer\`, \`QString\`) and std-typed (\`bool\`, \`int64_t\`) — goes in \`Private\` and is accessed as \`d->m_<name>\`.
- Methods can also instantiate Qt objects locally: \`QNetworkAccessManager mgr; auto* reply = mgr.get(...);\` etc.

## CRITICAL — the impl class is NOT a QObject

The codegen emits \`<Pascal(id)>Impl\` as a **plain C++ class with pimpl**, NOT a \`QObject\` subclass. There is no \`Q_OBJECT\` macro, no \`moc\` integration, no \`connect()\` syntax sugar, no \`emit\`. The AI keeps generating QObject-style C++ that fails to compile. Don't.

**Forbidden patterns (compile errors guaranteed):**

- \`QNetworkAccessManager(this)\` — passing \`this\` as parent. \`LondonTimeFetcherImpl*\` isn't a \`QObject*\`. Compile error: *no matching function for call to 'QNetworkAccessManager::QNetworkAccessManager(LondonTimeFetcherImpl*)'.*
- \`connect(reply, &QNetworkReply::finished, ...)\` — bare \`connect\` is a member of QObject; the impl class doesn't have it. Compile error: *'connect' was not declared in this scope*.
- \`emit somethingChanged(...)\` — same reason; no signals on a plain class.
- Lambda capturing \`this\` and using it inside a Qt callback to access \`d->m_*\` — works only when the lambda **doesn't outlive the impl**. Prefer capturing what you need by value.

**Correct patterns (use these verbatim):**

\`\`\`cpp
// State (declared as a CoreStateField with cppType QNetworkAccessManager):
//   d->m_manager  — already constructed by codegen.

// Kick off a request:
QNetworkRequest req(QUrl(QStringLiteral("https://example.com/api")));
QNetworkReply* reply = d->m_manager.get(req);

// Connect with the EXPLICIT QObject:: namespace and use the reply as the
// receiver context (so the connection auto-disconnects when reply is
// deleted — no dangling capture).
QObject::connect(reply, &QNetworkReply::finished, reply, [this, reply]() {
    if (reply->error() == QNetworkReply::NoError) {
        const QByteArray bytes = reply->readAll();
        // ... parse, assign to d->m_last ...
    }
    reply->deleteLater();
});
\`\`\`

Notes:
- \`QObject::connect\` (with the namespace prefix) IS a free static — works from non-QObject classes.
- The 4-arg form \`QObject::connect(sender, signal, context, lambda)\` ties the lifetime of the connection to \`context\`. Use \`reply\` as context — when the reply is deleted, the lambda goes too.
- \`reply->deleteLater()\` cleans up the QNetworkReply. Always include it.
- Capture \`this\` to write to \`d->m_*\` — fine because the impl class outlives the network request in our usage.

## Module composition rules — READ BEFORE BUILDING A MODULE

**Custom C++ modules are SELF-CONTAINED.** They cannot call other modules from inside their bodies. There is NO working LogosAPI / m_api / inter-module-call hook available to AI-built modules right now. Bodies that reference \`m_api\`, \`LogosAPI\`, or \`->callModule(\` will be rejected by the build pipeline before nix even runs.

Composition between modules happens at the **UI layer** (QML), not the C++ layer. The UI's \`logos.callModule(...)\` works fine for any installed module — delivery_module, storage_module, accounts_module, capability_module, your custom module, all of them.

### Decision tree: when the user describes an app that "uses" multiple modules

1. **Can this be done with the UI alone?** (Buttons calling \`callModule\`, triggers reacting to \`moduleEvent\`, variables binding to method results.) → YES for >90% of cases. **Don't build a backend module.** Use \`apply_patch\` to wire the UI directly.
2. **Does this genuinely need new C++ logic** (parsing custom data formats, complex state machines, network fetches with parse logic)? → Build a **self-contained** module: it accepts inputs as method args, returns results, holds private state. No upstream module calls.
3. **Does the user want a backend that orchestrates two upstream modules** (e.g. *"a backend that listens for delivery_module messages, processes them, and stores via storage_module"*)? → Compose at the UI: trigger on \`delivery_module.messageReceived\` → call your custom \`process(message) → string\` → call \`storage_module.save(key, processed)\`.

### Concrete examples

| User intent | Path |
|---|---|
| *"Show London time in this label"* | \`build_backend_module\` → self-contained \`london_weather\` (network fetch, no deps) + \`apply_patch\` to wire UI |
| *"Chat app using delivery"* | \`apply_patch\` only — UI calls \`delivery_module.send\` + trigger on \`messageReceived\` |
| *"Profanity filter on incoming chat"* | \`build_backend_module\` → self-contained \`profanity_filter\` with \`clean(text) → string\`. UI: moduleEvent on \`delivery_module.messageReceived\` → callModule \`profanity_filter.clean(data[0])\` → display result |
| *"Save my todos to disk"* | \`apply_patch\` only — UI button calls \`storage_module.save\`, list refreshes from \`storage_module.load\` |
| *"Aggregate weather from 3 APIs and average them"* | \`build_backend_module\` → self-contained \`weather_aggregator\` that fetches all 3 internally and exposes one \`getAverage()\` method |

### Hard ban (will fail the build)

Method bodies that reference any of the following are rejected before nix runs:
- \`m_api\` (no such field in our codegen)
- \`LogosAPI\` / \`LogosResult\`
- \`->callModule(\` / \`callRemoteMethod\`

If the user asks for something that seems to require inter-module C++ calls, restructure as: *backend exposes the standalone primitive; UI does the orchestration*.

The \`dependencies\` field on the spec is still useful — it gets written to metadata.json and the flake — but currently it's just metadata for the package manager. The C++ side cannot call those deps yet.

## Pushing events back to QML (the \`events\` field)

When the spec has events, the codegen declares \`std::function<void(const std::string&, LogosList)> emitEvent;\` on the impl class. The generator wires this to LogosProviderBase::emitEvent at build time — calling it from a method body fires the event to QML for real (no longer preview-only):

\`\`\`cpp
if (emitEvent) {
  emitEvent("temperatureUpdated", LogosList{ tempStdString });
}
\`\`\`

Still: declare every event you emit in \`events[]\` so the editor's trigger picker shows it, and prefer the cache-and-poll pattern when QML refresh latency isn't critical (events are best-effort, polling is reliable).

## Richer C++ types (cppType / cppReturn)

The spec types map to C++ as: string→\`const std::string&\`/\`std::string\`, number→\`double\`, boolean→\`bool\`. For richer payloads, set \`cppType\` on an arg or \`cppReturn\` on a method:

| Use case | cppType / cppReturn value | Maps to (Qt) |
|---|---|---|
| List of strings | \`std::vector<std::string>\` | \`QStringList\` |
| Byte array / blob | \`std::vector<uint8_t>\` | \`QByteArray\` |
| Explicit signed int | \`int64_t\` | \`int\` |
| Explicit unsigned int | \`uint64_t\` | \`int\` |
| List of ints | \`std::vector<int64_t>\` | \`QVariantList\` |
| Structured JSON object | \`LogosMap\` | \`QVariantMap\` |
| Heterogeneous list | \`LogosList\` | \`QVariantList\` |

\`LogosMap\` and \`LogosList\` come from \`<logos_json.h>\` (nlohmann::json aliases) — codegen auto-includes that header when these types appear. Use them to return whole structured payloads natively instead of hand-rolling JSON strings:

\`\`\`cpp
// Method with cppReturn: "LogosMap"
LogosMap result;
result["temperature"] = 14.2;
result["conditions"] = "rainy";
result["humidity"] = 65;
return result;
\`\`\`

## Tests (highly encouraged)

The codegen emits a \`tests/\` directory wired into \`logos-test-framework\`. Provide test cases via the spec's \`tests[]\` array — each becomes a \`LOGOS_TEST(name) {...}\` block. The build pipeline runs \`nix build '.#unit-tests'\` after the main build; failures feed back to you with phase:"tests" so you know to fix the body or the assertion (not the compile).

Example test body (the codegen pre-instantiates the impl as \`impl\` at the top of the block):

\`\`\`cpp
LOGOS_ASSERT_FALSE(impl.lastWeather().empty());
impl.refreshWeather();
LOGOS_ASSERT_TRUE(impl.lastWeather().find("Loading") == 0);
\`\`\`

Available macros: \`LOGOS_ASSERT_TRUE\`, \`LOGOS_ASSERT_FALSE\`, \`LOGOS_ASSERT_EQ(a, b)\`. Tests should be hermetic — no network, no sleeps. For network-fetching modules, test the parsing logic by feeding fixture JSON into a helper, not by hitting the live API.

## Hard rules
- Always call build_backend_module with a complete spec when the user asks for backend behavior.
- Public method signatures in your spec are translated to standard C++ types — never assume QString in your body's *return value*; convert before returning.
- Method body is real C++ spliced into the .cpp; no signature, just the statements.
- Method descriptions are user-facing; speak to the no-coder, not the C++ reviewer.
- Add at least one unit test when the module's behaviour is non-trivial. Tests don't have to be exhaustive — even one assertion catches the most common semantic regressions on subsequent rebuilds.

# Available modules

`;

const APPLY_PATCH_TOOL: OpenAI.ChatCompletionTool = {
  type: "function",
  function: {
    name: "apply_patch",
    description:
      "Apply a JSON Patch (RFC 6902) to mutate the user's AppState. Always called with a complete coherent set of ops that achieves the user's request in one shot.",
    parameters: {
      type: "object",
      properties: {
        operations: {
          type: "array",
          description: "JSON Patch ops. Use 'add' with /- to append to arrays, 'replace' for in-place, 'remove' for deletion.",
          items: {
            type: "object",
            properties: {
              op:    { type: "string", enum: ["add", "replace", "remove"] },
              path:  { type: "string", description: "JSON Pointer, e.g. /variables/- or /pages/0/root/children/3/x" },
              value: { description: "Operand value for add/replace. Can be any JSON type." },
            },
            required: ["op", "path"],
            additionalProperties: false,
          },
        },
        summary: {
          type: "string",
          description: "One-sentence plain-language summary of what was changed. Shown to the user.",
        },
      },
      required: ["operations", "summary"],
      additionalProperties: false,
    },
  },
};

// Mirror of the BUILD_TOOL schema used by /api/build-module so the AI can
// generate a CoreModuleSpec from inside Ask AI when the user's request
// requires custom backend logic. Server runs nix build + retries (3 attempts).
const BUILD_BACKEND_MODULE_TOOL: OpenAI.ChatCompletionTool = {
  type: "function",
  function: {
    name: "build_backend_module",
    description:
      "Generate a complete CoreModuleSpec for a SELF-CONTAINED universal C++ module and compile it. " +
      "Modules built here CANNOT call other modules from inside their C++ — there is no LogosAPI / m_api / callModule hook available. " +
      "Use this only when the request needs new C++ logic that the UI can't compose itself — e.g. network fetches with parsing, custom data transformations, stateful computations, format conversions. " +
      "If the user wants behaviour that combines multiple modules (delivery + storage, etc.), compose at the UI layer via apply_patch (callModule actions on buttons, moduleEvent triggers) — DO NOT try to do it from inside C++. " +
      "Method bodies that reference m_api, LogosAPI, or ->callModule will be rejected before nix even runs. " +
      "The host runs the nix build (lgx-portable + unit-tests) and replaces /coreModule on success.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "snake_case identifier — used as the QML callModule key, the C++ class prefix, and metadata.json `name`." },
        name: { type: "string", description: "Human-readable display name." },
        description: { type: "string", description: "One-sentence explanation of what this module does." },
        version: { type: "string", default: "0.1.0" },
        category: { type: "string", default: "custom" },
        dependencies: {
          type: "array",
          items: { type: "string" },
          description: "Module ids this depends on, e.g. ['delivery_module']. Empty if none.",
        },
        state: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              cppType: { type: "string", description: "Raw C++ type, e.g. 'QString', 'qint64', 'QHash<QString, qint64>'." },
              initial: { type: "string" },
              description: { type: "string" },
            },
            required: ["name", "cppType"],
            additionalProperties: false,
          },
        },
        methods: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "camelCase method name." },
              args: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    type: { type: "string", enum: ["string", "number", "boolean"] },
                    description: { type: "string" },
                    cppType: {
                      type: "string",
                      description: "Optional richer C++ argument type. Default mapping is string→const std::string&, number→double, boolean→bool. Set this for: 'std::vector<std::string>', 'std::vector<uint8_t>' (byte arrays), 'int64_t', 'uint64_t', 'LogosMap', 'LogosList'.",
                    },
                  },
                  required: ["name", "type"],
                  additionalProperties: false,
                },
              },
              returns: { type: "string", enum: ["string", "number", "boolean", "void"] },
              cppReturn: {
                type: "string",
                description: "Optional richer C++ return type (overrides `returns`). Use 'std::vector<std::string>' for string arrays, 'LogosMap' for structured JSON objects, 'LogosList' for arrays of mixed values, 'int64_t'/'uint64_t' for explicit integers.",
              },
              description: { type: "string" },
              body: { type: "string", description: "Real C++ body spliced into the .cpp file. Statements only — no signature, no surrounding braces." },
            },
            required: ["name", "args", "returns", "description", "body"],
            additionalProperties: false,
          },
        },
        events: {
          type: "array",
          description: "Events this module emits. Codegen wires the impl class with `std::function<void(const std::string&, LogosList)> emitEvent;` — call it from method bodies to push values back to QML.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              data: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    type: { type: "string", enum: ["string", "number", "boolean"] },
                  },
                  required: ["name", "type"],
                  additionalProperties: false,
                },
              },
              description: { type: "string" },
            },
            required: ["name", "data"],
            additionalProperties: false,
          },
        },
        tests: {
          type: "array",
          description: "Optional unit tests. Each becomes a LOGOS_TEST(name) {...} block in tests/test_<id>.cpp. The build pipeline runs `nix build '.#unit-tests'` after the main build; assertion failures feed back to you for retry, same as compile errors. Highly encouraged when method behaviour is non-trivial — catches semantic bugs the compiler can't.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "snake_case test name, becomes LOGOS_TEST(name)." },
              description: { type: "string" },
              body: {
                type: "string",
                description: "Raw C++ statements. The codegen pre-instantiates the impl as `<Pascal(id)>Impl impl;` at the start of the block — your body should call methods on `impl` and use LOGOS_ASSERT_TRUE / LOGOS_ASSERT_FALSE / LOGOS_ASSERT_EQ macros from <logos_test.h>.",
              },
            },
            required: ["name", "body"],
            additionalProperties: false,
          },
        },
      },
      required: ["id", "name", "description", "dependencies", "state", "methods"],
      additionalProperties: false,
    },
  },
};

interface PatchPayload {
  operations: Operation[];
  summary: string;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

export async function POST(request: NextRequest) {
  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: "Body must be valid JSON" }, { status: 400 });
  }

  const prompt = (body as { prompt?: unknown })?.prompt;
  const app = (body as { app?: unknown })?.app;
  if (typeof prompt !== "string" || prompt.trim().length < 3) {
    return Response.json({ error: "`prompt` is required (at least 3 characters)." }, { status: 400 });
  }
  if (!isPlainObject(app)) {
    return Response.json({ error: "`app` (current AppState) is required." }, { status: 400 });
  }

  const modelOverride = typeof (body as { model?: unknown })?.model === "string"
    ? (body as { model: string }).model
    : undefined;
  const llm = pickProvider(modelOverride);
  if (!llm) {
    return Response.json(
      { error: "No LLM API key set. Add OPENAI_API_KEY (preferred) or NVIDIA_API_KEY to web/.env.local." },
      { status: 500 }
    );
  }
  const { client, model, providerName } = llm;

  const coreModule = (app as Partial<AppState>).coreModule;
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT + moduleDocs(coreModule) },
    {
      role: "user",
      content:
        `Current AppState:\n\`\`\`json\n${JSON.stringify(app, null, 2)}\n\`\`\`\n\nUser request: ${prompt}`,
    },
  ];

  // Agentic loop: the AI may call apply_patch and/or build_backend_module
  // multiple times in sequence within a single user turn. e.g. for
  // "build a london time fetcher and show the time in the title", we expect
  // build_backend_module → apply_patch → done. Capped at MAX_ITER so a
  // hallucinating model can't run away with the loop.
  const MAX_ITER = 5;
  // Build retries (per build_backend_module call). Bounded inside the
  // build branch — distinct from MAX_ITER, which counts whole turns.
  // Each retry is 30s–10min of nix wallclock, so this isn't free, but the
  // most common shape of failure is "AI gets the diagnostic wrong on the
  // first try and needs another shot." Empirically attempts 4–6 still
  // converge on tricky modules (network fetch, JSON parsing).
  const MAX_BUILD_RETRIES = 6;

  // Sanitize the incoming app state — client-side data may have stale or
  // missing fields. The Zod schema coerces to safe defaults.
  const incomingSanitized = sanitizeApp(app);
  let workingApp = (incomingSanitized.ok ? incomingSanitized.app : JSON.parse(JSON.stringify(app))) as AppState;
  const allOperations: Operation[] = [];
  const summaries: string[] = [];
  let lastBuildSpec: CoreModuleSpec | null = null;
  let lastBuildAttempts = 0;
  let lastBuildDurationMs = 0;
  let buildHappened = false;

  try {
    for (let iter = 0; iter < MAX_ITER; iter++) {
      const completion = await client.chat.completions.create({
        model,
        messages,
        tools: [APPLY_PATCH_TOOL, BUILD_BACKEND_MODULE_TOOL],
        tool_choice: "auto",
        max_completion_tokens: 4096,
      });

      const assistantMsg = completion.choices[0]?.message;
      const toolCalls = assistantMsg?.tool_calls ?? [];

      // No tool calls → AI wants to stop. But if we just built a backend
      // module and there are unwired buttons or no triggers linking the
      // module to the UI, force a continuation — the user will get a
      // dead-looking widget otherwise.
      if (toolCalls.length === 0) {
        if (allOperations.length === 0 && !buildHappened) {
          const replyText = typeof assistantMsg?.content === "string" ? assistantMsg.content : "";
          return Response.json(
            { error: replyText.trim() || "AI did not call any tool." },
            { status: 502 },
          );
        }
        // Force wiring follow-up: if a build happened this turn and the
        // UI still has unwired buttons or no triggers referencing the core
        // module, inject a nudge and re-enter the loop with tool_choice
        // forcing apply_patch.
        const advisory = renderUnwiredAdvisory(workingApp);
        const hasCoreWiring = (workingApp.triggers ?? []).some(
          (t) => (t.actions ?? []).some(
            (a) => (a.kind === "callModule" || a.kind === "callModuleToVariable") && a.moduleId === workingApp.coreModule?.id
          )
        );
        if (buildHappened && workingApp.coreModule && (!hasCoreWiring || advisory)) {
          const nudge = [
            "You built the backend module but STOPPED before wiring the UI to it.",
            "The widget will look completely dead — buttons won't work and no data will display.",
            "You MUST now call apply_patch to:",
            "1. Add a variable for each piece of data the module returns (callModuleToVariable needs a varId).",
            "2. Add an appStart trigger that calls the module's fetch/init method.",
            "3. If data changes over time, add an interval trigger that polls the getter.",
            "4. Wire every Button's onClick to the appropriate callModule/callModuleToVariable action.",
            "5. Bind Text nodes to the variables so the data actually displays.",
            "",
            advisory || `Module "${workingApp.coreModule.id}" methods: ${(workingApp.coreModule.methods ?? []).map(m => m.name).join(", ")}`,
          ].join("\n");
          messages.push({
            role: "assistant",
            content: assistantMsg?.content ?? "",
          });
          messages.push({ role: "user", content: nudge });
          continue; // re-enter the loop — the next iteration uses tool_choice: "auto"
        }
        break;
      }

      // Track the assistant turn for subsequent iterations' tool_results
      // to refer to. Must come BEFORE we push the tool results.
      messages.push({
        role: "assistant",
        content: assistantMsg?.content ?? "",
        tool_calls: toolCalls,
      });

      // Process apply_patch calls BEFORE build_backend_module so that all
      // tool-call responses are in `messages` before any build-retry loop
      // calls the LLM again (OpenAI requires every tool_call_id to have a
      // corresponding tool response before the next API call).
      const patchCalls = toolCalls.filter((tc) => tc.type === "function" && tc.function.name === "apply_patch");
      const buildCalls = toolCalls.filter((tc) => tc.type === "function" && tc.function.name === "build_backend_module");
      const knownNames = new Set(["apply_patch", "build_backend_module"]);
      const otherCalls = toolCalls.filter((tc) => tc.type !== "function" || !knownNames.has(tc.function.name));

      for (const tc of patchCalls) {
        if (tc.type !== "function") continue;
        let payload: PatchPayload;
        try {
          payload = JSON.parse(tc.function.arguments);
        } catch {
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({ ok: false, error: "Malformed JSON in apply_patch arguments." }),
          });
          continue;
        }
        if (!Array.isArray(payload.operations) || typeof payload.summary !== "string") {
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({ ok: false, error: "Patch payload missing operations[] or summary." }),
          });
          continue;
        }
        try {
          const prevApp = workingApp;
          const result = applyPatch(
            prevApp,
            payload.operations,
            true,
            false,
          );
          const rawCandidate = result.newDocument;
          // Run through the strict Zod schema — coerces missing/bad fields
          // to safe defaults so the QML emitter can never crash.
          const sanitized = sanitizeApp(rawCandidate);
          if (!sanitized.ok) {
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: JSON.stringify({
                ok: false,
                error: "Patch produced invalid AppState. Schema errors:\n" + sanitized.errors.join("\n"),
                operations: payload.operations,
              }),
            });
            continue;
          }
          const candidate = sanitized.app as AppState;
          const valid = validateModuleRefs(candidate, prevApp);
          if (!valid.ok) {
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: JSON.stringify({
                ok: false,
                error: "Patch references unknown module ids or methods. Fix and resubmit:\n" + valid.errors.join("\n"),
                operations: payload.operations,
              }),
            });
            continue;
          }
          workingApp = candidate;
          allOperations.push(...payload.operations);
          summaries.push(payload.summary);
          const advisory = renderUnwiredAdvisory(candidate);
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({
              ok: true,
              summary: payload.summary,
              ...(advisory ? { next_steps: advisory } : {}),
            }),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "patch failed";
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({
              ok: false,
              error: `Patch failed: ${msg}`,
              operations: payload.operations,
            }),
          });
        }
      }

      // Respond to unknown tool calls so every tool_call_id has a response
      // before any build-retry loop calls the LLM again.
      for (const tc of otherCalls) {
        const name = tc.type === "function" ? tc.function.name : tc.type;
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({ ok: false, error: `Unknown tool: ${name}` }),
        });
      }

      // ── build_backend_module (with internal compile-retry loop) ────
      for (const tc of buildCalls) {
          if (tc.type !== "function") continue;
          let attempt = 1;
          let lastBuild: BuildResult | null = null;
          let lastArgs = tc.function.arguments;
          let lastToolCallId = tc.id;
          let succeeded = false;

          while (attempt <= MAX_BUILD_RETRIES) {
            let spec: CoreModuleSpec;
            try {
              spec = JSON.parse(lastArgs) as CoreModuleSpec;
            } catch {
              messages.push({
                role: "tool",
                tool_call_id: lastToolCallId,
                content: JSON.stringify({ ok: false, error: "Malformed JSON in build_backend_module arguments." }),
              });
              break;
            }
            try {
              lastBuild = await buildCoreModule(spec);
            } catch (buildErr) {
              const msg = buildErr instanceof Error ? buildErr.message : String(buildErr);
              messages.push({
                role: "tool",
                tool_call_id: lastToolCallId,
                content: JSON.stringify({ ok: false, error: `Build crashed: ${msg}` }),
              });
              break;
            }
            lastBuildAttempts = attempt;
            lastBuildDurationMs = lastBuild.durationMs;

            if (lastBuild.ok) {
              // Land the spec in workingApp via a replace/add patch so the
              // overall response shape stays uniform.
              const op: Operation = workingApp.coreModule
                ? { op: "replace", path: "/coreModule", value: spec as unknown as Record<string, unknown> }
                : { op: "add", path: "/coreModule", value: spec as unknown as Record<string, unknown> };
              try {
                const result = applyPatch(workingApp, [op], true, false);
                workingApp = result.newDocument as AppState;
              } catch {
                workingApp = { ...workingApp, coreModule: spec } as AppState;
              }
              allOperations.push(op);
              const buildSummary =
                `Built ${spec.id} in ${(lastBuild.durationMs / 1000).toFixed(1)}s` +
                (attempt > 1 ? ` (took ${attempt} attempts)` : "");
              summaries.push(buildSummary);
              lastBuildSpec = spec;
              buildHappened = true;
              succeeded = true;
              // Tool result includes the new spec so the AI can wire to its
              // methods/events on the next loop iteration. We also surface
              // every Button on the canvas that has no onClick — the AI is
              // expected to wire those in a follow-up apply_patch (otherwise
              // the user gets a stopwatch-style "buttons that do nothing"
              // experience).
              const advisory = renderUnwiredAdvisory(workingApp);
              // Include the CURRENT AppState so the AI can write correct
              // JSON Patch paths (indexes, variable ids) in its follow-up
              // apply_patch. Without this, the AI guesses at paths based on
              // the stale initial state and wiring often fails.
              messages.push({
                role: "tool",
                tool_call_id: lastToolCallId,
                content: JSON.stringify({
                  ok: true,
                  summary: buildSummary,
                  spec: {
                    id: spec.id,
                    name: spec.name,
                    description: spec.description,
                    methods: (spec.methods ?? []).map((m) => ({
                      name: m.name, args: m.args, returns: m.returns, description: m.description,
                    })),
                    events: spec.events ?? [],
                  },
                  current_app_state: workingApp,
                  ...(advisory ? { next_steps: advisory } : {}),
                }),
              });
              break;
            }

            // lastBuild is a BuildFailure here (we checked !ok above).
            const failPhase = (lastBuild && !lastBuild.ok) ? lastBuild.phase : "compile";
            const failureKey = failPhase === "tests" ? "test_failures" : "compile_errors";
            const failureMsg = failPhase === "tests"
              ? "Unit tests failed (the module compiled but assertions / test cases didn't pass). Read the failing assertions and adjust either the method bodies or the test expectations, then call build_backend_module again."
              : "Build failed. Read compiler errors and call build_backend_module again with a corrected spec.";

            if (attempt >= MAX_BUILD_RETRIES) {
              messages.push({
                role: "tool",
                tool_call_id: lastToolCallId,
                content: JSON.stringify({
                  ok: false,
                  phase: failPhase,
                  error: `Build failed after ${attempt} attempts.`,
                  [failureKey]: lastBuild.errors,
                  stderr_tail: lastBuild.stderrTail,
                }),
              });
              break;
            }

            // Push the error as a tool result, then ask the AI for a fresh
            // build_backend_module call with corrections.
            messages.push({
              role: "tool",
              tool_call_id: lastToolCallId,
              content: JSON.stringify({
                ok: false,
                phase: failPhase,
                message: failureMsg,
                [failureKey]: lastBuild.errors,
                stderr_tail: lastBuild.stderrTail,
              }),
            });
            let retry;
            try {
              retry = await client.chat.completions.create({
                model,
                messages,
                tools: [APPLY_PATCH_TOOL, BUILD_BACKEND_MODULE_TOOL],
                tool_choice: { type: "function", function: { name: "build_backend_module" } },
                max_completion_tokens: 4096,
              });
            } catch (retryErr) {
              messages.push({
                role: "tool",
                tool_call_id: lastToolCallId,
                content: JSON.stringify({ ok: false, error: `LLM retry failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}` }),
              });
              break;
            }
            const retryMsg = retry.choices[0]?.message;
            const retryTc = retryMsg?.tool_calls?.[0];
            if (!retryTc || retryTc.type !== "function" || retryTc.function.name !== "build_backend_module") {
              messages.push({
                role: "tool",
                tool_call_id: lastToolCallId,
                content: JSON.stringify({ ok: false, error: "AI didn't retry build after compile failure." }),
              });
              break;
            }
            messages.push({
              role: "assistant",
              content: retryMsg?.content ?? "",
              tool_calls: [retryTc],
            });
            lastToolCallId = retryTc.id;
            lastArgs = retryTc.function.arguments;
            attempt += 1;
          }

          if (!succeeded) {
            // Bail out of the whole multi-step loop — no point trying to
            // wire something we couldn't build.
            return Response.json({
              ok: false,
              kind: "build",
              attempts: lastBuildAttempts,
              errors: lastBuild && !lastBuild.ok ? lastBuild.errors : ["Unknown build failure"],
              stderrTail: lastBuild && !lastBuild.ok ? lastBuild.stderrTail : "",
              durationMs: lastBuildDurationMs,
              error: `Build failed after ${lastBuildAttempts} attempts. Try simplifying the request.`,
            });
          }
          continue;
      }
    }

    if (allOperations.length === 0 && !buildHappened) {
      return Response.json({ error: "AI didn't make any changes." }, { status: 502 });
    }

    // Final sanitization pass — guarantees the returned app is schema-clean
    // regardless of how many patches/builds mutated it.
    const finalSanitized = sanitizeApp(workingApp);
    const finalApp = finalSanitized.ok ? finalSanitized.app : workingApp;

    return Response.json({
      ok: true,
      kind: buildHappened ? "build" : "patch",
      app: finalApp,
      operations: allOperations,
      summary: summaries.join(" Then "),
      providerName,
      // Build details (only set if a build_backend_module call succeeded):
      spec: lastBuildSpec ?? undefined,
      attempts: buildHappened ? lastBuildAttempts : undefined,
      durationMs: buildHappened ? lastBuildDurationMs : undefined,
    });
  } catch (err) {
    if (err instanceof OpenAI.AuthenticationError) {
      const keyName = providerName === "OpenAI" ? "OPENAI_API_KEY" : "NVIDIA_API_KEY";
      return Response.json({ error: `${providerName} rejected the API key. Check ${keyName}.` }, { status: 401 });
    }
    if (err instanceof OpenAI.RateLimitError) {
      return Response.json({ error: `${providerName} rate limited — try again shortly.` }, { status: 429 });
    }
    if (err instanceof OpenAI.NotFoundError) {
      const overrideKey = providerName === "OpenAI" ? "OPENAI_MODEL" : "NVIDIA_MODEL";
      return Response.json(
        { error: `Model "${model}" not found on ${providerName}. Set ${overrideKey} in .env.local to override.` },
        { status: 404 }
      );
    }
    if (err instanceof OpenAI.APIError) {
      return Response.json({ error: err.message }, { status: err.status ?? 500 });
    }
    const msg = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: msg }, { status: 500 });
  }
}
