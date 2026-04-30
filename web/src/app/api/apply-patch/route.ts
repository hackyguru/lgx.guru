// Server endpoint for the "Ask AI" flow. The user describes a change in
// plain English; the LLM returns a JSON Patch (RFC 6902) against AppState;
// the server applies the patch and returns the new state. The client just
// dispatches a single `commit` so it lands as one undo step.
//
// Provider precedence is shared with /api/build-module — OpenAI > NVIDIA.

import OpenAI from "openai";
import type { NextRequest } from "next/server";
import { applyPatch, type Operation } from "fast-json-patch";
import { MODULE_CATALOG } from "../../modules/catalog";
import { buildCoreModule, type BuildResult } from "../../lib/buildModule";
import type { AppState, CoreModuleSpec, ModuleSpec } from "../../types";

export const runtime = "nodejs";
// Builds can take minutes; raise the cap accordingly. JSON-patch path
// completes well under this in practice.
export const maxDuration = 300;

const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
const DEFAULT_OPENAI_MODEL = "gpt-5.5";
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
      methods: coreModule.methods.map((m) => ({
        name: m.name, args: m.args, returns: m.returns, description: m.description,
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
        const args = method.args.map((a) => `${a.name}: ${a.type}`).join(", ");
        lines.push(`  - ${method.name}(${args}) -> ${method.returns}${method.description ? ` — ${method.description}` : ""}`);
      }
    }
    if (m.events && m.events.length > 0) {
      lines.push("Events:");
      for (const ev of m.events) {
        const fields = ev.data.map((d) => `${d.name}: ${d.type}`).join(", ");
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

Stop calling tools (return no tool_calls) once the request is fully addressed. You can also call apply_patch alone, multiple apply_patches if appropriate, or build_backend_module alone — the loop adapts.

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

Each \`state\` field becomes a private member of the impl class:
- If \`cppType\` is a standard C++ type (\`std::string\`, \`int\`, \`std::vector<…>\`): member of \`<Pascal(id)>Impl\` directly. Access in bodies as \`m_<name>\`.
- If \`cppType\` is a Qt type (anything starting with \`Q\`): codegen places it inside a private \`Private\` pimpl class to keep the .h pure C++. **Access in bodies as \`d->m_<name>\`** instead of \`m_<name>\`.

## Method bodies (the \`body\` field)

Spliced verbatim into the .cpp. You can use Qt freely (QNetworkAccessManager, QJsonDocument, QString, QTimer, QHash, QVector, QDateTime, QDebug — codegen auto-injects #includes + cmake links). Public method signatures stay pure C++; convert at the boundary:

- QString → return value: \`return q.toStdString();\`
- std::string → QString: \`QString::fromStdString(s)\` or \`QString::fromUtf8(s.data(), int(s.size()))\`
- Numbers: double ↔ QString via \`QString::number(d, 'f', 1).toStdString()\`

## C++ → QML data path (CRITICAL)

Shipped Basecamp's \`logos.callModule\` is the ONLY reliable C++→QML data path. \`onModuleEvent\` exists in the in-browser editor preview but is a no-op in real Basecamp. So:

1. Cache the latest value in state (\`QString m_last\` in Private, or \`std::string m_last\`).
2. Update m_last whenever fresh data arrives (sync return, async network reply, etc.).
3. Expose a synchronous getter, e.g. \`std::string lastX()\` returning the cached value.
4. The QML side polls the getter via \`logos.callModule(...)\` and stores the result in a variable.

For network-fetching modules, the canonical shape is:
- state field: \`{ name: "last", cppType: "QString", initial: 'QStringLiteral("Loading...")' }\`
- method \`refreshX()\` returns void — kicks off async QNetworkAccessManager request; on reply, assigns d->m_last
- method \`lastX()\` returns string — \`return d->m_last.toStdString();\`

Without a sync getter, the UI cannot display module state in production.

## ASCII-only return values

The dispatch chain double-encodes UTF-8 somewhere along the std::string round trip — non-ASCII bytes ("°", "…", emoji) come out as mojibake. Keep returned strings ASCII (\`"14.2 C"\`, not \`"14.2 °C"\`); QML can render any glyph by formatting around the value.

## Network fetches

Use \`QNetworkAccessManager\` async with a connect-to-finished lambda. Never block. On reply success, parse the body and set m_last. Optionally also \`emit eventResponse(...)\` for editor-preview parity — but the production read path is the getter + QML polling.

- For modules whose state needs Qt's event loop (QNetworkAccessManager, QTimer): declare \`Private\` state and let codegen place the Qt-typed members inside the pimpl.
- Methods can also instantiate Qt objects locally: \`QNetworkAccessManager mgr; auto* reply = mgr.get(...);\` etc.

## Hard rules
- Always call build_backend_module with a complete spec when the user asks for backend behavior.
- Public method signatures in your spec are translated to standard C++ types — never assume QString in your body's *return value*; convert before returning.
- Method body is real C++ spliced into the .cpp; no signature, just the statements.
- Method descriptions are user-facing; speak to the no-coder, not the C++ reviewer.

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
      "Generate a complete CoreModuleSpec and compile it. Call this only when the user's request requires custom backend logic that no existing module exposes — e.g. fetching from a URL, custom data transformation, stateful protocol logic. The host runs the nix build and replaces /coreModule on success. Each call replaces any existing module wholesale; preserve previous methods if the user asked to extend.",
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
                  },
                  required: ["name", "type"],
                  additionalProperties: false,
                },
              },
              returns: { type: "string", enum: ["string", "number", "boolean", "void"] },
              description: { type: "string" },
              body: { type: "string", description: "Real C++ body spliced into the .cpp file. Statements only — no signature, no surrounding braces." },
            },
            required: ["name", "args", "returns", "description", "body"],
            additionalProperties: false,
          },
        },
        events: {
          type: "array",
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
  const MAX_BUILD_RETRIES = 3;

  let workingApp = JSON.parse(JSON.stringify(app)) as AppState;
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

      // No tool calls → AI is done.
      if (toolCalls.length === 0) {
        if (allOperations.length === 0 && !buildHappened) {
          // The AI didn't call any tool on the very first turn — surface
          // its text so the user sees what it said (e.g. "I don't have
          // enough context").
          const replyText = typeof assistantMsg?.content === "string" ? assistantMsg.content : "";
          return Response.json(
            { error: replyText.trim() || "AI did not call any tool." },
            { status: 502 },
          );
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

      for (const tc of toolCalls) {
        if (tc.type !== "function") continue;

        // ── apply_patch ────────────────────────────────────────────────
        if (tc.function.name === "apply_patch") {
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
            const result = applyPatch(
              workingApp,
              payload.operations,
              true,
              false,
            );
            workingApp = result.newDocument as AppState;
            allOperations.push(...payload.operations);
            summaries.push(payload.summary);
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: JSON.stringify({ ok: true, summary: payload.summary }),
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
          continue;
        }

        // ── build_backend_module (with internal compile-retry loop) ────
        if (tc.function.name === "build_backend_module") {
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
            lastBuild = await buildCoreModule(spec);
            lastBuildAttempts = attempt;
            lastBuildDurationMs = lastBuild.durationMs;

            if (lastBuild.ok) {
              // Land the spec in workingApp via a replace/add patch so the
              // overall response shape stays uniform.
              const op: Operation = workingApp.coreModule
                ? { op: "replace", path: "/coreModule", value: spec as unknown as Record<string, unknown> }
                : { op: "add", path: "/coreModule", value: spec as unknown as Record<string, unknown> };
              const result = applyPatch(workingApp, [op], true, false);
              workingApp = result.newDocument as AppState;
              allOperations.push(op);
              const buildSummary =
                `Built ${spec.id} in ${(lastBuild.durationMs / 1000).toFixed(1)}s` +
                (attempt > 1 ? ` (took ${attempt} attempts)` : "");
              summaries.push(buildSummary);
              lastBuildSpec = spec;
              buildHappened = true;
              succeeded = true;
              // Tool result includes the new spec so the AI can wire to its
              // methods/events on the next loop iteration.
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
                    methods: spec.methods.map((m) => ({
                      name: m.name, args: m.args, returns: m.returns, description: m.description,
                    })),
                    events: spec.events ?? [],
                  },
                }),
              });
              break;
            }

            if (attempt >= MAX_BUILD_RETRIES) {
              messages.push({
                role: "tool",
                tool_call_id: lastToolCallId,
                content: JSON.stringify({
                  ok: false,
                  error: `Build failed after ${attempt} attempts.`,
                  compile_errors: lastBuild.errors,
                  stderr_tail: lastBuild.stderrTail,
                }),
              });
              break;
            }

            // Compile failed but we have retries left. Push the error as a
            // tool result, then ask the AI for a fresh build_backend_module
            // call with corrections.
            messages.push({
              role: "tool",
              tool_call_id: lastToolCallId,
              content: JSON.stringify({
                ok: false,
                message: "Build failed. Read compiler errors and call build_backend_module again with a corrected spec.",
                compile_errors: lastBuild.errors,
                stderr_tail: lastBuild.stderrTail,
              }),
            });
            const retry = await client.chat.completions.create({
              model,
              messages,
              tools: [APPLY_PATCH_TOOL, BUILD_BACKEND_MODULE_TOOL],
              tool_choice: { type: "function", function: { name: "build_backend_module" } },
              max_completion_tokens: 4096,
            });
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

        // Unknown tool — feed an error back and let the AI decide how to recover.
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({ ok: false, error: `Unknown tool: ${tc.function.name}` }),
        });
      }
    }

    if (allOperations.length === 0 && !buildHappened) {
      return Response.json({ error: "AI didn't make any changes." }, { status: 502 });
    }

    return Response.json({
      ok: true,
      kind: buildHappened ? "build" : "patch",
      app: workingApp,
      operations: allOperations,
      summary: summaries.join(" Then "),
      providerName,
      // Build details (only set if a build_backend_module call succeeded):
      spec: lastBuildSpec ?? undefined,
      attempts: buildHappened ? lastBuildAttempts : undefined,
      durationMs: buildHappened ? lastBuildDurationMs : undefined,
    });
  } catch (err: unknown) {
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
