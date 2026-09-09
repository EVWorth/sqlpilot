import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface Favorite {
  id: string;
  name: string;
  sql: string;
  category: string;
  description?: string;
  connectionName?: string;
  database?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * The outcome of an action that writes a name.
 *
 * Names are the only handle the user has on a favorite — the sidebar shows
 * nothing else at a glance — so two favorites sharing one inside a category
 * left them picking between identical rows to find the one to delete (#332).
 * The store refuses rather than the dialog, because every path in reaches it
 * and only some of them go through a dialog.
 */
export type FavoriteWriteResult =
  | { ok: true; id: string }
  | { ok: false; reason: "duplicate"; existingId: string };

/**
 * The favorite that would collide with `name` in `category`, if any.
 *
 * Case- and whitespace-insensitive: "Users" beside "users " is a distinction
 * the sidebar cannot show, so it is one the store will not create. `exceptId`
 * excludes the row being edited, so renaming a favorite to the case it
 * already has is not a collision with itself.
 */
function findDuplicate(
  favorites: Favorite[],
  name: string,
  category: string,
  exceptId?: string,
): Favorite | undefined {
  const key = name.trim().toLowerCase();
  return favorites.find(
    (f) => f.id !== exceptId && f.category === category && f.name.trim().toLowerCase() === key,
  );
}

interface FavoritesState {
  favorites: Favorite[];
  categories: string[];

  addFavorite: (fav: Omit<Favorite, "id" | "createdAt" | "updatedAt">) => FavoriteWriteResult;
  updateFavorite: (
    id: string,
    updates: Partial<Pick<Favorite, "name" | "sql" | "description" | "category">>,
  ) => FavoriteWriteResult;
  deleteFavorite: (id: string) => void;
  renameFavorite: (id: string, name: string) => FavoriteWriteResult;
  moveToCategory: (id: string, category: string) => FavoriteWriteResult;
  addCategory: (name: string) => void;
  deleteCategory: (name: string) => void;

  getByCategory: (category: string) => Favorite[];
  findDuplicate: (name: string, category: string, exceptId?: string) => Favorite | undefined;
  searchFavorites: (query: string) => Favorite[];
}

let idCounter = 0;

function generateId(): string {
  idCounter++;
  return `fav-${Date.now()}-${idCounter}`;
}

export const useFavoritesStore = create<FavoritesState>()(
  persist(
    (set, get) => ({
      favorites: [],
      categories: ["Uncategorized"],

      addFavorite: (fav) => {
        const clash = findDuplicate(get().favorites, fav.name, fav.category);
        if (clash) return { ok: false, reason: "duplicate", existingId: clash.id };

        const now = new Date().toISOString();
        const newFav: Favorite = {
          ...fav,
          id: generateId(),
          createdAt: now,
          updatedAt: now,
        };
        set((state) => {
          const cats = state.categories.includes(fav.category)
            ? state.categories
            : [...state.categories, fav.category];
          return {
            favorites: [newFav, ...state.favorites],
            categories: cats,
          };
        });
        return { ok: true, id: newFav.id };
      },

      updateFavorite: (id, updates) => {
        const existing = get().favorites.find((f) => f.id === id);
        if (!existing) return { ok: true, id };

        // Either half of the pair that has to be unique can move here, so the
        // check reads both from the merged row rather than from `updates`.
        const name = updates.name ?? existing.name;
        const category = updates.category ?? existing.category;
        const clash = findDuplicate(get().favorites, name, category, id);
        if (clash) return { ok: false, reason: "duplicate", existingId: clash.id };

        set((state) => ({
          favorites: state.favorites.map((f) =>
            f.id === id
              ? { ...f, ...updates, updatedAt: new Date().toISOString() }
              : f
          ),
        }));
        return { ok: true, id };
      },

      deleteFavorite: (id) =>
        set((state) => ({
          favorites: state.favorites.filter((f) => f.id !== id),
        })),

      renameFavorite: (id, name) => {
        const existing = get().favorites.find((f) => f.id === id);
        if (!existing) return { ok: true, id };

        const clash = findDuplicate(get().favorites, name, existing.category, id);
        if (clash) return { ok: false, reason: "duplicate", existingId: clash.id };

        set((state) => ({
          favorites: state.favorites.map((f) =>
            f.id === id
              ? { ...f, name, updatedAt: new Date().toISOString() }
              : f
          ),
        }));
        return { ok: true, id };
      },

      moveToCategory: (id, category) => {
        const existing = get().favorites.find((f) => f.id === id);
        if (!existing) return { ok: true, id };

        // A move can collide too: the destination may already hold the name.
        const clash = findDuplicate(get().favorites, existing.name, category, id);
        if (clash) return { ok: false, reason: "duplicate", existingId: clash.id };

        set((state) => {
          const cats = state.categories.includes(category)
            ? state.categories
            : [...state.categories, category];
          return {
            favorites: state.favorites.map((f) =>
              f.id === id
                ? { ...f, category, updatedAt: new Date().toISOString() }
                : f
            ),
            categories: cats,
          };
        });
        return { ok: true, id };
      },

      addCategory: (name) =>
        set((state) => ({
          categories: state.categories.includes(name)
            ? state.categories
            : [...state.categories, name],
        })),

      // Deleting a category sweeps its favorites into Uncategorized, which can
      // land two identical names there — the state the rest of the store
      // refuses to create. The moved one is suffixed rather than dropped or
      // silently merged: the user asked to delete a category, not a query.
      deleteCategory: (name) =>
        set((state) => {
          const kept = state.favorites.filter((f) => f.category !== name);
          const moved = state.favorites
            .filter((f) => f.category === name)
            .map((f) => {
              let candidate = f.name;
              for (let n = 2; findDuplicate(kept, candidate, "Uncategorized"); n++) {
                candidate = `${f.name} (${n})`;
              }
              const renamed = { ...f, name: candidate, category: "Uncategorized" };
              kept.push(renamed);
              return renamed;
            });

          // Rebuild in the original order rather than kept-then-moved, so the
          // list does not reshuffle around the user as a side effect.
          const byId = new Map(moved.map((f) => [f.id, f]));
          return {
            categories: state.categories.filter((c) => c !== name),
            favorites: state.favorites.map((f) => byId.get(f.id) ?? f),
          };
        }),

      getByCategory: (category) => get().favorites.filter((f) => f.category === category),

      findDuplicate: (name, category, exceptId) => findDuplicate(get().favorites, name, category, exceptId),

      searchFavorites: (query) => {
        const q = query.toLowerCase();
        return get().favorites.filter(
          (f) =>
            f.name.toLowerCase().includes(q)
            || f.sql.toLowerCase().includes(q)
            || (f.description?.toLowerCase().includes(q) ?? false),
        );
      },
    }),
    { name: "mas-query-favorites" },
  ),
);
