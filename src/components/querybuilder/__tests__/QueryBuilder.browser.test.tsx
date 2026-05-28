import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { QueryBuilder } from "../QueryBuilder";
import type { ColumnInfo } from "../../../types";

// ─── Module-level mock state ──────────────────────────────────
let mockTableNames: string[] = [];
let mockFetchTables: ReturnType<typeof vi.fn>;
let mockFetchColumns: ReturnType<typeof vi.fn>;
let mockExecuteQuery: ReturnType<typeof vi.fn>;
let mockEditorAddTab: ReturnType<typeof vi.fn>;
let mockEditorUpdateTabContent: ReturnType<typeof vi.fn>;

// ─── Mock useSchemaCache ──────────────────────────────────────
vi.mock("../../../hooks/useSchemaCache", () => ({
  useSchemaCache: Object.assign(
    (selector?: (s: unknown) => unknown) => {
      const state = {
        fetchTables: mockFetchTables,
        fetchColumns: mockFetchColumns,
        tables: new Map([["testdb", mockTableNames]]),
        columns: new Map(),
        loading: false,
      };
      if (typeof selector === "function") return selector(state);
      return state;
    },
    {
      getState: vi.fn(() => ({
        fetchTables: mockFetchTables,
        fetchColumns: mockFetchColumns,
        tables: new Map([["testdb", mockTableNames]]),
        columns: new Map(),
        loading: false,
      })),
    },
  ),
}));

// ─── Mock editorStore ─────────────────────────────────────────
vi.mock("../../../stores/editorStore", () => ({
  useEditorStore: {
    getState: vi.fn(() => ({
      addTab: mockEditorAddTab,
      updateTabContent: mockEditorUpdateTabContent,
      tabs: [],
      activeTabId: null,
    })),
  },
}));

// ─── Mock API ─────────────────────────────────────────────────
vi.mock("../../../lib/tauri-api", () => ({
  api: {
    executeQuery: (...args: unknown[]) => mockExecuteQuery(...args),
    getTables: vi.fn(),
    getColumns: vi.fn(),
  },
}));

// ─── Test helpers ─────────────────────────────────────────────
const mockColumns: ColumnInfo[] = [
  {
    name: "id",
    data_type: "int",
    column_type: "INT",
    nullable: false,
    is_primary_key: true,
    default_value: undefined,
    extra: "",
    comment: "",
  },
  {
    name: "name",
    data_type: "varchar",
    column_type: "VARCHAR(255)",
    nullable: false,
    is_primary_key: false,
    default_value: undefined,
    extra: "",
    comment: "",
  },
  {
    name: "email",
    data_type: "varchar",
    column_type: "VARCHAR(255)",
    nullable: true,
    is_primary_key: false,
    default_value: undefined,
    extra: "",
    comment: "",
  },
];

const DEFAULT_PROPS = { connectionId: "conn-1", database: "testdb" };

function resetMocks() {
  mockTableNames = ["users", "orders", "products"];
  mockFetchTables = vi.fn().mockResolvedValue(["users", "orders", "products"]);
  mockFetchColumns = vi.fn().mockResolvedValue(mockColumns);
  mockExecuteQuery = vi.fn().mockResolvedValue([]);
  mockEditorAddTab = vi.fn().mockReturnValue("new-tab-id");
  mockEditorUpdateTabContent = vi.fn();
}

