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

interface FavoritesState {
  favorites: Favorite[];
  categories: string[];

  addFavorite: (fav: Omit<Favorite, "id" | "createdAt" | "updatedAt">) => void;
  updateFavorite: (id: string, updates: Partial<Pick<Favorite, "name" | "sql" | "description" | "category">>) => void;
  deleteFavorite: (id: string) => void;
  renameFavorite: (id: string, name: string) => void;
  moveToCategory: (id: string, category: string) => void;
  addCategory: (name: string) => void;
  deleteCategory: (name: string) => void;

  getByCategory: (category: string) => Favorite[];
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
      },

      updateFavorite: (id, updates) =>
        set((state) => ({
          favorites: state.favorites.map((f) =>
            f.id === id
              ? { ...f, ...updates, updatedAt: new Date().toISOString() }
              : f
          ),
        })),

      deleteFavorite: (id) =>
        set((state) => ({
          favorites: state.favorites.filter((f) => f.id !== id),
        })),

      renameFavorite: (id, name) =>
        set((state) => ({
          favorites: state.favorites.map((f) =>
            f.id === id
              ? { ...f, name, updatedAt: new Date().toISOString() }
              : f
          ),
        })),

      moveToCategory: (id, category) =>
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
        }),

      addCategory: (name) =>
        set((state) => ({
          categories: state.categories.includes(name)
            ? state.categories
            : [...state.categories, name],
        })),

      deleteCategory: (name) =>
        set((state) => ({
          categories: state.categories.filter((c) => c !== name),
          favorites: state.favorites.map((f) => f.category === name ? { ...f, category: "Uncategorized" } : f),
        })),

      getByCategory: (category) => get().favorites.filter((f) => f.category === category),

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
