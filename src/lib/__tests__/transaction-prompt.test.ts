import { describe, expect, it } from "vitest";
import type { EditorTab } from "../../types";
import { endedTransactionsText } from "../transaction-prompt";

const tab = (id: string, title: string, connectionId?: string) =>
  ({ id, title, connectionId, content: "", type: "query", isDirty: false }) as EditorTab;
const fileName = (id: string) => (id === "lite-1" ? "app.db" : "other.db");

describe("endedTransactionsText", () => {
  it("says a tab's own session ends, as before (#843)", () => {
    const text = endedTransactionsText(
      [tab("t1", "Orders fix", "conn-1")],
      { open: { t1: true }, openConnections: {} },
      fileName,
      "Closing",
    );
    expect(text).toEqual([
      "\"Orders fix\" has a transaction open. Closing ends the session, which rolls back everything not committed.",
    ]);
  });

  // #935: the transaction is on the file's connection, not on the tab.
  it("names the file whose connection holds the transaction", () => {
    const text = endedTransactionsText(
      [tab("t1", "Notes", "lite-1")],
      { open: {}, openConnections: { "lite-1": true } },
      fileName,
      "Switching",
    );
    expect(text).toEqual([
      "\"Notes\" is the last tab on app.db, and a transaction is open on the file's connection. "
      + "Switching rolls back everything not committed on it.",
    ]);
  });

  it("says each, one sentence per file, after the sessions", () => {
    const text = endedTransactionsText(
      [tab("t1", "A", "lite-1"), tab("t2", "B", "conn-1"), tab("t3", "C", "lite-1"), tab("t4", "D", "lite-2")],
      { open: { t2: true }, openConnections: { "lite-1": true, "lite-2": true } },
      fileName,
      "Closing",
    );
    expect(text).toHaveLength(3);
    expect(text[0]).toMatch(/^"B" has a transaction open/);
    expect(text[1]).toMatch(/^"A", "C" are the last tabs on app\.db/);
    expect(text[2]).toMatch(/^"D" is the last tab on other\.db/);
  });
});
