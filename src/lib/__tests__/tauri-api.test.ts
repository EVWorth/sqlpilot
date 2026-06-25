import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, getVersionMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  getVersionMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: getVersionMock,
}));

type Api = Record<string, (...args: any[]) => Promise<any>>;

async function loadWithTauri(): Promise<Api> {
  (globalThis as any).__TAURI_INTERNALS__ = {};
  vi.resetModules();
  const mod = await import("../tauri-api");
  return mod.api as any;
}

async function loadWithoutTauri(): Promise<Api> {
  delete (globalThis as any).__TAURI_INTERNALS__;
  vi.resetModules();
  const mod = await import("../tauri-api");
  return mod.api as any;
}

// ---------------------------------------------------------------------------
// Sample fixtures
// ---------------------------------------------------------------------------

const profile = {
  id: "p1",
  name: "Test",
  dbType: "postgres",
  host: "localhost",
  port: 5432,
  username: "user",
  password: "pass",
  database: "",
  sslMode: "prefer",
  group: "",
  createdAt: 0,
};

const queryResult = {
  columns: ["id"],
  rows: [{ id: 1 }],
  query: "select 1",
};

// ===========================================================================
// Tests with Tauri available
// ===========================================================================

describe("api (Tauri available)", () => {
  let api: Api;

  beforeAll(async () => {
    api = await loadWithTauri();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -- Connections ---------------------------------------------------------

  it("saveConnectionProfile calls invoke with correct args", async () => {
    invokeMock.mockResolvedValue("new-id");
    const result = await api.saveConnectionProfile(profile);
    expect(invokeMock).toHaveBeenCalledWith("save_connection_profile", {
      profile,
    });
    expect(result).toBe("new-id");
  });

  it("listConnectionProfiles calls invoke with no args", async () => {
    invokeMock.mockResolvedValue([]);
    const result = await api.listConnectionProfiles();
    expect(invokeMock).toHaveBeenCalledWith(
      "list_connection_profiles",
      undefined,
    );
    expect(result).toEqual([]);
  });

  it("deleteConnectionProfile calls invoke with profileId", async () => {
    await api.deleteConnectionProfile("profile-1");
    expect(invokeMock).toHaveBeenCalledWith("delete_connection_profile", {
      profileId: "profile-1",
    });
  });

  it("testConnection calls invoke with profile", async () => {
    invokeMock.mockResolvedValue({ success: true });
    const result = await api.testConnection(profile);
    expect(invokeMock).toHaveBeenCalledWith("test_connection", { profile });
    expect(result).toEqual({ success: true });
  });

  it("connect calls invoke with profileId", async () => {
    invokeMock.mockResolvedValue({
      connectionId: "conn-1",
      connectedAt: 123,
    });
    const result = await api.connect("profile-1");
    expect(invokeMock).toHaveBeenCalledWith("connect", {
      profileId: "profile-1",
    });
    expect(result).toEqual({ connectionId: "conn-1", connectedAt: 123 });
  });

  it("disconnect calls invoke with connectionId", async () => {
    await api.disconnect("conn-1");
    expect(invokeMock).toHaveBeenCalledWith("disconnect", {
      connectionId: "conn-1",
    });
  });

  it("listConnections calls invoke with no args", async () => {
    invokeMock.mockResolvedValue([]);
    const result = await api.listConnections();
    expect(invokeMock).toHaveBeenCalledWith("list_connections", undefined);
    expect(result).toEqual([]);
  });

  // -- Queries -------------------------------------------------------------

  it("executeQuery calls invoke with all args", async () => {
    invokeMock.mockResolvedValue([queryResult]);
    const result = await api.executeQuery("conn-1", "SELECT 1", "mydb", 100);
    expect(invokeMock).toHaveBeenCalledWith("execute_query", {
      connectionId: "conn-1",
      sql: "SELECT 1",
      database: "mydb",
      limit: 100,
    });
    expect(result).toEqual([queryResult]);
  });

  it("executeQuery omits undefined optional args", async () => {
    invokeMock.mockResolvedValue([queryResult]);
    await api.executeQuery("conn-1", "SELECT 1");
    expect(invokeMock).toHaveBeenCalledWith("execute_query", {
      connectionId: "conn-1",
      sql: "SELECT 1",
      database: undefined,
      limit: undefined,
    });
  });

  // -- Schema --------------------------------------------------------------

  it("getDatabases calls invoke with connectionId", async () => {
    invokeMock.mockResolvedValue([{ name: "mydb" }]);
    const result = await api.getDatabases("conn-1");
    expect(invokeMock).toHaveBeenCalledWith("get_databases", {
      connectionId: "conn-1",
    });
    expect(result).toEqual([{ name: "mydb" }]);
  });

  it("getTables calls invoke with connectionId and database", async () => {
    invokeMock.mockResolvedValue([]);
    await api.getTables("conn-1", "mydb");
    expect(invokeMock).toHaveBeenCalledWith("get_tables", {
      connectionId: "conn-1",
      database: "mydb",
    });
  });

  it("getColumns calls invoke with connectionId, database, and table", async () => {
    invokeMock.mockResolvedValue([]);
    await api.getColumns("conn-1", "mydb", "users");
    expect(invokeMock).toHaveBeenCalledWith("get_columns", {
      connectionId: "conn-1",
      database: "mydb",
      table: "users",
    });
  });

  it("getIndexes calls invoke with connectionId, database, and table", async () => {
    invokeMock.mockResolvedValue([]);
    await api.getIndexes("conn-1", "mydb", "users");
    expect(invokeMock).toHaveBeenCalledWith("get_indexes", {
      connectionId: "conn-1",
      database: "mydb",
      table: "users",
    });
  });

  it("getTableDdl calls invoke with connectionId, database, and table", async () => {
    invokeMock.mockResolvedValue("CREATE TABLE ...");
    const result = await api.getTableDdl("conn-1", "mydb", "users");
    expect(invokeMock).toHaveBeenCalledWith("get_table_ddl", {
      connectionId: "conn-1",
      database: "mydb",
      table: "users",
    });
    expect(result).toBe("CREATE TABLE ...");
  });

  it("getViews calls invoke with connectionId and database", async () => {
    invokeMock.mockResolvedValue([]);
    await api.getViews("conn-1", "mydb");
    expect(invokeMock).toHaveBeenCalledWith("get_views", {
      connectionId: "conn-1",
      database: "mydb",
    });
  });

  it("getRoutines calls invoke with connectionId and database", async () => {
    invokeMock.mockResolvedValue([]);
    await api.getRoutines("conn-1", "mydb");
    expect(invokeMock).toHaveBeenCalledWith("get_routines", {
      connectionId: "conn-1",
      database: "mydb",
    });
  });

  it("getTriggers calls invoke with connectionId and database", async () => {
    invokeMock.mockResolvedValue([]);
    await api.getTriggers("conn-1", "mydb");
    expect(invokeMock).toHaveBeenCalledWith("get_triggers", {
      connectionId: "conn-1",
      database: "mydb",
    });
  });

  it("getViewDdl calls invoke with correct args", async () => {
    invokeMock.mockResolvedValue("CREATE VIEW ...");
    const result = await api.getViewDdl("conn-1", "mydb", "myview");
    expect(invokeMock).toHaveBeenCalledWith("get_view_ddl", {
      connectionId: "conn-1",
      database: "mydb",
      viewName: "myview",
    });
    expect(result).toBe("CREATE VIEW ...");
  });

  it("getRoutineDdl calls invoke with correct args", async () => {
    invokeMock.mockResolvedValue("CREATE FUNCTION ...");
    const result = await api.getRoutineDdl(
      "conn-1",
      "mydb",
      "myfunc",
      "FUNCTION",
    );
    expect(invokeMock).toHaveBeenCalledWith("get_routine_ddl", {
      connectionId: "conn-1",
      database: "mydb",
      routineName: "myfunc",
      routineType: "FUNCTION",
    });
    expect(result).toBe("CREATE FUNCTION ...");
  });

  it("getTriggerDdl calls invoke with correct args", async () => {
    invokeMock.mockResolvedValue("CREATE TRIGGER ...");
    const result = await api.getTriggerDdl("conn-1", "mydb", "mytrig");
    expect(invokeMock).toHaveBeenCalledWith("get_trigger_ddl", {
      connectionId: "conn-1",
      database: "mydb",
      triggerName: "mytrig",
    });
    expect(result).toBe("CREATE TRIGGER ...");
  });

  // -- Export --------------------------------------------------------------

  it("exportResults calls invoke with all args", async () => {
    invokeMock.mockResolvedValue("/tmp/result.csv");
    const result = await api.exportResults(
      queryResult,
      "csv",
      "my_table",
    );
    expect(invokeMock).toHaveBeenCalledWith("export_results", {
      result: queryResult,
      format: "csv",
      tableName: "my_table",
    });
    expect(result).toBe("/tmp/result.csv");
  });

  it("exportResults omits optional tableName", async () => {
    await api.exportResults(queryResult, "json");
    expect(invokeMock).toHaveBeenCalledWith("export_results", {
      result: queryResult,
      format: "json",
      tableName: undefined,
    });
  });

  // -- Admin ---------------------------------------------------------------

  it("getProcessList calls invoke with connectionId", async () => {
    invokeMock.mockResolvedValue([]);
    await api.getProcessList("conn-1");
    expect(invokeMock).toHaveBeenCalledWith("get_process_list", {
      connectionId: "conn-1",
    });
  });

  it("getServerVariables calls invoke with connectionId", async () => {
    invokeMock.mockResolvedValue([]);
    await api.getServerVariables("conn-1");
    expect(invokeMock).toHaveBeenCalledWith("get_server_variables", {
      connectionId: "conn-1",
    });
  });

  it("killProcess calls invoke with connectionId and processId", async () => {
    await api.killProcess("conn-1", 42);
    expect(invokeMock).toHaveBeenCalledWith("kill_process", {
      connectionId: "conn-1",
      processId: 42,
    });
  });

  // -- File import / export ------------------------------------------------

  it("readFileContents calls invoke with path", async () => {
    invokeMock.mockResolvedValue("file contents");
    const result = await api.readFileContents("/tmp/test.sql");
    expect(invokeMock).toHaveBeenCalledWith("read_file_contents", {
      path: "/tmp/test.sql",
    });
    expect(result).toBe("file contents");
  });

  it("pickFile calls invoke with title and filters", async () => {
    invokeMock.mockResolvedValue("/tmp/selected.sql");
    const filters: [string, string[]][] = [["SQL", ["sql", "txt"]]];
    const result = await api.pickFile("Open file", filters);
    expect(invokeMock).toHaveBeenCalledWith("pick_file", {
      title: "Open file",
      filters,
    });
    expect(result).toBe("/tmp/selected.sql");
  });

  it("writeFileContents calls invoke with path and contents", async () => {
    await api.writeFileContents("/tmp/out.txt", "hello");
    expect(invokeMock).toHaveBeenCalledWith("write_file_contents", {
      path: "/tmp/out.txt",
      contents: "hello",
    });
  });

  it("pickSaveFile calls invoke with correct args", async () => {
    invokeMock.mockResolvedValue("/tmp/saved.sql");
    const filters: [string, string[]][] = [["SQL", ["sql"]]];
    const result = await api.pickSaveFile("Save as", "export.sql", filters);
    expect(invokeMock).toHaveBeenCalledWith("pick_save_file", {
      title: "Save as",
      defaultName: "export.sql",
      filters,
    });
    expect(result).toBe("/tmp/saved.sql");
  });

  // -- AI ------------------------------------------------------------------

  it("aiChat calls invoke with all args", async () => {
    invokeMock.mockResolvedValue("response text");
    const result = await api.aiChat(
      "hello",
      "conv-1",
      "chat",
      "conn-1",
      "mydb",
    );
    expect(invokeMock).toHaveBeenCalledWith("ai_chat", {
      message: "hello",
      conversationId: "conv-1",
      mode: "chat",
      connectionId: "conn-1",
      database: "mydb",
    });
    expect(result).toBe("response text");
  });

  it("aiChat omits optional args", async () => {
    await api.aiChat("hello", "conv-1", "chat");
    expect(invokeMock).toHaveBeenCalledWith("ai_chat", {
      message: "hello",
      conversationId: "conv-1",
      mode: "chat",
      connectionId: undefined,
      database: undefined,
    });
  });

  it("aiGetStatus calls invoke with no args", async () => {
    invokeMock.mockResolvedValue({ enabled: true });
    const result = await api.aiGetStatus();
    expect(invokeMock).toHaveBeenCalledWith("ai_get_status", undefined);
    expect(result).toEqual({ enabled: true });
  });

  it("aiSetConfig calls invoke with config", async () => {
    const config = { provider: "openai" as const, apiKey: "sk-test" };
    await api.aiSetConfig(config);
    expect(invokeMock).toHaveBeenCalledWith("ai_set_config", { config });
  });

  it("aiCancel calls invoke with conversationId", async () => {
    await api.aiCancel("conv-1");
    expect(invokeMock).toHaveBeenCalledWith("ai_cancel", {
      conversationId: "conv-1",
    });
  });

  it("aiApprovePermission calls invoke with correct args", async () => {
    await api.aiApprovePermission("conv-1", "req-1", true);
    expect(invokeMock).toHaveBeenCalledWith("ai_approve_permission", {
      conversationId: "conv-1",
      requestId: "req-1",
      approved: true,
    });
  });

  // -- App metadata --------------------------------------------------------

  it("getAppVersion returns version from getVersion", async () => {
    getVersionMock.mockResolvedValue("1.2.3");
    const version = await api.getAppVersion();
    expect(getVersionMock).toHaveBeenCalled();
    expect(version).toBe("1.2.3");
  });

  it("getAppVersion does not call invoke", async () => {
    getVersionMock.mockResolvedValue("0.0.0");
    await api.getAppVersion();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Tests without Tauri
// ===========================================================================

describe("api (Tauri unavailable)", () => {
  let api: Api;

  beforeAll(async () => {
    api = await loadWithoutTauri();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when calling a method that uses invoke", async () => {
    await expect(api.listConnectionProfiles()).rejects.toThrow(
      "Tauri not available for command: list_connection_profiles",
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("throws for methods with args", async () => {
    await expect(api.connect("p1")).rejects.toThrow(
      "Tauri not available for command: connect",
    );
  });

  it("throws for methods with optional args", async () => {
    await expect(
      api.executeQuery("conn-1", "SELECT 1", "mydb", 10),
    ).rejects.toThrow("Tauri not available for command: execute_query");
  });

  it("getAppVersion returns fallback empty string", async () => {
    const version = await api.getAppVersion();
    expect(version).toBe("");
    expect(getVersionMock).not.toHaveBeenCalled();
  });

  it("getAppVersion returns VITE_APP_VERSION when set", async () => {
    vi.stubEnv("VITE_APP_VERSION", "2.0.0");
    vi.resetModules();
    const mod = await import("../tauri-api");
    const api2 = mod.api as any;
    const version = await api2.getAppVersion();
    expect(version).toBe("2.0.0");
  });
});
