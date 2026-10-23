import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { RowLimitInput } from "../RowLimitInput";

// The box edits a draft and stores it on blur or Enter, so it can be emptied
// and retyped like any other number field (#848).

function Harness({ onChange }: { onChange: (n: number) => void }) {
  const [value, setValue] = useState(1000);
  return (
    <>
      <RowLimitInput
        value={value}
        onChange={(n) => {
          setValue(n);
          onChange(n);
        }}
      />
      <span data-testid="stored">{value}</span>
    </>
  );
}

function setup() {
  const onChange = vi.fn();
  render(<Harness onChange={onChange} />);
  const input = screen.getByLabelText("Row limit") as HTMLInputElement;
  return { input, onChange, user: userEvent.setup() };
}

describe("RowLimitInput", () => {
  it("can be cleared and retyped", async () => {
    const { input, onChange, user } = setup();

    await user.clear(input);
    expect(input.value).toBe("");
    await user.type(input, "250{Enter}");

    expect(input.value).toBe("250");
    expect(onChange).toHaveBeenCalledWith(250);
    expect(screen.getByTestId("stored").textContent).toBe("250");
  });

  it("shows the allowed range while the draft is out of range, and clamps it", async () => {
    const { input, onChange, user } = setup();

    await user.clear(input);
    await user.type(input, "500000");
    expect(screen.getByRole("alert").textContent).toMatch(/1–100,000/);
    expect(input.getAttribute("aria-invalid")).toBe("true");

    await user.tab();
    expect(onChange).toHaveBeenCalledWith(100000);
    expect(input.value).toBe("100000");
  });

  it("reverts an empty box on blur", async () => {
    const { input, onChange, user } = setup();

    await user.clear(input);
    await user.tab();

    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe("1000");
  });

  it("puts the stored value back on Escape", async () => {
    const { input, onChange, user } = setup();

    await user.clear(input);
    await user.type(input, "42{Escape}");

    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe("1000");
  });
});
