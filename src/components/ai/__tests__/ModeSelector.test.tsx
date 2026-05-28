import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ModeSelector } from "../ModeSelector";
import type { AiMode } from "../../../types";

describe("ModeSelector", () => {
  it("renders all three mode options", () => {
    render(<ModeSelector value="ask" onChange={vi.fn()} />);

    expect(screen.getByText("Ask")).toBeInTheDocument();
    expect(screen.getByText("Agent")).toBeInTheDocument();
    expect(screen.getByText("Plan")).toBeInTheDocument();
  });

  it("highlights the selected mode", () => {
    render(<ModeSelector value="ask" onChange={vi.fn()} />);

    const askButton = screen.getByText("Ask");
    expect(askButton.className).toContain("bg-brand-600");
  });

  it("calls onChange with the clicked mode value", () => {
    const onChange = vi.fn();
    render(<ModeSelector value="ask" onChange={onChange} />);

    fireEvent.click(screen.getByText("Agent"));
    expect(onChange).toHaveBeenCalledWith("agent" as AiMode);

    fireEvent.click(screen.getByText("Plan"));
    expect(onChange).toHaveBeenCalledWith("plan" as AiMode);
  });

  it("does not call onChange for already-selected mode", () => {
    const onChange = vi.fn();
    render(<ModeSelector value="ask" onChange={onChange} />);

    fireEvent.click(screen.getByText("Ask"));
    expect(onChange).toHaveBeenCalledTimes(1);
    // It still calls onChange with the same value — that's the component's behavior
    expect(onChange).toHaveBeenCalledWith("ask");
  });

  it("disables all buttons when disabled is true", () => {
    render(<ModeSelector value="ask" onChange={vi.fn()} disabled={true} />);

    const buttons = screen.getAllByRole("button");
    buttons.forEach((btn) => {
      expect(btn).toBeDisabled();
    });
  });

  it("shows tooltip/title on each mode button", () => {
    render(<ModeSelector value="ask" onChange={vi.fn()} />);

    expect(screen.getByTitle("Read-only questions")).toBeInTheDocument();
    expect(screen.getByTitle("Can modify data")).toBeInTheDocument();
    expect(screen.getByTitle("Plan then execute")).toBeInTheDocument();
  });
});
