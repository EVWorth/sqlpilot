import { beforeEach, describe, expect, it, vi } from "vitest";
import { connectionKind } from "../../lib/datasource";
import { api } from "../../lib/tauri-api";
import { useSqliteStore } from "../sqliteStore";

vi.mock("../../lib/tauri-api", () => ({
  api: {
    pickFile: vi.fn(),
    sqliteOpen: vi.fn(),
    sqliteClose: vi.fn(),
  },
}));

describe("useSqliteStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSqliteStore.setState({ sessions: [], opening: false, error: null });
  });

  it("opens the file the picker returns", async () => {
    vi.mocked(api.pickFile).mockResolvedValue("/home/a/app.db");
    vi.mocked(api.sqliteOpen).mockResolvedValue("conn-1");

    const session = await useSqliteStore.getState().openFile();

    expect(session).toMatchObject({ id: "conn-1", path: "/home/a/app.db", name: "app.db" });
    expect(useSqliteStore.getState().sessions).toHaveLength(1);
  });

  it("registers the connection as SQLite, so queries route there", async () => {
    vi.mocked(api.sqliteOpen).mockResolvedValue("conn-2");
    await useSqliteStore.getState().openPath("/home/a/app.db");
    expect(connectionKind("conn-2")).toBe("sqlite");
  });

  it("treats a dismissed picker as nothing to do, not an error", async () => {
    vi.mocked(api.pickFile).mockResolvedValue(null as never);

    expect(await useSqliteStore.getState().openFile()).toBeNull();
    expect(useSqliteStore.getState().error).toBeNull();
    expect(api.sqliteOpen).not.toHaveBeenCalled();
  });

  it("reports a refused file instead of adding a session", async () => {
    // The backend refuses anything that is not a SQLite database (#463).
    vi.mocked(api.sqliteOpen).mockRejectedValue("/etc/passwd is not a SQLite database");

    expect(await useSqliteStore.getState().openPath("/etc/passwd")).toBeNull();
    expect(useSqliteStore.getState().sessions).toHaveLength(0);
    expect(useSqliteStore.getState().error).toContain("not a SQLite database");
  });

  it("selects the file already open rather than opening it twice", async () => {
    vi.mocked(api.sqliteOpen).mockResolvedValue("conn-3");
    const first = await useSqliteStore.getState().openPath("/home/a/app.db");
    const second = await useSqliteStore.getState().openPath("/home/a/app.db");

    expect(second).toBe(first);
    expect(api.sqliteOpen).toHaveBeenCalledTimes(1);
    expect(useSqliteStore.getState().sessions).toHaveLength(1);
  });

  it("closes and forgets the connection", async () => {
    vi.mocked(api.sqliteOpen).mockResolvedValue("conn-4");
    vi.mocked(api.sqliteClose).mockResolvedValue(undefined as never);
    await useSqliteStore.getState().openPath("/home/a/app.db");

    await useSqliteStore.getState().close("conn-4");

    expect(useSqliteStore.getState().sessions).toHaveLength(0);
    expect(connectionKind("conn-4")).toBe("mysql");
  });

  it("still removes the session when the backend refuses to close", async () => {
    // Leaving a database the user asked to close on screen is worse than an
    // orphaned handle, which goes when the app does.
    vi.mocked(api.sqliteOpen).mockResolvedValue("conn-5");
    vi.mocked(api.sqliteClose).mockRejectedValue("busy");
    await useSqliteStore.getState().openPath("/home/a/app.db");

    await useSqliteStore.getState().close("conn-5");

    expect(useSqliteStore.getState().sessions).toHaveLength(0);
    expect(useSqliteStore.getState().error).toContain("busy");
  });
});
