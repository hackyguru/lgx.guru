// Source-level regression tests for the delivery_relay C++ plugin.
//
// These guard the relay against the "LogosAPI not available" silent failure
// mode: the PluginInterface base class declares a `logosAPI` member that
// Basecamp's runtime uses to dispatch calls into our plugin. A private
// duplicate (e.g. `m_api`) leaves `logosAPI` null → every callModule into
// the relay no-ops → the UI's status pill stays "Off" forever.
//
// We only check the source for the right pattern. A proper integration
// test would require running Basecamp + sending traffic; these run in <1ms.

import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const HEADER = resolve(__dirname, "..", "..", "core-modules", "delivery-relay", "src", "delivery_relay_plugin.h");
const CPP    = resolve(__dirname, "..", "..", "core-modules", "delivery-relay", "src", "delivery_relay_plugin.cpp");

describe("delivery-relay source guards", () => {
  const cpp = readFileSync(CPP, "utf8");
  const hdr = readFileSync(HEADER, "utf8");

  it("initLogos assigns the api to the inherited PluginInterface::logosAPI field", () => {
    // Match `logosAPI = api;` (whitespace-tolerant). NOT `m_api = api;`.
    expect(cpp).toMatch(/logosAPI\s*=\s*api\s*;/);
    expect(cpp).not.toMatch(/m_api\s*=\s*api\s*;/);
  });

  it("does not declare a duplicate m_api LogosAPI* private member", () => {
    expect(hdr).not.toMatch(/LogosAPI\*\s+m_api\b/);
  });

  it("uses logosAPI (not m_api) to obtain the delivery_module client", () => {
    expect(cpp).toMatch(/logosAPI->getClient\("delivery_module"\)/);
  });

  it("registers onEvent handlers BEFORE the delivery start RPC", () => {
    // The onEvent registrations must come earlier in the source than the
    // start invocation — Basecamp's connectionStateChanged fires synchronously
    // from start() and unregistered handlers will miss it.
    const onEventIdx = cpp.indexOf('onEvent(m_deliveryObject, "connectionStateChanged"');
    const startIdx   = cpp.indexOf('invokeRemoteMethod("delivery_module", "start")');
    expect(onEventIdx).toBeGreaterThan(0);
    expect(startIdx).toBeGreaterThan(0);
    expect(onEventIdx).toBeLessThan(startIdx);
  });

  it("plugin name() returns delivery_relay (matches the QML's callModule key)", () => {
    expect(hdr).toMatch(/QString\s+name\(\)\s+const\s+override\s*\{\s*return\s+"delivery_relay";\s*\}/);
  });
});
