import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryFavorites } from "../QueryFavorites";

const { useFavoritesStoreFn, updateTabContent, addTab, editorState } = vi.hoisted(() => ({
  useFavoritesStoreFn: vi.fn(),
  updateTabContent: vi.fn(),
  addTab: vi.fn(() => "newTabId"),
  editorState: {
    tabs: [{ id: "tab1", type: "query", content: "", isDirty: false }],
    activeTabId: "tab1",
  },
}));

vi.mock("../../../stores/favoritesStore", () => ({
  useFavoritesStore: useFavoritesStoreFn,
}));

vi.mock("../../../lib/tauri-api", () => ({
  api: {
    pickSaveFile: vi.fn().mockResolvedValue("/tmp/favorites.json"),
    pickFile: vi.fn().mockResolvedValue("/tmp/favorites.json"),
    writeFileContents: vi.fn().mockResolvedValue(undefined),
    readFileContents: vi.fn().mockResolvedValue("{}"),
  },
}));

vi.mock("../../../stores/editorStore", () => ({
  useEditorStore: {
    getState: vi.fn(() => ({
      ...editorState,
      addTab,
      updateTabContent,
    })),
  },
}));

// Context-menu mock that renders the items as buttons so tests can click
// them. Uses real React state so updates trigger re-renders of the host.
vi.mock("../../../hooks/useContextMenu", async () => {
  const { useState, useCallback } = await import("react");
  return {
    useContextMenu: () => {
      const [items, setItems] = useState<
        { label: string; onClick: () => void; danger?: boolean; separator?: boolean }[]
      >([]);
      const showContextMenu = useCallback(
        (_e: unknown, newItems: typeof items) => {
          setItems(newItems);
        },
        [],
      );
      const hideContextMenu = useCallback(() => setItems([]), []);
      const contextMenu = items.length > 0
        ? (
          <div data-testid="ctx-menu">
            {items.map((item, i) =>
              item.separator
                ? <hr key={i} data-testid="ctx-sep" />
                : (
                  <button
                    key={i}
                    data-testid={`ctx-item-${item.label}`}
                    data-danger={item.danger ? "true" : undefined}
                    onClick={item.onClick}
                  >
                    {item.label}
                  </button>
                )
            )}
          </div>
        )
        : null;
      return { contextMenu, showContextMenu, hideContextMenu };
    },
  };
});

const baselineFavorites = [
  {
    id: "fav1",
    name: "Get Active Users",
    sql: "SELECT * FROM users WHERE active = 1",
    category: "Uncategorized",
    description: "Returns all active users",
    createdAt: "2025-01-01",
    updatedAt: "2025-01-01",
  },
  {
    id: "fav2",
    name: "Order Summary",
    sql: "SELECT COUNT(*) FROM orders",
    category: "Reports",
    description: "Daily order count",
    connectionName: "Prod DB",
    createdAt: "2025-01-02",
    updatedAt: "2025-01-02",
  },
];

const storeState = {
  favorites: baselineFavorites,
  categories: ["Uncategorized", "Reports"],
  deleteFavorite: vi.fn(),
  renameFavorite: vi.fn(),
  moveToCategory: vi.fn(),
  updateFavorite: vi.fn(),
  addCategory: vi.fn(),
  deleteCategory: vi.fn(),
  exportFavorites: vi.fn(() => "{}"),
  importFavorites: vi.fn(() => ({ imported: 0, skipped: 0, invalid: 0 })),
};

beforeAll(() => {
  useFavoritesStoreFn.mockImplementation((s: (v: typeof storeState) => unknown) => s(storeState));
});

