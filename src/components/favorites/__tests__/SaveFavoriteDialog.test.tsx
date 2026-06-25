import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { SaveFavoriteDialog } from "../SaveFavoriteDialog";

const { useFavoritesStoreFn, mockAddFavorite, mockAddCategory } = vi.hoisted(() => {
  return { useFavoritesStoreFn: vi.fn(), mockAddFavorite: vi.fn(), mockAddCategory: vi.fn() };
});

vi.mock("../../stores/favoritesStore", () => ({
  useFavoritesStore: useFavoritesStoreFn,
}));

beforeAll(() => {
  useFavoritesStoreFn.mockImplementation((s: (v: any) => unknown) =>
    s({
      categories: ["Uncategorized", "Reports", "Monitoring"],
      addFavorite: mockAddFavorite,
      addCategory: mockAddCategory,
    })
  );
});

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
});
