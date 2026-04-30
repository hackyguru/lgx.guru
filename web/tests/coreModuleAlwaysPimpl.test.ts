// Regression: when the AI declares std-typed state (bool, int64_t, etc.)
// it naturally writes `d->m_<name>` for access, matching its mental model
// of uniform pimpl. The old codegen partitioned std-typed state to direct
// members of the impl class — so `d->m_fetching` failed to compile with
// "no member named 'm_fetching' in 'CryptoPricesImpl::Private'", costing
// 3+ build cycles before the AI gave up. We now always-pimpl all state.

import { describe, expect, it } from "vitest";
import { generateCoreModuleFiles } from "../src/app/codegen/coreModule";
import type { CoreModuleSpec } from "../src/app/types";

const dec = new TextDecoder();

const cryptoLikeSpec = (): CoreModuleSpec => ({
  id: "crypto_prices",
  name: "Crypto Prices",
  version: "0.1.0",
  description: "Polls a price API",
  category: "custom",
  dependencies: [],
  state: [
    // The ones that broke the user's build — std-typed primitives.
    { name: "fetching",       cppType: "bool",     initial: "false" },
    { name: "lastSuccessMs",  cppType: "int64_t",  initial: "0" },
    { name: "started",        cppType: "bool",     initial: "false" },
    // Plus a Qt-typed one to confirm both kinds coexist in Private.
    { name: "manager",        cppType: "QNetworkAccessManager", initial: "" },
  ],
  methods: [
    {
      name: "kickoff",
      args: [],
      returns: "void",
      description: "",
      // Body references std-typed fields via d->. This is the AI's natural
      // pattern and used to fail with "no member named 'm_fetching'".
      body: [
        `if (d->m_fetching) return;`,
        `d->m_fetching = true;`,
        `d->m_started = true;`,
        `d->m_lastSuccessMs = 0;`,
      ].join("\n"),
    },
    {
      name: "isFetching",
      args: [],
      returns: "boolean",
      description: "",
      body: `return d->m_fetching;`,
    },
  ],
});

describe("always-pimpl: std-typed state lives in Private", () => {
  it("does NOT emit std state as direct members of the impl class", () => {
    const files = generateCoreModuleFiles(cryptoLikeSpec());
    const h = dec.decode(files.find((f) => f.path === "src/crypto_prices_impl.h")!.data);
    // The header used to declare `bool m_fetching;` etc. directly. With
    // always-pimpl it must NOT — those are inside Private in the .cpp.
    expect(h).not.toMatch(/^\s*bool m_fetching;/m);
    expect(h).not.toMatch(/^\s*bool m_started;/m);
    expect(h).not.toMatch(/^\s*int64_t m_lastSuccessMs;/m);
    // What it MUST have: the pimpl forward decl + pointer.
    expect(h).toContain("class Private;");
    expect(h).toContain("Private* d;");
  });

  it("emits ALL state (std + Qt) inside Private in the .cpp", () => {
    const files = generateCoreModuleFiles(cryptoLikeSpec());
    const cpp = dec.decode(files.find((f) => f.path === "src/crypto_prices_impl.cpp")!.data);
    // Private must contain every field — std and Qt alike.
    expect(cpp).toContain("class CryptoPricesImpl::Private");
    expect(cpp).toMatch(/bool m_fetching\{ false \}/);
    expect(cpp).toMatch(/bool m_started\{ false \}/);
    expect(cpp).toMatch(/int64_t m_lastSuccessMs\{ 0 \}/);
    expect(cpp).toContain("QNetworkAccessManager m_manager");
    // And the bodies splice in untouched, with their d-> access intact.
    expect(cpp).toContain("if (d->m_fetching) return;");
    expect(cpp).toContain("return d->m_fetching;");
  });

  it("auto-includes <cstdint> when state uses int64_t (even if no method does)", () => {
    const files = generateCoreModuleFiles(cryptoLikeSpec());
    const h = dec.decode(files.find((f) => f.path === "src/crypto_prices_impl.h")!.data);
    expect(h).toContain("#include <cstdint>");
  });

  it("public header still has zero Qt — logos-cpp-generator can parse it", () => {
    const files = generateCoreModuleFiles(cryptoLikeSpec());
    const h = dec.decode(files.find((f) => f.path === "src/crypto_prices_impl.h")!.data);
    expect(h).not.toMatch(/Q_INVOKABLE|Q_OBJECT/);
    expect(h).not.toMatch(/QString|QNetworkAccessManager/);
    expect(h).not.toMatch(/#include\s*<Q[A-Z]/);
  });
});
