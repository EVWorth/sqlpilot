import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAddAdminTab = vi.fn();
const mockCycleTheme = vi.fn();
let connState = { selectedConnectionId: null as string | null };

vi.mock("../../../stores/editorStore", () => ({
  useEditorStore: Object.assign(vi.fn(), {
    getState: vi.fn(() => ({ addAdminTab: mockAddAdminTab })),
  }),
}));

vi.mock("../../../stores/connectionStore", () => ({
  useConnectionStore: Object.assign(
    vi.fn((selector: (s: unknown) => unknown) => selector(connState)),
    { getState: () => connState },
  ),
}));

vi.mock("../../../stores/themeStore", () => ({
  useThemeStore: Object.assign(
    vi.fn((selector: (s: unknown) => unknown) => selector({ theme: "dark", cycleTheme: mockCycleTheme })),
    { getState: () => ({ theme: "dark", cycleTheme: mockCycleTheme }) },
  ),
}));

import { FeatureButtons } from "../FeatureButtons";

function renderButtons(props: Partial<React.ComponentProps<typeof FeatureButtons>> = {}) {
  return render(
    <div data-testid="host">
      <FeatureButtons buttonClassName={(d) => (d ? "off" : "on")} {...props} />
    </div>,
  );
}

/** The buttons a host is expected to show, in order. */
const EXPECTED = ["Admin", "Import", "Backup", "Restore"];

describe("FeatureButtons", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connState = { selectedConnectionId: "conn-1" };
  });

  it("renders the feature set", () => {
    renderButtons();
    for (const label of EXPECTED) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("hides AI unless it is enabled", () => {
    renderButtons();
    expect(screen.queryByText("AI")).not.toBeInTheDocument();

    renderButtons({ aiEnabled: true });
    expect(screen.getAllByText("AI")).toHaveLength(1);
  });

  it("disables everything that needs a connection when there is none", () => {
    connState = { selectedConnectionId: null };
    renderButtons();

    for (const label of EXPECTED) {
      expect(screen.getByText(label).closest("button")).toBeDisabled();
    }
  });

  it("leaves the theme button alone with no connection", () => {
    // The theme is the app's, not the server's.
    connState = { selectedConnectionId: null };
    renderButtons();

    fireEvent.click(screen.getByTitle(/^Theme:/));

    expect(mockCycleTheme).toHaveBeenCalled();
  });

  it("opens an admin tab on the selected connection", () => {
    renderButtons();
    fireEvent.click(screen.getByText("Admin"));
    expect(mockAddAdminTab).toHaveBeenCalledWith("conn-1");
  });

  it("does nothing on Admin with no connection selected", () => {
    connState = { selectedConnectionId: null };
    renderButtons();

    fireEvent.click(screen.getByText("Admin"));

    expect(mockAddAdminTab).not.toHaveBeenCalled();
  });

  it("calls each handler", () => {
    const onShowImport = vi.fn();
    const onShowBackup = vi.fn();
    const onShowRestore = vi.fn();
    const onToggleAI = vi.fn();
    renderButtons({ onShowImport, onShowBackup, onShowRestore, onToggleAI, aiEnabled: true });

    fireEvent.click(screen.getByText("Import"));
    fireEvent.click(screen.getByText("Backup"));
    fireEvent.click(screen.getByText("Restore"));
    fireEvent.click(screen.getByText("AI"));

    expect(onShowImport).toHaveBeenCalled();
    expect(onShowBackup).toHaveBeenCalled();
    expect(onShowRestore).toHaveBeenCalled();
    expect(onToggleAI).toHaveBeenCalled();
  });

  it("takes its styling from the host", () => {
    // The two hosts look different — the title bar's row is tighter — so the
    // shared set must not force one appearance on both.
    connState = { selectedConnectionId: null };
    renderButtons({ buttonClassName: (d) => (d ? "host-disabled" : "host-enabled") });

    const host = screen.getByTestId("host");
    expect(within(host).getByText("Admin").closest("button")).toHaveClass("host-disabled");
    expect(within(host).getByTitle(/^Theme:/)).toHaveClass("host-enabled");
  });

  it("uses the active styling for an open AI panel", () => {
    renderButtons({ aiEnabled: true, aiPanelOpen: true, activeButtonClassName: "is-open" });
    expect(screen.getByText("AI").closest("button")).toHaveClass("is-open");
  });
});
