import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { ColorPicker } from "../ColorPicker";

function Host({ initial }: { initial: string | null }) {
  const [color, setColor] = useState<string | null>(initial);
  return (
    <>
      <span id="label">Color</span>
      <ColorPicker value={color} onChange={setColor} labelledBy="label" />
      <output data-testid="value">{color ?? ""}</output>
    </>
  );
}

describe("ColorPicker (#834)", () => {
  it("names the presets and marks none selected when there is no colour", () => {
    render(<Host initial={null} />);
    expect(screen.getByRole("group", { name: "Color" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Amber" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Custom colour" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText("Clear")).toBeNull();
  });

  it("matches a preset whatever the case of the saved value", () => {
    render(<Host initial="#f59e0b" />);
    expect(screen.getByRole("button", { name: "Amber" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Custom colour" })).toHaveAttribute("aria-pressed", "false");
  });

  it("shows a colour outside the presets as the selected custom swatch", () => {
    render(<Host initial="#22c55e" />);
    const custom = screen.getByRole("button", { name: "Custom colour, #22c55e" });
    expect(custom).toHaveAttribute("aria-pressed", "true");
    expect(custom).toHaveStyle({ backgroundColor: "#22c55e" });
    expect(screen.getAllByRole("button", { pressed: true })).toHaveLength(1);
    expect(screen.getByLabelText("Custom colour value")).toHaveValue("#22c55e");
  });

  it("takes any colour from the custom picker", () => {
    render(<Host initial={null} />);
    fireEvent.change(screen.getByLabelText("Custom colour value"), { target: { value: "#123456" } });
    expect(screen.getByTestId("value")).toHaveTextContent("#123456");
    expect(screen.getByRole("button", { name: "Custom colour, #123456" })).toHaveAttribute("aria-pressed", "true");
  });

  it("picks a preset and clears", () => {
    render(<Host initial="#22c55e" />);
    fireEvent.click(screen.getByRole("button", { name: "Violet" }));
    expect(screen.getByRole("button", { name: "Violet" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByText("Clear"));
    expect(screen.getByTestId("value")).toHaveTextContent("");
  });
});
