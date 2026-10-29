import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useEditorStore } from "../../../stores/editorStore";
import { useFavoritesStore } from "../../../stores/favoritesStore";
import { QueryFavorites } from "../QueryFavorites";

/**
 * Opening a favorite against the real editor store, so "dirty" is what the
 * store decides rather than what a mock was told (#909).
 */
describe("opening a favorite (#909)", () => {
  const sql = "SELECT id, email FROM users WHERE active = 1";

  beforeEach(() => {
    useEditorStore.setState({
      tabs: [{ id: "tab-a", title: "Untitled-1", content: "", type: "query", isDirty: false }],
      activeTabId: "tab-a",
    });
    useFavoritesStore.setState({ favorites: [], categories: ["Uncategorized"] });
    useFavoritesStore.getState().addFavorite({ name: "Active users", sql, category: "Uncategorized" });
  });

  it("puts the SQL in the active tab without marking it unsaved", () => {
    render(<QueryFavorites />);

    fireEvent.click(screen.getByText("Active users"));

    const tab = useEditorStore.getState().tabs.find((t) => t.id === "tab-a");
    expect(tab?.content).toBe(sql);
    expect(tab?.isDirty).toBe(false);
  });

  it("still counts an edit after opening as unsaved", () => {
    render(<QueryFavorites />);
    fireEvent.click(screen.getByText("Active users"));

    useEditorStore.getState().updateTabContent("tab-a", `${sql} LIMIT 10`);

    expect(useEditorStore.getState().tabs.find((t) => t.id === "tab-a")?.isDirty).toBe(true);
  });

  it("opens a clean new tab on double-click", () => {
    render(<QueryFavorites />);

    fireEvent.doubleClick(screen.getByText("Active users"));

    const { tabs, activeTabId } = useEditorStore.getState();
    const opened = tabs.find((t) => t.id === activeTabId);
    expect(opened?.id).not.toBe("tab-a");
    expect(opened?.content).toBe(sql);
    expect(opened?.isDirty).toBe(false);
  });
});
