import { fireEvent, render, screen } from "@testing-library/react";
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
};

beforeAll(() => {
  useFavoritesStoreFn.mockImplementation((s: (v: typeof storeState) => unknown) => s(storeState));
});

beforeEach(() => {
  storeState.deleteFavorite.mockClear();
  storeState.renameFavorite.mockClear();
  storeState.moveToCategory.mockClear();
  storeState.updateFavorite.mockClear();
  storeState.addCategory.mockClear();
  storeState.deleteCategory.mockClear();
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
});