beforeEach(async () => {
  // The api mocks live in a module factory, so they keep their calls between
  // tests unless cleared — a previous export would look like this one's.
  const { api } = await import("../../../lib/tauri-api");
  vi.mocked(api.pickSaveFile).mockReset().mockResolvedValue("/tmp/favorites.json");
  vi.mocked(api.pickFile).mockReset().mockResolvedValue("/tmp/favorites.json");
  vi.mocked(api.writeFileContents).mockReset().mockResolvedValue(undefined);
  vi.mocked(api.readFileContents).mockReset().mockResolvedValue("{}");

  storeState.deleteFavorite.mockClear();
  storeState.renameFavorite.mockClear().mockReturnValue({ ok: true, id: "fav1" });
  storeState.moveToCategory.mockClear().mockReturnValue({ ok: true, id: "fav1" });
  storeState.updateFavorite.mockClear().mockReturnValue({ ok: true, id: "fav1" });
  storeState.addCategory.mockClear();
  storeState.deleteCategory.mockClear();
  storeState.exportFavorites.mockClear().mockReturnValue("{}");
  storeState.importFavorites.mockClear().mockReturnValue({ imported: 0, skipped: 0, invalid: 0 });
  updateTabContent.mockReset();
  addTab.mockReset().mockReturnValue("newTabId");
  editorState.tabs = [
    { id: "tab1", type: "query", content: "", isDirty: false },
  ];
  editorState.activeTabId = "tab1";
});

afterEach(() => {
  storeState.favorites = baselineFavorites;
  storeState.categories = ["Uncategorized", "Reports"];
});

