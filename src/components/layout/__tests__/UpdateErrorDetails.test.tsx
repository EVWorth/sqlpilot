import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCheckForUpdates = vi.fn();
let settings = {
  updateStatus: "error" as string,
  updateVersion: null as string | null,
  updateError: "signature verification failed",
  checkForUpdates: mockCheckForUpdates,
};

vi.mock("../../../stores/settingsStore", () => ({
  useSettingsStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector(settings),
    { getState: () => settings },
  ),
}));

import { UpdateErrorDetails } from "../UpdateErrorDetails";

function renderIt(props = {}) {
  return render(
    <UpdateErrorDetails appVersion="2.1.0" packageFormat="deb" {...props} />,
  );
}

describe("UpdateErrorDetails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings = {
      updateStatus: "error",
      updateVersion: null,
      updateError: "signature verification failed",
      checkForUpdates: mockCheckForUpdates,
    };
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  it("renders nothing unless an update actually failed", () => {
    settings.updateStatus = "up-to-date";
    const { container } = renderIt();
    expect(container.firstChild).toBeNull();
  });

  it("shows the chip when one did", () => {
    renderIt();
    expect(screen.getByText("Update failed")).toBeInTheDocument();
  });

  it("keeps the panel closed until asked", () => {
    renderIt();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens and closes the panel", () => {
    renderIt();

    fireEvent.click(screen.getByText("Update failed"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Close update error details"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes on a click outside", () => {
    renderIt();
    fireEvent.click(screen.getByText("Update failed"));

    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("stays open for a click inside", () => {
    renderIt();
    fireEvent.click(screen.getByText("Update failed"));

    fireEvent.mouseDown(screen.getByRole("dialog"));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("shows the driver error and a diagnostic", () => {
    renderIt();
    fireEvent.click(screen.getByText("Update failed"));

    expect(screen.getAllByText(/signature verification failed/).length).toBeGreaterThan(0);
    expect(screen.getByText(/SQLPilot v2\.1\.0/)).toBeInTheDocument();
    expect(screen.getByText(/Install type: deb/)).toBeInTheDocument();
  });

  it("says the install type is unknown rather than blank", () => {
    renderIt({ packageFormat: null });
    fireEvent.click(screen.getByText("Update failed"));
    expect(screen.getByText(/Install type: unknown/)).toBeInTheDocument();
  });

  it("copies the diagnostic", async () => {
    renderIt();
    fireEvent.click(screen.getByText("Update failed"));

    fireEvent.click(screen.getByText("Copy diagnostic"));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining("SQLPilot v2.1.0"),
    );
  });

  it("retries and closes", () => {
    renderIt();
    fireEvent.click(screen.getByText("Update failed"));

    fireEvent.click(screen.getByText("Retry"));

    expect(mockCheckForUpdates).toHaveBeenCalledWith(true);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens a prefilled issue", () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    renderIt();
    fireEvent.click(screen.getByText("Update failed"));

    fireEvent.click(screen.getByText("Report issue"));

    const [url] = open.mock.calls[0];
    expect(url).toContain("github.com/EVWorth/sqlpilot/issues/new");
    expect(decodeURIComponent(url)).toContain("signature verification failed");
    vi.unstubAllGlobals();
  });

  it("drops its open state when the status stops being an error", () => {
    // An early `return null` does not unmount, so without an explicit reset
    // the panel comes back open on the next failure. StatusBar used to own
    // that reset; it lives with the state now.
    const { rerender } = renderIt();
    fireEvent.click(screen.getByText("Update failed"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    settings.updateStatus = "up-to-date";
    rerender(<UpdateErrorDetails appVersion="2.1.0" packageFormat="deb" />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    settings.updateStatus = "error";
    rerender(<UpdateErrorDetails appVersion="2.1.0" packageFormat="deb" />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
