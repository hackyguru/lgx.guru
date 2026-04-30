// Code-generate a Universal Module source project from a CoreModuleSpec.
//
// Output (matches logos-co/logos-dev-boost's universal-module template):
//   metadata.json     — type:core + interface:universal
//   flake.nix         — runs logos-cpp-generator in preConfigure
//   CMakeLists.txt    — logos_module() with generated_code/ in SOURCES
//   src/<id>_impl.h   — pure C++ public API (std::string / double / bool)
//   src/<id>_impl.cpp — implementation (Qt usage allowed, pimpl-hidden)
//   README.md
//
// At build time, `logos-cpp-generator --from-header src/<id>_impl.h
// --backend qt --impl-class <Pascal>Impl ...` reads the impl header and
// emits generated_code/<id>_qt_glue.h + <id>_dispatch.cpp. Those plug into
// LogosProviderObject::callMethod / getMethods, which is the dispatch path
// shipped Basecamp actually uses (the legacy Q_INVOKABLE QString plugin
// shape silently fails with "Invalid response").
//
// Method bodies are spliced verbatim into the .cpp. The AI's body can use
// Qt types freely (we auto-inject the right #includes + cmake links via
// detectQtNeeds), but the *public method signatures* stay pure C++.

import { CoreMethod, CoreModuleSpec, CoreStateField, ModuleParam, ParamType } from "../types";

export interface CodegenFile { path: string; data: Uint8Array }

const enc = new TextEncoder();
const text = (s: string) => enc.encode(s);

// QML/JSON id-safe — we use the user's id verbatim if it matches [a-z0-9_],
// otherwise a fallback. Class names use PascalCase derived from the id.
const sanitiseId = (raw: string): string =>
  (raw.match(/^[a-z][a-z0-9_]*$/) ? raw : "my_module").toLowerCase();

const pascal = (id: string): string =>
  id.split("_").filter(Boolean).map((s) => s[0].toUpperCase() + s.slice(1)).join("");

// ── Pure-C++ type mapping (universal module API surface) ──────────────────
//
// Universal modules expose only standard C++ types in their public header
// — that's what logos-cpp-generator parses to produce the dispatch layer.
// Internally the .cpp can use anything.

const stdType = (t: ParamType): string => {
  if (t === "string")  return "std::string";
  if (t === "number")  return "double";
  if (t === "boolean") return "bool";
  return "void";
};

const stdReturn = (r: ParamType | "void"): string =>
  r === "void" ? "void" : stdType(r);

// Args: const-ref for std::string, value for primitives.
const stdArg = (p: ModuleParam): string =>
  p.type === "string" ? `const std::string& ${p.name}` : `${stdType(p.type)} ${p.name}`;

const stubReturn = (r: ParamType | "void"): string => {
  switch (r) {
    case "void":    return "// no return";
    case "string":  return "return std::string();";
    case "number":  return "return 0.0;";
    case "boolean": return "return false;";
  }
};

// ── Qt feature auto-detection (for impl.cpp) ──────────────────────────────
//
// Scans the AI's method bodies + state fields' cppType for Qt class names
// and produces matching #include directives + CMake config. The AI writes
// `QNetworkAccessManager`/`QJsonDocument`/etc. freely; the build env is set
// up automatically.

interface QtFeature {
  pattern: RegExp;
  includes: string[];
  findPackage?: string;
  linkLib?: string;
}

const QT_FEATURES: QtFeature[] = [
  {
    pattern: /\bQNetwork(?:AccessManager|Request|Reply|Cookie|CookieJar)\b/,
    includes: ["QNetworkAccessManager", "QNetworkRequest", "QNetworkReply"],
    findPackage: "Qt6Network",
    linkLib: "Qt6::Network",
  },
  {
    pattern: /\bQJson(?:Document|Object|Array|Value|ParseError)\b/,
    includes: ["QJsonDocument", "QJsonObject", "QJsonArray", "QJsonValue", "QJsonParseError"],
  },
  { pattern: /\bQTimer\b/,            includes: ["QTimer"] },
  { pattern: /\bQDateTime\b/,         includes: ["QDateTime"] },
  { pattern: /\bQUrl(?:Query)?\b/,    includes: ["QUrl", "QUrlQuery"] },
  { pattern: /\bQByteArray\b/,        includes: ["QByteArray"] },
  { pattern: /\bQString(?:List)?\b/,  includes: ["QString", "QStringList"] },
  { pattern: /\bQHash\b|\bQMap\b/,    includes: ["QHash", "QMap"] },
  { pattern: /\bQVector\b|\bQList\b/, includes: ["QVector", "QList"] },
  { pattern: /\bQVariant\b/,          includes: ["QVariant"] },
  { pattern: /\bQObject\b/,           includes: ["QObject"] },
  { pattern: /\bqDebug\b|\bqWarning\b|\bqInfo\b/, includes: ["QDebug"] },
];

