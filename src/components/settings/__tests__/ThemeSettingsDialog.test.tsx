import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { serializeTheme, type Theme } from "../../../lib/themes";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useThemeStore } from "../../../stores/themeStore";
import { ThemeSettingsDialog } from "../ThemeSettingsDialog";

const custom: Theme = {
  id: "mine",
  name: "Mine",
  base: "dark",
  colors: {
    "bg-primary": "#123456",
    "bg-secondary": "#222222",
    "bg-tertiary": "#333333",
    "border": "#444444",
    "text-primary": "#ffffff",
    "text-secondary": "#dddddd",
    "text-muted": "#aaaaaa",
    "accent": "#3b82f6",
    "success": "#22c55e",
    "warning": "#eab308",
    "error": "#ef4444",
    "brand-300": "#93c5fd",
    "brand-400": "#60a5fa",
    "brand-500": "#3b82f6",
    "brand-600": "#2563eb",
    "brand-700": "#1d4ed8",
  },
};

const open = () => render(<ThemeSettingsDialog isOpen onClose={vi.fn()} />);
const row = (name: string) => screen.getByRole("button", { name: `Use ${name}` });
const bgVar = () => document.documentElement.style.getPropertyValue("--color-bg-primary");

describe("ThemeSettingsDialog (#350)", () => {
  beforeEach(() => {
    localStorage.clear();
    useThemeStore.setState({ theme: "dark", effectiveTheme: "dark", customThemes: [] });
    useThemeStore.getState().setTheme("dark");
  });

  it("renders nothing when closed", () => {
    const { container } = render(<ThemeSettingsDialog isOpen={false} onClose={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("offers every built-in theme, plus following the system", () => {
    open();
    for (const name of ["Dark", "Light", "Nord", "Solarized Light", "High Contrast"]) {
      expect(row(name)).toBeInTheDocument();
    }
    expect(row("Follow the system")).toBeInTheDocument();
  });

  it("applies a theme on selection, because the app is the preview", () => {
    // A swatch pane would show colours without showing what they do to a
    // dense grid, which is the only question worth asking of a theme.
    open();

    fireEvent.click(row("Nord"));

    expect(useThemeStore.getState().theme).toBe("nord");
    expect(bgVar()).toBe("#2e3440");
  });

  it("marks the selected theme", () => {
    useThemeStore.getState().setTheme("nord");
    open();
    expect(row("Nord").getAttribute("aria-pressed")).toBe("true");
    expect(row("Dark").getAttribute("aria-pressed")).toBe("false");
  });

  describe("editing", () => {
    it("opens a built-in as a copy, so the original survives", () => {
      open();

      fireEvent.click(screen.getByLabelText("Edit Nord"));

      expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Nord copy");
    });

    it("shows an edit on the page as it is typed, without saving it", () => {
      open();
      fireEvent.click(screen.getByLabelText("Edit Dark"));

      fireEvent.change(screen.getByLabelText("Background"), { target: { value: "#ff0000" } });

      expect(bgVar()).toBe("#ff0000");
      expect(useThemeStore.getState().customThemes).toEqual([]);
    });

    it("puts back the chosen theme when the edit is abandoned", () => {
      useThemeStore.getState().setTheme("nord");
      open();
      fireEvent.click(screen.getByLabelText("Edit Nord"));
      fireEvent.change(screen.getByLabelText("Background"), { target: { value: "#ff0000" } });

      fireEvent.click(screen.getByText("Cancel"));

      expect(bgVar()).toBe("#2e3440");
    });

    it("saves and selects the edited theme", () => {
      open();
      fireEvent.click(screen.getByLabelText("Edit Dark"));
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Midnight" } });

      fireEvent.click(screen.getByText("Save theme"));

      expect(useThemeStore.getState().customThemes[0].name).toBe("Midnight");
      expect(useThemeStore.getState().theme).toBe("midnight");
    });

    it("will not save a theme with no name", () => {
      open();
      fireEvent.click(screen.getByLabelText("Edit Dark"));
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  " } });

      fireEvent.click(screen.getByText("Save theme"));

      expect(screen.getByRole("status")).toHaveTextContent("Give the theme a name");
      expect(useThemeStore.getState().customThemes).toEqual([]);
    });

    it("warns when text would be unreadable, without blocking the edit", () => {
      // The one thing taste does not excuse. A theme mid-edit is allowed to
      // be unreadable; being told so is the point.
      open();
      fireEvent.click(screen.getByLabelText("Edit Dark"));

      fireEvent.change(screen.getByLabelText("Text"), { target: { value: "#0a0a0f" } });

      expect(screen.getByRole("alert")).toHaveTextContent(/WCAG AA/);
      expect(screen.getByText("Save theme")).toBeEnabled();
    });

    it("says nothing about contrast when there is nothing to say", () => {
      open();
      fireEvent.click(screen.getByLabelText("Edit Dark"));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("labels every colour, so nothing is an unnamed swatch", () => {
      open();
      fireEvent.click(screen.getByLabelText("Edit Dark"));
      for (const label of ["Background", "Panels", "Borders", "Text", "Accent"]) {
        expect(screen.getByLabelText(label)).toBeInTheDocument();
      }
    });
  });

  describe("custom themes", () => {
    beforeEach(() => useThemeStore.getState().saveCustomTheme(custom));

    it("offers one for deletion, and a built-in not at all", () => {
      open();
      expect(screen.getByLabelText("Delete Mine")).toBeInTheDocument();
      expect(screen.queryByLabelText("Delete Dark")).not.toBeInTheDocument();
    });

    it("deletes it", () => {
      open();
      fireEvent.click(screen.getByLabelText("Delete Mine"));
      expect(useThemeStore.getState().customThemes).toEqual([]);
    });

    it("edits it in place rather than as a copy", () => {
      open();
      fireEvent.click(screen.getByLabelText("Edit Mine"));
      expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Mine");
    });
  });

  describe("import and export", () => {
    it("takes a theme from a file", async () => {
      open();
      const file = new File([serializeTheme(custom)], "mine.json", { type: "application/json" });

      fireEvent.change(screen.getByLabelText("Import theme file"), {
        target: { files: [file] },
      });

      await waitFor(() => expect(useThemeStore.getState().customThemes).toHaveLength(1));
      expect(screen.getByRole("status")).toHaveTextContent("Imported mine.json");
    });

    it("says why a bad file was refused, and keeps nothing", async () => {
      open();
      const file = new File(["not json"], "bad.json", { type: "application/json" });

      fireEvent.change(screen.getByLabelText("Import theme file"), {
        target: { files: [file] },
      });

      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/JSON/));
      expect(useThemeStore.getState().customThemes).toEqual([]);
    });

    it("hands a theme back as a file", () => {
      const click = vi.fn();
      const create = document.createElement.bind(document);
      vi.spyOn(document, "createElement").mockImplementation(
        ((tag: string) => {
          const el = create(tag);
          if (tag === "a") el.click = click;
          return el;
        }) as typeof document.createElement,
      );
      vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x");
      vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
      open();

      fireEvent.click(screen.getByLabelText("Export Nord"));

      expect(click).toHaveBeenCalled();
      vi.restoreAllMocks();
    });
  });

  it("hides the decorative swatches from assistive technology", () => {
    // Four coloured squares per row would otherwise be four unnamed nodes in
    // the accessibility tree of every theme.
    open();
    expect(within(row("Nord")).queryAllByRole("img")).toHaveLength(0);
  });

  describe("editor settings (#295)", () => {
    it("offers the minimap, which was hard-disabled", () => {
      open();
      expect(screen.getByLabelText("Show minimap")).not.toBeChecked();
    });

    it("turns it on", () => {
      open();

      fireEvent.click(screen.getByLabelText("Show minimap"));

      expect(useSettingsStore.getState().querySettings.showMinimap).toBe(true);
    });
  });
});
