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

import { CoreMethod, CoreModuleSpec, ModuleParam, ParamType } from "../types";

// Github URLs we know — used when emitting flake.nix inputs for module
// dependencies. Anything not on this list gets a placeholder URL the
// user is expected to point at the real source.
const KNOWN_DEP_URLS: Record<string, string> = {
  delivery_module: "github:logos-co/logos-delivery-module",
  storage_module:  "github:logos-co/logos-storage-module",
  capability_module: "github:logos-co/logos-capability-module",
  package_manager: "github:logos-co/logos-package-manager",
};

export interface CodegenFile { path: string; data: Uint8Array }

const enc = new TextEncoder();
const text = (s: string) => enc.encode(s);

// QML/JSON id-safe — we use the user's id verbatim if it matches [a-z0-9_],
// otherwise a fallback. Class names use PascalCase derived from the id.
const sanitiseId = (raw: string): string => {
  const s = typeof raw === "string" ? raw : "";
  return (s.match(/^[a-z][a-z0-9_]*$/) ? s : "my_module").toLowerCase();
};

const pascal = (id: string): string =>
  (id || "").split("_").filter(Boolean).map((s) => s[0].toUpperCase() + s.slice(1)).join("");

// Normalise a CoreModuleSpec from AI JSON — any field could be missing,
// wrong type, or malformed. Returns a spec safe to pass through codegen.
const normaliseSpec = (raw: CoreModuleSpec): CoreModuleSpec => ({
  ...raw,
  id: typeof raw.id === "string" ? raw.id : "my_module",
  name: typeof raw.name === "string" ? raw.name : (raw.id ?? "Module"),
  version: typeof raw.version === "string" ? raw.version : "1.0.0",
  description: typeof raw.description === "string" ? raw.description : "",
  category: typeof raw.category === "string" ? raw.category : "custom",
  dependencies: Array.isArray(raw.dependencies) ? raw.dependencies : [],
  methods: (Array.isArray(raw.methods) ? raw.methods : []).map((m) => ({
    ...m,
    name: (typeof m.name === "string" ? m.name : "unnamed").replace(/[^a-zA-Z0-9_]/g, "_"),
    args: Array.isArray(m.args) ? m.args.map((a) => ({
      ...a,
      name: (typeof a.name === "string" ? a.name : "arg").replace(/[^a-zA-Z0-9_]/g, "_"),
      type: typeof a.type === "string" ? a.type : "string" as const,
    })) : [],
    returns: typeof m.returns === "string" ? m.returns : "void" as const,
    body: typeof m.body === "string" ? m.body : undefined,
  })),
  state: (Array.isArray(raw.state) ? raw.state : []).map((s) => ({
    ...s,
    name: (typeof s.name === "string" ? s.name : "value").replace(/[^a-zA-Z0-9_]/g, "_"),
    cppType: typeof s.cppType === "string" && s.cppType.trim() ? s.cppType : "std::string",
    initial: typeof s.initial === "string" ? s.initial : undefined,
  })),
  events: Array.isArray(raw.events) ? raw.events : [],
  tests: Array.isArray(raw.tests) ? raw.tests.map((t) => ({
    ...t,
    name: typeof t.name === "string" ? t.name : "test",
    body: typeof t.body === "string" ? t.body : "",
  })) : [],
});

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

// Args: const-ref for std::string, value for primitives. cppType
// overrides the basic mapping when set (lets the AI pick richer C++
// types like std::vector<std::string>, LogosMap, int64_t, byte arrays).
const stdArg = (p: ModuleParam): string => {
  if (p.cppType && p.cppType.trim().length > 0) {
    const t = p.cppType.trim();
    // Heuristic: pass non-trivial types by const-ref, primitives by value.
    const isPrimitive = /^(?:bool|int|short|long|long long|unsigned[\w\s]*|char|signed[\w\s]*|float|double|int8_t|int16_t|int32_t|int64_t|uint8_t|uint16_t|uint32_t|uint64_t|size_t|ssize_t|std::size_t)\b\s*\*?$/.test(t);
    return isPrimitive ? `${t} ${p.name}` : `const ${t}& ${p.name}`;
  }
  return p.type === "string" ? `const std::string& ${p.name}` : `${stdType(p.type)} ${p.name}`;
};

