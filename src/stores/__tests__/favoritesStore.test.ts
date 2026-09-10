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
  describe("duplicate names", () => {
    const base = { sql: "SELECT 1", category: "Uncategorized" };

    it("refuses a second favorite with the same name in the same category", () => {
      const store = useFavoritesStore.getState();
      const first = store.addFavorite({ ...base, name: "Active users" });
      const second = store.addFavorite({ ...base, name: "Active users", sql: "SELECT 2" });

      expect(second).toEqual({
        ok: false,
        reason: "duplicate",
        existingId: first.ok ? first.id : "",
      });
      expect(useFavoritesStore.getState().favorites).toHaveLength(1);
    });

    it("leaves the existing favorite untouched when it refuses", () => {
      const store = useFavoritesStore.getState();
      store.addFavorite({ ...base, name: "Active users" });
      store.addFavorite({ ...base, name: "Active users", sql: "DROP TABLE users" });

      const [only] = useFavoritesStore.getState().favorites;
      expect(only.sql).toBe("SELECT 1");
    });

    it("ignores case and surrounding whitespace", () => {
      const store = useFavoritesStore.getState();
      store.addFavorite({ ...base, name: "Active users" });

      expect(store.addFavorite({ ...base, name: "  ACTIVE USERS  " }).ok).toBe(false);
    });

    it("allows the same name in a different category", () => {
      const store = useFavoritesStore.getState();
      store.addFavorite({ ...base, name: "Active users" });

      expect(store.addFavorite({ ...base, name: "Active users", category: "Reports" }).ok).toBe(
        true,
      );
      expect(useFavoritesStore.getState().favorites).toHaveLength(2);
    });

    it("refuses a rename onto a sibling's name and keeps the old one", () => {
      const store = useFavoritesStore.getState();
      store.addFavorite({ ...base, name: "Taken" });
      const mine = store.addFavorite({ ...base, name: "Mine" });
      const id = mine.ok ? mine.id : "";

      expect(store.renameFavorite(id, "Taken").ok).toBe(false);
      expect(useFavoritesStore.getState().favorites.find((f) => f.id === id)?.name).toBe("Mine");
    });

    it("does not treat a favorite as its own duplicate", () => {
      const store = useFavoritesStore.getState();
      const mine = store.addFavorite({ ...base, name: "Mine" });
      const id = mine.ok ? mine.id : "";

      expect(store.renameFavorite(id, "MINE").ok).toBe(true);
      expect(useFavoritesStore.getState().favorites[0].name).toBe("MINE");
    });

    it("refuses a move into a category that already holds the name", () => {
      const store = useFavoritesStore.getState();
      store.addFavorite({ ...base, name: "Shared", category: "Reports" });
      const mine = store.addFavorite({ ...base, name: "Shared" });
      const id = mine.ok ? mine.id : "";

      expect(store.moveToCategory(id, "Reports").ok).toBe(false);
      expect(useFavoritesStore.getState().favorites.find((f) => f.id === id)?.category).toBe(
        "Uncategorized",
      );
    });

    it("refuses an update whose name and category together collide", () => {
      const store = useFavoritesStore.getState();
      store.addFavorite({ ...base, name: "Shared", category: "Reports" });
      const mine = store.addFavorite({ ...base, name: "Mine" });
      const id = mine.ok ? mine.id : "";

      expect(store.updateFavorite(id, { name: "Shared", category: "Reports" }).ok).toBe(false);
    });

    it("suffixes rather than collides when a deleted category is swept up", () => {
      const store = useFavoritesStore.getState();
      store.addFavorite({ ...base, name: "Shared" });
      store.addFavorite({ ...base, name: "Shared", category: "Reports" });

      store.deleteCategory("Reports");

      const names = useFavoritesStore.getState().favorites.map((f) => f.name).sort();
      expect(names).toEqual(["Shared", "Shared (2)"]);
      expect(useFavoritesStore.getState().favorites.every((f) => f.category === "Uncategorized"))
        .toBe(true);
    });
  });

  describe("credential redaction (#339)", () => {
    const base = { category: "Uncategorized", name: "Reset a password" };

    it("never stores the password from a saved statement", () => {
      const store = useFavoritesStore.getState();
      store.addFavorite({ ...base, sql: "CREATE USER 'a'@'%' IDENTIFIED BY 's3cret'" });

      const [stored] = useFavoritesStore.getState().favorites;
      expect(stored.sql).not.toContain("s3cret");
      expect(stored.redacted).toBe(true);
      expect(localStorage.getItem("mas-query-favorites")).not.toContain("s3cret");
    });

    it("catches a credential introduced by an edit", () => {
      const store = useFavoritesStore.getState();
      const added = store.addFavorite({ ...base, sql: "SELECT 1" });
      const id = added.ok ? added.id : "";

      store.updateFavorite(id, { sql: "ALTER USER 'a'@'%' IDENTIFIED BY 'later'" });

      const [stored] = useFavoritesStore.getState().favorites;
      expect(stored.sql).not.toContain("later");
      expect(stored.redacted).toBe(true);
    });

    it("leaves an ordinary query alone, values and all", () => {
      // A favorite exists to be run again. Blanking its values would leave a
      // broken query rather than a saved one.
      const store = useFavoritesStore.getState();
      const sql = "SELECT * FROM users WHERE email = 'alice@example.com' AND id = 42";
      store.addFavorite({ ...base, sql });

      const [stored] = useFavoritesStore.getState().favorites;
      expect(stored.sql).toBe(sql);
      expect(stored.redacted).toBeUndefined();
    });

    it("does not mark an edit that introduced nothing", () => {
      const store = useFavoritesStore.getState();
      const added = store.addFavorite({ ...base, sql: "SELECT 1" });
      const id = added.ok ? added.id : "";

      store.updateFavorite(id, { sql: "SELECT 2" });

      expect(useFavoritesStore.getState().favorites[0].redacted).toBeUndefined();
    });

    it("does not touch an edit that leaves the SQL alone", () => {
      const store = useFavoritesStore.getState();
      const added = store.addFavorite({ ...base, sql: "SELECT 'kept'" });
      const id = added.ok ? added.id : "";

      store.updateFavorite(id, { description: "just a note" });

      expect(useFavoritesStore.getState().favorites[0].sql).toBe("SELECT 'kept'");
    });
  });

  describe("export and import (#335)", () => {
    const base = { category: "Uncategorized", sql: "SELECT 1" };

    /** A file this build would write. */
    function exportOf(favorites: unknown[], categories: string[] = ["Uncategorized"]) {
      return JSON.stringify({
        kind: "sqlpilot-favorites",
        version: 1,
        exportedAt: "2026-01-01T00:00:00Z",
        categories,
        favorites,
      });
    }

    it("exports what is there, in a shape it can read back", () => {
      const store = useFavoritesStore.getState();
      store.addFavorite({ ...base, name: "Active users" });

      const parsed = JSON.parse(store.exportFavorites());

      expect(parsed.kind).toBe("sqlpilot-favorites");
      expect(parsed.version).toBe(1);
      expect(parsed.favorites).toHaveLength(1);
      expect(parsed.favorites[0].name).toBe("Active users");
    });

    it("round-trips through an empty store", () => {
      const store = useFavoritesStore.getState();
      store.addFavorite({ ...base, name: "Active users", description: "who is on" });
      const file = store.exportFavorites();

      store.deleteFavorite(useFavoritesStore.getState().favorites[0].id);
      const result = store.importFavorites(file);

      expect(result.imported).toBe(1);
      const [restored] = useFavoritesStore.getState().favorites;
      expect(restored.name).toBe("Active users");
      expect(restored.description).toBe("who is on");
    });

    it("merges rather than replacing", () => {
      const store = useFavoritesStore.getState();
      store.addFavorite({ ...base, name: "Mine" });

      store.importFavorites(exportOf([{ name: "Theirs", sql: "SELECT 2", category: "Uncategorized" }]));

      const names = useFavoritesStore.getState().favorites.map((f) => f.name).sort();
      expect(names).toEqual(["Mine", "Theirs"]);
    });

    it("importing the same file twice imports nothing the second time", () => {
      const store = useFavoritesStore.getState();
      const file = exportOf([{ name: "Active users", sql: "SELECT 1", category: "Uncategorized" }]);

      expect(store.importFavorites(file).imported).toBe(1);
      const second = store.importFavorites(file);

      expect(second.imported).toBe(0);
      expect(second.skipped).toBe(1);
      expect(useFavoritesStore.getState().favorites).toHaveLength(1);
    });

    it("gives an imported favorite a fresh id", () => {
      // Ids are per-install counters, so a file from someone else's machine
      // could collide with a local one.
      const store = useFavoritesStore.getState();
      store.importFavorites(
        exportOf([{ id: "fav-1-1", name: "Theirs", sql: "SELECT 1", category: "Uncategorized" }]),
      );

      expect(useFavoritesStore.getState().favorites[0].id).not.toBe("fav-1-1");
    });

    it("brings across categories that hold nothing yet", () => {
      const store = useFavoritesStore.getState();
      store.importFavorites(exportOf([], ["Uncategorized", "Reports"]));

      expect(useFavoritesStore.getState().categories).toContain("Reports");
    });

    it("creates a category an imported favorite needs", () => {
      const store = useFavoritesStore.getState();
      store.importFavorites(exportOf([{ name: "Daily", sql: "SELECT 1", category: "Reports" }]));

      expect(useFavoritesStore.getState().categories).toContain("Reports");
    });

    it("strips a credential from an export written before #339", () => {
      const store = useFavoritesStore.getState();
      store.importFavorites(
        exportOf([{
          name: "Reset",
          sql: "CREATE USER 'a'@'%' IDENTIFIED BY 's3cret'",
          category: "Uncategorized",
        }]),
      );

      const [imported] = useFavoritesStore.getState().favorites;
      expect(imported.sql).not.toContain("s3cret");
      expect(imported.redacted).toBe(true);
    });

    it("counts entries it could not read rather than dropping them silently", () => {
      const store = useFavoritesStore.getState();
      const result = store.importFavorites(
        exportOf([
          { name: "Good", sql: "SELECT 1", category: "Uncategorized" },
          { name: "", sql: "SELECT 2" },
          { name: "No SQL" },
        ]),
      );

      expect(result).toMatchObject({ imported: 1, invalid: 2 });
    });

    it("defaults a missing category rather than refusing the favorite", () => {
      const store = useFavoritesStore.getState();
      store.importFavorites(exportOf([{ name: "Loose", sql: "SELECT 1" }]));

      expect(useFavoritesStore.getState().favorites[0].category).toBe("Uncategorized");
    });

    it("refuses something that is not JSON", () => {
      const result = useFavoritesStore.getState().importFavorites("{ not json");
      expect(result.error).toContain("not JSON");
      expect(result.imported).toBe(0);
    });

    it("refuses JSON that is not a favorites export", () => {
      // Someone will pick the wrong file. Saying so beats importing nothing
      // and reporting success.
      const result = useFavoritesStore.getState().importFavorites(
        JSON.stringify({ some: "other file" }),
      );

      expect(result.error).toContain("not a SQLPilot favorites export");
    });

    it("changes nothing when the file is refused", () => {
      const store = useFavoritesStore.getState();
      store.addFavorite({ ...base, name: "Mine" });

      store.importFavorites("{ not json");

      expect(useFavoritesStore.getState().favorites).toHaveLength(1);
    });
  });
});