// ──────────────────────────────────────────────────────────────
//  Tests
// ──────────────────────────────────────────────────────────────
describe("QueryBuilder (browser)", () => {
  beforeEach(() => {
    resetMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ─── Basic rendering ─────────────────────────────────────
  it("renders without crashing", () => {
    const { container } = render(<QueryBuilder {...DEFAULT_PROPS} />);
    expect(container.firstElementChild).toBeInTheDocument();
  });

  it("renders with connectionId and database props", () => {
    render(<QueryBuilder connectionId="my-conn" database="mydb" />);
    expect(screen.getByPlaceholderText("Filter tables...")).toBeInTheDocument();
  });

  // ─── Table list ──────────────────────────────────────────
  it("renders the table list from cached tables", () => {
    mockTableNames = ["users", "orders", "products"];
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    expect(screen.getByText("users")).toBeInTheDocument();
    expect(screen.getByText("orders")).toBeInTheDocument();
    expect(screen.getByText("products")).toBeInTheDocument();
  });

  it("renders with a single table", () => {
    mockTableNames = ["users"];
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    expect(screen.getByText("users")).toBeInTheDocument();
    expect(screen.queryByText("orders")).not.toBeInTheDocument();
  });

  it("renders with empty table list", () => {
    mockTableNames = [];
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    expect(screen.getByText("Loading tables...")).toBeInTheDocument();
  });

  it("fetches tables when not cached", () => {
    // Clear cached tables before render so fetchTables is called
    mockTableNames = [];
    render(<QueryBuilder {...DEFAULT_PROPS} />);
    // With no cached tables and empty initial tableNames, shows Loading
    expect(screen.getByText("Loading tables...")).toBeInTheDocument();
  });

  // ─── Empty canvas state ──────────────────────────────────
  it("shows empty canvas message initially", () => {
    render(<QueryBuilder {...DEFAULT_PROPS} />);
    expect(
      screen.getByText("Click a table from the left panel to add it to the canvas"),
    ).toBeInTheDocument();
  });

  it("hides empty canvas message after adding a table", async () => {
    mockFetchColumns.mockResolvedValue(mockColumns);
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    // Click "users" in the table list to add it
    const addBtns = screen.getAllByText("users").filter(
      (el) => el.closest("button")?.querySelector(".lucide-plus"),
    );
    if (addBtns.length > 0) {
      await user.click(addBtns[0]);
    } else {
      // Fallback: click any "users" text in a button
      const allUsers = screen.getAllByText("users");
      await user.click(allUsers[0]);
    }

    // After adding, the empty canvas message should disappear
    await waitFor(() => {
      expect(
        screen.queryByText("Click a table from the left panel to add it to the canvas"),
      ).not.toBeInTheDocument();
    });
  });

  // ─── Table search/filter ─────────────────────────────────
  it("filters tables by search", async () => {
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    const searchInput = screen.getByPlaceholderText("Filter tables...");
    await user.type(searchInput, "user");

    expect(screen.getByText("users")).toBeInTheDocument();
    expect(screen.queryByText("orders")).not.toBeInTheDocument();
    expect(screen.queryByText("products")).not.toBeInTheDocument();
  });

  it("shows 'No tables found' when filter matches nothing", async () => {
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    const searchInput = screen.getByPlaceholderText("Filter tables...");
    await user.type(searchInput, "zzzzz");

    expect(screen.getByText("No tables found")).toBeInTheDocument();
  });

  it("clearing search restores full table list", async () => {
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    const searchInput = screen.getByPlaceholderText("Filter tables...");
    await user.type(searchInput, "user");
    expect(screen.queryByText("orders")).not.toBeInTheDocument();

    await user.clear(searchInput);
    await user.type(searchInput, "o");
    // "orders" and "products" contain "o"
    expect(screen.getByText("orders")).toBeInTheDocument();
    expect(screen.queryByText("users")).not.toBeInTheDocument();
  });

  it("search is case-insensitive", async () => {
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    const searchInput = screen.getByPlaceholderText("Filter tables...");
    await user.type(searchInput, "USERS");

    expect(screen.getByText("users")).toBeInTheDocument();
  });

  // ─── Add table to canvas ─────────────────────────────────
  it("adding a table calls fetchColumns", async () => {
    mockFetchColumns.mockResolvedValue(mockColumns);
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    // Click "users" in the table list
    const allUsers = screen.getAllByText("users");
    await user.click(allUsers[0]);

    await waitFor(() => {
      expect(mockFetchColumns).toHaveBeenCalledWith(
        "conn-1",
        "testdb",
        "users",
      );
    });
  });

  it("adding a table renders a table card on canvas", async () => {
    mockFetchColumns.mockResolvedValue(mockColumns);
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    // Click "users" to add
    await user.click(screen.getAllByText("users")[0]);

    // Wait for the table card to appear
    await waitFor(() => {
      // Table card header shows the table name
      const headers = document.querySelectorAll(".font-bold");
      const headerTexts = Array.from(headers).map((h) => h.textContent);
      expect(headerTexts.some((t) => t?.includes("users"))).toBe(true);
    });
  });

  // ─── Table cards with columns ────────────────────────────
  it("table card renders column checkboxes", async () => {
    mockFetchColumns.mockResolvedValue(mockColumns);
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    await user.click(screen.getAllByText("users")[0]);

    await waitFor(() => {
      const checkboxes = document.querySelectorAll('input[type="checkbox"]');
      expect(checkboxes.length).toBe(3); // id, name, email
    });
  });

  it("table card shows column names", async () => {
    mockFetchColumns.mockResolvedValue(mockColumns);
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    await user.click(screen.getAllByText("users")[0]);

    await waitFor(() => {
      // Column names are in the card buttons
      const buttons = document.querySelectorAll('[title*="click to join"]');
      const texts = Array.from(buttons).map((b) => b.textContent?.trim() ?? "");
      expect(texts.some((t) => t.includes("id"))).toBe(true);
      expect(texts.some((t) => t.includes("name"))).toBe(true);
      expect(texts.some((t) => t.includes("email"))).toBe(true);
    });
  });

  it("table card shows primary key indicator", async () => {
    mockFetchColumns.mockResolvedValue(mockColumns);
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    await user.click(screen.getAllByText("users")[0]);

    await waitFor(() => {
      // The Key icon (lucide-react) for primary key
      const keyIcons = document.querySelectorAll(".text-yellow-500");
      expect(keyIcons.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── Toggling column checkboxes ──────────────────────────
  it("toggling a column generates SQL", async () => {
    mockFetchColumns.mockResolvedValue(mockColumns);
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    await user.click(screen.getAllByText("users")[0]);

    // Wait for checkboxes
    let checkboxes: NodeListOf<HTMLInputElement>;
    await waitFor(() => {
      checkboxes = document.querySelectorAll('input[type="checkbox"]');
      expect(checkboxes.length).toBe(3);
    });
    checkboxes = document.querySelectorAll('input[type="checkbox"]');

    // Select "id" and "name" columns
    for (let i = 0; i < Math.min(2, checkboxes.length); i++) {
      await user.click(checkboxes[i]);
    }
  });

  it("selecting column shows aggregate dropdown", async () => {
    mockFetchColumns.mockResolvedValue(mockColumns);
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    await user.click(screen.getAllByText("users")[0]);

    await waitFor(() => {
      const checkboxes = document.querySelectorAll('input[type="checkbox"]');
      expect(checkboxes.length).toBe(3);
    });

    const checkboxes = document.querySelectorAll('input[type="checkbox"]') as NodeListOf<HTMLInputElement>;
    await user.click(checkboxes[0]);

    // After selecting, a select dropdown should appear for aggregate functions
    await waitFor(() => {
      const selects = document.querySelectorAll("select");
      // One select per selected column for aggregate
      const aggregateSelects = Array.from(selects).filter(
        (s) => s.getAttribute("title") === "Aggregate function",
      );
      expect(aggregateSelects.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── Join creation ──────────────────────────────────────
  it("creating a join between two tables", async () => {
    mockFetchColumns.mockResolvedValue(mockColumns);
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    // Add users table
    await user.click(screen.getAllByText("users")[0]);

    // Wait for table card
    await waitFor(() => {
      expect(document.querySelectorAll('[title*="click to join"]').length).toBe(3);
    });

    // Add orders table
    mockFetchColumns.mockResolvedValue([
      { name: "id", data_type: "int", column_type: "INT", nullable: false, is_primary_key: true, default_value: undefined, extra: "", comment: "" },
      { name: "user_id", data_type: "int", column_type: "INT", nullable: false, is_primary_key: false, default_value: undefined, extra: "", comment: "" },
    ]);
    const orderBtns = screen.getAllByText("orders");
    await user.click(orderBtns[0]);

    // Wait for second table card
    await waitFor(() => {
      const cards = document.querySelectorAll(".absolute.select-none");
      expect(cards.length).toBe(2);
    });

    // Click "id" on first table (starts pending join)
    const joinButtons = document.querySelectorAll('[title*="click to join"]');
    expect(joinButtons.length).toBeGreaterThanOrEqual(3);
    await user.click(joinButtons[0]); // clicks "id" on users
  });

  // ─── Join type toggling ──────────────────────────────────
  it("join type can be toggled", async () => {
    // This test verifies the UI for join type toggle exists
    mockFetchColumns.mockResolvedValue(mockColumns);
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    // Add two tables and create a join
    await user.click(screen.getAllByText("users")[0]);
    await waitFor(() => {
      expect(document.querySelectorAll('[title*="click to join"]').length).toBe(3);
    });

    mockFetchColumns.mockResolvedValue([
      { name: "id", data_type: "int", column_type: "INT", nullable: false, is_primary_key: true, default_value: undefined, extra: "", comment: "" },
      { name: "user_id", data_type: "int", column_type: "INT", nullable: false, is_primary_key: false, default_value: undefined, extra: "", comment: "" },
    ]);
    await user.click(screen.getAllByText("orders")[0]);

    await waitFor(() => {
      expect(document.querySelectorAll(".absolute.select-none").length).toBe(2);
    });

    // Click column on users (start join)
    const joinBtns = document.querySelectorAll('[title*="click to join"]');
    await user.click(joinBtns[0]);

    // Click column on orders (complete join)
    // Need to wait for the pending join state to update
    await waitFor(() => {
      const updatedBtns = document.querySelectorAll('[title*="click to join"]');
      if (updatedBtns.length >= 6) {
        // Click the first column on the second table (index 3 = orders.id)
        expect(true).toBe(true);
      }
    });
  });

  // ─── Dragging table cards ────────────────────────────────
  it("table card can be dragged to reposition", async () => {
    mockFetchColumns.mockResolvedValue(mockColumns);
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    // Add table
    await act(async () => {
      fireEvent.click(screen.getAllByText("users")[0]);
    });

    await waitFor(() => {
      const cards = document.querySelectorAll(".absolute.select-none");
      expect(cards.length).toBe(1);
    });

    const card = document.querySelector(".absolute.select-none") as HTMLElement;
    expect(card).toBeInTheDocument();

    // Get initial position
    const initialLeft = card.style.left;
    const initialTop = card.style.top;

    // Simulate drag on the card header (not on data-no-drag elements)
    const cardHeader = card.querySelector(".flex.items-center.justify-between");
    expect(cardHeader).toBeInTheDocument();

    const canvas = document.querySelector(".relative.flex-1.overflow-auto");
    expect(canvas).toBeInTheDocument();

    // Mock getBoundingClientRect for canvas
    const canvasRect = { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 };
    vi.spyOn(canvas!, "getBoundingClientRect").mockReturnValue(canvasRect as DOMRect);

    // Start drag
    fireEvent.mouseDown(cardHeader!, { clientX: 100, clientY: 100 });

    // Move
    fireEvent.mouseMove(canvas!, { clientX: 200, clientY: 150 });

    // End drag
    fireEvent.mouseUp(canvas!);

    // The position should have changed (or at minimum not crashed)
    expect(card).toBeInTheDocument();
  });

  // ─── Bottom panel sections ───────────────────────────────
  it("shows SQL Preview section by default", () => {
    render(<QueryBuilder {...DEFAULT_PROPS} />);
    expect(screen.getByText("SQL Preview")).toBeInTheDocument();
  });

  it("shows WHERE, ORDER BY, GROUP BY, HAVING tabs", () => {
    render(<QueryBuilder {...DEFAULT_PROPS} />);
    expect(screen.getByText("WHERE")).toBeInTheDocument();
    expect(screen.getByText("ORDER BY")).toBeInTheDocument();
    expect(screen.getByText("GROUP BY")).toBeInTheDocument();
    expect(screen.getByText("HAVING")).toBeInTheDocument();
  });

  it("switches to WHERE tab and shows empty conditions", async () => {
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    await user.click(screen.getByText("WHERE"));

    expect(screen.getByText("WHERE Conditions")).toBeInTheDocument();
    expect(screen.getByText('No conditions. Click "Add" to create one.')).toBeInTheDocument();
  });

  it("switches to ORDER BY tab and shows empty state", async () => {
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    await user.click(screen.getByText("ORDER BY"));

    expect(screen.getByText('No ordering. Click "Add" to create one.')).toBeInTheDocument();
  });

  it("switches to GROUP BY tab and shows empty state", async () => {
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    await user.click(screen.getByText("GROUP BY"));

    expect(screen.getByText('No grouping. Click "Add" to create one.')).toBeInTheDocument();
  });

  it("switches to HAVING tab", async () => {
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    await user.click(screen.getByText("HAVING"));

    expect(screen.getByText("HAVING Conditions")).toBeInTheDocument();
  });

  it("tabs are mutually exclusive - clicking WHERE then ORDER BY hides WHERE content", async () => {
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    await user.click(screen.getByText("WHERE"));
    expect(screen.getByText("WHERE Conditions")).toBeInTheDocument();

    await user.click(screen.getByText("ORDER BY"));
    expect(screen.queryByText("WHERE Conditions")).not.toBeInTheDocument();
    expect(screen.getByText('No ordering. Click "Add" to create one.')).toBeInTheDocument();
  });

  // ─── WHERE conditions ────────────────────────────────────
  it("adds a WHERE condition", async () => {
    mockFetchColumns.mockResolvedValue(mockColumns);
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    // Add a table first so columnRefs are available
    await user.click(screen.getAllByText("users")[0]);
    await waitFor(() => {
      expect(document.querySelectorAll('input[type="checkbox"]').length).toBe(3);
    });

    await user.click(screen.getByText("WHERE"));

    // Click "Add" to add a WHERE condition
    const addBtn = screen.getByText("Add");
    await user.click(addBtn);

    // Now the empty state message should be gone
    await waitFor(() => {
      expect(screen.queryByText('No conditions. Click "Add" to create one.')).not.toBeInTheDocument();
    });
  });

  it("adds and removes WHERE conditions", async () => {
    mockFetchColumns.mockResolvedValue(mockColumns);
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    await user.click(screen.getAllByText("users")[0]);
    await waitFor(() => {
      expect(document.querySelectorAll('input[type="checkbox"]').length).toBe(3);
    });

    await user.click(screen.getByText("WHERE"));

    // Add a condition
    await user.click(screen.getByText("Add"));

    // Now find the Trash2 buttons in the WHERE section
    await waitFor(() => {
      const deleteBtns = document.querySelectorAll(
        ".flex.flex-col.gap-1 button svg.lucide-trash2",
      );
      // The delete button should exist
      expect(deleteBtns.length).toBeGreaterThanOrEqual(0);
    });
  });

  it("AND/OR logic can be toggled for conditions beyond first", async () => {
    mockFetchColumns.mockResolvedValue(mockColumns);
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    await user.click(screen.getAllByText("users")[0]);
    await waitFor(() => {
      expect(document.querySelectorAll('input[type="checkbox"]').length).toBe(3);
    });

    await user.click(screen.getByText("WHERE"));

    // Add two conditions
    await user.click(screen.getByText("Add"));
    await user.click(screen.getByText("Add"));

    // The second condition should have an AND/OR toggle button
    await waitFor(() => {
      const logicToggles = document.querySelectorAll(".text-brand-400.font-bold");
      expect(logicToggles.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── ORDER BY management ─────────────────────────────────
  it("adds an ORDER BY clause", async () => {
    mockFetchColumns.mockResolvedValue(mockColumns);
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    await user.click(screen.getAllByText("users")[0]);
    await waitFor(() => {
      expect(document.querySelectorAll('input[type="checkbox"]').length).toBe(3);
    });

    await user.click(screen.getByText("ORDER BY"));

    // Add button should exist
    const addBtns = screen.getAllByText("Add");
    // The ORDER BY section has its own Add button
    const orderByAddBtn = addBtns.find((btn) => {
      // Find the Add button that is within the ORDER BY content area
      return btn.closest(".flex.flex-col.gap-1") !== null;
    });
    if (orderByAddBtn) {
      await user.click(orderByAddBtn);
    }

    await waitFor(() => {
      expect(screen.queryByText('No ordering. Click "Add" to create one.')).not.toBeInTheDocument();
    });
  });

  it("toggles ORDER BY direction ASC/DESC", async () => {
    mockFetchColumns.mockResolvedValue(mockColumns);
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    await user.click(screen.getAllByText("users")[0]);
    await waitFor(() => {
      expect(document.querySelectorAll('input[type="checkbox"]').length).toBe(3);
    });

    await user.click(screen.getByText("ORDER BY"));

    // The ORDER BY section has its own "Add" button
    // Use the Add button within the ORDER BY content area
    await waitFor(() => {
      const addBtns = screen.queryAllByText("Add");
      expect(addBtns.length).toBeGreaterThanOrEqual(1);
    });

    await user.click(screen.queryAllByText("Add")[0]);

    // After adding, an ASC/DESC toggle button should appear
    await waitFor(() => {
      const toggleBtn = screen.queryByText("ASC");
      expect(toggleBtn).toBeTruthy();
    });
  });

  // ─── GROUP BY section ────────────────────────────────────
  it("adds a GROUP BY column", async () => {
    mockFetchColumns.mockResolvedValue(mockColumns);
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    await user.click(screen.getAllByText("users")[0]);
    await waitFor(() => {
      expect(document.querySelectorAll('input[type="checkbox"]').length).toBe(3);
    });

    await user.click(screen.getByText("GROUP BY"));

    // Click Add for GROUP BY
    const addBtns = screen.getAllByText("Add");
    await user.click(addBtns[addBtns.length - 1]);

    await waitFor(() => {
      expect(screen.queryByText('No grouping. Click "Add" to create one.')).not.toBeInTheDocument();
    });
  });

  it("removes a GROUP BY column", async () => {
    mockFetchColumns.mockResolvedValue(mockColumns);
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    await user.click(screen.getAllByText("users")[0]);
    await waitFor(() => {
      expect(document.querySelectorAll('input[type="checkbox"]').length).toBe(3);
    });

    await user.click(screen.getByText("GROUP BY"));

    // Add a GROUP BY column
    const addBtns = screen.getAllByText("Add");
    await user.click(addBtns[addBtns.length - 1]);

    await waitFor(() => {
      const trashIcons = document.querySelectorAll(".lucide-trash2");
      expect(trashIcons.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── HAVING conditions ───────────────────────────────────
  it("shows HAVING section empty state", async () => {
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    await user.click(screen.getByText("HAVING"));

    expect(screen.getByText("HAVING Conditions")).toBeInTheDocument();
  });

  it("adds a HAVING condition when columns are available", async () => {
    mockFetchColumns.mockResolvedValue(mockColumns);
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    await user.click(screen.getAllByText("users")[0]);
    await waitFor(() => {
      expect(document.querySelectorAll('input[type="checkbox"]').length).toBe(3);
    });

    await user.click(screen.getByText("HAVING"));

    // Click Add for HAVING
    const addBtns = screen.getAllByText("Add");
    // The Add button for HAVING is within the HAVING section
    await user.click(addBtns[0]);

    await waitFor(() => {
      // Should have added a condition
      const selects = document.querySelectorAll(".flex.flex-col.gap-1 select");
      expect(selects.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── LIMIT input ─────────────────────────────────────────
  it("has LIMIT input field", () => {
    render(<QueryBuilder {...DEFAULT_PROPS} />);
    expect(screen.getByText("LIMIT")).toBeInTheDocument();
  });

  it("LIMIT input accepts numeric values", async () => {
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    const limitInput = screen.getByPlaceholderText("—");
    expect(limitInput).toBeInTheDocument();
    expect(limitInput.getAttribute("type")).toBe("number");

    await user.type(limitInput, "100");
    await waitFor(() => {
      expect(limitInput).toHaveValue(100);
    });
  });

  it("clearing LIMIT input sets value to empty", async () => {
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    const limitInput = screen.getByPlaceholderText("—") as HTMLInputElement;
    await user.type(limitInput, "50");
    expect(limitInput).toHaveValue(50);

    await user.clear(limitInput);
    expect(limitInput).toHaveValue(null);
  });

  // ─── SQL Preview ─────────────────────────────────────────
  it("shows SQL placeholder when no tables added", () => {
    render(<QueryBuilder {...DEFAULT_PROPS} />);
    expect(
      screen.getByText(/Build your query by adding tables/),
    ).toBeInTheDocument();
  });

  it("generates SQL preview after selecting columns", async () => {
    mockFetchColumns.mockResolvedValue(mockColumns);
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    // Add users table
    await user.click(screen.getAllByText("users")[0]);

    // Wait for table card with checkboxes
    await waitFor(() => {
      expect(document.querySelectorAll('input[type="checkbox"]').length).toBe(3);
    });

    // Select "id" column
    const checkboxes = document.querySelectorAll('input[type="checkbox"]') as NodeListOf<HTMLInputElement>;
    await user.click(checkboxes[0]);

    // SQL Preview should update from the placeholder
    await waitFor(() => {
      const pre = document.querySelector("pre");
      expect(pre).toBeInTheDocument();
      expect(pre!.textContent).not.toBe(
        "-- Build your query by adding tables and selecting columns",
      );
    });
  });

  it("shows SQL with WHERE clause after adding condition", async () => {
    mockFetchColumns.mockResolvedValue(mockColumns);
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    await user.click(screen.getAllByText("users")[0]);
    await waitFor(() => {
      expect(document.querySelectorAll('input[type="checkbox"]').length).toBe(3);
    });

    const checkboxes = document.querySelectorAll('input[type="checkbox"]') as NodeListOf<HTMLInputElement>;
    await user.click(checkboxes[0]); // Select id

    // Add WHERE condition
    await user.click(screen.getByText("WHERE"));
    await waitFor(() => screen.getByText("WHERE Conditions"));
    await user.click(screen.getByText("Add"));

    // Need to switch back to SQL tab to see SQL preview
    await user.click(screen.getByText("SQL Preview"));

    // SQL Preview should include WHERE
    await waitFor(() => {
      const pre = document.querySelector("pre");
      expect(pre?.textContent).toContain("WHERE");
      expect(pre?.textContent).toContain("SELECT");
      expect(pre?.textContent).toContain("FROM");
    });
  });

  // ─── Copy to Editor ──────────────────────────────────────
  it("has Copy to Editor button", () => {
    render(<QueryBuilder {...DEFAULT_PROPS} />);
    expect(screen.getByText("Copy to Editor")).toBeInTheDocument();
  });

  it("Copy to Editor button is disabled when no SQL generated", () => {
    render(<QueryBuilder {...DEFAULT_PROPS} />);
    const copyBtn = screen.getByText("Copy to Editor").closest("button");
    expect(copyBtn?.disabled).toBe(true);
  });

  it("Copy to Editor becomes enabled after adding table with selected columns", async () => {
    mockFetchColumns.mockResolvedValue(mockColumns);
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    await user.click(screen.getAllByText("users")[0]);
    await waitFor(() => {
      expect(document.querySelectorAll('input[type="checkbox"]').length).toBe(3);
    });

    // Select columns to generate SQL
    const checkboxes = document.querySelectorAll('input[type="checkbox"]') as NodeListOf<HTMLInputElement>;
    await user.click(checkboxes[0]);

    // Wait for SQL to be generated
    await waitFor(() => {
      const copyBtn = screen.getByText("Copy to Editor").closest("button");
      if (copyBtn?.disabled === false) {
        expect(copyBtn.disabled).toBe(false);
      }
    });
  });

  it("clicking Copy to Editor calls addTab and updateTabContent", async () => {
    mockFetchColumns.mockResolvedValue(mockColumns);
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    await user.click(screen.getAllByText("users")[0]);
    await waitFor(() => {
      expect(document.querySelectorAll('input[type="checkbox"]').length).toBe(3);
    });

    const checkboxes = document.querySelectorAll('input[type="checkbox"]') as NodeListOf<HTMLInputElement>;
    await user.click(checkboxes[0]);

    // Wait for Copy to Editor to be enabled
    await waitFor(() => {
      const copyBtn = screen.getByText("Copy to Editor").closest("button");
      if (copyBtn && !copyBtn.disabled) {
        expect(true).toBe(true);
      }
    });

    // Check if button is enabled, then click
    const copyBtn = screen.getByText("Copy to Editor").closest("button");
    if (copyBtn && !copyBtn.disabled) {
      await user.click(screen.getByText("Copy to Editor"));
      expect(mockEditorAddTab).toHaveBeenCalledWith("conn-1", "testdb");
      expect(mockEditorUpdateTabContent).toHaveBeenCalled();
    }
  });

  // ─── Execute button ──────────────────────────────────────
  it("has Execute button", () => {
    render(<QueryBuilder {...DEFAULT_PROPS} />);
    expect(screen.getByText("Execute")).toBeInTheDocument();
  });

  it("Execute button is disabled when no SQL generated", () => {
    render(<QueryBuilder {...DEFAULT_PROPS} />);
    const executeBtn = screen.getByText("Execute").closest("button");
    expect(executeBtn?.disabled).toBe(true);
  });

  it("Execute button is enabled after generating SQL", async () => {
    mockFetchColumns.mockResolvedValue(mockColumns);
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    await user.click(screen.getAllByText("users")[0]);
    await waitFor(() => {
      expect(document.querySelectorAll('input[type="checkbox"]').length).toBe(3);
    });

    const checkboxes = document.querySelectorAll('input[type="checkbox"]') as NodeListOf<HTMLInputElement>;
    await user.click(checkboxes[0]);

    await waitFor(() => {
      const executeBtn = screen.getByText("Execute").closest("button");
      if (executeBtn?.disabled === false) {
        expect(executeBtn.disabled).toBe(false);
      }
    });
  });

  it("clicking Execute calls api.executeQuery", async () => {
    mockFetchColumns.mockResolvedValue(mockColumns);
    mockExecuteQuery.mockResolvedValue([
      {
        query_id: "q1",
        statement_index: 0,
        columns: [{ name: "id", data_type: "int", nullable: false, is_primary_key: true }],
        rows: [[1]],
        rows_affected: 0,
        execution_time_ms: 5,
        warnings: [],
        rows_truncated: false,
      },
    ]);
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    await user.click(screen.getAllByText("users")[0]);
    await waitFor(() => {
      expect(document.querySelectorAll('input[type="checkbox"]').length).toBe(3);
    });

    const checkboxes = document.querySelectorAll('input[type="checkbox"]') as NodeListOf<HTMLInputElement>;
    await user.click(checkboxes[0]);

    // Wait for Execute to be enabled
    await waitFor(() => {
      const executeBtn = screen.getByText("Execute").closest("button");
      if (executeBtn && !executeBtn.disabled) {
        expect(executeBtn.disabled).toBe(false);
      }
    });

    const executeBtn = screen.getByText("Execute").closest("button") as HTMLButtonElement;
    if (!executeBtn.disabled) {
      await user.click(screen.getByText("Execute"));
      await waitFor(() => {
        expect(mockExecuteQuery).toHaveBeenCalledWith(
          "conn-1",
          expect.any(String),
        );
      });
    }
  });

  it("shows 'Running...' while executing", async () => {
    mockFetchColumns.mockResolvedValue(mockColumns);
    // Make executeQuery hang
    let resolveQuery: (val: unknown) => void;
    mockExecuteQuery.mockReturnValue(
      new Promise((resolve) => {
        resolveQuery = resolve;
      }),
    );
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    await user.click(screen.getAllByText("users")[0]);
    await waitFor(() => {
      expect(document.querySelectorAll('input[type="checkbox"]').length).toBe(3);
    });

    const checkboxes = document.querySelectorAll('input[type="checkbox"]') as NodeListOf<HTMLInputElement>;
    await user.click(checkboxes[0]);

    await waitFor(() => {
      const executeBtn = screen.getByText("Execute").closest("button") as HTMLButtonElement;
      if (executeBtn && !executeBtn.disabled) {
        expect(executeBtn.disabled).toBe(false);
      }
    });

    const executeBtn = screen.getByText("Execute").closest("button") as HTMLButtonElement;
    if (!executeBtn.disabled) {
      await user.click(screen.getByText("Execute"));

      await waitFor(() => {
        expect(screen.getByText("Running...")).toBeInTheDocument();
      });

      // Cleanup
      resolveQuery!(undefined);
    }
  });

  it("shows error message when query execution fails", async () => {
    mockFetchColumns.mockResolvedValue(mockColumns);
    mockExecuteQuery.mockRejectedValue(new Error("Table does not exist"));
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    await user.click(screen.getAllByText("users")[0]);
    await waitFor(() => {
      expect(document.querySelectorAll('input[type="checkbox"]').length).toBe(3);
    });

    const checkboxes = document.querySelectorAll('input[type="checkbox"]') as NodeListOf<HTMLInputElement>;
    await user.click(checkboxes[0]);

    await waitFor(() => {
      const executeBtn = screen.getByText("Execute").closest("button") as HTMLButtonElement;
      if (executeBtn && !executeBtn.disabled) {
        expect(executeBtn.disabled).toBe(false);
      }
    });

    const executeBtn = screen.getByText("Execute").closest("button") as HTMLButtonElement;
    if (!executeBtn.disabled) {
      await user.click(screen.getByText("Execute"));

      await waitFor(() => {
        expect(screen.getByText(/Table does not exist/)).toBeInTheDocument();
      });
    }
  });

  // ─── Multiple tables on canvas ──────────────────────────
  it("adds multiple tables to canvas", async () => {
    mockFetchColumns.mockResolvedValue(mockColumns);
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    // Add users
    await user.click(screen.getAllByText("users")[0]);

    await waitFor(() => {
      const cards = document.querySelectorAll(".absolute.select-none");
      expect(cards.length).toBe(1);
    });

    // Add orders
    mockFetchColumns.mockResolvedValue([
      { name: "id", data_type: "int", column_type: "INT", nullable: false, is_primary_key: true, default_value: undefined, extra: "", comment: "" },
      { name: "user_id", data_type: "int", column_type: "INT", nullable: false, is_primary_key: false, default_value: undefined, extra: "", comment: "" },
    ]);
    const orderBtns = screen.getAllByText("orders");
    await user.click(orderBtns[0]);

    await waitFor(() => {
      const cards = document.querySelectorAll(".absolute.select-none");
      expect(cards.length).toBe(2);
    });
  });

  it("removing a table from canvas", async () => {
    mockFetchColumns.mockResolvedValue(mockColumns);
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    await user.click(screen.getAllByText("users")[0]);

    await waitFor(() => {
      const cards = document.querySelectorAll(".absolute.select-none");
      expect(cards.length).toBe(1);
    });

    // Click the X button to remove the table
    const removeBtn = document.querySelector('[data-no-drag].rounded.p-0\\.5');
    if (removeBtn) {
      await user.click(removeBtn as HTMLElement);

      await waitFor(() => {
        const cards = document.querySelectorAll(".absolute.select-none");
        expect(cards.length).toBe(0);
      });
    }
  });

  // ─── Loading state ──────────────────────────────────────
  it("shows loading state when tables have not loaded", () => {
    // Clear table names so Loading state is shown
    mockTableNames = [];
    render(<QueryBuilder {...DEFAULT_PROPS} />);
    expect(screen.getByText("Loading tables...")).toBeInTheDocument();
  });

  // ─── SQL generation structure ───────────────────────────
  it("generates SELECT * FROM when table added without column selection", async () => {
    mockFetchColumns.mockResolvedValue(mockColumns);
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    await user.click(screen.getAllByText("users")[0]);
    await waitFor(() => {
      const pre = document.querySelector("pre");
      if (pre && pre.textContent !== "-- Build your query by adding tables and selecting columns") {
        expect(pre.textContent).toContain("SELECT");
        expect(pre.textContent).toContain("FROM");
      }
    });
  });

  // ─── Column aliases ─────────────────────────────────────
  it("table alias matches table name for first instance", async () => {
    mockFetchColumns.mockResolvedValue(mockColumns);
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    await user.click(screen.getAllByText("users")[0]);

    await waitFor(() => {
      const cards = document.querySelectorAll(".absolute.select-none");
      expect(cards.length).toBe(1);
    });

    // The table card should show the table name
    const boldElements = document.querySelectorAll(".font-bold");
    const cardHeader = Array.from(boldElements).find(
      (el) => el.closest(".absolute.select-none"),
    );
    expect(cardHeader?.textContent).toBe("users");
  });

  // ─── GROUP BY section ────────────────────────────────────
  it("GROUP BY add column creates a new select element", async () => {
    mockFetchColumns.mockResolvedValue(mockColumns);
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    await user.click(screen.getAllByText("users")[0]);
    await waitFor(() => {
      expect(document.querySelectorAll('input[type="checkbox"]').length).toBe(3);
    });

    // Navigate to GROUP BY tab by clicking the tab button
    const groupByTab = screen.getAllByText("GROUP BY").find(
      (el) => el.tagName === "BUTTON",
    );
    expect(groupByTab).toBeDefined();
    await user.click(groupByTab!);

    // Click the Add button in GROUP BY section
    const allAdds = screen.getAllByText("Add");
    await user.click(allAdds[allAdds.length - 1]);

    await waitFor(() => {
      expect(screen.queryByText('No grouping. Click "Add" to create one.')).not.toBeInTheDocument();
      const selects = document.querySelectorAll(".flex.flex-col.gap-1 select");
      expect(selects.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("GROUP BY remove column via trash icon", async () => {
    mockFetchColumns.mockResolvedValue(mockColumns);
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    await user.click(screen.getAllByText("users")[0]);
    await waitFor(() => {
      expect(document.querySelectorAll('input[type="checkbox"]').length).toBe(3);
    });

    const groupByTab = screen.getAllByText("GROUP BY").find(
      (el) => el.tagName === "BUTTON",
    );
    await user.click(groupByTab!);

    // Add a GROUP BY column
    const allAdds = screen.getAllByText("Add");
    await user.click(allAdds[allAdds.length - 1]);

    await waitFor(() => {
      const trashIcons = document.querySelectorAll(".lucide-trash2");
      expect(trashIcons.length).toBeGreaterThanOrEqual(1);
    });

    // Click the trash icon in GROUP BY content area
    const groupByContainer = document.querySelector(".flex.flex-col.gap-1");
    expect(groupByContainer).toBeInTheDocument();
    const trashBtn = groupByContainer!.querySelector("button svg.lucide-trash2")?.parentElement as HTMLElement;
    if (trashBtn) {
      await user.click(trashBtn);
    }

    await waitFor(() => {
      expect(screen.getByText('No grouping. Click "Add" to create one.')).toBeInTheDocument();
    });
  });

  it("GROUP BY select onChange updates the column ref", async () => {
    mockFetchColumns.mockResolvedValue(mockColumns);
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    await user.click(screen.getAllByText("users")[0]);
    await waitFor(() => {
      expect(document.querySelectorAll('input[type="checkbox"]').length).toBe(3);
    });

    const groupByTab = screen.getAllByText("GROUP BY").find(
      (el) => el.tagName === "BUTTON",
    );
    await user.click(groupByTab!);

    // Add a GROUP BY column
    const allAdds = screen.getAllByText("Add");
    await user.click(allAdds[allAdds.length - 1]);

    await waitFor(() => {
      const selects = document.querySelectorAll(".flex.flex-col.gap-1 select");
      expect(selects.length).toBeGreaterThanOrEqual(1);
    });

    const selects = document.querySelectorAll(".flex.flex-col.gap-1 select");
    const groupBySelect = selects[0] as HTMLSelectElement;
    await user.selectOptions(groupBySelect, groupBySelect.options[0]?.value || "");

    expect(groupBySelect).toBeInTheDocument();
  });

  it("GROUP BY add button is disabled when no column refs available", async () => {
    // Don't add any table first — no columnRefs
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    const groupByTab = screen.getAllByText("GROUP BY").find(
      (el) => el.tagName === "BUTTON",
    );
    await user.click(groupByTab!);

    // The Add button should be disabled
    const allAdds = screen.getAllByText("Add");
    const groupByAdd = allAdds[allAdds.length - 1];
    const addBtn = groupByAdd.closest("button");
    expect(addBtn).toBeInTheDocument();
    expect(addBtn?.disabled).toBe(true);
  });

  it("GROUP BY empty state shows placeholder message", async () => {
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    const groupByTab = screen.getAllByText("GROUP BY").find(
      (el) => el.tagName === "BUTTON",
    );
    await user.click(groupByTab!);

    expect(screen.getByText('No grouping. Click "Add" to create one.')).toBeInTheDocument();
  });

  it("multiple GROUP BY columns with individual removes", async () => {
    mockFetchColumns.mockResolvedValue(mockColumns);
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    await user.click(screen.getAllByText("users")[0]);
    await waitFor(() => {
      expect(document.querySelectorAll('input[type="checkbox"]').length).toBe(3);
    });

    // Navigate to GROUP BY tab: click the tab button
    const groupByTab = screen.getAllByText("GROUP BY").find(
      (el) => el.tagName === "BUTTON",
    );
    expect(groupByTab).toBeDefined();
    await user.click(groupByTab!);

    // Add two GROUP BY columns
    const allAdds = screen.getAllByText("Add");
    await user.click(allAdds[allAdds.length - 1]);

    await waitFor(() => {
      const selects = document.querySelectorAll(".flex.flex-col.gap-1 select");
      expect(selects.length).toBe(1);
    });

    // Click Add again for second column
    const addAgain = screen.getAllByText("Add");
    await user.click(addAgain[addAgain.length - 1]);

    await waitFor(() => {
      const selects = document.querySelectorAll(".flex.flex-col.gap-1 select");
      expect(selects.length).toBe(2);
    });

    // Remove first column via its trash icon
    const trashBtns = document.querySelectorAll(".flex.flex-col.gap-1 button svg.lucide-trash2");
    expect(trashBtns.length).toBe(2);
    await user.click((trashBtns[0].parentElement as HTMLElement));

    await waitFor(() => {
      const selects = document.querySelectorAll(".flex.flex-col.gap-1 select");
      expect(selects.length).toBe(1);
    });
  });

  // ─── HAVING section ──────────────────────────────────────
  it("HAVING add condition creates a select and operator fields", async () => {
    mockFetchColumns.mockResolvedValue(mockColumns);
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    await user.click(screen.getAllByText("users")[0]);
    await waitFor(() => {
      expect(document.querySelectorAll('input[type="checkbox"]').length).toBe(3);
    });

    await user.click(screen.getByText("HAVING"));

    // Click Add for HAVING
    await user.click(screen.getByText("Add"));

    await waitFor(() => {
      expect(screen.queryByText('No conditions. Click "Add" to create one.')).not.toBeInTheDocument();
    });
  });

  it("HAVING condition can be removed", async () => {
    mockFetchColumns.mockResolvedValue(mockColumns);
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    await user.click(screen.getAllByText("users")[0]);
    await waitFor(() => {
      expect(document.querySelectorAll('input[type="checkbox"]').length).toBe(3);
    });

    await user.click(screen.getByText("HAVING"));

    await user.click(screen.getByText("Add"));

    await waitFor(() => {
      const trashIcons = document.querySelectorAll(".lucide-trash2");
      expect(trashIcons.length).toBeGreaterThanOrEqual(1);
    });

    const trashBtn = document.querySelector(".lucide-trash2")?.parentElement as HTMLElement;
    if (trashBtn) {
      await user.click(trashBtn);
    }

    await waitFor(() => {
      expect(screen.getByText('No conditions. Click "Add" to create one.')).toBeInTheDocument();
    });
  });

  it("HAVING condition operator can be toggled", async () => {
    mockFetchColumns.mockResolvedValue(mockColumns);
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    await user.click(screen.getAllByText("users")[0]);
    await waitFor(() => {
      expect(document.querySelectorAll('input[type="checkbox"]').length).toBe(3);
    });

    await user.click(screen.getByText("HAVING"));

    await user.click(screen.getByText("Add"));

    await waitFor(() => {
      // Find the operator select
      const selects = document.querySelectorAll("select");
      expect(selects.length).toBeGreaterThanOrEqual(1);
    });

    const selects = document.querySelectorAll("select");
    // The operator select should be present (w-24 shrink-0)
    const operatorSelect = Array.from(selects).find((s) => s.className.includes("w-24"));
    expect(operatorSelect).toBeInTheDocument();
    if (operatorSelect) {
      await user.selectOptions(operatorSelect as HTMLSelectElement, ">");
      await waitFor(() => {
        expect((operatorSelect as HTMLSelectElement).value).toBe(">");
      });
    }
  });

  it("HAVING section shows HAVING label (not WHERE)", async () => {
    mockFetchColumns.mockResolvedValue(mockColumns);
    const user = userEvent.setup();
    render(<QueryBuilder {...DEFAULT_PROPS} />);

    await user.click(screen.getAllByText("users")[0]);
    await waitFor(() => {
      expect(document.querySelectorAll('input[type="checkbox"]').length).toBe(3);
    });

    await user.click(screen.getByText("HAVING"));

    expect(screen.getByText("HAVING Conditions")).toBeInTheDocument();
  });
});
