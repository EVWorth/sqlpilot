import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  pickFile: vi.fn(),
  pickSaveFile: vi.fn(),
  readFileContents: vi.fn(),
  writeFileContents: vi.fn(),
  readFileHead: vi.fn(),
}));

vi.mock("../../lib/tauri-api", () => ({ api }));

import { useFileStore } from "../fileStore";

describe("fileStore", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
  });

  it("passes a pick through, including a cancelled one", async () => {
    api.pickFile.mockResolvedValue(null);
    api.pickSaveFile.mockResolvedValue("/out/x.json");

    expect(await useFileStore.getState().pickFile("Open", [["JSON", ["json"]]])).toBeNull();
    expect(await useFileStore.getState().pickSaveFile("Save", "x.json", [["JSON", ["json"]]])).toBe("/out/x.json");
    expect(api.pickFile).toHaveBeenCalledWith("Open", [["JSON", ["json"]]]);
    expect(api.pickSaveFile).toHaveBeenCalledWith("Save", "x.json", [["JSON", ["json"]]]);
  });

  it("reads and writes files", async () => {
    api.readFileContents.mockResolvedValue("{}");
    api.readFileHead.mockResolvedValue({ text: "--", totalBytes: 2, truncated: false });
    api.writeFileContents.mockResolvedValue(null);

    expect(await useFileStore.getState().readFileContents("/a")).toBe("{}");
    expect(await useFileStore.getState().readFileHead("/a", 10)).toEqual({
      text: "--",
      totalBytes: 2,
      truncated: false,
    });
    await useFileStore.getState().writeFileContents("/b", "data");
    expect(api.writeFileContents).toHaveBeenCalledWith("/b", "data");
  });

  it("rejects as the API does, for the caller to report", async () => {
    api.writeFileContents.mockRejectedValue("Permission denied");

    await expect(useFileStore.getState().writeFileContents("/b", "data")).rejects.toBe("Permission denied");
  });
});