interface DetectedQtNeeds {
  includes: string[];
  findPackages: string[];
  linkLibs: string[];
  // True when any Qt detection fired — controls whether <QObject> + the
  // Private pimpl wrapper get emitted.
  any: boolean;
}

const detectQtNeeds = (spec: CoreModuleSpec): DetectedQtNeeds => {
  const corpus = [
    ...spec.methods.map((m) => m.body ?? ""),
    ...spec.state.map((s) => s.cppType ?? ""),
    ...spec.state.map((s) => s.initial ?? ""),
  ].join("\n");
  const includes = new Set<string>();
  const findPackages = new Set<string>();
  const linkLibs = new Set<string>();
  let any = false;
  for (const f of QT_FEATURES) {
    if (!f.pattern.test(corpus)) continue;
    any = true;
    for (const inc of f.includes) includes.add(inc);
    if (f.findPackage) findPackages.add(f.findPackage);
    if (f.linkLib) linkLibs.add(f.linkLib);
  }
  return {
    includes: Array.from(includes),
    findPackages: Array.from(findPackages),
    linkLibs: Array.from(linkLibs),
    any,
  };
};

// State fields whose cppType references a Qt token — those must live in the
// Private pimpl class (in the .cpp), since the public .h is Qt-free.
const isQtTyped = (cppType: string): boolean =>
  /\bQ[A-Z]/.test(cppType);

interface PartitionedState {
  qtState: CoreStateField[];   // → Private pimpl, in .cpp
  stdState: CoreStateField[];  // → impl.h private members (raw types)
}

const partitionState = (state: CoreStateField[]): PartitionedState => {
  const qtState: CoreStateField[] = [];
  const stdState: CoreStateField[] = [];
  for (const s of state) (isQtTyped(s.cppType) ? qtState : stdState).push(s);
  return { qtState, stdState };
};

// ── File generators ───────────────────────────────────────────────────────

const metadataJson = (spec: CoreModuleSpec): string => {
  const id = sanitiseId(spec.id);
  const detected = detectQtNeeds(spec);
  return JSON.stringify({
    name: id,
    version: spec.version || "1.0.0",
    description: spec.description || "",
    author: "",
    type: "core",
    // The single most important field — tells logos-module-builder to run
    // the generator and use LogosProviderObject dispatch instead of the
    // legacy Q_INVOKABLE plugin shape.
    interface: "universal",
    category: spec.category || "custom",
    main: `${id}_plugin`,
    dependencies: spec.dependencies,
    include: [],
    capabilities: [],
    nix: {
      packages: { build: [], runtime: [] },
      external_libraries: [],
      cmake: {
        find_packages: detected.findPackages,
        extra_sources: [],
        extra_include_dirs: [],
        extra_link_libraries: detected.linkLibs,
      },
    },
  }, null, 2) + "\n";
};

const flakeNix = (spec: CoreModuleSpec): string => {
  const id = sanitiseId(spec.id);
  const cls = `${pascal(id)}Impl`;
  return [
    `{`,
    `  description = "${spec.description ? spec.description.replace(/[\\"]/g, "\\$&") : spec.name || id}";`,
    ``,
    `  inputs = {`,
    `    logos-module-builder.url = "github:logos-co/logos-module-builder";`,
    `  };`,
    ``,
    `  outputs = inputs@{ logos-module-builder, ... }:`,
    `    logos-module-builder.lib.mkLogosModule {`,
    `      src = ./.;`,
    `      configFile = ./metadata.json;`,
    `      flakeInputs = inputs;`,
    `      # Runs the universal-module code generator. It parses`,
    `      # src/${id}_impl.h and produces the QML/IPC glue under`,
    `      # generated_code/. CMakeLists.txt picks those up.`,
    `      preConfigure = ''`,
    `        logos-cpp-generator --from-header src/${id}_impl.h \\`,
    `          --backend qt \\`,
    `          --impl-class ${cls} \\`,
    `          --impl-header ${id}_impl.h \\`,
    `          --metadata metadata.json \\`,
    `          --output-dir ./generated_code`,
    `      '';`,
    `    };`,
    `}`,
    ``,
  ].join("\n");
};

