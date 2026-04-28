#!/usr/bin/env node
// Inspect what's actually running + installed in Basecamp. Use this when
// "messages aren't crossing" — it shows whether each Basecamp instance has
// loaded the relay, what's installed, what the manifests declare, etc.
//
// Run: `npm run diagnose` from web/

import { execSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PLUGINS = `${homedir()}/Library/Application Support/Logos/LogosBasecamp/plugins`;
const MODULES = `${homedir()}/Library/Application Support/Logos/LogosBasecamp/modules`;

const c = {
  dim:  (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  ok:   (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  bad:  (s) => `\x1b[31m${s}\x1b[0m`,
  hl:   (s) => `\x1b[36m${s}\x1b[0m`,
};

const banner = (title) => {
  console.log(`\n${c.bold(title)}`);
  console.log(c.dim("─".repeat(title.length)));
};

// ── Running processes ──
banner("Running Basecamp processes");
const ps = spawnSync("ps", ["-ax", "-o", "pid,etime,command"], { encoding: "utf8" }).stdout
  .split("\n")
  .filter((l) => /LogosBasecamp\.bin|logos_host/.test(l));
if (ps.length === 0) {
  console.log(c.warn("(none)"));
} else {
  // Group by Basecamp instance based on parent PID grouping isn't reliable
  // here — just list each process with its loaded plugin.
  for (const l of ps) {
    const m = l.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    const [, pid, etime, cmd] = m;
    const isHost = cmd.includes("logos_host");
    const name = isHost ? (cmd.match(/--name (\S+)/)?.[1] ?? "?") : "Basecamp app";
    const tag = isHost ? c.hl(`[host: ${name}]`) : c.bold("[Basecamp]");
    console.log(`  ${c.dim(pid.padStart(6))}  ${etime.padStart(11)}  ${tag}`);
  }
  // Highlight: how many delivery_relay processes are there vs Basecamp apps?
  const apps = ps.filter((l) => l.includes("LogosBasecamp.bin")).length;
  const relays = ps.filter((l) => /--name delivery_relay/.test(l)).length;
  const deliveries = ps.filter((l) => /--name delivery_module/.test(l)).length;
  console.log("");
  console.log(`  Basecamp instances:    ${c.bold(apps)}`);
  console.log(`  delivery_module hosts: ${deliveries === apps ? c.ok(deliveries) : c.warn(deliveries)} ${deliveries === apps ? "" : "(expected " + apps + ")"}`);
  console.log(`  delivery_relay hosts:  ${relays === apps ? c.ok(relays) : c.warn(relays)} ${relays === apps ? "" : "(expected " + apps + " — older instances likely pre-date the relay install; quit and relaunch)"}`);
}

// ── Installed UI plugins ──
banner("Installed UI plugins");
const pluginDirs = (existsSync(PLUGINS) ? readdirSync(PLUGINS) : []).filter((d) => !d.startsWith("."));
if (pluginDirs.length === 0) {
  console.log(c.warn("(none)"));
} else {
  for (const dir of pluginDirs) {
    const manifestPath = join(PLUGINS, dir, "manifest.json");
    if (!existsSync(manifestPath)) {
      console.log(`  ${c.warn(dir)} ${c.dim("(no manifest.json — broken install)")}`);
      continue;
    }
    let m;
    try { m = JSON.parse(readFileSync(manifestPath, "utf8")); }
    catch { console.log(`  ${c.bad(dir)} ${c.dim("(corrupt manifest)")}`); continue; }
    const deps = (m.dependencies || []).join(", ") || c.dim("none");
    console.log(`  ${c.bold(m.name ?? dir)}  ${c.dim("v" + (m.version || "?"))}`);
    console.log(`    type: ${m.type ?? "?"}, deps: ${deps}`);
  }
}

// ── Installed core modules ──
banner("Installed core modules");
const moduleDirs = (existsSync(MODULES) ? readdirSync(MODULES) : []).filter((d) => !d.startsWith("."));
const installedModuleNames = new Set();   // for the cross-check below
if (moduleDirs.length === 0) {
  console.log(c.warn("(none)"));
} else {
  for (const dir of moduleDirs) {
    // Modules shipped via .lgx have manifest.json; some pre-installed cores
    // (delivery_module etc.) ship as bare dylibs without a manifest. Both
    // count as "installed" for dep-resolution purposes — Basecamp resolves
    // by directory name in the modules/ root.
    const manifestPath = join(MODULES, dir, "manifest.json");
    const dyl = (() => { try { return readdirSync(join(MODULES, dir)).filter((f) => f.endsWith(".dylib")); } catch { return []; } })();
    const dylTag = dyl.length > 0 ? c.ok(`✓ ${dyl.find((f) => f.endsWith("_plugin.dylib")) ?? dyl[0]}`) : c.bad("✗ no dylib");
    if (existsSync(manifestPath)) {
      let m;
      try { m = JSON.parse(readFileSync(manifestPath, "utf8")); }
      catch { console.log(`  ${c.bad(dir)} ${c.dim("(corrupt manifest)")}`); continue; }
      const name = m.name ?? dir;
      installedModuleNames.add(name);
      const deps = (m.dependencies || []).join(", ") || c.dim("none");
      console.log(`  ${c.bold(name)}  ${c.dim("v" + (m.version || "?"))}  ${dylTag}`);
      console.log(`    deps: ${deps}`);
    } else {
      // Pre-installed (no manifest) — name comes from the directory.
      installedModuleNames.add(dir);
      console.log(`  ${c.bold(dir)}  ${c.dim("(pre-installed)")}  ${dylTag}`);
    }
  }
}

// ── Cross-checks ──
banner("Cross-checks");
const installedPluginNames = new Set();
for (const d of pluginDirs) {
  try { installedPluginNames.add(JSON.parse(readFileSync(join(PLUGINS, d, "manifest.json"), "utf8")).name); }
  catch { installedPluginNames.add(d); }
}
const allInstalled = new Set([...installedPluginNames, ...installedModuleNames]);
const missing = [];
for (const dir of pluginDirs) {
  try {
    const m = JSON.parse(readFileSync(join(PLUGINS, dir, "manifest.json"), "utf8"));
    for (const d of m.dependencies || []) {
      if (!allInstalled.has(d)) missing.push(`${m.name} → ${d}`);
    }
  } catch {}
}
if (missing.length === 0) {
  console.log(c.ok("✓ all UI dependencies are installed"));
} else {
  console.log(c.bad("✗ missing dependencies:"));
  for (const m of missing) console.log(`    ${m}`);
}

// ── How to relaunch cleanly ──
banner("Relaunch helpers");
console.log(`  ${c.dim("Quit all:")}    pkill -f LogosBasecamp.bin && pkill -f logos_host`);
console.log(`  ${c.dim("Instance 1:")}  open -n /Users/guru/Desktop/LogosBasecamp.app`);
console.log(`  ${c.dim("Instance 2:")}  open -n /Users/guru/Desktop/LogosBasecamp.app --env POLLING_TCPPORT=60001`);
console.log("");
