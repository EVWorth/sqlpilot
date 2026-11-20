#!/usr/bin/env node
// scripts/check-dependency-age.mjs
//
// Fail when a change adds a package version published less than 7 days ago,
// to package-lock.json or src-tauri/Cargo.lock.
//
// The rule itself is older than this check (AGENTS.md, "New dependencies
// wait a week"): `.npmrc` sets `min-release-age=7`, `src-tauri/.cargo/
// config.toml` sets `registry.global-min-publish-age`, and Dependabot has a
// `cooldown`. Each covers only some routes in. Dependabot's cooldown applies
// to the packages a PR names, not to what its lockfile pulls in with them
// (#988 brought in three crates 3-4 days old that way); npm 10 ignores
// `min-release-age`; and the Cargo setting keeps whatever is already in the
// lockfile. This reads the lockfile itself, so it does not matter how a
// version got there.
//
// Usage:
//   node scripts/check-dependency-age.mjs [--base <git ref>] [--days <n>]
//
// Compares each lockfile at <base> (default origin/dev) with the working
// tree and asks the registry when every added version was published.
//
// An urgent security fix younger than the limit: label the PR
// `dependency-age-exception` and re-run the job. The labels are read from
// the GitHub API when it runs (GITHUB_TOKEN, GITHUB_REPOSITORY and
// PR_NUMBER), so a label added after the run started counts on a re-run.
//
// Exit codes: 0 all old enough or excepted; 1 too new; 2 could not check.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const EXCEPTION_LABEL = "dependency-age-exception";
const DAY_MS = 24 * 60 * 60 * 1000;

/** `{name, version}` for every registry package in an npm lockfile (v2/v3). */
export function npmPackages(lockText) {
  if (!lockText) return [];
  const packages = JSON.parse(lockText).packages ?? {};
  const out = [];
  for (const [path, meta] of Object.entries(packages)) {
    // The root project, workspace links and git or file dependencies have
    // no registry publish date.
    if (!path || meta.link || !meta.version) continue;
    if (meta.resolved && !meta.resolved.startsWith("https://registry.npmjs.org/")) continue;
    const name = meta.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    out.push({ name, version: meta.version });
  }
  return out;
}

/** `{name, version}` for every crates.io package in a Cargo.lock. */
export function cargoPackages(lockText) {
  if (!lockText) return [];
  const out = [];
  for (const block of lockText.split(/^\[\[package\]\]$/m).slice(1)) {
    const field = (key) => block.match(new RegExp(`^${key} = "([^"]*)"`, "m"))?.[1];
    // Workspace members have no source; git and path dependencies have
    // another one. Only crates.io has publish dates.
    if (field("source") !== "registry+https://github.com/rust-lang/crates.io-index") continue;
    out.push({ name: field("name"), version: field("version") });
  }
  return out;
}

/** The entries of `after` that `before` does not have. */
export function added(before, after) {
  const seen = new Set(before.map((p) => `${p.name}@${p.version}`));
  const result = new Map();
  for (const p of after) {
    const key = `${p.name}@${p.version}`;
    if (!seen.has(key)) result.set(key, p);
  }
  return [...result.values()];
}

/** When an npm package version was published, or null when the registry does not say. */
export async function npmPublished(name, version, fetchImpl = fetch) {
  const res = await fetchImpl(`https://registry.npmjs.org/${name.replace("/", "%2F")}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`npm registry answered ${res.status} for ${name}`);
  const time = (await res.json()).time?.[version];
  return time ? new Date(time) : null;
}

/** When a crate version was published, or null when crates.io does not say. */
export async function cratePublished(name, version, fetchImpl = fetch) {
  const res = await fetchImpl(`https://crates.io/api/v1/crates/${name}/${version}`, {
    // crates.io refuses requests without one.
    headers: { "user-agent": "sqlpilot-dependency-age-check" },
  });
  if (!res.ok) throw new Error(`crates.io answered ${res.status} for ${name} ${version}`);
  const created = (await res.json()).version?.created_at;
  return created ? new Date(created) : null;
}

/**
 * Every added version younger than `days`, oldest check first. A version the
 * registry has no date for counts as too young: it cannot be shown to be old.
 */
export async function tooYoung(candidates, published, days, now = new Date()) {
  const young = [];
  for (const p of candidates) {
    const when = await published(p.name, p.version);
    const age = when ? (now.getTime() - when.getTime()) / DAY_MS : null;
    if (age === null || age < days) young.push({ ...p, age });
  }
  return young;
}

/** Whether the PR running this check carries the exception label. */
export async function hasExceptionLabel(env = process.env, fetchImpl = fetch) {
  const { GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER } = env;
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !PR_NUMBER) return false;
  const res = await fetchImpl(`https://api.github.com/repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/labels`, {
    headers: { authorization: `Bearer ${GITHUB_TOKEN}`, accept: "application/vnd.github+json" },
  });
  if (!res.ok) return false;
  return (await res.json()).some((l) => l.name === EXCEPTION_LABEL);
}

function gitShow(ref, path) {
  try {
    return execFileSync("git", ["show", `${ref}:${path}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    // The file is new on this side, so everything in it is added.
    return "";
  }
}

function readOrEmpty(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function describe({ name, version, age }) {
  return `  ${name} ${version}: ${age === null ? "no publish date" : `${age.toFixed(1)} days old`}`;
}

async function main(argv) {
  const arg = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const base = arg("--base", "origin/dev");
  const days = Number(arg("--days", "7"));

  const lockfiles = [
    { path: "package-lock.json", parse: npmPackages, published: npmPublished, label: "npm" },
    { path: "src-tauri/Cargo.lock", parse: cargoPackages, published: cratePublished, label: "crates.io" },
  ];

  const young = [];
  let checked = 0;
  for (const lock of lockfiles) {
    const candidates = added(lock.parse(gitShow(base, lock.path)), lock.parse(readOrEmpty(lock.path)));
    checked += candidates.length;
    for (const p of await tooYoung(candidates, lock.published, days)) young.push({ ...p, registry: lock.label });
  }

  console.log(`Checked ${checked} package version(s) added since ${base}; minimum age ${days} days.`);
  if (young.length === 0) return 0;

  console.log(`\n${young.length} added version(s) are newer than that:`);
  for (const p of young) console.log(`${describe(p)} (${p.registry})`);

  if (await hasExceptionLabel()) {
    console.log(`\nThe PR is labelled ${EXCEPTION_LABEL}, so this is reported and not failed.`);
    return 0;
  }
  console.log(
    `\nWait until they are ${days} days old, or pin older versions. For an urgent security`
      + ` fix, label the PR ${EXCEPTION_LABEL} and re-run this job (AGENTS.md, rule 9).`,
  );
  return 1;
}

// Run only when executed, so the tests can import the pieces.
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`Could not check dependency ages: ${e.message}`);
      process.exit(2);
    },
  );
}
