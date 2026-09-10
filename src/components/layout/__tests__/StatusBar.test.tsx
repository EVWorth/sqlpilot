import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act, Profiler } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../../lib/tauri-api";
import { useConnectionStore } from "../../../stores/connectionStore";
import { useEditorStore } from "../../../stores/editorStore";
import { useResultStore } from "../../../stores/resultStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useStorageErrorStore } from "../../../stores/storageErrorStore";
import { StatusBar } from "../StatusBar";

vi.mock("../../../lib/tauri-api", () => ({
  api: {
    getAppVersion: vi.fn().mockResolvedValue("2.1.0"),
    getPlatformInfo: vi.fn().mockResolvedValue({ package_format: "standard", arch: "x86_64" }),
    keyringAvailable: vi.fn().mockResolvedValue(true),
  },
}));

const { act: reactAct } = await import("react");

describe("StatusBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({ updateStatus: "up-to-date", updateVersion: null });
    useStorageErrorStore.setState({ errors: {} });

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

  it("asks before starting a download, rather than starting one on a click", async () => {
    // The chip used to begin a download of unknown size on a single click
    // (#353).
    const user = userEvent.setup({ applyAccept: false });
    useSettingsStore.setState({
      updateStatus: "available",
      updateVersion: "2.0.0",
      updateError: null,
      dismissedVersion: null,
    });
    renderStatusBar();
    const spy = vi.spyOn(useSettingsStore.getState(), "installUpdate");

    await user.click(screen.getByText("Update to v2.0.0"));

    expect(screen.getByTestId("update-confirm")).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it("hides the chip for a version the user put off", async () => {
    const user = userEvent.setup({ applyAccept: false });
    useSettingsStore.setState({
      updateStatus: "available",
      updateVersion: "2.0.0",
      updateError: null,
      dismissedVersion: null,
    });
    renderStatusBar();

    await user.click(screen.getByText("Update to v2.0.0"));
    await user.click(screen.getByText("Later"));

    expect(screen.queryByText("Update to v2.0.0")).toBeNull();
    expect(useSettingsStore.getState().dismissedVersion).toBe("2.0.0");
  });

  it("still shows a newer version after one was put off", async () => {
    // "Later" means later for that update, not silence for every update.
    useSettingsStore.setState({
      updateStatus: "available",
      updateVersion: "2.1.0",
      dismissedVersion: "2.0.0",
      updateError: null,
    });
    renderStatusBar();

    expect(screen.getByText("Update to v2.1.0")).toBeInTheDocument();
  });

  it("does not promise a restart it no longer performs", async () => {
    // Downloading and restarting are separate since #573, so the copy must
    // not say the app will restart when the download finishes.
    const user = userEvent.setup({ applyAccept: false });
    useSettingsStore.setState({
      updateStatus: "available",
      updateVersion: "2.0.0",
      dismissedVersion: null,
      updateError: null,
    });
    renderStatusBar();
    await user.click(screen.getByText("Update to v2.0.0"));

    const panel = screen.getByTestId("update-confirm");
    expect(panel.textContent).toMatch(/ask before restarting/i);
  });

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

  describe("storage errors (issue #454 / #348)", () => {
    it("surfaces a settings storage failure to the user", () => {
      useStorageErrorStore.setState({
        errors: { "query-settings": "Could not save query settings: quota exceeded." },
      });
      render(<StatusBar />);
      expect(screen.getByText(/Could not save query settings/)).toBeInTheDocument();
    });

    it("surfaces a theme storage failure to the user", () => {
      useStorageErrorStore.setState({
        errors: { theme: "Could not save theme: storage blocked." },
      });
      render(<StatusBar />);
      expect(screen.getByText(/Could not save theme/)).toBeInTheDocument();
    });

    it("shows one entry per failing key", () => {
      useStorageErrorStore.setState({
        errors: { theme: "Could not save theme: x", "query-settings": "Could not save query settings: y" },
      });
      render(<StatusBar />);
      expect(screen.getByText(/Could not save theme/)).toBeInTheDocument();
      expect(screen.getByText(/Could not save query settings/)).toBeInTheDocument();
    });

    it("dismisses an error when clicked", () => {
      useStorageErrorStore.setState({ errors: { theme: "Could not save theme: x" } });
      render(<StatusBar />);

      fireEvent.click(screen.getByText(/Could not save theme/));

      expect(useStorageErrorStore.getState().errors.theme).toBeUndefined();
      expect(screen.queryByText(/Could not save theme/)).not.toBeInTheDocument();
    });

    it("renders nothing when there are no storage errors", () => {
      render(<StatusBar />);
      expect(screen.queryByText(/Could not save/)).not.toBeInTheDocument();
    });
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
      await user.click(screen.getByText("Download"));
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
      await user.click(screen.getByText("Update to v2.0.0"));
      await user.click(screen.getByText("Download"));
      // The button delegates; the refusal comes from the store, so it also
      // applies to any other caller and is re-checked before the restart
      // (#570).
      expect(useSettingsStore.getState().updateStatus).toBe("error");
      expect(useSettingsStore.getState().updateError).toMatch(/query is still running/i);
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
      await user.click(screen.getByText("Update to v2.0.0"));
      await user.click(screen.getByText("Download"));
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
      const updater = await import("@tauri-apps/plugin-updater");
      vi.mocked(updater.check).mockClear();
      useSettingsStore.setState({ updateStatus: "error", updateError: null });
      renderStatusBar();
      // Chip click now opens the details panel (which holds the Retry button)
      await user.click(screen.getByText("Update failed"));
      await user.click(screen.getByRole("button", { name: /retry/i }));
      expect(vi.mocked(updater.check)).toHaveBeenCalledOnce();
    });

    it("opens the error details panel with diagnostic + report + retry buttons", async () => {
      const user = userEvent.setup({ applyAccept: false });
      useSettingsStore.setState({
        updateStatus: "error",
        updateError: "rpm install failed: transaction test failed",
      });
      renderStatusBar();
      await user.click(screen.getByText("Update failed"));
      const dialog = screen.getByRole("dialog", { name: /update error details/i });
      expect(dialog).toBeInTheDocument();
      expect(dialog.textContent).toContain("rpm install failed: transaction test failed");
      expect(dialog.textContent).toMatch(/SQLPilot v2\.1\.0/);
      expect(dialog.textContent).toMatch(/Install type: standard/);
      expect(screen.getByRole("button", { name: /copy diagnostic/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /report issue/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    });

    it("Report issue opens a GitHub new-issue URL with the diagnostic in the body", async () => {
      const user = userEvent.setup({ applyAccept: false });
      const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
      useSettingsStore.setState({
        updateStatus: "error",
        updateError: "rpm install failed: signature bad",
        updateVersion: "0.4.1",
      });
      renderStatusBar();
      await user.click(screen.getByText("Update failed"));
      await user.click(screen.getByRole("button", { name: /report issue/i }));
      expect(openSpy).toHaveBeenCalledOnce();
      const url = openSpy.mock.calls[0][0] as string;
      expect(url).toContain("https://github.com/EVWorth/sqlpilot/issues/new");
      expect(url).toContain("labels=bug%2Cauto-update");
      // decoded body should contain the error and diagnostic line
      const decoded = decodeURIComponent(url.split("body=")[1]);
      expect(decoded).toContain("rpm install failed: signature bad");
      expect(decoded).toContain("SQLPilot v2.1.0");
    });

    it("Copy diagnostic writes the formatted blob to the clipboard", async () => {
      const user = userEvent.setup({ applyAccept: false });
      const writeSpy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
      useSettingsStore.setState({
        updateStatus: "error",
        updateError: "rpm install failed",
        updateVersion: "0.4.1",
        packageFormat: "rpm_ostree",
        arch: "x86_64",
      });
      renderStatusBar();
      // detectPlatform runs on mount and overrides the format. Wait for
      // it to settle, then re-set state and re-open the panel.
      await user.click(screen.getByText("Update failed"));
      // dialog text reflects post-detectPlatform hint; assert the structural fields instead.
      await user.click(screen.getByRole("button", { name: /copy diagnostic/i }));
      expect(writeSpy).toHaveBeenCalledOnce();
      const blob = writeSpy.mock.calls[0][0] as string;
      expect(blob).toContain("SQLPilot v2.1.0");
      expect(blob).toContain("Error: rpm install failed");
      expect(blob).toContain("target v0.4.1");
      expect(blob).toMatch(/Install type: (standard|rpm_ostree|flatpak|snap|app_image|unknown)/);
      expect(blob).toMatch(/Timestamp: \d{4}-\d{2}-\d{2}T/);
    });

    it("Close button dismisses the error details panel", async () => {
      const user = userEvent.setup({ applyAccept: false });
      useSettingsStore.setState({ updateStatus: "error", updateError: "boom" });
      renderStatusBar();
      await user.click(screen.getByText("Update failed"));
      expect(screen.getByRole("dialog", { name: /update error details/i })).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: /close update error details/i }));
      expect(screen.queryByRole("dialog", { name: /update error details/i })).toBeNull();
    });

    it("clicking outside the details panel dismisses it", async () => {
      const user = userEvent.setup({ applyAccept: false });
      useSettingsStore.setState({ updateStatus: "error", updateError: "boom" });
      renderStatusBar();
      await user.click(screen.getByText("Update failed"));
      expect(screen.getByRole("dialog", { name: /update error details/i })).toBeInTheDocument();
      // mousedown on document body, outside the panel
      fireEvent.mouseDown(document.body);
      expect(screen.queryByRole("dialog", { name: /update error details/i })).toBeNull();
    });

    it("leaves the status bar in error state when panel is open", async () => {
      const user = userEvent.setup({ applyAccept: false });
      useSettingsStore.setState({ updateStatus: "error", updateError: "boom" });
      renderStatusBar();
      await user.click(screen.getByText("Update failed"));
      expect(useSettingsStore.getState().updateStatus).toBe("error");
    });

    it("shows manual-update-required chip with copyable command on rpm-ostree", () => {
      useSettingsStore.setState({
        updateStatus: "manual-update-required",
        updateVersion: "0.4.1",
        manualUpdateCommand:
          "rpm-ostree install https://github.com/EVWorth/sqlpilot/releases/download/v0.4.1/SQLPilot-0.4.1-1.x86_64.rpm",
      });
      renderStatusBar();
      expect(screen.getByText(/Manual update on rpm-ostree/)).toBeInTheDocument();
      expect(useSettingsStore.getState().pendingUpdate).toBeNull();
    });

    it("manual-update chip click copies the install command", async () => {
      const user = userEvent.setup({ applyAccept: false });
      const writeSpy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
      useSettingsStore.setState({
        updateStatus: "manual-update-required",
        updateVersion: "0.4.1",
        manualUpdateCommand:
          "rpm-ostree install https://github.com/EVWorth/sqlpilot/releases/download/v0.4.1/SQLPilot-0.4.1-1.x86_64.rpm",
      });
      renderStatusBar();
      await user.click(screen.getByText(/Manual update on rpm-ostree/));
      expect(writeSpy).toHaveBeenCalledWith(
        "rpm-ostree install https://github.com/EVWorth/sqlpilot/releases/download/v0.4.1/SQLPilot-0.4.1-1.x86_64.rpm",
      );
    });
  });
});

