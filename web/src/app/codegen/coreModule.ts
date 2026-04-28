// Code-generate a Logos core-module source project from a CoreModuleSpec.
//
// Output mirrors the shape of logos-workshop/part3-polling/polling-core/:
//   metadata.json
//   flake.nix
//   CMakeLists.txt
//   src/<id>_interface.h
//   src/<id>_plugin.h
//   src/<id>_plugin.cpp
//
// Method bodies are stubbed with a TODO so the project compiles + loads
// out of the box. The user fills in the C++ logic. Run `nix build` in the
// project root to produce the actual installable .lgx.

import { CoreModuleSpec, ModuleParam, ParamType } from "../types";

export interface CodegenFile { path: string; data: Uint8Array }

const enc = new TextEncoder();
const text = (s: string) => enc.encode(s);

// NOTE: this codegen now produces source for the user's *custom* core only.
// Delivery integration lives in the pre-built shared `delivery_relay` .lgx
// shipped under web/public/. Users with no custom backend logic don't need
// any source from here at all — they install the bundled relay + their UI.

// QML/JSON id-safe — we use the user's id verbatim if it matches [a-z0-9_],
// otherwise a fallback. Class names use PascalCase derived from the id.
const sanitiseId = (raw: string): string =>
  (raw.match(/^[a-z][a-z0-9_]*$/) ? raw : "my_module").toLowerCase();

const pascal = (id: string): string =>
  id.split("_").filter(Boolean).map((s) => s[0].toUpperCase() + s.slice(1)).join("");

// QML/Qt argument types from the spec's ParamType.
const qtType = (t: ParamType): string =>
  t === "number" ? "int" : t === "boolean" ? "bool" : "QString";

// Parameter-passing form (const ref for QString, value for primitives).
const qtParamForm = (p: ModuleParam): string =>
  p.type === "string" ? `const QString& ${p.name}` : `${qtType(p.type)} ${p.name}`;

const qtReturn = (r: ParamType | "void"): string =>
  r === "void" ? "void" : qtType(r);

// Default return statement for stubbed bodies.
const stubReturn = (r: ParamType | "void"): string => {
  switch (r) {
    case "void":    return "// no return";
    case "string":  return "return QString();";
    case "number":  return "return 0;";
    case "boolean": return "return false;";
  }
};

const escJson = (s: string): string => JSON.stringify(s).slice(1, -1);

// ── File generators ────────────────────────────────────────────────────────

const metadataJson = (spec: CoreModuleSpec): string => {
  const id = sanitiseId(spec.id);
  return JSON.stringify({
    name: id,
    version: spec.version || "0.1.0",
    type: "core",
    category: spec.category || "example",
    description: spec.description || "",
    main: `${id}_plugin`,
    dependencies: spec.dependencies,
    nix: {
      packages: { build: [], runtime: [] },
      external_libraries: [],
      cmake: {
        find_packages: [],
        extra_sources: [],
        extra_include_dirs: [],
        extra_link_libraries: [],
      },
    },
  }, null, 2) + "\n";
};

const flakeNix = (spec: CoreModuleSpec): string => {
  // Map dependency ids to inputs. We only know the canonical github
  // location for delivery_module right now; other dependencies get a
  // placeholder URL the user is expected to point at the real source.
  const knownDepUrls: Record<string, string> = {
    delivery_module: "github:logos-co/logos-delivery-module",
  };
  const inputLines = [
    `    logos-module-builder.url = "github:logos-co/logos-module-builder";`,
  ];
  for (const dep of spec.dependencies) {
    const url = knownDepUrls[dep] ?? `# TODO: set the source URL for "${dep}"`;
    if (url.startsWith("#")) {
      inputLines.push(`    # ${dep}.url = "...";   ${url}`);
    } else {
      inputLines.push(`    ${dep}.url = "${url}";`);
    }
  }
  return [
    `{`,
    `  description = "${escJson(spec.description || spec.name)}";`,
    ``,
    `  inputs = {`,
    ...inputLines,
    `  };`,
    ``,
    `  outputs = inputs@{ logos-module-builder, ... }:`,
    `    logos-module-builder.lib.mkLogosModule {`,
    `      src = ./.;`,
    `      configFile = ./metadata.json;`,
    `      flakeInputs = inputs;`,
    `    };`,
    `}`,
    ``,
  ].join("\n");
};

