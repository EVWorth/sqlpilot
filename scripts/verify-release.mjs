#!/usr/bin/env node
// scripts/verify-release.mjs
//
// Check a published release the way docs/RELEASING.md says to after every
// release: exactly one release for the tag, published (not a draft), every
// platform's assets and their updater signatures attached, and a
// `latest.json` that names this version and every updater platform key.
//
// Usage:
//   node scripts/verify-release.mjs <version> [--repo owner/name]
//
// <version> is with or without the leading "v". The GitHub API is read with
// `gh api` where the gh CLI is installed (it carries its own login), and with
// a plain request otherwise, sending GITHUB_TOKEN or GH_TOKEN when set. Only
// an authenticated caller sees draft releases.
//
// Exit codes: 0 all present; 1 something is missing; 2 could not check.

import { execFileSync } from "node:child_process";

/** Every asset a release must carry, as [description, pattern]. */
export function expectedAssets(version) {
  const v = version.replace(/\./g, "\\.");
  const asset = (description, pattern) => [description, new RegExp(pattern)];
  return [
    asset("Linux AppImage", `_${v}_amd64\\.AppImage$`),
    asset("Linux AppImage signature", `_${v}_amd64\\.AppImage\\.sig$`),
    asset("Linux .deb", `_${v}_amd64\\.deb$`),
    asset("Linux .deb signature", `_${v}_amd64\\.deb\\.sig$`),
    asset("Linux .rpm", `-${v}-\\d+\\.x86_64\\.rpm$`),
    asset("Linux .rpm signature", `-${v}-\\d+\\.x86_64\\.rpm\\.sig$`),
    asset("Windows .msi", `_${v}_x64_[A-Za-z-]+\\.msi$`),
    asset("Windows .msi signature", `_${v}_x64_[A-Za-z-]+\\.msi\\.sig$`),
    asset("Windows installer", `_${v}_x64-setup\\.exe$`),
    asset("Windows installer signature", `_${v}_x64-setup\\.exe\\.sig$`),
    asset("Windows portable exe", `^SQLPilot\\.exe$`),
    asset("Windows portable exe signature", `^SQLPilot\\.exe\\.sig$`),
    asset("macOS Apple Silicon .dmg", `_${v}_aarch64\\.dmg$`),
    asset("macOS Apple Silicon updater bundle", `_${v}_aarch64\\.app\\.tar\\.gz$`),
    asset("macOS Apple Silicon updater signature", `_${v}_aarch64\\.app\\.tar\\.gz\\.sig$`),
    asset("macOS Intel .dmg", `_${v}_x64\\.dmg$`),
    asset("macOS Intel updater bundle", `_${v}_x64\\.app\\.tar\\.gz$`),
    asset("macOS Intel updater signature", `_${v}_x64\\.app\\.tar\\.gz\\.sig$`),
    asset("update manifest", `^latest\\.json$`),
  ];
}

/** The updater keys scripts/build-update-manifest.sh writes. */
export const UPDATER_KEYS = [
  "linux-x86_64",
  "linux-x86_64-appimage",
  "linux-x86_64-deb",
  "linux-x86_64-rpm",
  "windows-x86_64",
  "windows-x86_64-msi",
  "windows-x86_64-nsis",
  "windows-x86_64-portable",
  "darwin-x86_64",
  "darwin-x86_64-app",
  "darwin-aarch64",
  "darwin-aarch64-app",
];

/** Descriptions of the expected assets that `names` lacks. */
export function missingAssets(names, version) {
  return expectedAssets(version)
    .filter(([, pattern]) => !names.some((n) => pattern.test(n)))
    .map(([description]) => description);
}

/** What is wrong with a parsed latest.json for `version`, as sentences. */
export function manifestProblems(manifest, version, tag = `v${version}`) {
  const problems = [];
  if (manifest?.version !== version) {
    problems.push(`latest.json says version ${manifest?.version ?? "(none)"}, not ${version}`);
  }
  const platforms = manifest?.platforms ?? {};
  for (const key of UPDATER_KEYS) {
    const entry = platforms[key];
    if (!entry) problems.push(`latest.json has no ${key} entry`);
    else if (!entry.signature) problems.push(`latest.json's ${key} entry has no signature`);
    else if (!entry.url?.includes(`/download/${tag}/`)) {
      problems.push(`latest.json's ${key} entry points at ${entry.url}, not this release`);
    }
  }
  return problems;
}

/**
 * GET a GitHub API path. `gh api` goes first: it is authenticated wherever
 * the gh CLI is, including behind a proxy that refuses anonymous calls. A
 * plain request, with GITHUB_TOKEN or GH_TOKEN when set, is the fallback.
 */
async function github(path) {
  try {
    return JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
  } catch (e) {
    if (e.code !== "ENOENT") throw new Error(`gh api ${path} failed: ${String(e.stderr || e.message).trim()}`);
  }
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const headers = { accept: "application/vnd.github+json", "user-agent": "sqlpilot-verify-release" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com/${path}`, { headers });
  if (!res.ok) throw new Error(`api.github.com/${path} answered ${res.status}`);
  return res.json();
}

async function main(argv) {
  const positional = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--repo");
  const i = argv.indexOf("--repo");
  const repo = i >= 0 ? argv[i + 1] : process.env.GITHUB_REPOSITORY || "EVWorth/sqlpilot";
  if (!positional[0]) {
    console.error("Usage: node scripts/verify-release.mjs <version> [--repo owner/name]");
    return 2;
  }
  const version = positional[0].replace(/^v/, "");
  const tag = `v${version}`;
  const problems = [];

  // Draft releases are listed only to an authenticated caller, so an
  // anonymous count can miss a stray draft for the same tag.
  const all = await github(`repos/${repo}/releases?per_page=100`);
  const forTag = all.filter((r) => r.tag_name === tag);
  if (forTag.length !== 1) problems.push(`${forTag.length} releases exist for ${tag}; expected exactly 1`);
  const release = forTag.find((r) => !r.draft) ?? forTag[0];
  if (!release) {
    for (const p of problems) console.log(p);
    return 1;
  }
  if (release.draft) problems.push(`${tag} is still a draft`);
  const names = release.assets.map((a) => a.name);
  for (const missing of missingAssets(names, version)) problems.push(`missing asset: ${missing}`);

  const manifestAsset = release.assets.find((a) => a.name === "latest.json");
  if (manifestAsset) {
    const res = await fetch(manifestAsset.browser_download_url, { redirect: "follow" });
    if (!res.ok) throw new Error(`latest.json answered ${res.status}`);
    problems.push(...manifestProblems(await res.json(), version, tag));
  }

  console.log(`${repo} ${tag}: ${names.length} assets, ${release.draft ? "draft" : "published"}.`);
  if (!problems.length) {
    console.log("One release, published, with every platform's assets, signatures and update manifest.");
    return 0;
  }
  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems) console.log(`  ${p}`);
  return 1;
}

// Run only when executed, so the tests can import the pieces.
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`Could not verify the release: ${e.message}`);
      process.exit(2);
    },
  );
}
