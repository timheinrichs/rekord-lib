import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "./markdown";

const texts = (src: string) =>
  parseInline(src)
    .map((r) => `${r.kind}:${r.text}`)
    .join("|");

describe("parseInline", () => {
  it("leaves plain text alone", () => {
    expect(parseInline("just words")).toEqual([
      { kind: "text", text: "just words" },
    ]);
  });

  it("marks bold, emphasis and code", () => {
    expect(texts("a **b** c *d* e `f`")).toBe(
      "text:a |strong:b|text: c |em:d|text: e |code:f",
    );
  });

  it("reads a link as text plus target", () => {
    expect(parseInline("see [the docs](https://x.dev/a) now")).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", text: "the docs", href: "https://x.dev/a" },
      { kind: "text", text: " now" },
    ]);
  });

  it("keeps what is inside backticks literal", () => {
    // Code first in the alternation is what makes this hold: a glob or a
    // multiplication in a command is not emphasis.
    expect(texts("run `a * b` and `**kwargs`")).toBe(
      "text:run |code:a * b|text: and |code:**kwargs",
    );
  });

  it("does not read an underscore as emphasis", () => {
    // In this text an underscore is nearly always part of an identifier.
    expect(texts("the library_dir key")).toBe("text:the library_dir key");
  });

  it("prefers bold over emphasis", () => {
    expect(texts("**both**")).toBe("strong:both");
  });

  it("does not read two loose asterisks as emphasis", () => {
    // `*` is a multiplication sign and a glob far more often than it is
    // emphasis, and a rule that ignored the spaces would eat the words between.
    expect(texts("44.1 kHz * 2 channels * 16 bit")).toBe(
      "text:44.1 kHz * 2 channels * 16 bit",
    );
  });

  it("leaves malformed syntax as the text it is", () => {
    expect(texts("[unclosed](")).toBe("text:[unclosed](");
    expect(texts("a * lone asterisk")).toBe("text:a * lone asterisk");
    expect(texts("`unclosed code")).toBe("text:`unclosed code");
  });

  it("returns nothing for an empty string", () => {
    expect(parseInline("")).toEqual([]);
  });
});

describe("parseMarkdown", () => {
  it("reads headings with their level", () => {
    expect(parseMarkdown("## Big\n\n### Small")).toEqual([
      { kind: "heading", level: 2, content: [{ kind: "text", text: "Big" }] },
      { kind: "heading", level: 3, content: [{ kind: "text", text: "Small" }] },
    ]);
  });

  it("collects bullets into one list", () => {
    const [list] = parseMarkdown("- one\n- two\n* three");
    expect(list).toEqual({
      kind: "list",
      items: [
        [{ kind: "text", text: "one" }],
        [{ kind: "text", text: "two" }],
        [{ kind: "text", text: "three" }],
      ],
    });
  });

  it("joins a bullet wrapped over several lines", () => {
    // Every bullet in the changelog is wrapped; unjoined they read as fragments.
    const [list] = parseMarkdown(
      "- **A tempo written into the wrong file.** A rename\n  that landed between the scan\n  and the tag write.",
    );
    expect(list).toEqual({
      kind: "list",
      items: [
        [
          { kind: "strong", text: "A tempo written into the wrong file." },
          {
            kind: "text",
            text: " A rename that landed between the scan and the tag write.",
          },
        ],
      ],
    });
  });

  it("separates two lists with a heading between them", () => {
    const blocks = parseMarkdown("### Added\n- a\n\n### Fixed\n- b");
    expect(blocks.map((b) => b.kind)).toEqual([
      "heading",
      "list",
      "heading",
      "list",
    ]);
  });

  it("joins the lines of a paragraph", () => {
    expect(parseMarkdown("prose that\nwraps")).toEqual([
      { kind: "paragraph", content: [{ kind: "text", text: "prose that wraps" }] },
    ]);
  });

  it("starts a new paragraph after a blank line", () => {
    const blocks = parseMarkdown("one\n\ntwo");
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toEqual({
      kind: "paragraph",
      content: [{ kind: "text", text: "two" }],
    });
  });

  it("drops a horizontal rule instead of printing three dashes", () => {
    expect(parseMarkdown("a\n\n---\n\nb").map((b) => b.kind)).toEqual([
      "paragraph",
      "paragraph",
    ]);
  });

  it("is empty for empty or blank input", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("\n  \n\n")).toEqual([]);
  });

  it("reads a real changelog section end to end", () => {
    // 0.7.2's, shortened — prose under a heading, wrapped bullets, a link.
    const blocks = parseMarkdown(
      [
        "### Added",
        "- **The first scan can be watched and paused.** It now goes",
        "  through the same job as every other scan.",
        "- The app is tested by driving it. See",
        "  [docs/TESTING.md](https://x.dev/TESTING.md).",
        "",
        "### Fixed",
        "A database that cannot be opened no longer leaves the app",
        "stuck.",
      ].join("\n"),
    );
    expect(blocks.map((b) => b.kind)).toEqual([
      "heading",
      "list",
      "heading",
      "paragraph",
    ]);
    const list = blocks[1];
    expect(list.kind === "list" && list.items).toHaveLength(2);
    // The link survives the line join, and the sentence's full stop after it
    // stays outside the link.
    expect(list.kind === "list" && list.items[1]).toEqual([
      { kind: "text", text: "The app is tested by driving it. See " },
      {
        kind: "link",
        text: "docs/TESTING.md",
        href: "https://x.dev/TESTING.md",
      },
      { kind: "text", text: "." },
    ]);
  });
});