const cmakeLists = (spec: CoreModuleSpec): string => {
  const id = sanitiseId(spec.id);
  return [
    `cmake_minimum_required(VERSION 3.14)`,
    `project(${pascal(id)}Plugin LANGUAGES CXX)`,
    ``,
    `if(DEFINED ENV{LOGOS_MODULE_BUILDER_ROOT})`,
    `    include($ENV{LOGOS_MODULE_BUILDER_ROOT}/cmake/LogosModule.cmake)`,
    `elseif(EXISTS "\${CMAKE_CURRENT_SOURCE_DIR}/cmake/LogosModule.cmake")`,
    `    include(cmake/LogosModule.cmake)`,
    `else()`,
    `    message(FATAL_ERROR "LogosModule.cmake not found")`,
    `endif()`,
    ``,
    `logos_module(`,
    `    NAME ${id}`,
    `    SOURCES`,
    `        src/${id}_interface.h`,
    `        src/${id}_plugin.h`,
    `        src/${id}_plugin.cpp`,
    `)`,
    ``,
  ].join("\n");
};

const interfaceHeader = (spec: CoreModuleSpec): string => {
  const id = sanitiseId(spec.id);
  const cls = `${pascal(id)}Interface`;
  const guard = `${id.toUpperCase()}_INTERFACE_H`;
  const methodLines: string[] = [];
  for (const m of spec.methods) {
    if (m.description) methodLines.push(`    // ${m.description}`);
    const args = m.args.map(qtParamForm).join(", ");
    methodLines.push(`    Q_INVOKABLE virtual ${qtReturn(m.returns)} ${m.name}(${args}) = 0;`);
  }
  if (methodLines.length === 0) methodLines.push(`    // TODO: declare your Q_INVOKABLE methods.`);
  return [
    `#ifndef ${guard}`,
    `#define ${guard}`,
    ``,
    `#include <QObject>`,
    `#include <QString>`,
    `#include "interface.h"`,
    ``,
    `class ${cls} : public PluginInterface`,
    `{`,
    `public:`,
    `    virtual ~${cls}() = default;`,
    ``,
    ...methodLines,
    `};`,
    ``,
    `#define ${cls}_iid "org.logos.${cls}"`,
    `Q_DECLARE_INTERFACE(${cls}, ${cls}_iid)`,
    ``,
    `#endif`,
    ``,
  ].join("\n");
};

const pluginHeader = (spec: CoreModuleSpec): string => {
  const id = sanitiseId(spec.id);
  const cls = `${pascal(id)}Plugin`;
  const ifaceCls = `${pascal(id)}Interface`;
  const guard = `${id.toUpperCase()}_PLUGIN_H`;
  const methodDecls: string[] = [];
  for (const m of spec.methods) {
    const args = m.args.map(qtParamForm).join(", ");
    methodDecls.push(`    Q_INVOKABLE ${qtReturn(m.returns)} ${m.name}(${args}) override;`);
  }
  return [
    `#ifndef ${guard}`,
    `#define ${guard}`,
    ``,
    `#include <QObject>`,
    `#include <QString>`,
    `#include <QHash>`,
    `#include <QVariant>`,
    `#include "${id}_interface.h"`,
    `#include "logos_api.h"`,
    `#include "logos_api_client.h"`,
    `#include "logos_object.h"`,
    `#include "logos_sdk.h"`,
    ``,
    `class ${cls} : public QObject, public ${ifaceCls}`,
    `{`,
    `    Q_OBJECT`,
    `    Q_PLUGIN_METADATA(IID ${ifaceCls}_iid FILE "metadata.json")`,
    `    Q_INTERFACES(${ifaceCls} PluginInterface)`,
    ``,
    `public:`,
    `    explicit ${cls}(QObject* parent = nullptr);`,
    `    ~${cls}() override;`,
    ``,
    `    QString name() const override { return "${id}"; }`,
    `    QString version() const override { return "${spec.version || "0.1.0"}"; }`,
    ``,
    `    Q_INVOKABLE void initLogos(LogosAPI* api);`,
    ``,
    ...methodDecls,
    ``,
    `signals:`,
    `    void eventResponse(const QString& eventName, const QVariantList& args);`,
    ``,
    `private:`,
    `    LogosAPI* m_api = nullptr;`,
    ...spec.dependencies.map((dep) => `    LogosAPIClient* m_${dep}Client = nullptr;`),
    ...spec.dependencies.map((dep) => `    LogosObject*    m_${dep}Object = nullptr;`),
    ...(spec.state.length > 0 ? [``, `    // ── User-defined state ──`] : []),
    ...spec.state.flatMap((s): string[] => {
      const lines: string[] = [];
      if (s.description) lines.push(`    // ${s.description}`);
      const init = s.initial ? ` = ${s.initial}` : "";
      lines.push(`    ${s.cppType} m_${s.name}${init};`);
      return lines;
    }),
    `};`,
    ``,
    `#endif`,
    ``,
  ].join("\n");
};