// Method return form. cppReturn overrides when set.
const stdReturnFor = (m: CoreMethod): string => {
  if (m.cppReturn && m.cppReturn.trim().length > 0) return m.cppReturn.trim();
  return stdReturn(m.returns);
};

const stubReturn = (r: ParamType | "void"): string => {
  switch (r) {
    case "void":    return "// no return";
    case "string":  return "return std::string();";
    case "number":  return "return 0.0;";
    case "boolean": return "return false;";
    default:        return "// no return";
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
  // Qt6::Network — the most common for API-fetching modules
  {
    pattern: /\bQNetwork(?:AccessManager|Request|Reply|Cookie|CookieJar)\b/,
    includes: ["QNetworkAccessManager", "QNetworkRequest", "QNetworkReply"],
    findPackage: "Qt6Network",
    linkLib: "Qt6::Network",
  },
  // Qt6::Sql — for local database storage
  {
    pattern: /\bQSql(?:Database|Query|Error|Record|Field|Driver|Index|Result|TableModel|QueryModel|RelationalTableModel)?\b/,
    includes: ["QSqlDatabase", "QSqlQuery", "QSqlError", "QSqlRecord"],
    findPackage: "Qt6Sql",
    linkLib: "Qt6::Sql",
  },
  // Qt6::Core classes (already linked, just need includes)
  {
    pattern: /\bQJson(?:Document|Object|Array|Value|ParseError)\b/,
    includes: ["QJsonDocument", "QJsonObject", "QJsonArray", "QJsonValue", "QJsonParseError"],
  },
  { pattern: /\bQTimer\b/,            includes: ["QTimer"] },
  { pattern: /\bQDateTime\b/,         includes: ["QDateTime"] },
  { pattern: /\bQDate\b/,             includes: ["QDate"] },
  { pattern: /\bQTime\b(?!\s*:)/,     includes: ["QTime"] },
  { pattern: /\bQUrl(?:Query)?\b/,    includes: ["QUrl", "QUrlQuery"] },
  { pattern: /\bQByteArray\b/,        includes: ["QByteArray"] },
  { pattern: /\bQString(?:List)?\b/,  includes: ["QString", "QStringList"] },
  { pattern: /\bQHash\b|\bQMap\b/,    includes: ["QHash", "QMap"] },
  { pattern: /\bQVector\b|\bQList\b/, includes: ["QVector", "QList"] },
  { pattern: /\bQVariant\b/,          includes: ["QVariant"] },
  { pattern: /\bQObject\b/,           includes: ["QObject"] },
  { pattern: /\bqDebug\b|\bqWarning\b|\bqInfo\b/, includes: ["QDebug"] },
  { pattern: /\bQFile\b/,             includes: ["QFile"] },
  { pattern: /\bQDir\b/,              includes: ["QDir"] },
  { pattern: /\bQTextStream\b/,       includes: ["QTextStream"] },
  { pattern: /\bQIODevice\b/,         includes: ["QIODevice"] },
  { pattern: /\bQRegularExpression\b/, includes: ["QRegularExpression"] },
  { pattern: /\bQCryptographicHash\b/, includes: ["QCryptographicHash"] },
  { pattern: /\bQRandomGenerator\b/,  includes: ["QRandomGenerator"] },
  { pattern: /\bQUuid\b/,             includes: ["QUuid"] },
  { pattern: /\bQElapsedTimer\b/,     includes: ["QElapsedTimer"] },
  { pattern: /\bQStandardPaths\b/,    includes: ["QStandardPaths"] },
  { pattern: /\bQSettings\b/,         includes: ["QSettings"] },
  { pattern: /\bQProcess\b/,          includes: ["QProcess"] },
  { pattern: /\bQThread\b/,           includes: ["QThread"] },
  { pattern: /\bQMutex\b/,            includes: ["QMutex"] },
  { pattern: /\bQEventLoop\b/,        includes: ["QEventLoop"] },
  { pattern: /\bQCoreApplication\b/,  includes: ["QCoreApplication"] },
];

// Non-Qt feature detection: nlohmann::json aliases (LogosMap / LogosList).
// The generator maps these to QVariantMap / QVariantList in the dispatch
// glue — lets methods return structured payloads natively.
// IMPORTANT: logos_json.h includes <nlohmann/json.hpp> which is NOT bundled
// with the logos-cpp-sdk — it must be added to nix.packages.build in
// metadata.json so mkLogosModule resolves it from nixpkgs.
const detectLogosJson = (corpus: string): boolean =>
  /\bLogos(?:Map|List)\b/.test(corpus);

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
    ...spec.methods.map((m) => m.cppReturn ?? ""),
    ...spec.methods.flatMap((m) => m.args.map((a) => a.cppType ?? "")),
    ...spec.state.map((s) => s.cppType ?? ""),
    ...spec.state.map((s) => s.initial ?? ""),
    ...(spec.tests ?? []).map((t) => t.body ?? ""),
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

// True when the spec uses LogosMap/LogosList anywhere — used to inject
// the <logos_json.h> include + nlohmann-json build dependency.
// Also true when the module declares events, because the emitEvent
// callback signature uses LogosList.
const usesLogosJson = (spec: CoreModuleSpec): boolean => {
  // Events use LogosList in the emitEvent callback signature
  if ((spec.events ?? []).length > 0) return true;
  const corpus = [
    ...spec.methods.map((m) => m.body ?? ""),
    ...spec.methods.map((m) => m.cppReturn ?? ""),
    ...spec.methods.flatMap((m) => m.args.map((a) => a.cppType ?? "")),
    ...(spec.tests ?? []).map((t) => t.body ?? ""),
  ].join("\n");
  return detectLogosJson(corpus);
};

// All state lives in the Private pimpl in the .cpp — uniform access via
// `d->m_<name>` regardless of whether the field is Qt-typed (QString,
// QNetworkAccessManager) or std-typed (bool, int64_t, std::string).
//
// We tried partitioning std-typed state to direct members of the impl
// class, but the AI consistently writes `d->m_X` for everything, and the
// resulting compile errors ("no member named 'm_fetching' in Private")
// kept costing whole multi-minute build cycles. Uniform pimpl is simpler,
// keeps the public .h pure C++ regardless, and matches the AI's mental
// model. Tiny pointer-chase cost is irrelevant here.

// ── File generators ───────────────────────────────────────────────────────

const metadataJson = (spec: CoreModuleSpec): string => {
  const id = sanitiseId(spec.id);
  const detected = detectQtNeeds(spec);
  const wantsLogosJson = usesLogosJson(spec);

  // When LogosMap/LogosList is used, nlohmann-json must be available at
  // build time. logos_json.h includes <nlohmann/json.hpp> which isn't
  // bundled with the logos-cpp-sdk. The correct way to supply it is via
  // nix.packages.build — mkLogosModule maps these strings to nixpkgs
  // packages (e.g. pkgs.nlohmann_json) and adds them to nativeBuildInputs.
  // NOTE: nix.external_libraries is for flake-input-based bundled libs
  // (like .so/.dylib in lib/), NOT for nixpkgs packages.
  const buildPkgs: string[] = [];
  const findPkgs = [...detected.findPackages];
  const linkLibs = [...detected.linkLibs];
  if (wantsLogosJson) {
    buildPkgs.push("nlohmann_json");
    findPkgs.push("nlohmann_json");
    linkLibs.push("nlohmann_json::nlohmann_json");
  }

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
      packages: { build: buildPkgs, runtime: [] },
      external_libraries: [],
      cmake: {
        find_packages: findPkgs,
        extra_sources: [],
        extra_include_dirs: [],
        extra_link_libraries: linkLibs,
      },
    },
  }, null, 2) + "\n";
};

