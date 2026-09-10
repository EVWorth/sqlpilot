import {
  ChevronDown,
  ChevronRight,
  Database,
  Download,
  FileText,
  FolderInput,
  FolderPlus,
  Pencil,
  Search,
  Star,
  Trash2,
  Upload,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useContextMenu } from "../../hooks/useContextMenu";
import { useInlineEdit } from "../../hooks/useInlineEdit";
import {
  buildCategoryTree,
  isUnderCategory,
  normaliseCategoryPath,
  visibleCategoryRows,
} from "../../lib/category-tree";
import { api } from "../../lib/tauri-api";
import { useEditorStore } from "../../stores/editorStore";
import { type Favorite, useFavoritesStore } from "../../stores/favoritesStore";
import { ConfirmDialog } from "../common/ConfirmDialog";
import type { MenuItem } from "../common/ContextMenu";

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
  // Two inline editors, one hook each. Both had to get the same subtleties
  // right — Escape must not commit, a refused value keeps the editor open —
  // and both used to spell them out separately (#340).
  const rename = useInlineEdit();
  // Clearing a description is the only way to remove one, so an emptied
  // field is a value here rather than a cancel.
  const describe_ = useInlineEdit({ allowEmpty: true });
  const [showNewCategory, setShowNewCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [pendingFavorite, setPendingFavorite] = useState<Favorite | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ cat: string; count: number } | null>(
    null,
  );

  const { contextMenu, showContextMenu } = useContextMenu();
  const exportFavorites = useFavoritesStore((s) => s.exportFavorites);
  const importFavorites = useFavoritesStore((s) => s.importFavorites);
  /** What the last import or export did. Cleared on the next one. */
  const [notice, setNotice] = useState<string | null>(null);
  /** The folder a drag is currently over, for the drop highlight. */
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const filtered = useMemo(() => {
    if (!search.trim()) return favorites;
    const q = search.toLowerCase();
    return favorites.filter(
      (f) =>
        f.name.toLowerCase().includes(q)
        || f.sql.toLowerCase().includes(q)
        || (f.description?.toLowerCase().includes(q) ?? false),
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

  const openFavorite = (fav: Favorite) => {
    const store = useEditorStore.getState();
    const activeTab = store.tabs.find((t) => t.id === store.activeTabId);
    if (activeTab && activeTab.type === "query") {
      store.updateTabContent(activeTab.id, fav.sql);
    } else {
      const tabId = store.addTab();
      store.updateTabContent(tabId, fav.sql);
    }
  };

  const handleClick = (fav: Favorite) => {
    const store = useEditorStore.getState();
    const activeTab = store.tabs.find((t) => t.id === store.activeTabId);
    if (activeTab?.type === "query" && activeTab.isDirty) {
      setPendingFavorite(fav);
      setShowConfirm(true);
      return;
    }
    openFavorite(fav);
  };

  const handleConfirmReplace = () => {
    if (pendingFavorite) {
      openFavorite(pendingFavorite);
    }
    setPendingFavorite(null);
    setShowConfirm(false);
  };

  const handleCancelReplace = () => {
    setPendingFavorite(null);
    setShowConfirm(false);
  };

  const handleDoubleClick = (fav: Favorite) => {
    const store = useEditorStore.getState();
    const tabId = store.addTab();
    store.updateTabContent(tabId, fav.sql);
  };

  const handleAddCategory = () => {
    // "Reports/Daily" makes both folders — the separator is what people
    // already type when they mean nesting (#334).
    const path = normaliseCategoryPath(newCategoryName);
    if (path) {
      addCategory(path);
      // Open every folder on the way down, or the new one is created out of
      // sight underneath a collapsed parent.
      setExpanded((prev) => {
        const next = { ...prev };
        const segments = path.split("/");
        for (let i = 1; i <= segments.length; i++) {
          next[segments.slice(0, i).join("/")] = true;
        }
        return next;
      });
      setNewCategoryName("");
    }
    setShowNewCategory(false);
  };

  const handleExport = async () => {
    try {
      const path = await api.pickSaveFile("Export favorites", "sqlpilot-favorites.json", [[
        "JSON",
        ["json"],
      ]]);
      // A cancelled dialog is the user changing their mind, not a failure.
      if (!path) return;
      await api.writeFileContents(path, exportFavorites());
      setNotice(`Exported ${favorites.length} favorite(s).`);
    } catch (e) {
      setNotice(`Could not export: ${String(e)}`);
    }
  };

  const handleImport = async () => {
    try {
      const path = await api.pickFile("Import favorites", [["JSON", ["json"]]]);
      if (!path) return;
      const result = importFavorites(await api.readFileContents(path));

      if (result.error) {
        setNotice(result.error);
        return;
      }
      // Says what happened to everything in the file, not just the good half:
      // "imported 3" when the file held 40 is a report worth doubting.
      const parts = [`Imported ${result.imported}`];
      if (result.skipped > 0) parts.push(`${result.skipped} already here`);
      if (result.invalid > 0) parts.push(`${result.invalid} unreadable`);
      setNotice(`${parts.join(", ")}.`);
    } catch (e) {
      setNotice(`Could not import: ${String(e)}`);
    }
  };

  const handleRenameConfirm = () =>
    rename.confirm((id, value) => renameFavorite(id, value).ok ? null : "That name is already used in this category.");

  const handleEditDescConfirm = () =>
    describe_.confirm((id, value) => {
      // undefined rather than "", so an empty description is absent rather
      // than present-and-blank.
      updateFavorite(id, { description: value || undefined });
      return null;
    });

  const toggleCategory = (cat: string) => {
    setExpanded((prev) => ({ ...prev, [cat]: !prev[cat] }));
  };

  // Categories are paths, so the flat list renders as a tree (#334). A
  // search hides folders it found nothing in, at any depth.
  const categoryRows = useMemo(() => {
    const rows = visibleCategoryRows(
      buildCategoryTree(categories),
      (path) => expanded[path] ?? false,
    );
    if (!search.trim()) return rows;
    return rows.filter((row) =>
      categories.some((c) => isUnderCategory(c, row.path) && groupedByCategory[c]?.length > 0)
    );
  }, [categories, expanded, search, groupedByCategory]);

  /** Move a favorite into a category, reporting a refusal. */
  const dropFavoriteInto = (favoriteId: string, category: string) => {
    if (!moveToCategory(favoriteId, category).ok) {
      setNotice("A favorite with that name is already in that category.");
    }
  };

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
          onClick={() => void handleExport()}
          disabled={favorites.length === 0}
          className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] disabled:opacity-40 disabled:cursor-not-allowed"
          title="Export favorites"
        >
          <Download className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => void handleImport()}
          className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
          title="Import favorites"
        >
          <Upload className="h-3.5 w-3.5" />
        </button>
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
            placeholder="Category, or Parent/Child"
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

      {notice && (
        <p
          role="status"
          className="flex items-start gap-1 border-b border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-text-secondary)]"
        >
          <span className="flex-1">{notice}</span>
          <button
            onClick={() => setNotice(null)}
            aria-label="Dismiss"
            className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
          >
            ✕
          </button>
        </p>
      )}

      {/* Favorites List */}
      <div className="flex-1 overflow-y-auto">
        {favorites.length === 0
          ? (
            <p className="p-3 text-center text-[11px] text-[var(--color-text-muted)]">
              No favorites yet. Use ⭐ to save queries.
            </p>
          )
          : filtered.length === 0
          ? (
            <p className="p-3 text-center text-[11px] text-[var(--color-text-muted)]">
              No matches
            </p>
          )
          : (
            categoryRows.map((node) => {
              const cat = node.path;
              const items = groupedByCategory[cat] ?? [];
              return (
                <div key={cat}>
                  <button
                    // A favorite can be dropped onto a folder to move it, which
                    // is the other half of FR-9.2.2 (#334).
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const id = e.dataTransfer.getData("text/sqlpilot-favorite");
                      if (id) dropFavoriteInto(id, cat);
                      setDropTarget(null);
                    }}
                    onDragEnter={() => setDropTarget(cat)}
                    onDragLeave={() => setDropTarget((t) => t === cat ? null : t)}
                    onClick={() => toggleCategory(cat)}
                    onContextMenu={(e) => {
                      if (cat !== "Uncategorized") {
                        showContextMenu(e, [
                          {
                            label: "Delete Category",
                            icon: <Trash2 className="h-3.5 w-3.5" />,
                            danger: true,
                            onClick: () => {
                              const count = favorites.filter((f) => f.category === cat).length;
                              setPendingDelete({ cat, count });
                            },
                          },
                        ]);
                      }
                    }}
                    style={{ paddingLeft: `${0.5 + node.depth * 0.75}rem` }}
                    className={`flex w-full items-center gap-1 py-1 pr-2 text-[11px] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] ${
                      dropTarget === cat ? "bg-brand-600/20 ring-1 ring-brand-500" : ""
                    }`}
                  >
                    {expanded[cat]
                      ? <ChevronDown className="h-3 w-3 shrink-0" />
                      : <ChevronRight className="h-3 w-3 shrink-0" />}
                    {/* The leaf name: the parents are already the indentation. */}
                    <span className="truncate" title={cat}>{node.name}</span>
                    <span className="ml-auto text-[10px] text-[var(--color-text-muted)]">
                      {items.length}
                    </span>
                  </button>
                  {expanded[cat] && (
                    <div className="ml-1">
                      {items.map((fav) => (
                        <div
                          key={fav.id}
                          draggable={rename.editingId !== fav.id}
                          onDragStart={(e) => {
                            // A private type rather than text/plain: dragging a
                            // favorite onto anything else should do nothing.
                            e.dataTransfer.setData("text/sqlpilot-favorite", fav.id);
                            e.dataTransfer.effectAllowed = "move";
                          }}
                          // While this row is being renamed, a press anywhere
                          // else in it does nothing at all. Without this the
                          // press blurred the input (committing the rename)
                          // and the click that followed loaded the query, so
                          // one click the user read as "open it" also wrote a
                          // half-typed name (#333).
                          onMouseDownCapture={(e) => {
                            if (rename.editingId === fav.id || describe_.editingId === fav.id) {
                              e.preventDefault();
                              e.stopPropagation();
                            }
                          }}
                          onClick={() => {
                            if (rename.editingId === fav.id || describe_.editingId === fav.id) return;
                            handleClick(fav);
                          }}
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
                                onClick: () => rename.start(fav.id, fav.name),
                              },
                              {
                                label: "Edit Description",
                                icon: <Pencil className="h-3.5 w-3.5" />,
                                onClick: () => describe_.start(fav.id, fav.description ?? ""),
                              },
                              ...(otherCategories.length > 0
                                // Typed, or the spread widens `separator` to
                                // boolean and stops matching the union.
                                ? [
                                  { separator: true } as MenuItem,
                                  ...otherCategories.map((c) => ({
                                    label: `Move to "${c}"`,
                                    icon: <FolderInput className="h-3.5 w-3.5" />,
                                    onClick: () => moveToCategory(fav.id, c),
                                  })),
                                ]
                                : []),
                              { separator: true },
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
                          {rename.editingId === fav.id
                            ? (
                              <>
                                <input
                                  type="text"
                                  value={rename.value}
                                  onChange={(e) => rename.setValue(e.target.value)}
                                  onBlur={handleRenameConfirm}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") handleRenameConfirm();
                                    if (e.key === "Escape") rename.cancel();
                                  }}
                                  autoFocus
                                  onClick={(e) => e.stopPropagation()}
                                  aria-invalid={rename.error !== null || undefined}
                                  aria-label="Favorite name"
                                  className={`w-full rounded bg-[var(--color-bg-primary)] px-1 py-0.5 text-[11px] text-[var(--color-text-primary)] outline-none ring-1 ${
                                    rename.error ? "ring-red-500" : "ring-brand-500"
                                  }`}
                                />
                                {rename.error && (
                                  <p role="alert" className="mt-0.5 text-[10px] text-red-400">
                                    {rename.error}
                                  </p>
                                )}
                              </>
                            )
                            : (
                              <>
                                <div className="flex items-center gap-1.5">
                                  <Star className="h-3 w-3 shrink-0 text-yellow-400/70" />
                                  <span className="truncate text-[11px] text-[var(--color-text-primary)]">
                                    {fav.name}
                                  </span>
                                  {fav.redacted && (
                                    <span
                                      className="shrink-0 rounded bg-[var(--color-bg-tertiary)] px-1 text-[9px] uppercase tracking-wide"
                                      title="A password was removed before this was saved, so it will not run as written."
                                    >
                                      redacted
                                    </span>
                                  )}
                                </div>
                                {describe_.editingId === fav.id
                                  ? (
                                    <input
                                      type="text"
                                      value={describe_.value}
                                      onChange={(e) => describe_.setValue(e.target.value)}
                                      onBlur={handleEditDescConfirm}
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") {
                                          handleEditDescConfirm();
                                        }
                                        if (e.key === "Escape") describe_.cancel();
                                      }}
                                      autoFocus
                                      onClick={(e) => e.stopPropagation()}
                                      placeholder="Add description..."
                                      className="mt-0.5 w-full rounded bg-[var(--color-bg-primary)] px-1 py-0.5 text-[10px] text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none ring-1 ring-brand-500"
                                    />
                                  )
                                  : (
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
      <ConfirmDialog
        isOpen={pendingDelete !== null}
        title={`Delete category "${pendingDelete?.cat ?? ""}"?`}
        message={pendingDelete
          ? `${pendingDelete.count} favorite${pendingDelete.count === 1 ? "" : "s"} will be moved to Uncategorized.`
          : ""}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        danger
        onConfirm={() => {
          if (pendingDelete) {
            deleteCategory(pendingDelete.cat);
          }
          setPendingDelete(null);
        }}
        onCancel={() => setPendingDelete(null)}
      />
      <ConfirmDialog
        isOpen={showConfirm}
        title="Replace current tab content?"
        message="Unsaved changes will be lost."
        onConfirm={handleConfirmReplace}
        onCancel={handleCancelReplace}
      />
    </div>
  );
}
