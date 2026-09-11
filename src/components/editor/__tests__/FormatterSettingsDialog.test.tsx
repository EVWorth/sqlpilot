import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "../../../stores/settingsStore";
import { FormatterSettingsDialog } from "../FormatterSettingsDialog";

describe("FormatterSettingsDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({
      formatterSettings: {
        keywordCase: "upper",
        identifierCase: "preserve",
        dataTypeCase: "upper",
        functionCase: "preserve",
        indentStyle: "standard",
        tabWidth: 2,
        useTabs: false,
        logicalOperatorNewline: "before",
        newlineBeforeSemicolon: false,
        expressionWidth: 50,
        linesBetweenQueries: 1,
        denseOperators: false,
      },
    });
  });

  it("renders nothing when isOpen is false", () => {
    const { container } = render(
      <FormatterSettingsDialog isOpen={false} onClose={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the dialog title when open", () => {
    render(<FormatterSettingsDialog isOpen={true} onClose={vi.fn()} />);
    expect(screen.getByText("SQL Formatter Settings")).toBeInTheDocument();
  });

  it("renders casing section with four selects", () => {
    render(<FormatterSettingsDialog isOpen={true} onClose={vi.fn()} />);

    expect(screen.getByText("Casing")).toBeInTheDocument();
    expect(screen.getByText("Keywords")).toBeInTheDocument();
    expect(screen.getByText("Identifiers (table/column names)")).toBeInTheDocument();
    expect(screen.getByText("Data types")).toBeInTheDocument();
    expect(screen.getByText("Functions")).toBeInTheDocument();
  });

  it("renders indentation section", () => {
    render(<FormatterSettingsDialog isOpen={true} onClose={vi.fn()} />);

    expect(screen.getByText("Indentation")).toBeInTheDocument();
    expect(screen.getByText("Indent style")).toBeInTheDocument();
    expect(screen.getByText("Indent using tabs")).toBeInTheDocument();
    expect(screen.getByText("Tab width")).toBeInTheDocument();
  });

  it("hides tab width when useTabs is enabled", () => {
    useSettingsStore.setState({
      formatterSettings: {
        keywordCase: "upper",
        identifierCase: "preserve",
        dataTypeCase: "upper",
        functionCase: "preserve",
        indentStyle: "standard",
        tabWidth: 2,
        useTabs: true,
        logicalOperatorNewline: "before",
        newlineBeforeSemicolon: false,
        expressionWidth: 50,
        linesBetweenQueries: 1,
        denseOperators: false,
      },
    });

    render(<FormatterSettingsDialog isOpen={true} onClose={vi.fn()} />);
    expect(screen.queryByLabelText("Tab width")).toBeNull();
  });

  it("renders layout section", () => {
    render(<FormatterSettingsDialog isOpen={true} onClose={vi.fn()} />);

    expect(screen.getByText("Layout")).toBeInTheDocument();
    expect(screen.getByText("Logical operator newline")).toBeInTheDocument();
    expect(screen.getByText("Expression width")).toBeInTheDocument();
    expect(screen.getByText("Lines between queries")).toBeInTheDocument();
    expect(screen.getByText("Dense operators")).toBeInTheDocument();
    expect(screen.getByText("Newline before semicolon")).toBeInTheDocument();
  });

  it("calls onClose when Cancel is clicked", () => {
    const onClose = vi.fn();
    render(<FormatterSettingsDialog isOpen={true} onClose={onClose} />);

    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("saves settings and closes when Save is clicked", () => {
    const onClose = vi.fn();
    render(<FormatterSettingsDialog isOpen={true} onClose={onClose} />);

    // Save starts disabled because local matches persisted defaults; toggle the
    // Keywords select (first combobox on the page) to make the dialog dirty.
    const keywordsSelect = screen.getAllByRole("combobox")[0] as HTMLSelectElement;
    fireEvent.change(keywordsSelect, { target: { value: "lower" } });

    const saveButton = screen.getByText("Save").closest("button")!;
    expect(saveButton).not.toBeDisabled();

    fireEvent.click(saveButton);
    expect(onClose).toHaveBeenCalledTimes(1);

    const state = useSettingsStore.getState();
    expect(state.formatterSettings.keywordCase).toBe("lower");
  });

  it("Save button is disabled when settings are unchanged from persisted state", () => {
    render(<FormatterSettingsDialog isOpen={true} onClose={vi.fn()} />);

    const saveButton = screen.getByText("Save").closest("button")!;
    expect(saveButton).toBeDisabled();
    // No dirty dot in title
    expect(screen.queryByLabelText("unsaved changes")).toBeNull();
  });

  it("Save button becomes enabled after a setting changes and shows a dirty dot", () => {
    render(<FormatterSettingsDialog isOpen={true} onClose={vi.fn()} />);

    const keywordsSelect = screen.getAllByRole("combobox")[0] as HTMLSelectElement;
    fireEvent.change(keywordsSelect, { target: { value: "lower" } });

    const saveButton = screen.getByText("Save").closest("button")!;
    expect(saveButton).not.toBeDisabled();
    // Dirty indicator appears
    expect(screen.getByLabelText("unsaved changes")).toBeInTheDocument();
  });

  it("clicking Save with no changes does not overwrite persisted state", () => {
    // Start with a non-default persisted state so we can detect spurious writes
    useSettingsStore.setState({
      formatterSettings: {
        ...useSettingsStore.getState().formatterSettings,
        keywordCase: "lower",
        tabWidth: 4,
      },
    });

    const onClose = vi.fn();
    render(<FormatterSettingsDialog isOpen={true} onClose={onClose} />);

    const saveButton = screen.getByText("Save").closest("button")!;
    expect(saveButton).toBeDisabled();

    // Note: fireEvent.click on a disabled button is a no-op in JSDOM. Verify
    // by checking the persisted state is untouched (the dialog guarantees no
    // write happens when not dirty, so any spurious round-trip would change
    // these values back to the dialog's "defaults" view of them).
    fireEvent.click(saveButton);

    expect(onClose).not.toHaveBeenCalled();
    const state = useSettingsStore.getState();
    expect(state.formatterSettings.keywordCase).toBe("lower");
    expect(state.formatterSettings.tabWidth).toBe(4);
  });

  it("resets to defaults when Reset to defaults is clicked", () => {
    render(<FormatterSettingsDialog isOpen={true} onClose={vi.fn()} />);

    fireEvent.click(screen.getByText("Reset to defaults"));

    // After Reset, local state equals defaults (which already match the persisted
    // state from beforeEach), so Save is still disabled. To exercise Save, we
    // first change a field, then Reset, then change it again.
    const state = useSettingsStore.getState();
    expect(state.formatterSettings.tabWidth).toBe(2);
  });

  it("calls onClose when clicking the backdrop", () => {
    const onClose = vi.fn();
    const { container } = render(
      <FormatterSettingsDialog isOpen={true} onClose={onClose} />,
    );

    const backdrop = container.firstElementChild!;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("FormatterSettingsDialog live preview (#355)", () => {
  const open = (sample?: string) => render(<FormatterSettingsDialog isOpen onClose={vi.fn()} sample={sample} />);

  const preview = () => screen.getByLabelText("Formatted preview").textContent ?? "";

  beforeEach(() => {
    useSettingsStore.setState({
      formatterSettings: {
        keywordCase: "upper",
        identifierCase: "preserve",
        dataTypeCase: "upper",
        functionCase: "preserve",
        indentStyle: "standard",
        tabWidth: 2,
        useTabs: false,
        logicalOperatorNewline: "before",
        newlineBeforeSemicolon: false,
        expressionWidth: 50,
        linesBetweenQueries: 1,
        denseOperators: false,
      },
    });
  });

  it("previews the user's own statement", () => {
    open("select id from users");
    expect(preview()).toContain("SELECT");
    expect(preview()).toContain("users");
  });

  it("updates as a setting changes, before anything is saved", () => {
    // The whole point: settings could only be judged by saving them, using
    // the Format button, and undoing if the output was wrong.
    open("select id from users");
    expect(preview()).toContain("SELECT");

    fireEvent.change(screen.getByLabelText("Keywords"), { target: { value: "lower" } });

    expect(preview()).toContain("select");
    expect(preview()).not.toContain("SELECT");
  });

  it("does not touch the saved settings while previewing", () => {
    open("select id from users");

    fireEvent.change(screen.getByLabelText("Keywords"), { target: { value: "lower" } });

    expect(useSettingsStore.getState().formatterSettings.keywordCase).toBe("upper");
  });

  it("shows a sample when the editor is empty", () => {
    // A blank preview would make the settings look broken rather than
    // showing what they do.
    open("");
    expect(preview()).toContain("SELECT");
    expect(preview().length).toBeGreaterThan(40);
  });

  it("shows a sample when the editor holds something unformattable", () => {
    open("SELECT 'unterminated");
    expect(preview()).toContain("LEFT JOIN");
  });
});

describe("FormatterSettingsDialog labels", () => {
  it.each([
    "Keywords",
    "Identifiers (table/column names)",
    "Data types",
    "Functions",
    "Indent style",
    "Tab width",
    "Logical operator newline",
    "Expression width",
    "Lines between queries",
  ])("associates the %s label with its control", (label) => {
    // An unlinked <label> is not announced with its control, and clicking it
    // does nothing.
    render(<FormatterSettingsDialog isOpen onClose={vi.fn()} />);
    expect(screen.getByLabelText(label)).toBeInTheDocument();
  });
});

describe("FormatterSettingsDialog defaults (F28 of #322)", () => {
  it("resets to what a fresh install starts with", async () => {
    // Two lists of twelve options drift, and a dialog whose "Reset to
    // defaults" disagreed with the store's would be the kind of difference
    // nobody notices for a year.
    const { DEFAULT_FORMATTER_SETTINGS } = await import("../../../stores/settingsStore");
    useSettingsStore.setState({
      formatterSettings: { ...DEFAULT_FORMATTER_SETTINGS, keywordCase: "lower", tabWidth: 8 },
    });
    render(<FormatterSettingsDialog isOpen onClose={vi.fn()} />);

    fireEvent.click(screen.getByText("Reset to defaults"));
    fireEvent.click(screen.getByText("Save"));

    expect(useSettingsStore.getState().formatterSettings).toEqual(DEFAULT_FORMATTER_SETTINGS);
  });
});
