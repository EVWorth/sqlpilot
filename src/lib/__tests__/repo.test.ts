import { describe, expect, it } from "vitest";
import { newIssueUrl, releaseAssetUrl, releaseUrl, REPO_URL, UPDATE_ISSUE_LABELS } from "../repo";

describe("repo (#345)", () => {
  it("points at one place, so moving the project is one edit", () => {
    // The release link, the rpm-ostree command and the report URL each
    // spelled the repository out for themselves.
    expect(releaseUrl("1.2.3").startsWith(REPO_URL)).toBe(true);
    expect(releaseAssetUrl("1.2.3", "x.rpm").startsWith(REPO_URL)).toBe(true);
    expect(newIssueUrl({ title: "t", body: "b" }).startsWith(REPO_URL)).toBe(true);
  });

  it("names releases the way the tags are named", () => {
    expect(releaseUrl("0.4.1")).toBe("https://github.com/EVWorth/sqlpilot/releases/tag/v0.4.1");
  });

  it("names an asset under its release", () => {
    expect(releaseAssetUrl("0.4.1", "SQLPilot-0.4.1-1.aarch64.rpm")).toBe(
      "https://github.com/EVWorth/sqlpilot/releases/download/v0.4.1/SQLPilot-0.4.1-1.aarch64.rpm",
    );
  });

  describe("newIssueUrl", () => {
    it("survives a round trip through decodeURIComponent", () => {
      // URLSearchParams writes spaces as `+`, which GitHub accepts but which
      // does not decode back — so the URL stops being readable by the first
      // person who checks what it contains.
      const url = newIssueUrl({ title: "a b", body: "line one\nline two" });
      expect(decodeURIComponent(url.split("body=")[1])).toBe("line one\nline two");
      expect(url).toContain("title=a%20b");
    });

    it("escapes characters that would end the query string", () => {
      const url = newIssueUrl({ title: "a&b=c", body: "#hash" });
      expect(url).toContain("title=a%26b%3Dc");
      expect(url).toContain("body=%23hash");
    });

    it("omits labels rather than sending an empty list", () => {
      expect(newIssueUrl({ title: "t", body: "b" })).not.toContain("labels=");
      expect(newIssueUrl({ title: "t", body: "b", labels: [] })).not.toContain("labels=");
    });

    it("joins labels the way GitHub reads them", () => {
      expect(newIssueUrl({ title: "t", body: "b", labels: ["a", "b"] }))
        .toContain("labels=a%2Cb");
    });
  });

  it("asks for labels the repo actually has", () => {
    // `auto-update` never existed, so GitHub dropped it and the report
    // arrived unlabelled — missing every triage filter it was meant for.
    expect(UPDATE_ISSUE_LABELS).toEqual(["kind/bug", "area/updates"]);
  });
});
