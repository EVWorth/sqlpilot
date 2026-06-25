import { beforeEach, describe, expect, it } from "vitest";
import { useFavoritesStore } from "../favoritesStore";

describe("favoritesStore", () => {
  beforeEach(() => {
    useFavoritesStore.getState().favorites.forEach((f) => {
      useFavoritesStore.getState().deleteFavorite(f.id);
    });
  });

  describe("addFavorite", () => {
    it("adds a new favorite", () => {
      const store = useFavoritesStore.getState();
      store.addFavorite({
        name: "Test Query",
        sql: "SELECT * FROM users",
        category: "Uncategorized",
      });

      const { favorites } = useFavoritesStore.getState();
      expect(favorites).toHaveLength(1);
      expect(favorites[0].name).toBe("Test Query");
      expect(favorites[0].sql).toBe("SELECT * FROM users");
      expect(favorites[0].id).toBeDefined();
      expect(favorites[0].createdAt).toBeDefined();
      expect(favorites[0].updatedAt).toBeDefined();
    });

    it("creates new category if it doesn't exist", () => {
      const store = useFavoritesStore.getState();
      store.addFavorite({
        name: "Test Query",
        sql: "SELECT 1",
        category: "MyCategory",
      });

      const { categories } = useFavoritesStore.getState();
      expect(categories).toContain("MyCategory");
    });

    it("does not duplicate existing category", () => {
      const store = useFavoritesStore.getState();
      store.addFavorite({
        name: "Query 1",
        sql: "SELECT 1",
        category: "Uncategorized",
      });

      const { categories } = useFavoritesStore.getState();
      expect(categories.filter((c) => c === "Uncategorized")).toHaveLength(1);
    });

    it("adds favorites to the beginning of the list", () => {
      const store = useFavoritesStore.getState();
      store.addFavorite({
        name: "First",
        sql: "SELECT 1",
        category: "Uncategorized",
      });
      store.addFavorite({
        name: "Second",
        sql: "SELECT 2",
        category: "Uncategorized",
      });

      const { favorites } = useFavoritesStore.getState();
      expect(favorites[0].name).toBe("Second");
      expect(favorites[1].name).toBe("First");
    });
  });

  describe("updateFavorite", () => {
    it("updates favorite fields", () => {
      const store = useFavoritesStore.getState();
      store.addFavorite({
        name: "Old Name",
        sql: "SELECT 1",
        category: "Uncategorized",
      });

      const fav = useFavoritesStore.getState().favorites[0];
      store.updateFavorite(fav.id, { name: "New Name", sql: "SELECT 2" });

      const updated = useFavoritesStore.getState().favorites[0];
      expect(updated.name).toBe("New Name");
      expect(updated.sql).toBe("SELECT 2");
    });

    it("does not update non-matching favorites", () => {
      const store = useFavoritesStore.getState();
      store.addFavorite({
        name: "First",
        sql: "SELECT 1",
        category: "Uncategorized",
      });
      store.addFavorite({
        name: "Second",
        sql: "SELECT 2",
        category: "Uncategorized",
      });

      const favs = useFavoritesStore.getState().favorites;
      // favorites are added to beginning, so Second is at index 0, First at index 1
      store.updateFavorite(favs[0].id, { name: "Updated" });

      const updated = useFavoritesStore.getState().favorites;
      expect(updated[0].name).toBe("Updated");
      expect(updated[1].name).toBe("First"); // First should remain unchanged
    });
  });

  describe("deleteFavorite", () => {
    it("removes a favorite", () => {
      const store = useFavoritesStore.getState();
      store.addFavorite({
        name: "Query 1",
        sql: "SELECT 1",
        category: "Uncategorized",
      });
      store.addFavorite({
        name: "Query 2",
        sql: "SELECT 2",
        category: "Uncategorized",
      });

      const fav = useFavoritesStore.getState().favorites[0];
      store.deleteFavorite(fav.id);

      const { favorites } = useFavoritesStore.getState();
      expect(favorites).toHaveLength(1);
      expect(favorites[0].id).not.toBe(fav.id);
    });
  });

  describe("renameFavorite", () => {
    it("renames a favorite", () => {
      const store = useFavoritesStore.getState();
      store.addFavorite({
        name: "Old Name",
        sql: "SELECT 1",
        category: "Uncategorized",
      });

      const fav = useFavoritesStore.getState().favorites[0];
      store.renameFavorite(fav.id, "New Name");

      const updated = useFavoritesStore.getState().favorites[0];
      expect(updated.name).toBe("New Name");
    });
  });

  describe("moveToCategory", () => {
    it("moves favorite to new category", () => {
      const store = useFavoritesStore.getState();
      store.addFavorite({
        name: "Query",
        sql: "SELECT 1",
        category: "Uncategorized",
      });

      const fav = useFavoritesStore.getState().favorites[0];
      store.moveToCategory(fav.id, "New Category");

      const updated = useFavoritesStore.getState().favorites[0];
      expect(updated.category).toBe("New Category");
    });

    it("creates category if it doesn't exist", () => {
      const store = useFavoritesStore.getState();
      store.addFavorite({
        name: "Query",
        sql: "SELECT 1",
        category: "Uncategorized",
      });

      const fav = useFavoritesStore.getState().favorites[0];
      store.moveToCategory(fav.id, "Brand New");

      const { categories } = useFavoritesStore.getState();
      expect(categories).toContain("Brand New");
    });
  });

  describe("addCategory", () => {
    it("adds a new category", () => {
      const store = useFavoritesStore.getState();
      store.addCategory("New Category");

      const { categories } = useFavoritesStore.getState();
      expect(categories).toContain("New Category");
    });

    it("does not duplicate existing category", () => {
      const store = useFavoritesStore.getState();
      store.addCategory("Uncategorized");

      const { categories } = useFavoritesStore.getState();
      expect(categories.filter((c) => c === "Uncategorized")).toHaveLength(1);
    });
  });

  describe("deleteCategory", () => {
    it("removes a category", () => {
      const store = useFavoritesStore.getState();
      store.addCategory("To Delete");
      store.deleteCategory("To Delete");

      const { categories } = useFavoritesStore.getState();
      expect(categories).not.toContain("To Delete");
    });

    it("moves favorites to Uncategorized when category deleted", () => {
      const store = useFavoritesStore.getState();
      store.addFavorite({
        name: "Query",
        sql: "SELECT 1",
        category: "To Delete",
      });

      store.deleteCategory("To Delete");

      const { favorites } = useFavoritesStore.getState();
      expect(favorites[0].category).toBe("Uncategorized");
    });
  });

  describe("getByCategory", () => {
    it("returns favorites in category", () => {
      const store = useFavoritesStore.getState();
      store.addFavorite({
        name: "Query 1",
        sql: "SELECT 1",
        category: "Category A",
      });
      store.addFavorite({
        name: "Query 2",
        sql: "SELECT 2",
        category: "Category B",
      });

      const result = store.getByCategory("Category A");
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Query 1");
    });

    it("returns empty array for empty category", () => {
      const result = useFavoritesStore.getState().getByCategory("Empty");
      expect(result).toHaveLength(0);
    });
  });

  describe("searchFavorites", () => {
    it("searches by name", () => {
      const store = useFavoritesStore.getState();
      store.addFavorite({
        name: "User Query",
        sql: "SELECT 1",
        category: "Uncategorized",
      });

      const result = store.searchFavorites("user");
      expect(result).toHaveLength(1);
    });

    it("searches by sql", () => {
      const store = useFavoritesStore.getState();
      store.addFavorite({
        name: "Query",
        sql: "SELECT * FROM users",
        category: "Uncategorized",
      });

      const result = store.searchFavorites("users");
      expect(result).toHaveLength(1);
    });

    it("searches by description", () => {
      const store = useFavoritesStore.getState();
      store.addFavorite({
        name: "Query",
        sql: "SELECT 1",
        category: "Uncategorized",
        description: "Get all users",
      });

      const result = store.searchFavorites("all");
      expect(result).toHaveLength(1);
    });

    it("is case insensitive", () => {
      const store = useFavoritesStore.getState();
      store.addFavorite({
        name: "User Query",
        sql: "SELECT 1",
        category: "Uncategorized",
      });

      const result = store.searchFavorites("USER");
      expect(result).toHaveLength(1);
    });

    it("returns empty array for no matches", () => {
      const result = useFavoritesStore.getState().searchFavorites("xyz");
      expect(result).toHaveLength(0);
    });
  });
});