const flakeNix = (spec: CoreModuleSpec): string => {
  const id = sanitiseId(spec.id);
  const cls = `${pascal(id)}Impl`;
  // Each metadata.json dependency must also appear as a flake input — the
  // logos-module-builder framework reads them to assemble the module's
  // dependency graph at build time. Known modules get canonical github:
  // URLs; unknown ones get a placeholder commented line the user can fill.
  const depInputLines: string[] = [];
  for (const dep of spec.dependencies) {
    const url = KNOWN_DEP_URLS[dep];
    if (url) {
      depInputLines.push(`    ${dep}.url = "${url}";`);
    } else {
      depInputLines.push(`    # ${dep}.url = "github:org/logos-${dep.replace(/_/g, "-")}";  # TODO: set the real source URL`);
    }
  }
  return [
    `{`,
    `  description = "${(spec.description || spec.name || id).replace(/[\\"]/g, "\\$&").replace(/\$/g, "\\$")}";`,
    ``,
    `  inputs = {`,
    `    logos-module-builder.url = "github:logos-co/logos-module-builder";`,
    ...depInputLines,
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
  const wantsLogosJson = usesLogosJson(spec);
  const hasEvents = (spec.events ?? []).length > 0;

  // Methods — pure C++ signatures, optionally overridden via cppType/cppReturn.
  const methodLines: string[] = [];
  for (const m of spec.methods) {
    if (m.description) methodLines.push(`    // ${m.description}`);
    const args = m.args.map(stdArg).join(", ");
    methodLines.push(`    ${stdReturnFor(m)} ${m.name}(${args});`);
  }
  if (methodLines.length === 0) {
    methodLines.push(`    // Declare your public methods here. Each becomes callable from QML`);
    methodLines.push(`    // via logos.callModule("${id}", "<methodName>", [args]).`);
  }

  // Header includes — derive from method types and state cppType. State
  // lives in the .cpp's Private pimpl, but the .cpp transitively pulls
  // these via #include "<id>_impl.h", so it's simpler to declare them once
  // in the header. Standard headers don't break .h's "pure C++" property.
  const stdIncludes = new Set<string>(["string"]);
  // Scan type declarations, state fields, and method bodies for std:: usage.
  const allCorpus = [
    ...spec.methods.map((m) => m.body ?? ""),
    ...spec.methods.map((m) => m.cppReturn ?? ""),
    ...spec.methods.flatMap((m) => m.args.map((a) => a.cppType ?? "")),
    ...spec.state.map((s) => s.cppType ?? ""),
  ].join("\n");
  for (const h of scanBodyStdIncludes(allCorpus)) stdIncludes.add(h);
  for (const m of spec.methods) {
    for (const a of m.args) {
      if (a.type === "number") stdIncludes.add("cstdint");
    }
    if (m.returns === "number") stdIncludes.add("cstdint");
  }
  // emitEvent uses std::function<void(const std::string&, LogosList)>
  if (hasEvents) {
    stdIncludes.add("functional");
  }

  // emitEvent member declaration — when set by the host, the impl can
  // call `if (emitEvent) emitEvent("name", LogosList{...});` to push an
  // event back to QML. The generator wires this to LogosProviderBase::emitEvent.
  const emitEventMember = hasEvents
    ? [
        ``,
        `    // Set by the host (logos-cpp-generator wires this to`,
        `    // LogosProviderBase::emitEvent in the generated dispatch).`,
        `    // Call from method bodies to push events back to QML:`,
        `    //   if (emitEvent) emitEvent("name", LogosList{ value1, value2 });`,
        `    std::function<void(const std::string&, LogosList)> emitEvent;`,
      ]
    : [];

  // NOTE: We do NOT declare an explicit onInit(LogosAPI*) in the public
  // header. logos-cpp-generator parses every public method into the
  // dispatch table, and a LogosAPI* arg doesn't convert from QVariant —
  // build fails. Inter-module calls (the `dependencies` field) require
  // a hook the generator emits in its own glue layer; wiring that into
  // our impl class needs more research and is a follow-up.

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
    ...(wantsLogosJson ? [``, `#include <logos_json.h>   // LogosMap / LogosList aliases for nlohmann::json`] : []),
    ``,
    `class ${cls} {`,
    `public:`,
    `    ${cls}();`,
    `    ~${cls}();`,
    ``,
    ...methodLines,
    ...emitEventMember,
    ``,
    `private:`,
    // All state lives in Private (defined in the .cpp). Keeps the public
    // header pure C++ so logos-cpp-generator can parse it, and gives the AI
    // a single uniform access pattern: `d->m_<name>` for every field.
    ...(spec.state.length > 0 || spec.methods.some((m) => /\bd->/.test(m.body ?? ""))
      ? [`    class Private;`, `    Private* d;`]
      : []),
    `};`,
    ``,
    `#endif // ${guard}`,
    ``,
  ].join("\n");
};

