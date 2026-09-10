/**
 * Categories as paths, so folders can nest.
 *
 * FR-9.2.2 asks for hierarchical folders. The store keeps `categories:
 * string[]`, and the flat list was read as the whole of what was possible
 * (#334) — but a category is a name, and a name can be a path. "Reports/Daily"
 * is one category to the store and two folders to the user, which is the whole
 * of the change: no migration, and a favorite saved under a flat name still
 * lands where it always did.
 *
 * The separator is "/" because that is what people already type when they mean
 * nesting, and because it cannot appear in a path segment without meaning it.
 */

export const CATEGORY_SEPARATOR = "/";

export interface CategoryNode {
  /** The full path, which is what a favorite stores. */
  path: string;
  /** The last segment — what the row shows. */
  name: string;
  /** How deep to indent. Zero at the top. */
  depth: number;
  children: CategoryNode[];
}

/**
 * Split a path into its segments, dropping empty ones.
 *
 * "Reports//Daily/" is "Reports/Daily": a stray separator is a typo, not a
 * folder with no name.
 */
export function splitCategoryPath(path: string): string[] {
  return path.split(CATEGORY_SEPARATOR).map((s) => s.trim()).filter(Boolean);
}

/** Put a path back together, normalised. */
export function normaliseCategoryPath(path: string): string {
  return splitCategoryPath(path).join(CATEGORY_SEPARATOR);
}

/** The path's own name, without its parents. */
export function categoryLeafName(path: string): string {
  const parts = splitCategoryPath(path);
  return parts[parts.length - 1] ?? path;
}

/** True when `path` is `ancestor` or sits underneath it. */
export function isUnderCategory(path: string, ancestor: string): boolean {
  if (path === ancestor) return true;
  return path.startsWith(ancestor + CATEGORY_SEPARATOR);
}

/**
 * Build the folder tree the sidebar renders.
 *
 * Intermediate folders are created even when nothing declared them: a category
 * called "Reports/Daily" with no "Reports" beside it still has to appear under
 * a Reports folder, or the nesting is invisible.
 *
 * Sorted by path, so siblings are alphabetical and a folder's children follow
 * it — the order someone would write the list in by hand.
 */
export function buildCategoryTree(categories: string[]): CategoryNode[] {
  const roots: CategoryNode[] = [];
  const byPath = new Map<string, CategoryNode>();

  const ensure = (segments: string[]): CategoryNode => {
    const path = segments.join(CATEGORY_SEPARATOR);
    const existing = byPath.get(path);
    if (existing) return existing;

    const node: CategoryNode = {
      path,
      name: segments[segments.length - 1],
      depth: segments.length - 1,
      children: [],
    };
    byPath.set(path, node);

    if (segments.length === 1) {
      roots.push(node);
    } else {
      ensure(segments.slice(0, -1)).children.push(node);
    }
    return node;
  };

  for (const category of categories) {
    const segments = splitCategoryPath(category);
    if (segments.length > 0) ensure(segments);
  }

  const sort = (nodes: CategoryNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    nodes.forEach((n) => sort(n.children));
  };
  sort(roots);

  return roots;
}

/**
 * Flatten the tree to the rows to render, hiding what is collapsed.
 *
 * A collapsed folder hides its descendants but stays visible itself, so the
 * user can open it again.
 */
export function visibleCategoryRows(
  tree: CategoryNode[],
  isExpanded: (path: string) => boolean,
): CategoryNode[] {
  const rows: CategoryNode[] = [];

  const walk = (nodes: CategoryNode[]) => {
    for (const node of nodes) {
      rows.push(node);
      if (isExpanded(node.path)) walk(node.children);
    }
  };
  walk(tree);

  return rows;
}

/**
 * Where a category ends up when it is moved under `newParent`.
 *
 * `null` when the move makes no sense: a folder cannot be moved inside itself
 * or inside one of its own descendants, which would detach the whole subtree
 * from the tree and lose it.
 */
export function reparentCategory(path: string, newParent: string | null): string | null {
  const name = categoryLeafName(path);
  if (newParent === null) return name;
  if (isUnderCategory(newParent, path)) return null;

  const parent = normaliseCategoryPath(newParent);
  return parent ? `${parent}${CATEGORY_SEPARATOR}${name}` : name;
}
