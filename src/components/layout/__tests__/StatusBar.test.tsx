import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useConnectionStore } from "../../../stores/connectionStore";
import { useEditorStore } from "../../../stores/editorStore";
import { useResultStore } from "../../../stores/resultStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { StatusBar } from "../StatusBar";

vi.mock("../../../lib/tauri-api", () => ({
  api: {
    getAppVersion: vi.fn().mockResolvedValue("2.1.0"),
  },
}));

const { act: reactAct } = await import("react");

describe("StatusBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({ updateStatus: "up-to-date", updateVersion: null });

    useConnectionStore.setState({
      activeConnections: [
        {
          id: "conn-1",
          profile_id: "prof-1",
          name: "Production DB",
          host: "db.example.com",
          port: 3306,
          database: "analytics",
          server_version: "8.0.33",
          connected_at: "2024-01-01T00:00:00Z",
        },
      ],
      selectedConnectionId: "conn-1",
      error: null,
      profiles: [
        {
          id: "prof-1",
          name: "Prod Profile",
          environment: "production" as const,
        },
      ],
      loading: false,
    } as any);

    useResultStore.setState({
      isExecuting: false,
      results: [],
      activeResultIndex: 0,
      error: null,
    } as any);

    useEditorStore.setState({
      tabs: [
        { id: "tab-0", title: "Query", content: "", type: "query", isDirty: false, database: "analytics" },
      ],
      activeTabId: "tab-0",
      editorInstance: null,
    });
  });

  function renderStatusBar() {
    let rerender: ReturnType<typeof render>["rerender"];
    act(() => {
      const r = render(<StatusBar />);
      rerender = r.rerender;
    });
    return rerender!;
  }

  it("renders connection name and host:port", () => {
    renderStatusBar();
    expect(screen.getByText(/Production DB/)).toBeInTheDocument();
    expect(screen.getByText(/db\.example\.com:3306/)).toBeInTheDocument();
  });

  it("renders MySQL version", () => {
    renderStatusBar();
    expect(screen.getByText("MySQL 8.0.33")).toBeInTheDocument();
  });

  it("renders 'Disconnected' when no connection is active", () => {
    useConnectionStore.setState({
      activeConnections: [],
      selectedConnectionId: null,
      error: null,
      profiles: [],
      loading: false,
    } as any);

    renderStatusBar();
    expect(screen.getByText("Disconnected")).toBeInTheDocument();
  });

  it("renders environment badge for production", () => {
    renderStatusBar();
    expect(screen.getByText("PROD")).toBeInTheDocument();
  });

  it("renders database name", () => {
    renderStatusBar();
    expect(screen.getByText("analytics")).toBeInTheDocument();
  });

  it("renders executing indicator when query is running", () => {
    useResultStore.setState({
      isExecuting: true,
      results: [],
      activeResultIndex: 0,
      error: null,
    } as any);

    renderStatusBar();
    expect(screen.getByText("Executing...")).toBeInTheDocument();
  });

  it("renders error when present", () => {
    useResultStore.setState({
      isExecuting: false,
      results: [],
      activeResultIndex: 0,
      error: "Syntax error near 'SELEKT'",
    } as any);

    renderStatusBar();
    expect(screen.getByText(/Syntax error/)).toBeInTheDocument();
  });

  it("renders connection error when present", () => {
    useConnectionStore.setState({
      activeConnections: [
        {
          id: "conn-1",
          profile_id: "prof-1",
          name: "Test DB",
          host: "localhost",
          port: 3306,
          server_version: "8.0.33",
          connected_at: "2024-01-01T00:00:00Z",
        },
      ],
      selectedConnectionId: "conn-1",
      error: "Connection timed out",
      profiles: [],
      loading: false,
    } as any);

    renderStatusBar();
    expect(screen.getByText("Connection timed out")).toBeInTheDocument();
  });

  it("renders result stats when results exist", () => {
    useResultStore.setState({
      isExecuting: false,
      results: [
        {
          query_id: "q-1",
          statement_index: 0,
          columns: [{ name: "id", data_type: "int", nullable: false, is_primary_key: true }],
          rows: [[1], [2], [3]],
          rows_affected: 0,
          execution_time_ms: 150,
          warnings: [],
          rows_truncated: false,
        },
      ],
      activeResultIndex: 0,
      error: null,
    } as any);

    renderStatusBar();
    expect(screen.getByText(/3 rows/)).toBeInTheDocument();
    expect(screen.getByText(/150ms/)).toBeInTheDocument();
  });

  it("shows app version after mount", async () => {
    renderStatusBar();
    expect(await screen.findByText("v2.1.0")).toBeInTheDocument();
  });

  describe("update indicators", () => {
    beforeEach(() => {
      useSettingsStore.setState({ updateStatus: "idle", updateVersion: null });
    });

    it("shows update available button with version", () => {
      useSettingsStore.setState({ updateStatus: "available", updateVersion: "1.5.0" });
      renderStatusBar();
      expect(screen.getByText("Update to v1.5.0")).toBeInTheDocument();
    });

    it("shows downloading status", () => {
      useSettingsStore.setState({ updateStatus: "downloading" });
      renderStatusBar();
      expect(screen.getByText("Downloading update")).toBeInTheDocument();
    });

    it("shows download progress percentage when total is known", () => {
      useSettingsStore.setState({
        updateStatus: "downloading",
        downloadProgress: { transferred: 512 * 1024 * 1024, total: 1024 * 1024 * 1024 },
      });
      renderStatusBar();
      // 512 MB / 1024 MB = 50%
      expect(screen.getByText("50%")).toBeInTheDocument();
    });

    it("shows downloaded bytes without percentage when total unknown", () => {
      useSettingsStore.setState({
        updateStatus: "downloading",
        downloadProgress: { transferred: 5 * 1024 * 1024, total: null },
      });
      renderStatusBar();
      expect(screen.getByText("5.0 MB")).toBeInTheDocument();
    });

    it("shows retry button when update check fails", () => {
      useSettingsStore.setState({ updateStatus: "error" });
      renderStatusBar();
      expect(screen.getByText("Update failed")).toBeInTheDocument();
    });

    it("calls installUpdate when update button is clicked", async () => {
      const user = userEvent.setup({ applyAccept: false });
      useSettingsStore.setState({
        updateStatus: "available",
        updateVersion: "2.0.0",
        updateError: null,
      });
      useResultStore.setState({ isExecuting: false });
      useEditorStore.setState({
        tabs: [{ id: "tab-0", title: "Query", content: "", type: "query", isDirty: false, database: "analytics" }],
        activeTabId: "tab-0",
      });
      renderStatusBar();
      const spy = vi.spyOn(useSettingsStore.getState(), "installUpdate");
      await user.click(screen.getByText("Update to v2.0.0"));
      expect(spy).toHaveBeenCalledOnce();
    });

    it("blocks install when a query is executing", async () => {
      const user = userEvent.setup({ applyAccept: false });
      useSettingsStore.setState({
        updateStatus: "available",
        updateVersion: "2.0.0",
        updateError: null,
      });
      useResultStore.setState({ isExecuting: true });
      useEditorStore.setState({
        tabs: [{ id: "tab-0", title: "Query", content: "", type: "query", isDirty: false, database: "analytics" }],
        activeTabId: "tab-0",
      });
      renderStatusBar();
      const installSpy = vi.spyOn(useSettingsStore.getState(), "installUpdate");
      await user.click(screen.getByText("Update to v2.0.0"));
      expect(installSpy).not.toHaveBeenCalled();
      expect(useSettingsStore.getState().updateStatus).toBe("error");
      expect(useSettingsStore.getState().updateError).toMatch(/query is running/i);
    });

    it("blocks install when an editor tab has unsaved changes", async () => {
      const user = userEvent.setup({ applyAccept: false });
      useSettingsStore.setState({
        updateStatus: "available",
        updateVersion: "2.0.0",
        updateError: null,
      });
      useResultStore.setState({ isExecuting: false });
      useEditorStore.setState({
        tabs: [
          {
            id: "tab-0",
            title: "Query",
            content: "SELECT 1",
            type: "query",
            isDirty: true,
            database: "analytics",
          },
        ],
        activeTabId: "tab-0",
      });
      renderStatusBar();
      const installSpy = vi.spyOn(useSettingsStore.getState(), "installUpdate");
      await user.click(screen.getByText("Update to v2.0.0"));
      expect(installSpy).not.toHaveBeenCalled();
      expect(useSettingsStore.getState().updateStatus).toBe("error");
      expect(useSettingsStore.getState().updateError).toMatch(/unsaved changes/i);
    });

    it("surfaces the underlying install error in the chip title", async () => {
      const user = userEvent.setup({ applyAccept: false });
      useSettingsStore.setState({
        updateStatus: "error",
        updateError: "rpm install failed: transaction check failed",
      });
      renderStatusBar();
      const chip = screen.getByText("Update failed");
      expect(chip.closest("button")?.getAttribute("title")).toContain(
        "rpm install failed: transaction check failed",
      );
    });

    it("calls checkForUpdates when retry button is clicked", async () => {
      const user = userEvent.setup({ applyAccept: false });
      useSettingsStore.setState({ updateStatus: "error", updateError: null });
      renderStatusBar();
      const spy = vi.spyOn(useSettingsStore.getState(), "checkForUpdates");
      await user.click(screen.getByText("Update failed"));
      expect(spy).toHaveBeenCalledOnce();
    });
  });
});
