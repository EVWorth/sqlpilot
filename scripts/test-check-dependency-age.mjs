#!/usr/bin/env node
// scripts/test-check-dependency-age.mjs
//
// Tests for check-dependency-age.mjs, offline: the registries and the GitHub
// API are stubbed. Run with `node --test scripts/test-check-dependency-age.mjs`.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  added,
  cargoPackages,
  cratePublished,
  EXCEPTION_LABEL,
  hasExceptionLabel,
  npmPackages,
  npmPublished,
  tooYoung,
} from "./check-dependency-age.mjs";

const npmLock = (packages) => JSON.stringify({ lockfileVersion: 3, packages });

test("npm: registry packages, nested ones included, and nothing else", () => {
  const lock = npmLock({
    "": { name: "app", version: "1.0.0" },
    "node_modules/jsdom": { version: "31.0.0", resolved: "https://registry.npmjs.org/jsdom/-/jsdom-31.0.0.tgz" },
    "node_modules/@vitest/browser": {
      version: "5.1.0",
      resolved: "https://registry.npmjs.org/@vitest/browser/-/browser-5.1.0.tgz",
    },
    "node_modules/a/node_modules/b": { version: "2.0.0", resolved: "https://registry.npmjs.org/b/-/b-2.0.0.tgz" },
    "node_modules/local": { link: true, resolved: "packages/local" },
    "node_modules/from-git": { version: "1.0.0", resolved: "git+ssh://git@github.com/x/y.git#abc" },
  });
  assert.deepEqual(npmPackages(lock), [
    { name: "jsdom", version: "31.0.0" },
    { name: "@vitest/browser", version: "5.1.0" },
    { name: "b", version: "2.0.0" },
  ]);
});

test("cargo: crates.io packages only", () => {
  const lock = `version = 4

[[package]]
name = "rusqlite"
version = "0.42.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "abc"

[[package]]
name = "mas-core"
version = "0.1.0"

[[package]]
name = "sqlx-sqlite"
version = "0.9.0"

[[package]]
name = "forked"
version = "1.0.0"
source = "git+https://github.com/x/forked#abc"
`;
  assert.deepEqual(cargoPackages(lock), [{ name: "rusqlite", version: "0.42.0" }]);
});

test("added: only versions the base did not have, once each", () => {
  const before = [{ name: "a", version: "1.0.0" }, { name: "b", version: "1.0.0" }];
  const after = [
    { name: "a", version: "1.0.0" },
    { name: "b", version: "1.1.0" },
    { name: "b", version: "1.1.0" },
    { name: "c", version: "0.1.0" },
  ];
  assert.deepEqual(added(before, after), [{ name: "b", version: "1.1.0" }, { name: "c", version: "0.1.0" }]);
});

test("added: a lockfile that is new adds everything in it", () => {
  assert.equal(added([], [{ name: "a", version: "1.0.0" }]).length, 1);
});

test("tooYoung: under the limit, or with no date, is too young", async () => {
  const now = new Date("2026-11-20T00:00:00Z");
  const dates = {
    old: new Date("2026-11-01T00:00:00Z"),
    edge: new Date("2026-11-13T00:00:00Z"),
    fresh: new Date("2026-11-17T00:00:00Z"),
    unknown: null,
  };
  const published = async (name) => dates[name];
  const young = await tooYoung(
    Object.keys(dates).map((name) => ({ name, version: "1.0.0" })),
    published,
    7,
    now,
  );
  assert.deepEqual(young.map((p) => p.name), ["fresh", "unknown"]);
  assert.equal(Math.round(young[0].age), 3);
  assert.equal(young[1].age, null);
});

const response = (status, body) => ({ ok: status < 400, status, json: async () => body });

test("npmPublished reads the version's time, escaping a scope", async () => {
  let url;
  const fetchStub = async (u) => {
    url = u;
    return response(200, { time: { "5.1.0": "2026-11-01T10:00:00.000Z" } });
  };
  const when = await npmPublished("@vitest/browser", "5.1.0", fetchStub);
  assert.equal(url, "https://registry.npmjs.org/@vitest%2Fbrowser");
  assert.equal(when.toISOString(), "2026-11-01T10:00:00.000Z");
  assert.equal(await npmPublished("@vitest/browser", "9.9.9", fetchStub), null);
});

test("cratePublished sends a user agent and reads created_at", async () => {
  let headers;
  const fetchStub = async (_u, init) => {
    headers = init.headers;
    return response(200, { version: { created_at: "2026-11-11T00:00:00Z" } });
  };
  const when = await cratePublished("rusqlite", "0.42.0", fetchStub);
  assert.ok(headers["user-agent"]);
  assert.equal(when.toISOString(), "2026-11-11T00:00:00.000Z");
});

test("a registry error is an error, not a pass", async () => {
  await assert.rejects(() => cratePublished("x", "1.0.0", async () => response(503, {})), /503/);
});

test("the exception label is read from the API, and absent without a PR", async () => {
  const env = { GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "o/r", PR_NUMBER: "7" };
  const labelled = async () => response(200, [{ name: EXCEPTION_LABEL }]);
  const plain = async () => response(200, [{ name: "dependencies" }]);
  assert.equal(await hasExceptionLabel(env, labelled), true);
  assert.equal(await hasExceptionLabel(env, plain), false);
  assert.equal(await hasExceptionLabel({}, labelled), false);
});
