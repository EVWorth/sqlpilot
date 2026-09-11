import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BlobViewer } from "../BlobViewer";

const utf8 = (s: string) => [...new TextEncoder().encode(s)];
/** A one-pixel PNG header plus enough body to be worth showing. */
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(40).fill(0)];

const view = (bytes: number[]) => render(<BlobViewer bytes={bytes} columnName="avatar" />);

describe("BlobViewer (#401)", () => {
  describe("which view opens first", () => {
    it("opens an image as an image", () => {
      view(PNG);
      expect(screen.getByAltText("avatar contents")).toBeInTheDocument();
    });

    it("opens text as text", () => {
      view(utf8("hello, this is a document"));
      expect(screen.getByText("hello, this is a document")).toBeInTheDocument();
    });

    it("opens unrecognised binary as hex", () => {
      // For a compiled blob the hex is the content; dropping the user on an
      // empty-looking text pane would suggest the value was empty.
      view([0x00, 0x01, 0x02, 0xfe, 0xff]);
      expect(screen.getByText(/00 01 02 fe ff/)).toBeInTheDocument();
    });
  });

  describe("which views are offered", () => {
    it("offers no image tab for something no <img> can render", () => {
      // A broken-icon placeholder is worse than not offering the tab.
      view(utf8("plain text"));
      expect(screen.queryByRole("button", { name: "image" })).not.toBeInTheDocument();
    });

    it("offers no text tab for binary that is not text", () => {
      view(PNG);
      expect(screen.queryByRole("button", { name: "text" })).not.toBeInTheDocument();
    });

    it("always offers hex, since every value has bytes", () => {
      view(PNG);
      expect(screen.getByRole("button", { name: "hex" })).toBeInTheDocument();
    });

    it("offers both image and hex for an SVG, which is also text", () => {
      view(utf8("<svg xmlns=\"http://www.w3.org/2000/svg\"><rect /></svg>"));
      expect(screen.getByRole("button", { name: "image" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "text" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "hex" })).toBeInTheDocument();
    });
  });

  it("switches view on click", () => {
    view(PNG);

    fireEvent.click(screen.getByRole("button", { name: "hex" }));

    expect(screen.queryByAltText("avatar contents")).not.toBeInTheDocument();
    expect(screen.getByText(/89 50 4e 47/)).toBeInTheDocument();
  });

  it("says what the value is and how big it is", () => {
    view(PNG);
    expect(screen.getByText(/image\/png · 48 B/)).toBeInTheDocument();
  });

  it("says so rather than claiming a type it does not know", () => {
    view([0x00, 0x01, 0x02]);
    expect(screen.getByText(/unrecognised · 3 B/)).toBeInTheDocument();
  });

  it("says how much of a large value the hex view is showing", () => {
    // Rendering 3.2 million lines to show the first screenful locks the
    // window up.
    // 0x00 rather than a letter, so this opens on hex rather than on text.
    view(Array.from({ length: 100_000 }, () => 0x00));

    expect(
      screen.getByText((_t, node) =>
        /Showing the first 64\.0 KB of 97\.7 KB/.test(
          node?.textContent ?? "",
        ), { selector: "p" }),
    ).toBeInTheDocument();
  });

  it("says nothing about truncation when the whole value is shown", () => {
    view([0x00, 0x01]);
    expect(screen.queryByText(/Showing the first/)).not.toBeInTheDocument();
  });
});