// Scan a C++ source string for standard-library usage and return the
// set of headers that need to be #included.
const scanBodyStdIncludes = (corpus: string): Set<string> => {
  const out = new Set<string>();
  if (/\bstd::(?:i|o|io)?stringstream\b/.test(corpus)) out.add("sstream");
  if (/\bstd::(?:sort|find|transform|for_each|count|copy|remove|reverse|min|max|clamp)\b/.test(corpus)) out.add("algorithm");
  if (/\bstd::numeric_limits\b/.test(corpus)) out.add("limits");
  if (/\bstd::(?:abs|pow|sqrt|floor|ceil|round|fmod|fabs)\b/.test(corpus)) out.add("cmath");
  if (/\bstd::(?:stoi|stod|stof|stol|to_string)\b/.test(corpus)) out.add("string");
  if (/\bstd::(?:tuple|make_tuple)\b|\bstd::get</.test(corpus)) out.add("tuple");
  if (/\bstd::(?:pair|make_pair)\b/.test(corpus)) out.add("utility");
  if (/\bstd::(?:unique_ptr|shared_ptr|make_unique|make_shared)\b/.test(corpus)) out.add("memory");
  if (/\bstd::(?:mutex|lock_guard)\b/.test(corpus)) out.add("mutex");
  if (/\bstd::(?:regex|smatch)\b/.test(corpus)) out.add("regex");
  if (/\bstd::accumulate\b/.test(corpus)) out.add("numeric");
  if (/\bstd::vector\b|\bstd::array\b/.test(corpus)) out.add("vector");
  if (/\bstd::map\b|\bstd::unordered_map\b/.test(corpus)) out.add("map");
  if (/\bstd::set\b|\bstd::unordered_set\b/.test(corpus)) out.add("set");
  if (/\bstd::deque\b/.test(corpus)) out.add("deque");
  if (/\bstd::function\b/.test(corpus)) out.add("functional");
  if (/\bstd::optional\b/.test(corpus)) out.add("optional");
  if (/\bstd::variant\b/.test(corpus)) out.add("variant");
  if (/\bstd::chrono\b/.test(corpus)) out.add("chrono");
  if (/\bint64_t\b|\buint64_t\b|\bint32_t\b|\buint32_t\b/.test(corpus)) out.add("cstdint");
  return out;
};

