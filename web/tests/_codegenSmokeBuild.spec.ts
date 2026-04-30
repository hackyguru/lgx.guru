// One-off harness that asks the rewritten codegen to lay down a complete
// universal-module project for a sample CoreModuleSpec, then writes the
// files to /tmp/codegen-smoke/ so we can run `nix build` against them.
// Lets us validate the codegen against the actual logos-module-builder
// without going through the editor or the LLM. NOT a regression test.
//
// Run: npx vitest run tests/_codegenSmokeBuild.spec.ts

import { describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateCoreModuleFiles } from "../src/app/codegen/coreModule";
import type { CoreModuleSpec } from "../src/app/types";

const OUT = "/tmp/codegen-smoke/london_weather";

const spec: CoreModuleSpec = {
  id: "london_weather",
  name: "London Weather",
  version: "1.0.0",
  description: "Fetches the current London temperature from Open-Meteo and exposes it via lastWeather().",
  category: "custom",
  dependencies: [],
  state: [
    { name: "manager", cppType: "QNetworkAccessManager", initial: "" },
    { name: "last",    cppType: "QString",                initial: 'QStringLiteral("Loading...")' },
  ],
  methods: [
    {
      name: "refreshWeather",
      args: [],
      returns: "void",
      description: "Kicks off an async fetch from Open-Meteo. Non-blocking.",
      body: [
        `const QUrl url(QStringLiteral(`,
        `    "https://api.open-meteo.com/v1/forecast"`,
        `    "?latitude=51.5072&longitude=-0.1276&current=temperature_2m"`,
        `));`,
        `QNetworkRequest req(url);`,
        `QNetworkReply* reply = d->m_manager.get(req);`,
        `QObject::connect(reply, &QNetworkReply::finished, reply, [this, reply]() {`,
        `    QString formatted = QStringLiteral("Weather unavailable");`,
        `    if (reply->error() == QNetworkReply::NoError) {`,
        `        const QByteArray bytes = reply->readAll();`,
        `        const QJsonDocument doc = QJsonDocument::fromJson(bytes);`,
        `        if (doc.isObject()) {`,
        `            const QJsonObject current = doc.object().value(QStringLiteral("current")).toObject();`,
        `            const QJsonValue t = current.value(QStringLiteral("temperature_2m"));`,
        `            if (t.isDouble()) {`,
        `                formatted = QString::number(t.toDouble(), 'f', 1) + QStringLiteral(" C");`,
        `            }`,
        `        }`,
        `    }`,
        `    d->m_last = formatted;`,
        `    reply->deleteLater();`,
        `});`,
      ].join("\n"),
    },
    {
      name: "lastWeather",
      args: [],
      returns: "string",
      description: "Returns the most recently fetched temperature as a string. \"Loading...\" before the first fetch lands.",
      body: `return d->m_last.toStdString();`,
    },
  ],
};

describe("codegen smoke — universal module", () => {
  it("emits the expected files with universal shape", async () => {
    const files = generateCoreModuleFiles(spec);
    const paths = files.map((f) => f.path);
    expect(paths).toContain("metadata.json");
    expect(paths).toContain("flake.nix");
    expect(paths).toContain("CMakeLists.txt");
    expect(paths).toContain("src/london_weather_impl.h");
    expect(paths).toContain("src/london_weather_impl.cpp");
    // Legacy filenames should be gone.
    expect(paths).not.toContain("src/london_weather_plugin.h");
    expect(paths).not.toContain("src/london_weather_interface.h");

    const dec = new TextDecoder();
    const get = (p: string) => dec.decode(files.find((f) => f.path === p)!.data);

    // metadata has the magic interface field.
    const meta = JSON.parse(get("metadata.json"));
    expect(meta.interface).toBe("universal");
    expect(meta.type).toBe("core");
    expect(meta.nix.cmake.find_packages).toContain("Qt6Network");
    expect(meta.nix.cmake.extra_link_libraries).toContain("Qt6::Network");

    // flake.nix runs the generator.
    const flake = get("flake.nix");
    expect(flake).toContain("logos-cpp-generator");
    expect(flake).toContain("--impl-class LondonWeatherImpl");
    expect(flake).toContain("--from-header src/london_weather_impl.h");

    // CMakeLists references the generated dispatch + impl files.
    const cmake = get("CMakeLists.txt");
    expect(cmake).toContain("src/london_weather_impl.h");
    expect(cmake).toContain("src/london_weather_impl.cpp");
    expect(cmake).toContain("generated_code/london_weather_qt_glue.h");
    expect(cmake).toContain("generated_code/london_weather_dispatch.cpp");

    // impl.h is pure C++ (no Qt, no LogosAPI hook) — only public methods.
    const h = get("src/london_weather_impl.h");
    expect(h).toContain("class LondonWeatherImpl");
    expect(h).toContain("void refreshWeather()");
    expect(h).toContain("std::string lastWeather()");
    expect(h).not.toMatch(/Q_INVOKABLE|Q_OBJECT|QString|#include\s*<Q/);
    // onInit / m_api are NOT emitted: the generator parses every public
    // method into the dispatch table, and a LogosAPI* arg can't be coerced
    // from QVariant. Inter-module calls need a different hook (TBD).
    expect(h).not.toContain("void onInit(LogosAPI*");
    expect(h).not.toContain("LogosAPI* m_api");

    // impl.cpp routes Qt-typed state through the Private pimpl + auto-includes.
    const cpp = get("src/london_weather_impl.cpp");
    expect(cpp).toContain('#include "london_weather_impl.h"');
    expect(cpp).toContain("class LondonWeatherImpl::Private");
    expect(cpp).toContain("QNetworkAccessManager m_manager");
    expect(cpp).toContain("QString m_last");
    expect(cpp).toContain("#include <QNetworkAccessManager>");
    expect(cpp).toContain("d->m_last");

    // Tests dir is always emitted (logos-module-builder picks it up).
    const testsCMake = get("tests/CMakeLists.txt");
    expect(testsCMake).toContain("logos_test(");
    expect(testsCMake).toContain("test_london_weather.cpp");
    const testsMain = get("tests/main.cpp");
    expect(testsMain).toContain("LOGOS_TEST_MAIN()");
    const testsImpl = get("tests/test_london_weather.cpp");
    expect(testsImpl).toContain("LOGOS_TEST(london_weather_constructs)");
    expect(testsImpl).toContain("LondonWeatherImpl impl;");

    // Write to disk so we can manually drive `nix build` if we want.
    await rm(OUT, { recursive: true, force: true });
    await mkdir(OUT, { recursive: true });
    for (const f of files) {
      const target = path.join(OUT, f.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(f.data));
    }
    // eslint-disable-next-line no-console
    console.log(`wrote codegen smoke project to ${OUT}`);
  });
});
