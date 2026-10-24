import { beforeEach, describe, expect, it } from "vitest";
import { forgetConnectionKind, registerConnectionKind } from "../../../lib/datasource";
import { useConnectionStore } from "../../../stores/connectionStore";
import { useEditorStore } from "../../../stores/editorStore";
import { openNewTableDesigner } from "../openNewTable";

const connection = (database: string | null) => ({
  id: "conn-1",
  profile_id: "prof-1",
  name: "Local",
  host: "127.0.0.1",
  port: 3306,
  database,
  server_version: "8.0.36",
  connected_at: "2026-01-01T00:00:00Z",
  color: null,
  environment: null,
});

describe("openNewTableDesigner (#818)", () => {
  beforeEach(() => {
    forgetConnectionKind("conn-1");
    useEditorStore.setState({ tabs: [], activeTabId: null });
    useConnectionStore.setState({ selectedConnectionId: "conn-1", activeConnections: [connection("shop")] });
  });

  it("opens a designer with no table on the connection's default database", () => {
    expect(openNewTableDesigner()).toBeNull();

    const [tab] = useEditorStore.getState().tabs;
    expect(tab).toMatchObject({ type: "designer", connectionId: "conn-1", database: "shop" });
    expect(tab.tableName).toBeUndefined();
  });

  it("prefers the active tab's database", () => {
    useEditorStore.setState({
      tabs: [{
        id: "q",
        title: "Q",
        content: "",
        type: "query",
        isDirty: false,
        connectionId: "conn-1",
        database: "logs",
      }],
      activeTabId: "q",
    });

    openNewTableDesigner();

    expect(useEditorStore.getState().tabs.at(-1)).toMatchObject({ type: "designer", database: "logs" });
  });

  it("says why when there is no database to put the table in", () => {
    useConnectionStore.setState({ activeConnections: [connection(null)] });

    expect(openNewTableDesigner()).toMatch(/Pick a database/);
    expect(useEditorStore.getState().tabs).toHaveLength(0);
  });

  it("says why when nothing is connected", () => {
    useConnectionStore.setState({ selectedConnectionId: null, activeConnections: [] });

    expect(openNewTableDesigner()).toMatch(/Connect/);
  });

  it("does not open the MySQL designer on a SQLite file", () => {
    registerConnectionKind("conn-1", "sqlite");

    expect(openNewTableDesigner()).toMatch(/MySQL and MariaDB/);
    expect(useEditorStore.getState().tabs).toHaveLength(0);
  });
});
