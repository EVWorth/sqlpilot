import { describe, expect, it } from "vitest";
import { canSelfUpdate, manualUpdateFor } from "../update-channel";

describe("canSelfUpdate", () => {
  it("allows the formats that own their own files", () => {
    expect(canSelfUpdate("standard")).toBe(true);
    expect(canSelfUpdate("app_image")).toBe(true);
  });

  it("refuses the formats whose runtime manages the install", () => {
    // Offering an update the runtime will not let the app apply produces a
    // failure the user cannot act on.
    expect(canSelfUpdate("flatpak")).toBe(false);
    expect(canSelfUpdate("snap")).toBe(false);
    expect(canSelfUpdate("rpm_ostree")).toBe(false);
  });
});

describe("manualUpdateFor", () => {
  it("names the architecture the app is running on", () => {
    // An aarch64 machine was handed an x86_64 download URL (#571).
    const update = manualUpdateFor("rpm_ostree", "1.2.3", "aarch64");
    expect(update?.command).toContain("SQLPilot-1.2.3-1.aarch64.rpm");
    expect(update?.command).not.toContain("x86_64");
  });

  it("gives each managed format its own command", () => {
    expect(manualUpdateFor("flatpak", "1.2.3", "x86_64")?.command).toContain("flatpak update");
    expect(manualUpdateFor("snap", "1.2.3", "x86_64")?.command).toContain("snap refresh");
    expect(manualUpdateFor("rpm_ostree", "1.2.3", "x86_64")?.command).toContain("rpm-ostree install");
  });

  it("explains why the app is not doing it itself", () => {
    for (const format of ["flatpak", "snap", "rpm_ostree"] as const) {
      expect(manualUpdateFor(format, "1.2.3", "x86_64")?.reason).toBeTruthy();
    }
  });

  it("has nothing to say for a format that updates itself", () => {
    expect(manualUpdateFor("standard", "1.2.3", "x86_64")).toBeNull();
    expect(manualUpdateFor("app_image", "1.2.3", "x86_64")).toBeNull();
  });
});
