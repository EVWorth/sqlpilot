import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { actionById, ACTIONS, MENUS, score, search } from "../actions";

/**
 * The registry has to stay honest about three things: that every action it
 * offers actually does something, that the menu bar and the palette show the
 * same set, and that searching finds what a person meant.
 */

describe("the action registry", () => {
  it("offers nothing the app cannot do", () => {
    // The palette dispatches `menu-action` with an id, and AppLayout answers
    // with a `switch`. An id with no case is a command that appears, is
    // chosen, and silently does nothing — the worst kind of broken, because
    // it looks like it worked.
    const handler = readFileSync("src/components/layout/AppLayout.tsx", "utf8");
    const unhandled = ACTIONS.filter((action) => !handler.includes(`case "${action.id}":`));
    expect(
      unhandled.map((a) => a.id),
      "these appear in the palette but AppLayout has no case for them",
    ).toEqual([]);
  });

  it("puts every action in a menu", () => {
    // Not a style rule: an action the menu bar cannot reach is one a user has
    // to already know exists, and the palette is meant to be a faster route to
    // the same things, not a separate set of them.
    const inMenus = new Set(
      MENUS.flatMap((menu) => menu.entries.filter((e) => e.type === "item").map((e) => e.id)),
    );
    const orphans = ACTIONS.filter((action) => !inMenus.has(action.id)).map((a) => a.id);
    expect(orphans, "these are in the palette but in no menu").toEqual([]);
  });

  it("has no menu entry pointing at an action that does not exist", () => {
    const dangling = MENUS.flatMap((menu) =>
      menu.entries
        .filter((entry): entry is { type: "item"; id: string } => entry.type === "item")
        .filter((entry) => !actionById(entry.id))
        .map((entry) => `${menu.label} → ${entry.id}`)
    );
    expect(dangling).toEqual([]);
  });

  it("gives every action a unique id", () => {
    const ids = ACTIONS.map((a) => a.id);
    expect(ids.length).toBe(new Set(ids).size);
  });

  it("names a category that matches the menu it lives under", () => {
    // The palette shows the category beside each row, so a mismatch would be
    // a label that contradicts where the action actually is.
    const wrong: string[] = [];
    for (const menu of MENUS) {
      for (const entry of menu.entries) {
        if (entry.type !== "item") continue;
        const action = actionById(entry.id);
        if (action && action.category !== menu.label) {
          wrong.push(`${action.id} says "${action.category}" but sits in "${menu.label}"`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe("searching", () => {
  it("matches letters in order, not just as a substring", () => {
    // The point of a palette over a menu: "fnr" reaches Find & Replace,
    // which no substring search would find.
    expect(search("fnr")[0].id).toBe("find-replace");
  });

  it("prefers the tighter run when two actions both match", () => {
    // "fr" is a closer fit for Format (f-o-r) than for Find & Replace, where
    // the two letters sit eight characters apart. Ranking Format first is the
    // correct answer, and worth pinning down because it is the behaviour that
    // makes short queries feel sharp rather than arbitrary.
    expect(search("fr")[0].id).toBe("format-sql");
    expect(search("fr").map((a) => a.id)).toContain("find-replace");
  });

  it("prefers a tighter match to a looser one", () => {
    const ranked = search("back");
    expect(ranked[0].id).toBe("backup");
  });

  it("finds an action by a word that is not in its label", () => {
    // Someone looking to export a database types "export", and the command is
    // called Backup.
    expect(search("export").map((a) => a.id)).toContain("backup");
    expect(search("theme").map((a) => a.id)).toContain("appearance");
  });

  it("returns everything for an empty query", () => {
    expect(search("").length).toBe(ACTIONS.length);
  });

  it("returns nothing when the letters are not there in order", () => {
    expect(search("zzzz")).toEqual([]);
  });

  it("ranks a label match above a keyword match", () => {
    // "import" is the label of one action and a keyword of Restore. The one
    // actually called Import has to come first.
    const ranked = search("import").map((a) => a.id);
    expect(ranked[0]).toBe("import");
    expect(ranked).toContain("restore");
  });

  it("scores a non-match as null rather than as a large number", () => {
    // A number would sort, and sorting a non-match puts unrelated commands at
    // the bottom of the list instead of leaving them out.
    const action = ACTIONS.find((a) => a.id === "quit")!;
    expect(score(action, "zzzz")).toBeNull();
  });
});
