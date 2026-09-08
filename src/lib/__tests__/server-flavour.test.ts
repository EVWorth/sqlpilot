import { describe, expect, it } from "vitest";
import { serverFlavour } from "../server-flavour";

describe("serverFlavour", () => {
  it("recognises MariaDB from the version string it reports", () => {
    expect(serverFlavour("11.4.2-MariaDB-ubu2404")).toBe("mariadb");
    expect(serverFlavour("10.11.6-mariadb")).toBe("mariadb");
  });

  it("treats a bare version as MySQL", () => {
    expect(serverFlavour("8.0.36")).toBe("mysql");
    expect(serverFlavour("8.4.0-log")).toBe("mysql");
  });

  it("assumes MySQL when the version is unknown", () => {
    // Which is the assumption the rest of the app already makes.
    expect(serverFlavour(null)).toBe("mysql");
    expect(serverFlavour(undefined)).toBe("mysql");
    expect(serverFlavour("")).toBe("mysql");
  });
});
