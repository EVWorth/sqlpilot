#!/usr/bin/env node
// scripts/test-verify-release.mjs
//
// Tests for verify-release.mjs, offline. Run with
// `node --test scripts/test-verify-release.mjs`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { manifestProblems, missingAssets, UPDATER_KEYS } from "./verify-release.mjs";

// The asset names v1.6.0 shipped with.
const V160 = [
  "latest.json",
  "SQLPilot-1.6.0-1.x86_64.rpm",
  "SQLPilot-1.6.0-1.x86_64.rpm.sig",
  "SQLPilot.exe",
  "SQLPilot.exe.sig",
  "SQLPilot_1.6.0_aarch64.app.tar.gz",
  "SQLPilot_1.6.0_aarch64.app.tar.gz.sig",
  "SQLPilot_1.6.0_aarch64.dmg",
  "SQLPilot_1.6.0_amd64.AppImage",
  "SQLPilot_1.6.0_amd64.AppImage.sig",
  "SQLPilot_1.6.0_amd64.deb",
  "SQLPilot_1.6.0_amd64.deb.sig",
  "SQLPilot_1.6.0_x64-setup.exe",
  "SQLPilot_1.6.0_x64-setup.exe.sig",
  "SQLPilot_1.6.0_x64.app.tar.gz",
  "SQLPilot_1.6.0_x64.app.tar.gz.sig",
  "SQLPilot_1.6.0_x64.dmg",
  "SQLPilot_1.6.0_x64_en-US.msi",
  "SQLPilot_1.6.0_x64_en-US.msi.sig",
];

test("a complete release is missing nothing", () => {
  assert.deepEqual(missingAssets(V160, "1.6.0"), []);
});

test("a missing platform, or a missing signature, is named", () => {
  const names = V160.filter((n) => !n.includes("aarch64.dmg") && n !== "SQLPilot_1.6.0_amd64.deb.sig");
  assert.deepEqual(missingAssets(names, "1.6.0"), ["Linux .deb signature", "macOS Apple Silicon .dmg"]);
});

test("assets from another version do not count", () => {
  const old = V160.map((n) => n.replace("1.6.0", "1.5.1"));
  const missing = missingAssets(old, "1.6.0");
  // Only the two unversioned names still match.
  assert.ok(!missing.includes("Windows portable exe"));
  assert.ok(!missing.includes("update manifest"));
  assert.equal(missing.length, V160.length - 3);
});

const manifest = (version, tag = `v${version}`) => ({
  version,
  platforms: Object.fromEntries(
    UPDATER_KEYS.map((k) => [k, { signature: "sig", url: `https://example.test/download/${tag}/${k}` }]),
  ),
});

test("a manifest for this release has no problems", () => {
  assert.deepEqual(manifestProblems(manifest("1.6.0"), "1.6.0"), []);
});

test("a manifest with the wrong version, a missing key or a stale URL is reported", () => {
  const m = manifest("1.6.0");
  delete m.platforms["linux-x86_64-rpm"];
  m.platforms["darwin-aarch64"].url = "https://example.test/download/v1.5.1/x";
  m.platforms["windows-x86_64"].signature = "";
  const problems = manifestProblems({ ...m, version: "1.5.1" }, "1.6.0");
  assert.equal(problems.length, 4);
  assert.match(problems[0], /version 1\.5\.1/);
  assert.ok(problems.some((p) => p.includes("no linux-x86_64-rpm")));
  assert.ok(problems.some((p) => p.includes("windows-x86_64 entry has no signature")));
  assert.ok(problems.some((p) => p.includes("darwin-aarch64") && p.includes("v1.5.1")));
});