const implCpp = (spec: CoreModuleSpec): string => {
  const id = sanitiseId(spec.id);
  const cls = `${pascal(id)}Impl`;
  const detected = detectQtNeeds(spec);
  const wantsLogosJson = usesLogosJson(spec);
  // Always-pimpl: every spec.state field lives inside Private. Pimpl is
  // emitted whenever there's any state, or whenever a body references `d->`
  // explicitly (e.g. user-typed access pattern with no declared state yet).
  const usesPimpl = spec.state.length > 0 || spec.methods.some((m) => /\bd->/.test(m.body ?? ""));
  const hasEvents = (spec.events ?? []).length > 0;

  // Method definitions.
  const methodBodies: string[] = [];
  for (const m of spec.methods) {
    const args = m.args.map(stdArg).join(", ");
    methodBodies.push(``);
    methodBodies.push(`${stdReturnFor(m)} ${cls}::${m.name}(${args})`);
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

  // Scan method bodies for standard-library usage and emit those includes
  // directly in the .cpp (the header may also have them, but being explicit
  // here avoids subtle breakage when logos-cpp-generator's generated glue
  // header doesn't transitively pull everything).
  const bodyCombined = spec.methods.map((m) => m.body ?? "").join("\n");
  const bodyStd = scanBodyStdIncludes(bodyCombined);
  const bodyStdIncludes = [...bodyStd].sort().map((h) => `#include <${h}>`);

  return [
    `#include "${id}_impl.h"`,
    ``,
    ...(detected.any ? [`// Qt headers auto-detected from method bodies / state.`] : []),
    ...qtIncludes,
    ...bodyStdIncludes,
    ...(wantsLogosJson ? [`#include <logos_json.h>`] : []),
    ``,
    ...(usesPimpl
      ? [
          `// Private impl — holds ALL state (Qt-typed and std-typed alike)`,
          `// so the public header stays pure C++. Method bodies access these`,
          `// uniformly via d->m_<name>.`,
          `class ${cls}::Private {`,
          `public:`,
          ...spec.state.map((s) => {
            const safeName = (s.name || "value").replace(/[^a-zA-Z0-9_]/g, "_");
            const init = s.initial ? `{ ${s.initial} }` : "";
            return `    ${s.cppType || "std::string"} m_${safeName}${init};`;
          }),
          `};`,
          ``,
          `${cls}::${cls}()`,
          `    : d(new Private())`,
          `{}`,
          ``,
          `${cls}::~${cls}() {`,
          `    delete d;`,
          `}`,
        ]
      : [
          `${cls}::${cls}() {}`,
          `${cls}::~${cls}() {}`,
        ]),
    ...methodBodies,
    ...(hasEvents
      ? [
          ``,
          `// emitEvent is wired by the generated dispatch — no definition`,
          `// needed here. Method bodies invoke it via:`,
          `//   if (emitEvent) emitEvent("eventName", LogosList{ args... });`,
        ]
      : []),
    ``,
  ].join("\n");
};

// ── Unit tests (logos-test-framework) ──────────────────────────────────────
//
// We always lay down a minimal tests/ directory so the build pipeline can
// run `nix build '.#unit-tests'` after the main build succeeds. If the
// spec.tests array is empty we emit a smoke test that just instantiates
// the impl class — proves the constructor doesn't crash. AI-provided tests
// land as additional LOGOS_TEST() blocks.

const testsMain = (): string => [
  `// Test runner entry point. logos-module-builder picks this up via the`,
  `// LOGOS_TEST_MAIN() macro and dispatches all LOGOS_TEST() blocks.`,
  `#include <logos_test.h>`,
  ``,
  `LOGOS_TEST_MAIN()`,
  ``,
].join("\n");

const testsCpp = (spec: CoreModuleSpec): string => {
  const id = sanitiseId(spec.id);
  const cls = `${pascal(id)}Impl`;
  const aiTests = spec.tests ?? [];

  const lines: string[] = [
    `// Generated by lgx.guru. AI-authored tests are appended below the`,
    `// smoke test. The build pipeline runs these after the main module`,
    `// build; failures feed back to the AI for retry.`,
    `#include <logos_test.h>`,
    `#include "../src/${id}_impl.h"`,
    ``,
    `// Smoke test — proves the impl class can be constructed and destroyed`,
    `// without crashing. Always passes for a well-formed module.`,
    `LOGOS_TEST(${id}_constructs) {`,
    `    ${cls} impl;`,
    `    (void)impl;`,
    `    LOGOS_ASSERT_TRUE(true);`,
    `}`,
  ];

  for (const t of aiTests) {
    lines.push(``);
    if (t.description) lines.push(`// ${t.description}`);
    lines.push(`LOGOS_TEST(${t.name}) {`);
    // Default: instantiate impl as `impl` so the body can poke at it.
    lines.push(`    ${cls} impl;`);
    // Sanitise: the AI sometimes wraps the body in its own LOGOS_TEST(){}
    // or includes a trailing `}` that conflicts with our wrapper. Strip
    // any leading LOGOS_TEST(...){ header and the matching trailing brace.
    let body = (t.body ?? "").replace(/\r\n/g, "\n").trim();
    // Strip wrapping LOGOS_TEST(…) { … }
    const wrapRe = /^LOGOS_TEST\s*\([^)]*\)\s*\{([\s\S]*)\}\s*$/;
    const wrapM = body.match(wrapRe);
    if (wrapM) body = wrapM[1].trim();
    // Strip duplicate `Impl impl;` line the AI may have included
    body = body.replace(new RegExp(`^\\s*${cls}\\s+impl\\s*;\\s*\\n?`, "m"), "");
    const indented = body
      .split("\n")
      .map((line) => (line.length === 0 ? "" : `    ${line}`))
      .join("\n");
    lines.push(indented);
    lines.push(`}`);
  }

  lines.push(``);
  return lines.join("\n");
};