const pluginCpp = (spec: CoreModuleSpec): string => {
  const id = sanitiseId(spec.id);
  const cls = `${pascal(id)}Plugin`;
  const ctorBody: string[] = [];
  if (spec.dependencies.length > 0) {
    ctorBody.push(`    // Dependency clients are wired up in initLogos() once the SDK is ready.`);
  }
  const initBody: string[] = [`    m_api = api;`];
  for (const dep of spec.dependencies) {
    initBody.push(``);
    initBody.push(`    // Bind to ${dep}. SDK pattern (see delivery-guide.md):`);
    initBody.push(`    //   1) getClient(name)         → LogosAPIClient*`);
    initBody.push(`    //   2) (call createNode/init via invokeRemoteMethod if needed)`);
    initBody.push(`    //   3) requestObject(name)     → LogosObject* (kept on this plugin)`);
    initBody.push(`    //   4) onEvent(obj, name, cb)  → register handlers BEFORE start.`);
    initBody.push(`    //   5) invokeRemoteMethod(...) → start the dependency.`);
    initBody.push(`    m_${dep}Client = m_api->getClient("${dep}");`);
    initBody.push(`    if (m_${dep}Client) {`);
    initBody.push(`        m_${dep}Object = m_${dep}Client->requestObject("${dep}");`);
    initBody.push(`        // Example event hook — uncomment + rename to your handler:`);
    initBody.push(`        // m_${dep}Client->onEvent(m_${dep}Object, "messageReceived",`);
    initBody.push(`        //     [this](const QString&, const QVariantList& data) {`);
    initBody.push(`        //         /* handle inbound message */`);
    initBody.push(`        //     });`);
    initBody.push(`    }`);
  }
  const methodBodies: string[] = [];
  for (const m of spec.methods) {
    const args = m.args.map(qtParamForm).join(", ");
    methodBodies.push(``);
    methodBodies.push(`${qtReturn(m.returns)} ${cls}::${m.name}(${args})`);
    methodBodies.push(`{`);
    if (m.description) methodBodies.push(`    // ${m.description}`);
    if (m.body && m.body.trim().length > 0) {
      // User-supplied body: paste verbatim with consistent indentation.
      const lines = m.body.replace(/\r\n/g, "\n").split("\n");
      for (const line of lines) {
        methodBodies.push(line.length === 0 ? "" : (line.startsWith("    ") ? line : `    ${line}`));
      }
    } else {
      if (m.args.length > 0) {
        const usage = m.args.map((a) => `(void)${a.name};`).join(" ");
        methodBodies.push(`    ${usage}`);
      }
      methodBodies.push(`    // TODO: implement ${m.name}.`);
      methodBodies.push(`    ${stubReturn(m.returns)}`);
    }
    methodBodies.push(`}`);
  }
  // Primer: copy-pasteable snippets showing the canonical SDK patterns
  // from delivery-guide.md. Only emitted when there's at least one
  // dependency, so empty modules stay clean.
  const dep0 = spec.dependencies[0];
  const primer = spec.dependencies.length === 0 ? [] : [
    ``,
    `// ── SDK primer (see delivery-guide.md) ────────────────────────────────`,
    `//`,
    `// 1) Initialise the dependency once, BEFORE start. createNode is`,
    `//    typical for delivery_module:`,
    `//      const QString cfg = R"({"logLevel":"INFO","mode":"Core","preset":"logos.dev"})";`,
    `//      m_${dep0}Client->invokeRemoteMethod("${dep0}", "createNode", cfg);`,
    `//`,
    `// 2) Register event handlers BEFORE calling start — events fire`,
    `//    during start() and any handler not yet attached misses them:`,
    `//      m_${dep0}Client->onEvent(m_${dep0}Object, "messageReceived",`,
    `//          [this](const QString&, const QVariantList& data) {`,
    `//              /* data: [hash, contentTopic, payload_base64, timestamp_ns] */`,
    `//          });`,
    `//`,
    `// 3) Start the dependency:`,
    `//      m_${dep0}Client->invokeRemoteMethod("${dep0}", "start");`,
    `//`,
    `// 4) Call any method:`,
    `//      m_${dep0}Client->invokeRemoteMethod("${dep0}", "send", topic, payload);`,
    `//`,
    `// 5) Tear down (in your stop method or destructor):`,
    `//      m_${dep0}Client->invokeRemoteMethod("${dep0}", "unsubscribe", topic);`,
    `//      m_${dep0}Client->invokeRemoteMethod("${dep0}", "stop");`,
    `//`,
    `// ─────────────────────────────────────────────────────────────────────`,
  ];
  return [
    `#include "${id}_plugin.h"`,
    ``,
    `${cls}::${cls}(QObject* parent) : QObject(parent)`,
    `{`,
    ...ctorBody,
    `}`,
    ``,
    `${cls}::~${cls}()`,
    `{`,
    `}`,
    ``,
    `void ${cls}::initLogos(LogosAPI* api)`,
    `{`,
    ...initBody,
    `}`,
    ...methodBodies,
    ...primer,
    ``,
  ].join("\n");
};

