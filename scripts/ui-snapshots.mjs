#!/usr/bin/env node
// Screenshots of the app running on the mock backend, for reviewing the UI.
//
//   node scripts/ui-snapshots.mjs [--out dir] [--only name,name] [--theme dark|light|both]
//
// Starts its own Vite dev server, opens each shot in Chromium with `?mock`
// (src/dev/mock), walks the steps to get to the screen, and saves a PNG per
// shot, theme and window size. The mock's data is deterministic, so two runs
// of the same commit give the same pictures, and a before/after pair shows
// only what a change did.
//
// Chromium is not the app's webview (WebKitGTK on Linux, WebView2 on
// Windows), and there is no native window chrome here. This is for layout,
// content and flow; check rendering details in the real app.

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const OUT = resolve(opt("out", "ui-snapshots"));
const ONLY = opt("only", "")?.split(",").filter(Boolean) ?? [];
const THEMES = { both: ["dark", "light"], dark: ["dark"], light: ["light"] }[opt("theme", "both")];
const PORT = Number(opt("port", "1431"));
const SIZES = [
  { name: "laptop", width: 1366, height: 820 },
  { name: "small", width: 1024, height: 680 },
];

/**
 * Each shot: the mock scenario to open, and the steps that reach the screen.
 * A step is a function of the page. Keep them to what a person would click,
 * by visible text or role, so a shot breaks only when the UI really changed.
 */
const SHOTS = [
  { name: "01-first-run", scenario: "empty", steps: [] },
  { name: "02-connections", scenario: "default", steps: [] },
  {
    name: "03-new-connection-dialog",
    scenario: "default",
    steps: [async (p) => p.getByRole("button", { name: /new connection/i }).first().click()],
  },
  { name: "04-connected", scenario: "connected", steps: [] },
  {
    name: "05-query-results",
    scenario: "connected",
    steps: [
      async (p) => {
        await p.locator(".monaco-editor").first().click();
        await p.keyboard.type("SELECT * FROM customers;");
        await p.keyboard.press("Control+Enter");
        await p.waitForTimeout(800);
      },
    ],
  },
  {
    name: "06-query-error",
    scenario: "connected",
    steps: [
      async (p) => {
        await p.locator(".monaco-editor").first().click();
        await p.keyboard.type("SELECT * FROM missing_table;");
        await p.keyboard.press("Control+Enter");
        await p.waitForTimeout(800);
      },
    ],
  },
];

function startVite() {
  const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((ok, no) => {
    const timer = setTimeout(() => no(new Error("Vite did not start within 60s")), 60_000);
    vite.stdout.on("data", (chunk) => {
      if (String(chunk).includes("Local:")) {
        clearTimeout(timer);
        ok(vite);
      }
    });
    vite.on("exit", (code) => no(new Error(`Vite exited (${code})`)));
  });
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const vite = await startVite();
  const browser = await chromium.launch();
  let failed = 0;
  try {
    for (const shot of SHOTS.filter((s) => ONLY.length === 0 || ONLY.includes(s.name))) {
      for (const theme of THEMES) {
        for (const size of SIZES) {
          const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1 });
          await context.addInitScript((t) => localStorage.setItem("theme", t), theme);
          const page = await context.newPage();
          const errors = [];
          page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
          const file = join(OUT, `${shot.name}--${theme}--${size.name}.png`);
          try {
            await page.goto(`http://localhost:${PORT}/?mock=${shot.scenario}`, { waitUntil: "networkidle" });
            await page.waitForTimeout(600);
            for (const step of shot.steps) await step(page);
            await page.waitForTimeout(300);
            await page.screenshot({ path: file });
            console.log(`ok   ${file}${errors.length ? `  (${errors.length} console errors)` : ""}`);
            for (const e of errors) console.log(`       ${e.slice(0, 200)}`);
          } catch (e) {
            failed++;
            await page.screenshot({ path: file.replace(/\.png$/, ".FAILED.png") }).catch(() => {});
            console.log(`FAIL ${shot.name} (${theme}, ${size.name}): ${String(e).split("\n")[0]}`);
          }
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
    vite.kill();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