const testsCMake = (spec: CoreModuleSpec): string => {
  const id = sanitiseId(spec.id);
  return [
    `cmake_minimum_required(VERSION 3.14)`,
    `project(${pascal(id)}Tests LANGUAGES CXX)`,
    ``,
    `# logos-module-builder auto-detects this file and creates the`,
    `# checks.<system>.unit-tests + packages.<system>.unit-tests targets.`,
    `# Run with \`nix build '.#unit-tests' -L\`.`,
    `include(LogosTest)`,
    ``,
    `logos_test(`,
    `    NAME ${id}_tests`,
    `    MODULE_SOURCES ../src/${id}_impl.cpp`,
    `    TEST_SOURCES`,
    `        main.cpp`,
    `        test_${id}.cpp`,
    `)`,
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

export function generateCoreModuleFiles(rawSpec: CoreModuleSpec): CodegenFile[] {
  const spec = normaliseSpec(rawSpec);
  const id = sanitiseId(spec.id);
  return [
    { path: "metadata.json",          data: text(metadataJson(spec)) },
    { path: "flake.nix",              data: text(flakeNix(spec)) },
    { path: "CMakeLists.txt",         data: text(cmakeLists(spec)) },
    { path: `src/${id}_impl.h`,       data: text(implHeader(spec)) },
    { path: `src/${id}_impl.cpp`,     data: text(implCpp(spec)) },
    // Always emit a tests/ directory. logos-module-builder auto-detects
    // it and exposes `nix build '.#unit-tests'`. The build pipeline runs
    // this after the lib build to catch semantic bugs the compiler can't.
    { path: "tests/main.cpp",         data: text(testsMain()) },
    { path: `tests/test_${id}.cpp`,   data: text(testsCpp(spec)) },
    { path: "tests/CMakeLists.txt",   data: text(testsCMake(spec)) },
    { path: "README.md",              data: text(readme(spec)) },
  ];
}