const cmakeLists = (spec: CoreModuleSpec): string => {
  const id = sanitiseId(spec.id);
  return [
    `cmake_minimum_required(VERSION 3.14)`,
    `project(Logos${pascal(id)}Plugin LANGUAGES CXX)`,
    ``,
    `if(DEFINED ENV{LOGOS_MODULE_BUILDER_ROOT})`,
    `    include($ENV{LOGOS_MODULE_BUILDER_ROOT}/cmake/LogosModule.cmake)`,
    `elseif(EXISTS "\${CMAKE_CURRENT_SOURCE_DIR}/cmake/LogosModule.cmake")`,
    `    include(cmake/LogosModule.cmake)`,
    `else()`,
    `    message(FATAL_ERROR "LogosModule.cmake not found. Set LOGOS_MODULE_BUILDER_ROOT.")`,
    `endif()`,
    ``,
    `configure_file(\${CMAKE_CURRENT_SOURCE_DIR}/metadata.json`,
    `               \${CMAKE_CURRENT_BINARY_DIR}/metadata.json COPYONLY)`,
    ``,
    `logos_module(`,
    `    NAME ${id}`,
    `    SOURCES`,
    `        src/${id}_impl.h`,
    `        src/${id}_impl.cpp`,
    `        generated_code/${id}_qt_glue.h`,
    `        generated_code/${id}_dispatch.cpp`,
    `    INCLUDE_DIRS`,
    `        \${CMAKE_CURRENT_SOURCE_DIR}/generated_code`,
    `)`,
    ``,
  ].join("\n");
};

const implHeader = (spec: CoreModuleSpec): string => {
  const id = sanitiseId(spec.id);
  const cls = `${pascal(id)}Impl`;
  const guard = `${id.toUpperCase()}_IMPL_H`;
  const { stdState, qtState } = partitionState(spec.state);

  // Methods — pure C++ signatures only.
  const methodLines: string[] = [];
  for (const m of spec.methods) {
    if (m.description) methodLines.push(`    // ${m.description}`);
    const args = m.args.map(stdArg).join(", ");
    methodLines.push(`    ${stdReturn(m.returns)} ${m.name}(${args});`);
  }
  if (methodLines.length === 0) {
    methodLines.push(`    // Declare your public methods here. Each becomes callable from QML`);
    methodLines.push(`    // via logos.callModule("${id}", "<methodName>", [args]).`);
  }

  // Header includes — derive from method types only (state-with-Qt-types
  // lives in the .cpp's Private pimpl, so .h stays pure C++).
  const stdIncludes = new Set<string>(["string"]);
  for (const m of spec.methods) {
    for (const a of m.args) {
      if (a.type === "number") stdIncludes.add("cstdint");
    }
    if (m.returns === "number") stdIncludes.add("cstdint");
  }

  return [
    `#ifndef ${guard}`,
    `#define ${guard}`,
    ``,
    `// Universal module — public API uses only standard C++ types`,
    `// (std::string, double, bool, void). All Qt usage is hidden in the`,
    `// .cpp behind a private pimpl, so logos-cpp-generator can parse this`,
    `// header to emit the QML/IPC glue.`,
    ``,
    ...[...stdIncludes].sort().map((h) => `#include <${h}>`),
    ``,
    `class ${cls} {`,
    `public:`,
    `    ${cls}();`,
    `    ~${cls}();`,
    ``,
    ...methodLines,
    ``,
    `private:`,
    // Qt state goes through the pimpl; std state can sit directly here.
    ...stdState.map((s) => {
      const init = s.initial ? ` = ${s.initial}` : "";
      return `    ${s.cppType} m_${s.name}${init};`;
    }),
    ...(qtState.length > 0 || spec.methods.some((m) => /\bd->/.test(m.body ?? ""))
      ? [`    class Private;`, `    Private* d;`]
      : []),
    `};`,
    ``,
    `#endif // ${guard}`,
    ``,
  ].join("\n");
};

