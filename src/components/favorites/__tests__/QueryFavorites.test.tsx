import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("../../../hooks/useContextMenu", () => ({
  useContextMenu: vi.fn(() => ({ contextMenu: null, showContextMenu: vi.fn() })),
}));

beforeAll(() => {
  useFavoritesStoreFn.mockImplementation((s: (v: any) => unknown) =>
    s({
      favorites: [
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
      ],
      categories: ["Uncategorized", "Reports"],
      deleteFavorite: vi.fn(),
      renameFavorite: vi.fn(),
      moveToCategory: vi.fn(),
      updateFavorite: vi.fn(),
      addCategory: vi.fn(),
      deleteCategory: vi.fn(),
    })
  );
});

beforeEach(() => {
  updateTabContent.mockReset();
  addTab.mockReset().mockReturnValue("newTabId");
  editorState.tabs = [
    { id: "tab1", type: "query", content: "", isDirty: false },
  ];
  editorState.activeTabId = "tab1";
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