describe("QueryFavorites", () => {
  it("renders search input", () => {
    render(<QueryFavorites />);
    expect(screen.getByPlaceholderText("Search favorites...")).toBeInTheDocument();
  });

  it("renders new category button", () => {
    render(<QueryFavorites />);
    expect(screen.getByTitle("New Category")).toBeInTheDocument();
  });

  it("renders favorites container", () => {
    const { container } = render(<QueryFavorites />);
    expect(container.querySelector(".flex.h-full.flex-col")).toBeInTheDocument();
  });

  it("confirms before replacing a dirty query tab", () => {
    editorState.tabs = [
      {
        id: "tab1",
        type: "query",
        content: "SELECT unsaved_work",
        isDirty: true,
      },
    ];
    render(<QueryFavorites />);

    fireEvent.click(screen.getByText("Get Active Users"));

    expect(screen.getByText("Replace current tab content?")).toBeInTheDocument();
    expect(screen.getByText("Unsaved changes will be lost.")).toBeInTheDocument();
    expect(updateTabContent).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(updateTabContent).toHaveBeenCalledWith(
      "tab1",
      "SELECT * FROM users WHERE active = 1",
    );
    expect(screen.queryByText("Unsaved changes will be lost.")).not.toBeInTheDocument();
  });

  it("keeps dirty query content when replacement is cancelled", () => {
    editorState.tabs = [
      {
        id: "tab1",
        type: "query",
        content: "SELECT unsaved_work",
        isDirty: true,
      },
    ];
    render(<QueryFavorites />);

    fireEvent.click(screen.getByText("Get Active Users"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(updateTabContent).not.toHaveBeenCalled();
    expect(screen.queryByText("Unsaved changes will be lost.")).not.toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Issue #337: confirm before deleting a category that holds favorites.
// ─────────────────────────────────────────────────────────────────────────
describe("QueryFavorites — delete category confirmation (#337)", () => {
  function makeReportsFavorites(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      id: `rep-${i}`,
      name: `Report ${i}`,
      sql: `SELECT ${i} FROM reports`,
      category: "Reports",
      description: undefined as string | undefined,
      connectionName: undefined as string | undefined,
      createdAt: "2025-01-01",
      updatedAt: "2025-01-01",
    }));
  }

  it("shows a ConfirmDialog with category name and favorite count when Delete Category is clicked", () => {
    storeState.favorites = makeReportsFavorites(50);
    storeState.categories = ["Uncategorized", "Reports"];

    render(<QueryFavorites />);

    const reportsHeader = screen.getByText("Reports").closest("button");
    expect(reportsHeader).not.toBeNull();
    fireEvent.contextMenu(reportsHeader!);

    const deleteBtn = screen.getByTestId("ctx-item-Delete Category");
    expect(deleteBtn).toBeInTheDocument();
    fireEvent.click(deleteBtn);

    // ConfirmDialog renders the category name, plural favorite count, and target category.
    expect(screen.getByText("Delete category \"Reports\"?")).toBeInTheDocument();
    expect(screen.getByText("50 favorites will be moved to Uncategorized.")).toBeInTheDocument();

    // Store action has NOT fired yet — user has not confirmed.
    expect(storeState.deleteCategory).not.toHaveBeenCalled();
  });

  it("calls deleteCategory when the user confirms the dialog", () => {
    storeState.favorites = makeReportsFavorites(50);
    storeState.categories = ["Uncategorized", "Reports"];

    render(<QueryFavorites />);
    fireEvent.contextMenu(screen.getByText("Reports").closest("button")!);
    fireEvent.click(screen.getByTestId("ctx-item-Delete Category"));

    // "Delete" is the confirmLabel set by QueryFavorites for danger flows.
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));

    expect(storeState.deleteCategory).toHaveBeenCalledTimes(1);
    expect(storeState.deleteCategory).toHaveBeenCalledWith("Reports");

    expect(screen.queryByText("Delete category \"Reports\"?")).not.toBeInTheDocument();
  });

  it("does NOT call deleteCategory when the user cancels", () => {
    storeState.favorites = makeReportsFavorites(50);
    storeState.categories = ["Uncategorized", "Reports"];

    render(<QueryFavorites />);
    fireEvent.contextMenu(screen.getByText("Reports").closest("button")!);
    fireEvent.click(screen.getByTestId("ctx-item-Delete Category"));

    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    expect(storeState.deleteCategory).not.toHaveBeenCalled();

    expect(screen.queryByText("Delete category \"Reports\"?")).not.toBeInTheDocument();
    expect(screen.getByText("Reports")).toBeInTheDocument();
  });

  it("uses the singular 'favorite' when the category has exactly one entry", () => {
    storeState.favorites = makeReportsFavorites(1);
    storeState.categories = ["Uncategorized", "Reports"];

    render(<QueryFavorites />);
    fireEvent.contextMenu(screen.getByText("Reports").closest("button")!);
    fireEvent.click(screen.getByTestId("ctx-item-Delete Category"));

    expect(screen.getByText("1 favorite will be moved to Uncategorized.")).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Issue #341: confirm before overwriting a dirty editor tab.
// ─────────────────────────────────────────────────────────────────────────
describe("QueryFavorites — dirty-tab overwrite confirmation (#341)", () => {
  it("confirms before replacing a dirty query tab", () => {
    editorState.tabs = [
      {
        id: "tab1",
        type: "query",
        content: "SELECT unsaved_work",
        isDirty: true,
      },
    ];
    render(<QueryFavorites />);

    fireEvent.click(screen.getByText("Get Active Users"));

    expect(screen.getByText("Replace current tab content?")).toBeInTheDocument();
    expect(screen.getByText("Unsaved changes will be lost.")).toBeInTheDocument();
    expect(updateTabContent).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(updateTabContent).toHaveBeenCalledWith(
      "tab1",
      "SELECT * FROM users WHERE active = 1",
    );
    expect(screen.queryByText("Unsaved changes will be lost.")).not.toBeInTheDocument();
  });

  it("keeps dirty query content when replacement is cancelled", () => {
    editorState.tabs = [
      {
        id: "tab1",
        type: "query",
        content: "SELECT unsaved_work",
        isDirty: true,
      },
    ];
    render(<QueryFavorites />);

    fireEvent.click(screen.getByText("Get Active Users"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(updateTabContent).not.toHaveBeenCalled();
    expect(screen.queryByText("Unsaved changes will be lost.")).not.toBeInTheDocument();
  });

  describe("renaming", () => {
    /** Put "Get Active Users" into rename mode and return its input. */
    function startRename() {
      fireEvent.contextMenu(screen.getByText("Get Active Users"));
      fireEvent.click(screen.getByTestId("ctx-item-Rename"));
      return screen.getByDisplayValue("Get Active Users");
    }

    it("commits on Enter", () => {
      render(<QueryFavorites />);
      const input = startRename();

      fireEvent.change(input, { target: { value: "Renamed" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(storeState.renameFavorite).toHaveBeenCalledWith("fav1", "Renamed");
    });

    it("commits on blur when focus leaves the row", () => {
      render(<QueryFavorites />);
      const input = startRename();

      fireEvent.change(input, { target: { value: "Renamed" } });
      fireEvent.blur(input);

      expect(storeState.renameFavorite).toHaveBeenCalledWith("fav1", "Renamed");
    });

    it("does not commit after Escape, even if a blur follows (#333)", () => {
      render(<QueryFavorites />);
      const input = startRename();

      fireEvent.change(input, { target: { value: "Renamed" } });
      fireEvent.keyDown(input, { key: "Escape" });
      // Whether unmounting a focused input fires blur is a renderer detail, so
      // the cancel has to hold even when it does.
      fireEvent.blur(input);

      expect(storeState.renameFavorite).not.toHaveBeenCalled();
      expect(screen.getByText("Get Active Users")).toBeInTheDocument();
    });

    it("ignores a press elsewhere in the row instead of loading the query (#333)", () => {
      render(<QueryFavorites />);
      const input = startRename();
      fireEvent.change(input, { target: { value: "Half typed" } });

      const row = input.closest("div.group") as HTMLElement;
      fireEvent.mouseDown(row);
      fireEvent.click(row);

      expect(updateTabContent).not.toHaveBeenCalled();
      expect(screen.getByDisplayValue(/typed|Order Summary/)).toBeInTheDocument();
    });

    it("stays in edit mode and explains when the store refuses the name", () => {
      storeState.renameFavorite.mockReturnValue({
        ok: false,
        reason: "duplicate",
        existingId: "fav2",
      });
      render(<QueryFavorites />);
      const input = startRename();

      fireEvent.change(input, { target: { value: "Order Summary" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(screen.getByRole("alert")).toHaveTextContent(/already used/);
      expect(screen.getByDisplayValue(/typed|Order Summary/)).toBeInTheDocument();
    });
  });

  describe("redacted favorites (#339)", () => {
    it("marks one whose credential was stripped", () => {
      storeState.favorites = [{ ...baselineFavorites[0], redacted: true }];
      render(<QueryFavorites />);

      expect(screen.getByText("redacted")).toBeInTheDocument();
    });

    it("says why it will not run as written", () => {
      storeState.favorites = [{ ...baselineFavorites[0], redacted: true }];
      render(<QueryFavorites />);

      expect(screen.getByText("redacted")).toHaveAttribute(
        "title",
        expect.stringContaining("will not run as written"),
      );
    });

    it("marks nothing on an ordinary favorite", () => {
      render(<QueryFavorites />);
      expect(screen.queryByText("redacted")).not.toBeInTheDocument();
    });
  });

  describe("import and export (#335)", () => {
    it("writes an export to the file the user picked", async () => {
      const { api } = await import("../../../lib/tauri-api");
      storeState.exportFavorites.mockReturnValue("{\"kind\":\"sqlpilot-favorites\"}");
      render(<QueryFavorites />);

      fireEvent.click(screen.getByTitle("Export favorites"));

      await waitFor(() =>
        expect(api.writeFileContents).toHaveBeenCalledWith(
          "/tmp/favorites.json",
          "{\"kind\":\"sqlpilot-favorites\"}",
        )
      );
    });

    it("writes nothing when the save dialog is cancelled", async () => {
      const { api } = await import("../../../lib/tauri-api");
      vi.mocked(api.pickSaveFile).mockResolvedValueOnce(null);
      render(<QueryFavorites />);

      fireEvent.click(screen.getByTitle("Export favorites"));

      await waitFor(() => expect(api.pickSaveFile).toHaveBeenCalled());
      expect(api.writeFileContents).not.toHaveBeenCalled();
    });

    it("cannot export an empty library", () => {
      storeState.favorites = [];
      render(<QueryFavorites />);
      expect(screen.getByTitle("Export favorites")).toBeDisabled();
    });

    it("reports what an import did to everything in the file", async () => {
      // "Imported 3" when the file held 40 is a report worth doubting.
      storeState.importFavorites.mockReturnValue({ imported: 3, skipped: 2, invalid: 1 });
      render(<QueryFavorites />);

      fireEvent.click(screen.getByTitle("Import favorites"));

      const notice = await screen.findByRole("status");
      expect(notice).toHaveTextContent("Imported 3");
      expect(notice).toHaveTextContent("2 already here");
      expect(notice).toHaveTextContent("1 unreadable");
    });

    it("says so when the file is not a favorites export", async () => {
      storeState.importFavorites.mockReturnValue({
        imported: 0,
        skipped: 0,
        invalid: 0,
        error: "That file is not a SQLPilot favorites export.",
      });
      render(<QueryFavorites />);

      fireEvent.click(screen.getByTitle("Import favorites"));

      expect(await screen.findByRole("status")).toHaveTextContent("not a SQLPilot favorites export");
    });

    it("imports nothing when the open dialog is cancelled", async () => {
      const { api } = await import("../../../lib/tauri-api");
      vi.mocked(api.pickFile).mockResolvedValueOnce(null);
      render(<QueryFavorites />);

      fireEvent.click(screen.getByTitle("Import favorites"));

      await waitFor(() => expect(api.pickFile).toHaveBeenCalled());
      expect(storeState.importFavorites).not.toHaveBeenCalled();
    });

    it("lets the report be dismissed", async () => {
      storeState.importFavorites.mockReturnValue({ imported: 1, skipped: 0, invalid: 0 });
      render(<QueryFavorites />);
      fireEvent.click(screen.getByTitle("Import favorites"));
      await screen.findByRole("status");

      fireEvent.click(screen.getByLabelText("Dismiss"));

      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });
  });

  describe("editing a description (#340)", () => {
    /** Put the first favorite's description into edit mode. */
    function startEditing() {
      fireEvent.contextMenu(screen.getByText("Get Active Users"));
      fireEvent.click(screen.getByTestId("ctx-item-Edit Description"));
      return screen.getByDisplayValue("Returns all active users");
    }

    it("saves an edited description", () => {
      render(<QueryFavorites />);
      const input = startEditing();

      fireEvent.change(input, { target: { value: "Updated note" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(storeState.updateFavorite).toHaveBeenCalledWith("fav1", {
        description: "Updated note",
      });
    });

    it("clears a description when the field is emptied", () => {
      // Emptying the field is the only way to remove a description. Treating
      // it as a cancel would make that impossible — which is exactly what
      // extracting the shared editor nearly did.
      render(<QueryFavorites />);
      const input = startEditing();

      fireEvent.change(input, { target: { value: "" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(storeState.updateFavorite).toHaveBeenCalledWith("fav1", {
        description: undefined,
      });
    });

    it("does not save after Escape", () => {
      render(<QueryFavorites />);
      const input = startEditing();

      fireEvent.change(input, { target: { value: "Discarded" } });
      fireEvent.keyDown(input, { key: "Escape" });
      fireEvent.blur(input);

      expect(storeState.updateFavorite).not.toHaveBeenCalled();
    });
  });

  describe("nested categories (#334)", () => {
    /** A DataTransfer stub jsdom does not provide. */
    function dragData(id: string) {
      const store: Record<string, string> = { "text/sqlpilot-favorite": id };
      return {
        getData: (type: string) => store[type] ?? "",
        setData: (type: string, value: string) => {
          store[type] = value;
        },
        dropEffect: "",
        effectAllowed: "",
      };
    }

    it("shows a path as nested folders", () => {
      storeState.categories = ["Uncategorized", "Reports", "Reports/Daily"];
      storeState.favorites = [{ ...baselineFavorites[0], category: "Reports/Daily" }];
      render(<QueryFavorites />);

      // "Reports" is a folder; "Daily" is its child, shown by its leaf name.
      expect(screen.getByText("Reports")).toBeInTheDocument();
      expect(screen.queryByText("Reports/Daily")).not.toBeInTheDocument();
    });

    it("hides a child until its parent is expanded", () => {
      storeState.categories = ["Reports", "Reports/Daily"];
      storeState.favorites = [{ ...baselineFavorites[0], category: "Reports/Daily" }];
      render(<QueryFavorites />);

      expect(screen.queryByText("Daily")).not.toBeInTheDocument();

      fireEvent.click(screen.getByText("Reports"));
      expect(screen.getByText("Daily")).toBeInTheDocument();
    });

    it("creates a parent nobody declared", () => {
      // A category called "Reports/Daily" with no "Reports" still has to
      // appear under one, or the nesting is invisible.
      storeState.categories = ["Reports/Daily"];
      storeState.favorites = [{ ...baselineFavorites[0], category: "Reports/Daily" }];
      render(<QueryFavorites />);

      expect(screen.getByText("Reports")).toBeInTheDocument();
    });

    it("makes a nested category from the New Category field", () => {
      render(<QueryFavorites />);
      fireEvent.click(screen.getByTitle("New Category"));

      const input = screen.getByPlaceholderText("Category, or Parent/Child");
      fireEvent.change(input, { target: { value: "Reports/Daily" } });
      fireEvent.click(screen.getByText("Add"));

      expect(storeState.addCategory).toHaveBeenCalledWith("Reports/Daily");
    });

    it("normalises a messy path", () => {
      render(<QueryFavorites />);
      fireEvent.click(screen.getByTitle("New Category"));

      fireEvent.change(screen.getByPlaceholderText("Category, or Parent/Child"), {
        target: { value: " Reports // Daily / " },
      });
      fireEvent.click(screen.getByText("Add"));

      expect(storeState.addCategory).toHaveBeenCalledWith("Reports/Daily");
    });

    it("moves a favorite when it is dropped on a folder", () => {
      storeState.categories = ["Uncategorized", "Reports"];
      render(<QueryFavorites />);

      const row = screen.getByText("Get Active Users").closest("div.group") as HTMLElement;
      const transfer = dragData("fav1");
      fireEvent.dragStart(row, { dataTransfer: transfer });
      fireEvent.drop(screen.getByText("Reports"), { dataTransfer: transfer });

      expect(storeState.moveToCategory).toHaveBeenCalledWith("fav1", "Reports");
    });

    it("says so when the move would collide", () => {
      storeState.categories = ["Uncategorized", "Reports"];
      storeState.moveToCategory.mockReturnValue({
        ok: false,
        reason: "duplicate",
        existingId: "fav9",
      });
      render(<QueryFavorites />);

      const row = screen.getByText("Get Active Users").closest("div.group") as HTMLElement;
      const transfer = dragData("fav1");
      fireEvent.dragStart(row, { dataTransfer: transfer });
      fireEvent.drop(screen.getByText("Reports"), { dataTransfer: transfer });

      expect(screen.getByRole("status")).toHaveTextContent("already in that category");
    });

    it("ignores a drop carrying something that is not a favorite", () => {
      // Dragging a file onto the panel should do nothing at all.
      storeState.categories = ["Uncategorized", "Reports"];
      render(<QueryFavorites />);

      fireEvent.drop(screen.getByText("Reports"), {
        dataTransfer: { getData: () => "", dropEffect: "" },
      });

      expect(storeState.moveToCategory).not.toHaveBeenCalled();
    });

    it("does not drag a row that is being renamed", () => {
      render(<QueryFavorites />);
      fireEvent.contextMenu(screen.getByText("Get Active Users"));
      fireEvent.click(screen.getByTestId("ctx-item-Rename"));

      const row = screen.getByDisplayValue("Get Active Users").closest("div.group") as HTMLElement;
      expect(row).toHaveAttribute("draggable", "false");
    });
  });
});