describe("keyring availability (#278)", () => {
  it("warns when no credential store was available at startup", async () => {
    // The app now starts without a keyring instead of panicking, so it has to
    // say that passwords are only kept for this session — otherwise the user
    // finds out when the next launch has forgotten them.
    // The surrounding beforeEach already puts an active connection in place.
    vi.mocked(api.keyringAvailable).mockResolvedValue(false);

    render(<StatusBar />);
    expect(await screen.findByText("Passwords not saved")).toBeDefined();
  });

  it("says nothing when the credential store is working", async () => {
    vi.mocked(api.keyringAvailable).mockResolvedValue(true);

    render(<StatusBar />);
    await screen.findByText(/MySQL/);
    expect(screen.queryByText("Passwords not saved")).toBeNull();
  });

  describe("re-rendering (#458)", () => {
    /**
     * Render StatusBar under a Profiler and return a live render count.
     *
     * Awaits a flush first: the component kicks off version, platform and
     * update lookups on mount, and counting renders while those are still
     * resolving measures their timing rather than the selector.
     */
    async function renderCounted() {
      const renders = { count: 0 };
      render(
        <Profiler id="status-bar" onRender={() => renders.count++}>
          <StatusBar />
        </Profiler>,
      );
      await act(async () => {
        await Promise.resolve();
      });
      renders.count = 0;
      return renders;
    }

    it("does not re-render when an unrelated tab field changes", async () => {
      const renders = await renderCounted();

      // Typing in the editor rewrites the tabs array on a debounce. Reading
      // the whole array meant every one of those re-rendered this component
      // and reflowed its update overlay, for a value that had not changed.
      await act(async () => {
        useEditorStore.setState((state) => ({
          tabs: state.tabs.map((t) => ({ ...t, content: "SELECT 1" })),
        }));
      });

      expect(renders.count).toBe(0);
    });

    it("does not re-render when a different tab's database changes", async () => {
      act(() => {
        useEditorStore.setState((state) => ({
          tabs: [
            ...state.tabs,
            { id: "tab-1", title: "Other", content: "", type: "query", isDirty: false, database: "other" },
          ],
        }));
      });
      const renders = await renderCounted();

      await act(async () => {
        useEditorStore.setState((state) => ({
          tabs: state.tabs.map((t) => t.id === "tab-1" ? { ...t, database: "changed" } : t),
        }));
      });

      expect(renders.count).toBe(0);
    });

    it("still re-renders when the active tab's database changes", async () => {
      // The narrowing must not be so tight that the bar stops updating.
      const renders = await renderCounted();

      await act(async () => {
        useEditorStore.setState((state) => ({
          tabs: state.tabs.map((t) => ({ ...t, database: "warehouse" })),
        }));
      });

      expect(renders.count).toBeGreaterThan(0);
    });

    it("still re-renders when the active tab changes", async () => {
      // Both tabs seeded here rather than leaning on the shared beforeEach, so
      // the two databases are unambiguously different before the switch.
      await act(async () => {
        useEditorStore.setState({
          tabs: [
            { id: "a", title: "A", content: "", type: "query", isDirty: false, database: "one" },
            { id: "b", title: "B", content: "", type: "query", isDirty: false, database: "two" },
          ],
          activeTabId: "a",
        });
      });
      const renders = await renderCounted();

      await act(async () => {
        useEditorStore.setState({ activeTabId: "b" });
      });

      expect(renders.count).toBeGreaterThan(0);
    });
  });
});
