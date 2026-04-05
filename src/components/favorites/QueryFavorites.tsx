import { useState, useMemo } from "react";
import {
  Search,
  ChevronRight,
  ChevronDown,
  FolderPlus,
  Star,
  Trash2,
  Pencil,
  FolderInput,
  FileText,
  Database,
} from "lucide-react";
import {
  useFavoritesStore,
  type Favorite,
} from "../../stores/favoritesStore";
import { useEditorStore } from "../../stores/editorStore";
import { useContextMenu } from "../../hooks/useContextMenu";

export function QueryFavorites() {
  const favorites = useFavoritesStore((s) => s.favorites);
  const categories = useFavoritesStore((s) => s.categories);
  const deleteFavorite = useFavoritesStore((s) => s.deleteFavorite);
  const renameFavorite = useFavoritesStore((s) => s.renameFavorite);
  const moveToCategory = useFavoritesStore((s) => s.moveToCategory);
  const updateFavorite = useFavoritesStore((s) => s.updateFavorite);
  const addCategory = useFavoritesStore((s) => s.addCategory);
  const deleteCategory = useFavoritesStore((s) => s.deleteCategory);

  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    Uncategorized: true,
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editDescId, setEditDescId] = useState<string | null>(null);
  const [editDescValue, setEditDescValue] = useState("");
  const [showNewCategory, setShowNewCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");

  const { contextMenu, showContextMenu } = useContextMenu();

  const filtered = useMemo(() => {
    if (!search.trim()) return favorites;
    const q = search.toLowerCase();
    return favorites.filter(
      (f) =>
        f.name.toLowerCase().includes(q) ||
        f.sql.toLowerCase().includes(q) ||
        (f.description?.toLowerCase().includes(q) ?? false),
    );
  }, [favorites, search]);

  const groupedByCategory = useMemo(() => {
    const groups: Record<string, Favorite[]> = {};
    for (const cat of categories) {
      groups[cat] = [];
    }
    for (const fav of filtered) {
      if (!groups[fav.category]) {
        groups[fav.category] = [];
      }
      groups[fav.category].push(fav);
    }
    return groups;
  }, [filtered, categories]);

  const handleClick = (fav: Favorite) => {
    const store = useEditorStore.getState();
    const activeTab = store.tabs.find((t) => t.id === store.activeTabId);
    if (activeTab && activeTab.type === "query") {
      store.updateTabContent(activeTab.id, fav.sql);
    } else {
      const tabId = store.addTab();
      store.updateTabContent(tabId, fav.sql);
    }
  };

  const handleDoubleClick = (fav: Favorite) => {
    const store = useEditorStore.getState();
    const tabId = store.addTab();
    store.updateTabContent(tabId, fav.sql);
  };

  const handleAddCategory = () => {
    if (newCategoryName.trim()) {
      addCategory(newCategoryName.trim());
      setExpanded((prev) => ({ ...prev, [newCategoryName.trim()]: true }));
      setNewCategoryName("");
    }
    setShowNewCategory(false);
  };

  const handleRenameStart = (fav: Favorite) => {
    setEditingId(fav.id);
    setEditValue(fav.name);
  };

  const handleRenameConfirm = () => {
    if (editingId && editValue.trim()) {
      renameFavorite(editingId, editValue.trim());
    }
    setEditingId(null);
    setEditValue("");
  };

  const handleEditDescStart = (fav: Favorite) => {
    setEditDescId(fav.id);
    setEditDescValue(fav.description ?? "");
  };

  const handleEditDescConfirm = () => {
    if (editDescId) {
      updateFavorite(editDescId, {
        description: editDescValue.trim() || undefined,
      });
    }
    setEditDescId(null);
    setEditDescValue("");
  };

  const toggleCategory = (cat: string) => {
    setExpanded((prev) => ({ ...prev, [cat]: !prev[cat] }));
  };

  const catOrder = categories.filter(
    (c) => groupedByCategory[c]?.length > 0 || !search.trim(),
  );

  return (
    <div className="flex h-full flex-col">
      {/* Search + New Category */}
      <div className="flex items-center gap-1 border-b border-[var(--color-border)] px-2 py-1.5">
        <div className="relative flex-1">
          <Search className="absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-[var(--color-text-muted)]" />
          <input
            type="text"
            placeholder="Search favorites..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded bg-[var(--color-bg-primary)] py-1 pl-6 pr-2 text-[11px] text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none ring-1 ring-[var(--color-border)] focus:ring-brand-500"
          />
        </div>
        <button
          onClick={() => setShowNewCategory(true)}
          className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
          title="New Category"
        >
          <FolderPlus className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* New Category Input */}
      {showNewCategory && (
        <div className="flex items-center gap-1 border-b border-[var(--color-border)] px-2 py-1.5">
          <input
            type="text"
            placeholder="Category name..."
            value={newCategoryName}
            onChange={(e) => setNewCategoryName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAddCategory();
              if (e.key === "Escape") {
                setShowNewCategory(false);
                setNewCategoryName("");
              }
            }}
            autoFocus
            className="flex-1 rounded bg-[var(--color-bg-primary)] px-2 py-1 text-[11px] text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none ring-1 ring-[var(--color-border)] focus:ring-brand-500"
          />
          <button
            onClick={handleAddCategory}
            className="rounded px-2 py-0.5 text-[11px] text-brand-400 hover:text-brand-300"
          >
            Add
          </button>
          <button
            onClick={() => {
              setShowNewCategory(false);
              setNewCategoryName("");
            }}
            className="rounded px-1 py-0.5 text-[11px] text-[var(--color-text-muted)]"
          >
            ✕
          </button>
        </div>
      )}

      {/* Favorites List */}
      <div className="flex-1 overflow-y-auto">
        {favorites.length === 0 ? (
          <p className="p-3 text-center text-[11px] text-[var(--color-text-muted)]">
            No favorites yet. Use ⭐ to save queries.
          </p>
        ) : filtered.length === 0 ? (
          <p className="p-3 text-center text-[11px] text-[var(--color-text-muted)]">
            No matches
          </p>
        ) : (
          catOrder.map((cat) => {
            const items = groupedByCategory[cat] ?? [];
            return (
              <div key={cat}>
                <button
                  onClick={() => toggleCategory(cat)}
                  onContextMenu={(e) => {
                    if (cat !== "Uncategorized") {
                      showContextMenu(e, [
                        {
                          label: "Delete Category",
                          icon: <Trash2 className="h-3.5 w-3.5" />,
                          danger: true,
                          onClick: () => deleteCategory(cat),
                        },
                      ]);
                    }
                  }}
                  className="flex w-full items-center gap-1 px-2 py-1 text-[11px] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]"
                >
                  {expanded[cat] ? (
                    <ChevronDown className="h-3 w-3 shrink-0" />
                  ) : (
                    <ChevronRight className="h-3 w-3 shrink-0" />
                  )}
                  <span className="truncate">{cat}</span>
                  <span className="ml-auto text-[10px] text-[var(--color-text-muted)]">
                    {items.length}
                  </span>
                </button>
                {expanded[cat] && (
                  <div className="ml-1">
                    {items.map((fav) => (
                      <div
                        key={fav.id}
                        onClick={() => handleClick(fav)}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          handleDoubleClick(fav);
                        }}
                        onContextMenu={(e) => {
                          const otherCategories = categories.filter(
                            (c) => c !== fav.category,
                          );
                          showContextMenu(e, [
                            {
                              label: "Open in New Tab",
                              icon: <FileText className="h-3.5 w-3.5" />,
                              onClick: () => handleDoubleClick(fav),
                            },
                            {
                              label: "Rename",
                              icon: <Pencil className="h-3.5 w-3.5" />,
                              onClick: () => handleRenameStart(fav),
                            },
                            {
                              label: "Edit Description",
                              icon: <Pencil className="h-3.5 w-3.5" />,
                              onClick: () => handleEditDescStart(fav),
                            },
                            ...(otherCategories.length > 0
                              ? [
                                  {
                                    label: "",
                                    separator: true as const,
                                    onClick: () => {},
                                  },
                                  ...otherCategories.map((c) => ({
                                    label: `Move to "${c}"`,
                                    icon: (
                                      <FolderInput className="h-3.5 w-3.5" />
                                    ),
                                    onClick: () => moveToCategory(fav.id, c),
                                  })),
                                ]
                              : []),
                            {
                              label: "",
                              separator: true as const,
                              onClick: () => {},
                            },
                            {
                              label: "Delete",
                              icon: <Trash2 className="h-3.5 w-3.5" />,
                              danger: true,
                              onClick: () => deleteFavorite(fav.id),
                            },
                          ]);
                        }}
                        className="group cursor-pointer rounded px-2 py-1.5 hover:bg-[var(--color-bg-tertiary)]"
                      >
                        {editingId === fav.id ? (
                          <input
                            type="text"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={handleRenameConfirm}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") handleRenameConfirm();
                              if (e.key === "Escape") {
                                setEditingId(null);
                                setEditValue("");
                              }
                            }}
                            autoFocus
                            onClick={(e) => e.stopPropagation()}
                            className="w-full rounded bg-[var(--color-bg-primary)] px-1 py-0.5 text-[11px] text-[var(--color-text-primary)] outline-none ring-1 ring-brand-500"
                          />
                        ) : (
                          <>
                            <div className="flex items-center gap-1.5">
                              <Star className="h-3 w-3 shrink-0 text-yellow-400/70" />
                              <span className="truncate text-[11px] text-[var(--color-text-primary)]">
                                {fav.name}
                              </span>
                            </div>
                            {editDescId === fav.id ? (
                              <input
                                type="text"
                                value={editDescValue}
                                onChange={(e) =>
                                  setEditDescValue(e.target.value)
                                }
                                onBlur={handleEditDescConfirm}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter")
                                    handleEditDescConfirm();
                                  if (e.key === "Escape") {
                                    setEditDescId(null);
                                    setEditDescValue("");
                                  }
                                }}
                                autoFocus
                                onClick={(e) => e.stopPropagation()}
                                placeholder="Add description..."
                                className="mt-0.5 w-full rounded bg-[var(--color-bg-primary)] px-1 py-0.5 text-[10px] text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none ring-1 ring-brand-500"
                              />
                            ) : (
                              fav.description && (
                                <p className="mt-0.5 truncate pl-[18px] text-[10px] text-[var(--color-text-muted)]">
                                  {fav.description}
                                </p>
                              )
                            )}
                            <pre className="mt-0.5 line-clamp-1 whitespace-pre-wrap break-all pl-[18px] font-mono text-[10px] leading-tight text-[var(--color-text-muted)]">
                              {fav.sql}
                            </pre>
                            {fav.connectionName && (
                              <div className="mt-0.5 flex items-center gap-1 pl-[18px]">
                                <Database className="h-2.5 w-2.5 text-[var(--color-text-muted)]" />
                                <span className="text-[10px] text-[var(--color-text-muted)]">
                                  {fav.connectionName}
                                </span>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
      {contextMenu}
    </div>
  );
}
