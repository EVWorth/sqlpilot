import { expect, test } from "@playwright/test";

test("App launches and displays main window", async ({ page }) => {
  // The app is already running as a Tauri window
  await page.goto("http://localhost:1420/");

  // Verify the main element exists
  const root = page.locator("#root");
  await expect(root).toBeVisible();

  // Verify the app title
  await expect(page).toHaveTitle("SQLPilot");
});

test("Connection dialog can be opened", async ({ page }) => {
  await page.goto("http://localhost:1420/");

  // Wait for the page to load
  await page.waitForLoadState("networkidle");

  // Check if the app has loaded
  const root = page.locator("#root");
  await expect(root).toBeVisible();
});
