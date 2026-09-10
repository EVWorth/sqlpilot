import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SaveFavoriteDialog } from "../SaveFavoriteDialog";

const { useFavoritesStoreFn, mockAddFavorite, mockAddCategory, mockUpdateFavorite } = vi.hoisted(() => {
  return {
    useFavoritesStoreFn: vi.fn(),
    mockAddFavorite: vi.fn(),
    mockAddCategory: vi.fn(),
    mockUpdateFavorite: vi.fn(),
  };
});

vi.mock("../../../stores/favoritesStore", () => ({
  useFavoritesStore: useFavoritesStoreFn,
}));

beforeAll(() => {
  useFavoritesStoreFn.mockImplementation((s: (v: any) => unknown) =>
    s({
      categories: ["Uncategorized", "Reports", "Monitoring"],
      addFavorite: mockAddFavorite,
      addCategory: mockAddCategory,
      updateFavorite: mockUpdateFavorite,
    })
  );
});

beforeEach(() => {
  mockAddFavorite.mockReset().mockReturnValue({ ok: true, id: "fav-1" });
  mockAddCategory.mockReset();
  mockUpdateFavorite.mockReset().mockReturnValue({ ok: true, id: "fav-1" });
});

/** Fill in a name and press Save. */
function save(favName: string) {
  fireEvent.change(screen.getByPlaceholderText("e.g. Get active users"), {
    target: { value: favName },
  });
  fireEvent.click(screen.getByText("Save Favorite"));
}

/** Make the next addFavorite come back as a name collision. */
function refuseAsDuplicate() {
  mockAddFavorite.mockReturnValue({ ok: false, reason: "duplicate", existingId: "fav-existing" });
}

function dp(overrides = {}) {
  return {
    isOpen: true,
    onClose: vi.fn(),
    sql: "SELECT * FROM users WHERE active = 1",
    connectionName: "Prod DB",
    database: "mydb",
    ...overrides,
  };
}

