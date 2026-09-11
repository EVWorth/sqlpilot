import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HighlightedName } from "../HighlightedName";

describe("HighlightedName (#296)", () => {
  const marked = () => screen.queryByRole("mark")?.textContent;

  it("picks out where the filter matched", () => {
    // With `user` matching `users`, `user_roles` and `audit_user`, knowing
    // where it matched is most of what tells you which one you wanted.
    render(<HighlightedName name="audit_user" match="user" />);
    expect(marked()).toBe("user");
  });

  it("keeps the name's own casing", () => {
    // Matched case-insensitively, rendered as written.
    const { container } = render(<HighlightedName name="UserRoles" match="user" />);
    expect(marked()).toBe("User");
    expect(container.textContent).toBe("UserRoles");
  });

  it("marks the first match only", () => {
    render(<HighlightedName name="user_user" match="user" />);
    expect(screen.getAllByRole("mark")).toHaveLength(1);
  });

  it("renders the plain name when nothing is being filtered", () => {
    const { container } = render(<HighlightedName name="users" match="" />);
    expect(container.querySelector("mark")).toBeNull();
    expect(container.textContent).toBe("users");
  });

  it("renders the plain name when the filter does not match it", () => {
    // Reachable: a database stays visible while its own data is still
    // loading, so its children may not match.
    const { container } = render(<HighlightedName name="orders" match="zzz" />);
    expect(container.querySelector("mark")).toBeNull();
  });

  it("ignores surrounding whitespace in the filter", () => {
    render(<HighlightedName name="users" match="  use  " />);
    expect(marked()).toBe("use");
  });
});
