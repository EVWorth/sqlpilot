import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useContextMenu } from "../../../hooks/useContextMenu";
import { ConnectionTab } from "../ConnectionTab";

const conn = {
  id: "c1",
  profile_id: "p1",
  name: "Local dev",
  host: "127.0.0.1",
  port: 3306,
  database: null,
  server_version: "8.0.36",
  connected_at: "2026-01-01T00:00:00Z",
  color: null,
  environment: null,
};

/** The tab with the app's real context menu, as ConnectionTabs wires it. */
function Harness({ onEdit }: { onEdit: () => void }) {
  const { contextMenu, showContextMenuAt } = useContextMenu();
  return (
    <>
      <ConnectionTab
        conn={conn}
        profile={undefined}
        isSelected
        focusable
        state="Connected"
        onSelect={() => {}}
        onDisconnect={() => {}}
        onMenu={(x, y) => showContextMenuAt(x, y, [{ label: "Edit Connection", onClick: onEdit }])}
      />
      {contextMenu}
    </>
  );
}

describe("ConnectionTab menu from the keyboard (#827, with #823's menu)", () => {
  it("opens with Shift+F10, takes focus and gives it back on Escape", () => {
    const onEdit = vi.fn();
    render(<Harness onEdit={onEdit} />);
    const tab = screen.getByRole("tab");
    tab.focus();

    fireEvent.keyDown(tab, { key: "F10", shiftKey: true });
    const item = screen.getByRole("menuitem", { name: /Edit Connection/ });
    expect(document.activeElement).toBe(item);

    fireEvent.keyDown(item, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(tab);
  });
});