describe("SaveFavoriteDialog", () => {
  it("returns null when isOpen is false", () => {
    const { container } = render(<SaveFavoriteDialog isOpen={false} onClose={vi.fn()} sql="SELECT 1" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders dialog when isOpen is true", () => {
    render(<SaveFavoriteDialog {...dp()} />);
    expect(screen.getByText("Save as Favorite")).toBeInTheDocument();
  });

  it("renders Name input", () => {
    render(<SaveFavoriteDialog {...dp()} />);
    expect(screen.getByPlaceholderText("e.g. Get active users")).toBeInTheDocument();
  });

  it("renders Category dropdown", () => {
    render(<SaveFavoriteDialog {...dp()} />);
    expect(screen.getByDisplayValue("Uncategorized")).toBeInTheDocument();
  });

  it("renders SQL preview", () => {
    render(<SaveFavoriteDialog {...dp()} />);
    expect(screen.getByText("SELECT * FROM users WHERE active = 1")).toBeInTheDocument();
  });

  it("disables Save when name is empty", () => {
    render(<SaveFavoriteDialog {...dp()} />);
    expect(screen.getByText("Save Favorite")).toBeDisabled();
  });

  it("enables Save when name is filled", () => {
    render(<SaveFavoriteDialog {...dp()} />);
    fireEvent.change(screen.getByPlaceholderText("e.g. Get active users"), { target: { value: "My Query" } });
    expect(screen.getByText("Save Favorite")).not.toBeDisabled();
  });

  it("calls onClose when Cancel clicked", () => {
    const onClose = vi.fn();
    render(<SaveFavoriteDialog {...dp({ onClose })} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders new category input when + New clicked", () => {
    render(<SaveFavoriteDialog {...dp()} />);
    fireEvent.click(screen.getByText("+ New"));
    expect(screen.getByPlaceholderText("New category name")).toBeInTheDocument();
  });

  it("closes on Escape key", () => {
    const onClose = vi.fn();
    render(<SaveFavoriteDialog {...dp({ onClose })} />);
    fireEvent.keyDown(screen.getByPlaceholderText("e.g. Get active users"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not save when name is whitespace", () => {
    render(<SaveFavoriteDialog {...dp()} />);
    fireEvent.change(screen.getByPlaceholderText("e.g. Get active users"), { target: { value: "   " } });
    expect(screen.getByText("Save Favorite")).toBeDisabled();
  });

  it("closes on backdrop click", () => {
    const onClose = vi.fn();
    render(<SaveFavoriteDialog {...dp({ onClose })} />);
    fireEvent.click(document.querySelector(".fixed.inset-0") as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  describe("duplicate names", () => {
    it("keeps the dialog open and says so when the store refuses (#332)", () => {
      const onClose = vi.fn();
      refuseAsDuplicate();
      render(<SaveFavoriteDialog {...dp({ onClose })} />);

      save("Active users");

      expect(screen.getByRole("alert")).toHaveTextContent(/already in Uncategorized/);
      expect(onClose).not.toHaveBeenCalled();
    });

    it("disables Save until the name changes", () => {
      refuseAsDuplicate();
      render(<SaveFavoriteDialog {...dp()} />);

      save("Active users");
      expect(screen.getByText("Save Favorite")).toBeDisabled();

      fireEvent.change(screen.getByPlaceholderText("e.g. Get active users"), {
        target: { value: "Active users 2" },
      });
      expect(screen.getByText("Save Favorite")).not.toBeDisabled();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("overwrites the existing favorite on request", () => {
      const onClose = vi.fn();
      refuseAsDuplicate();
      render(<SaveFavoriteDialog {...dp({ onClose })} />);

      save("Active users");
      fireEvent.click(screen.getByText("Overwrite"));

      expect(mockUpdateFavorite).toHaveBeenCalledWith("fav-existing", {
        name: "Active users",
        sql: "SELECT * FROM users WHERE active = 1",
        category: "Uncategorized",
        description: undefined,
      });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("offers no Overwrite button before a collision", () => {
      render(<SaveFavoriteDialog {...dp()} />);
      expect(screen.queryByText("Overwrite")).not.toBeInTheDocument();
    });

    it("does not create the typed category when the save is refused", () => {
      refuseAsDuplicate();
      render(<SaveFavoriteDialog {...dp()} />);

      fireEvent.click(screen.getByText("+ New"));
      fireEvent.change(screen.getByPlaceholderText("New category name"), {
        target: { value: "Reports 2026" },
      });
      save("Active users");

      expect(mockAddCategory).not.toHaveBeenCalled();
    });
  });

  describe("naming a new category (#338)", () => {
    /** Open the new-category field and type a name into it. */
    function typeCategory(value: string) {
      fireEvent.click(screen.getByText("+ New"));
      fireEvent.change(screen.getByPlaceholderText("New category name"), { target: { value } });
    }

    it("cannot add an empty category", () => {
      render(<SaveFavoriteDialog {...dp()} />);
      fireEvent.click(screen.getByText("+ New"));

      expect(screen.getByText("Add")).toBeDisabled();
    });

    it("commits the category and collapses back to the dropdown", () => {
      // The category used to come into being only when the favorite was
      // saved, so the user never saw it take.
      render(<SaveFavoriteDialog {...dp()} />);
      typeCategory("Daily Reports");

      fireEvent.click(screen.getByText("Add"));

      expect(mockAddCategory).toHaveBeenCalledWith("Daily Reports");
      expect(screen.queryByPlaceholderText("New category name")).not.toBeInTheDocument();
    });

    it("selects the category it just created", () => {
      render(<SaveFavoriteDialog {...dp()} />);
      typeCategory("Daily Reports");
      fireEvent.click(screen.getByText("Add"));

      save("Nightly rollup");

      expect(mockAddFavorite).toHaveBeenCalledWith(
        expect.objectContaining({ category: "Daily Reports" }),
      );
    });

    it("adds on Enter without saving the favorite", () => {
      // The user is naming a category, not finishing the dialog.
      render(<SaveFavoriteDialog {...dp()} />);
      typeCategory("Daily Reports");

      fireEvent.keyDown(screen.getByPlaceholderText("New category name"), { key: "Enter" });

      expect(mockAddCategory).toHaveBeenCalledWith("Daily Reports");
      expect(mockAddFavorite).not.toHaveBeenCalled();
    });

    it("still saves under a typed category the user never pressed Add on", () => {
      // Adding a confirmation step should not make one mandatory.
      render(<SaveFavoriteDialog {...dp()} />);
      typeCategory("Ad Hoc");

      save("Nightly rollup");

      expect(mockAddFavorite).toHaveBeenCalledWith(
        expect.objectContaining({ category: "Ad Hoc" }),
      );
    });

    it("forgets a cancelled category", () => {
      render(<SaveFavoriteDialog {...dp()} />);
      typeCategory("Discarded");

      fireEvent.click(screen.getByLabelText("Cancel new category"));
      save("Nightly rollup");

      expect(mockAddCategory).not.toHaveBeenCalled();
      expect(mockAddFavorite).toHaveBeenCalledWith(
        expect.objectContaining({ category: "Uncategorized" }),
      );
    });
  });
});
