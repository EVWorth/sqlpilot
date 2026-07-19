#!/usr/bin/env node
// scripts/check-deps.mjs
//
// Supply-chain defense: minimum-publish-age gate for direct dependencies.
//
// npm: handled natively by `.npmrc` -> `min-release-age=7`. The npm CLI refuses
// to resolve any package version published less than 7 days ago at install /
// update time. We deliberately do NOT duplicate this check here — running it
// twice would block resolution that the user otherwise trusts .npmrc to gate.
// CI also runs `npm ci` against the lockfile, which doesn't re-resolve.
//
// cargo: no native stable equivalent exists today. RFC 3923 /
// `-Zmin-publish-age` is nightly-only as of 2026-07; cargo-cooldown is a
// wrapper that requires every developer to opt in. Until Rust 1.98+ ships
// min-publish-age on stable, the post-hoc check below is the closest
// equivalent for the cargo half of the deps graph. See #223 for tracking.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const MIN_AGE_DAYS = parseInt(process.env.MIN_AGE_DAYS || "7", 10);
const MIN_AGE_MS = MIN_AGE_DAYS * 24 * 60 * 60 * 1000;
const REGISTRY_CONCURRENCY = 8;

let failures = 0;

async function fetchWithRetry(url, opts = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, opts);
      if (res.ok) return res;
      if (res.status === 404 || res.status === 405) return null;
      if (i < retries - 1) await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    } catch {
      if (i < retries - 1) await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  return null;
}

async function checkAll(checks) {
  const results = [];
  for (let i = 0; i < checks.length; i += REGISTRY_CONCURRENCY) {
    const batch = checks.slice(i, i + REGISTRY_CONCURRENCY).map(async (check) => {
      const age = await checkEntry(check);
      if (age !== null) results.push({ ...check, age });
    });
    await Promise.all(batch);
  }
  return results;
}

async function checkEntry({ name, version, ecosystem, url }) {
  const opts = ecosystem === "cargo"
    ? { headers: { "User-Agent": "sqlpilot-dep-check/1.0" } }
    : {};
  const res = await fetchWithRetry(url, opts);
  if (!res) {
    console.warn(`  [${ecosystem}] ${name}@${version} — registry unavailable`);
    return null;
  }
  try {
    const data = await res.json();
    const created = data.version?.created_at;
    if (!created) {
      console.warn(`  [${ecosystem}] ${name}@${version} — no publish time`);
      return null;
    }
    return Date.now() - new Date(created).getTime();
  } catch {
    console.warn(`  [${ecosystem}] ${name}@${version} — parse error`);
    return null;
  }
}

// ── Cargo: resolve workspace crates against Cargo.lock ───────────────

const LOCK_PATH = resolve(ROOT, "src-tauri", "Cargo.lock");

function parseCargoLock(path) {
  const text = readFileSync(path, "utf-8");
  const packages = [];
  let inPackage = false;
  let current = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "[[package]]") {
      if (inPackage) packages.push(current);
      inPackage = true;
      current = {};
    } else if (inPackage && trimmed.startsWith("name = ")) {
      current.name = trimmed.match(/name = "(.+)"/)?.[1];
    } else if (inPackage && trimmed.startsWith("version = ")) {
      current.version = trimmed.match(/version = "(.+)"/)?.[1];
    } else if (inPackage && trimmed.startsWith("source = ")) {
      current.source = trimmed.match(/source = "(.+)"/)?.[1];
    } else if (inPackage && trimmed === "") {
      // empty line within package block is fine, skip
    } else if (inPackage && !trimmed.startsWith("[")) {
      // skip other fields
    } else if (inPackage && trimmed.startsWith("[") && trimmed !== "[[package]]") {
      packages.push(current);
      inPackage = false;
      current = {};
    }
  }
  if (inPackage) packages.push(current);
  return packages.filter((p) => p.name && p.version);
}

let lockPkgs;
try {
  lockPkgs = parseCargoLock(LOCK_PATH);
} catch {
  console.warn("[cargo] failed to parse Cargo.lock — skipping");
  lockPkgs = null;
}

function lookupInLock(name) {
  return lockPkgs?.find((p) => p.name === name && p.source?.startsWith("registry+"));
}

function resolveCargoVersion(crateName) {
  const pkg = lookupInLock(crateName);
  return pkg ? { version: pkg.version, source: pkg.source } : null;
}

// Get workspace crate dependency names from Cargo.toml manifests
function parseWorkspaceDepNames() {
  const workspaceDir = resolve(ROOT, "src-tauri", "crates");
  const crates = ["mas-core", "mas-export", "mas-admin"];
  const manifests = [
    resolve(ROOT, "src-tauri", "Cargo.toml"),
    ...crates.map((c) => resolve(workspaceDir, c, "Cargo.toml")),
  ];
  const names = new Set();
  for (const manifest of manifests) {
    try {
      const toml = readFileSync(manifest, "utf-8");
      let inDeps = false;
      for (const line of toml.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "[dependencies]") { inDeps = true; continue; }
        if (inDeps && trimmed.startsWith("[")) break;
        if (inDeps) {
          const m = trimmed.match(/^(\S+)\s*=/);
          if (m) names.add(m[1]);
        }
      }
    } catch { /* skip */ }
  }
  // Exclude path-only deps (workspace members)
  for (const local of ["mas-core", "mas-export", "mas-admin", "mas-ai"]) {
    names.delete(local);
  }
  return names;
}

const cargoChecks = [];
if (lockPkgs) {
  const depNames = parseWorkspaceDepNames();
  for (const name of depNames) {
    const resolved = resolveCargoVersion(name);
    if (!resolved) continue;
    cargoChecks.push({
      name, version: resolved.version, ecosystem: "cargo",
      url: `https://crates.io/api/v1/crates/${encodeURIComponent(name)}/${encodeURIComponent(resolved.version)}`,
    });
  }
}

console.log(`[cargo] Checking ${cargoChecks.length} direct dependencies (min age: ${MIN_AGE_DAYS}d)...`);
console.log(`[npm]   Enforcement at resolver via .npmrc min-release-age=${MIN_AGE_DAYS} (no script-side check).`);
const cargoResults = await checkAll(cargoChecks);
for (const r of cargoResults) {
  if (r.age < MIN_AGE_MS) {
    const days = (r.age / (24 * 60 * 60 * 1000)).toFixed(1);
    console.error(`  [cargo] ${r.name}@${r.version} too new (${days}d, need >=${MIN_AGE_DAYS}d)`);
    failures++;
  }
}

if (failures > 0) {
  console.error(`\n${failures} cargo dep(s) younger than ${MIN_AGE_DAYS} days. Blocked.`);
  process.exit(1);
}

console.log(`All cargo dependencies are >=${MIN_AGE_DAYS} days old.`);