const implCpp = (spec: CoreModuleSpec): string => {
  const id = sanitiseId(spec.id);
  const cls = `${pascal(id)}Impl`;
  const detected = detectQtNeeds(spec);
  const { qtState } = partitionState(spec.state);
  const usesPimpl = qtState.length > 0 || spec.methods.some((m) => /\bd->/.test(m.body ?? ""));

  // Method definitions.
  const methodBodies: string[] = [];
  for (const m of spec.methods) {
    const args = m.args.map(stdArg).join(", ");
    methodBodies.push(``);
    methodBodies.push(`${stdReturn(m.returns)} ${cls}::${m.name}(${args})`);
    methodBodies.push(`{`);
    if (m.description) methodBodies.push(`    // ${m.description}`);
    if (m.body && m.body.trim().length > 0) {
      const indented = m.body
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map((line) => (line.length === 0 ? "" : `    ${line}`))
        .join("\n");
      methodBodies.push(indented);
    } else {
      // Acknowledge args so the body compiles even when empty.
      if (m.args.length > 0) {
        const usage = m.args.map((a) => `(void)${a.name};`).join(" ");
        methodBodies.push(`    ${usage}`);
      }
      methodBodies.push(`    // TODO: AI-generated body not yet provided.`);
      methodBodies.push(`    ${stubReturn(m.returns)}`);
    }
    methodBodies.push(`}`);
  }

  const qtIncludes = detected.includes.map((h) => `#include <${h}>`);

  // Constructor / destructor — manage the pimpl when used.
  const ctorBody: string[] = usesPimpl ? [`    : d(new Private())`] : [];
  const dtorBody: string[] = usesPimpl ? [`    delete d;`] : [];

  return [
    `#include "${id}_impl.h"`,
    ``,
    ...(detected.any ? [`// Qt headers auto-detected from method bodies / state.`] : []),
    ...qtIncludes,
    ``,
    ...(usesPimpl
      ? [
          `// Private impl — holds state with Qt types so the public header`,
          `// stays pure C++. AI-generated method bodies access these via`,
          `// d->m_<name>.`,
          `class ${cls}::Private {`,
          `public:`,
          ...qtState.map((s) => {
            const init = s.initial ? `{ ${s.initial} }` : "";
            return `    ${s.cppType} m_${s.name}${init};`;
          }),
          `};`,
          ``,
          `${cls}::${cls}()`,
          ...ctorBody,
          `{}`,
          ``,
          `${cls}::~${cls}() {`,
          ...dtorBody,
          `}`,
        ]
      : [
          `${cls}::${cls}() {}`,
          `${cls}::~${cls}() {}`,
        ]),
    ...methodBodies,
    ``,
  ].join("\n");
};

const readme = (spec: CoreModuleSpec): string => {
  const id = sanitiseId(spec.id);
  const cls = `${pascal(id)}Impl`;
  return [
    `# ${spec.name || id}`,
    ``,
    spec.description || "Universal Logos module generated by lgx.guru.",
    ``,
    `## Build`,
    ``,
    `\`\`\`bash`,
    `nix flake update           # first time only`,
    `nix build '.#lgx-portable'`,
    `\`\`\``,
    ``,
    `Produces \`result/${id}.lgx\`. Install into Basecamp's modules dir`,
    `(\`~/Library/Application Support/Logos/LogosBasecamp/modules/${id}/\` on macOS).`,
    ``,
    `## Layout`,
    ``,
    `- \`src/${id}_impl.h\` — public API (pure C++, std types only)`,
    `- \`src/${id}_impl.cpp\` — implementation (Qt allowed inside)`,
    `- \`metadata.json\` — module manifest with \`"interface": "universal"\``,
    `- \`flake.nix\` — runs \`logos-cpp-generator\` in \`preConfigure\` to emit \`generated_code/\``,
    `- \`CMakeLists.txt\` — \`logos_module()\` target`,
    ``,
    `## Calling from QML`,
    ``,
    `\`\`\`qml`,
    `var raw = logos.callModule("${id}", "${spec.methods[0]?.name ?? "<methodName>"}", []);`,
    `// raw is a JSON-encoded string. Parse + extract:`,
    `var v = JSON.parse(raw);`,
    `\`\`\``,
    ``,
    `## Editing`,
    ``,
    `Public method signatures live in \`${cls}\` in \`src/${id}_impl.h\`.`,
    `Implementation lives in \`src/${id}_impl.cpp\`. Add private state to the`,
    `\`Private\` pimpl class (already there if any Qt-typed state was declared).`,
    ``,
  ].join("\n");
};

// ── Public API ────────────────────────────────────────────────────────────

export function generateCoreModuleFiles(spec: CoreModuleSpec): CodegenFile[] {
  const id = sanitiseId(spec.id);
  return [
    { path: "metadata.json",          data: text(metadataJson(spec)) },
    { path: "flake.nix",              data: text(flakeNix(spec)) },
    { path: "CMakeLists.txt",         data: text(cmakeLists(spec)) },
    { path: `src/${id}_impl.h`,       data: text(implHeader(spec)) },
    { path: `src/${id}_impl.cpp`,     data: text(implCpp(spec)) },
    { path: "README.md",              data: text(readme(spec)) },
  ];
}
