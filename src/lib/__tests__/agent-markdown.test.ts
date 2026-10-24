import { describe, expect, it } from "vitest";
import { parseBlocks, parseInline } from "../agent-markdown";

describe("blocks", () => {
  it("turns dash lines into a list", () => {
    expect(parseBlocks("Here it is:\n\n- paid: 1,939\n- shipped: 1,902\n\nDone.")).toEqual([
      { type: "paragraph", text: "Here it is:" },
      { type: "list", ordered: false, items: ["paid: 1,939", "shipped: 1,902"] },
      { type: "paragraph", text: "Done." },
    ]);
  });

  it("keeps numbered lists apart from bulleted ones", () => {
    expect(parseBlocks("1. first\n2. second")).toEqual([
      { type: "list", ordered: true, items: ["first", "second"] },
    ]);
  });

  it("keeps a fenced block verbatim", () => {
    expect(parseBlocks("Run this:\n```sql\nSELECT *\n  FROM t -- - not a list\n```\nok")).toEqual([
      { type: "paragraph", text: "Run this:" },
      { type: "code", language: "sql", text: "SELECT *\n  FROM t -- - not a list" },
      { type: "paragraph", text: "ok" },
    ]);
  });

  it("shows a fence still being streamed as code", () => {
    expect(parseBlocks("```sql\nSELECT 1")).toEqual([{ type: "code", language: "sql", text: "SELECT 1" }]);
  });

  it("keeps line breaks inside a paragraph", () => {
    expect(parseBlocks("one\ntwo")).toEqual([{ type: "paragraph", text: "one\ntwo" }]);
  });

  it("treats a heading as a line of its own", () => {
    expect(parseBlocks("## Summary\ntext")).toEqual([
      { type: "heading", text: "Summary" },
      { type: "paragraph", text: "text" },
    ]);
  });
});

describe("inline", () => {
  it("picks out code and bold", () => {
    expect(parseInline("Run `copilot`, then **sign in**.")).toEqual([
      { type: "text", text: "Run " },
      { type: "code", text: "copilot" },
      { type: "text", text: ", then " },
      { type: "strong", text: "sign in" },
      { type: "text", text: "." },
    ]);
  });

  it("leaves a lone backtick alone", () => {
    expect(parseInline("it's a ` mark")).toEqual([{ type: "text", text: "it's a ` mark" }]);
  });
});