// ── Public API ─────────────────────────────────────────────────────────────

export function generateCoreModuleFiles(spec: CoreModuleSpec): CodegenFile[] {
  const id = sanitiseId(spec.id);
  return [
    { path: "metadata.json",                  data: text(metadataJson(spec)) },
    { path: "flake.nix",                      data: text(flakeNix(spec)) },
    { path: "CMakeLists.txt",                 data: text(cmakeLists(spec)) },
    { path: `src/${id}_interface.h`,          data: text(interfaceHeader(spec)) },
    { path: `src/${id}_plugin.h`,             data: text(pluginHeader(spec)) },
    { path: `src/${id}_plugin.cpp`,           data: text(pluginCpp(spec)) },
    { path: "README.md",                      data: text(readme(spec)) },
  ];
}

const readme = (spec: CoreModuleSpec): string => {
  const id = sanitiseId(spec.id);
  return [
    `# ${spec.name || id} (Logos core module)`,
    ``,
    spec.description || "Generated by lgx.guru.",
    ``,
    `## Build`,
    ``,
    `Built with the canonical Logos module build pipeline:`,
    ``,
    `\`\`\`bash`,
    `tar -xzf ${id}-core-source.lgx     # source archive ships in .lgx shape`,
    `cd ${id}-core`,
    `nix flake update                   # pin inputs (first build only)`,
    `nix build '.#lgx-portable'         # produces the portable installable .lgx`,
    `\`\`\``,
    ``,
    `The built \`.lgx\` lands in \`./result-portable/\`. Drop it into Logos`,
    `Basecamp's package manager alongside its dependencies (${spec.dependencies.length === 0 ? "none" : spec.dependencies.join(", ")}).`,
    ``,
    `### Why \`.#lgx-portable\` (and not \`.#lgx\`)?`,
    ``,
    `\`.#lgx\` produces a *dev* variant that references \`/nix/store\` paths`,
    `directly — fast to build, only runs on the machine that built it, and`,
    `the variant directory has a \`-dev\` suffix that released Basecamp`,
    `**ignores**. \`.#lgx-portable\` rewrites dependencies so the bundle is`,
    `self-contained and runs on any machine with the same OS + arch — this`,
    `is the version you ship.`,
    ``,
    `## Layout`,
    ``,
    `- \`src/${id}_interface.h\` — \`Q_INVOKABLE\` method declarations`,
    `- \`src/${id}_plugin.h\`    — class skeleton (state members, dependency clients)`,
    `- \`src/${id}_plugin.cpp\`  — method bodies (TODO stubs for you to fill in)`,
    `- \`metadata.json\`         — module manifest`,
    `- \`flake.nix\`             — Nix build (entry: \`mkLogosModule\`)`,
    `- \`CMakeLists.txt\`        — CMake target via \`logos_module()\``,
    ``,
    `## SDK quick reference`,
    ``,
    `Inside \`${id}_plugin.cpp\`, dependency clients are accessed via:`,
    ``,
    `\`\`\`cpp`,
    `m_${spec.dependencies[0] ?? "<dep>"}Client->invokeRemoteMethod(`,
    `    "${spec.dependencies[0] ?? "<dep>"}", "methodName", arg1, arg2);`,
    ``,
    `m_${spec.dependencies[0] ?? "<dep>"}Client->onEvent(`,
    `    m_${spec.dependencies[0] ?? "<dep>"}Object, "eventName",`,
    `    [this](const QString&, const QVariantList& data) { /* ... */ });`,
    `\`\`\``,
    ``,
    `Register event handlers BEFORE you call \`start\` on the dependency —`,
    `events fire during \`start()\` and unregistered handlers miss them.`,
    ``,
  ].join("\n");
};
