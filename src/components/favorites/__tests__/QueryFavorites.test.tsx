import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryFavorites } from "../QueryFavorites";

const { useFavoritesStoreFn } = vi.hoisted(() => {
  return { useFavoritesStoreFn: vi.fn() };
});

vi.mock("../../stores/favoritesStore", () => ({
  useFavoritesStore: useFavoritesStoreFn,
}));

vi.mock("../../stores/editorStore", () => ({
  useEditorStore: { getState: vi.fn(() => ({ tabs: [{ id: "tab1", type: "query", content: "" }], activeTabId: "tab1", addTab: vi.fn(() => "newTabId"), updateTabContent: vi.fn() })) },
}));

vi.mock("../../hooks/useContextMenu", () => ({
  useContextMenu: vi.fn(() => ({ contextMenu: null, showContextMenu: vi.fn() })),
}));

beforeAll(() => {
  useFavoritesStoreFn.mockImplementation((s: (v: any) => unknown) =>
    s({
      favorites: [
        { id: "fav1", name: "Get Active Users", sql: "SELECT * FROM users WHERE active = 1", category: "Uncategorized", description: "Returns all active users", createdAt: "2025-01-01", updatedAt: "2025-01-01" },
        { id: "fav2", name: "Order Summary", sql: "SELECT COUNT(*) FROM orders", category: "Reports", description: "Daily order count", connectionName: "Prod DB", createdAt: "2025-01-02", updatedAt: "2025-01-02" },
      ],
      categories: ["Uncategorized", "Reports"],
      deleteFavorite: vi.fn(), renameFavorite: vi.fn(), moveToCategory: vi.fn(),
      updateFavorite: vi.fn(), addCategory: vi.fn(), deleteCategory: vi.fn(),
    }),
  );
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
});
