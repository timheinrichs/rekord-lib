/**
 * A Markdown parser for exactly the subset the changelog writes.
 *
 * Release notes reach the app as the `CHANGELOG.md` section for a version
 * (`scripts/release-notes.mjs`), which means Markdown — headings, bullets, bold
 * leads, inline code, the odd link. Printing that raw is what the update dialog
 * used to do, and asterisks are not something a reader should have to decode.
 *
 * Deliberately not a Markdown library: the input is a file we write ourselves,
 * the constructs it uses fit on one hand, and the result is rendered as React
 * nodes rather than HTML — so there is no markup to sanitise in the first place.
 * Anything this parser does not know stays visible as its own text, which is the
 * behaviour the `<pre>` had: an unanticipated construct looks unrendered instead
 * of disappearing.
 *
 * Not supported, because the changelog has none of it: tables, code fences,
 * ordered lists, nested lists, block quotes, images, and emphasis inside
 * emphasis. `_underscores_` are not emphasis either — in this text they far more
 * often sit inside an identifier or a file name.
 */

/** A run of text with one optional mark on it. */
export type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "em"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string };

/** A block-level element. `level` is the number of `#` on a heading. */
export type Block =
  | { kind: "heading"; level: number; content: Inline[] }
  | { kind: "paragraph"; content: Inline[] }
  | { kind: "list"; items: Inline[][] };

/**
 * One alternation, scanned left to right, and the order is the rule:
 * code first, so that backticked asterisks and brackets stay literal, then the
 * link (whose text may contain almost anything), then `**strong**` before
 * `*em*` — the other way round, `**a**` would parse as an empty emphasis.
 *
 * Both emphasis forms require the marked text to begin and end with a non-space
 * character, which is what keeps two loose asterisks in a line apart: in
 * `44.1 kHz * 2 channels * 16 bit` there is nothing emphasised, and a rule that
 * ignored the spaces would swallow the middle of the sentence and both
 * asterisks with it.
 */
const MARKED = "([^\\s*][^\\n]*?[^\\s*]|[^\\s*])";
const INLINE = new RegExp(
  [
    "`([^`]+)`",
    "\\[([^\\]\\n]+)\\]\\(([^()\\s]+)\\)",
    `\\*\\*${MARKED}\\*\\*`,
    `\\*${MARKED}\\*`,
  ].join("|"),
  "g",
);

/** Marks up one line's worth of text. Never throws; unknown syntax stays text. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  const re = new RegExp(INLINE.source, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  const push = (text: string) => {
    if (text) out.push({ kind: "text", text });
  };
  while ((m = re.exec(src)) !== null) {
    push(src.slice(last, m.index));
    if (m[1] !== undefined) out.push({ kind: "code", text: m[1] });
    else if (m[2] !== undefined)
      out.push({ kind: "link", text: m[2], href: m[3] });
    else if (m[4] !== undefined) out.push({ kind: "strong", text: m[4] });
    else out.push({ kind: "em", text: m[5] });
    last = re.lastIndex;
  }
  push(src.slice(last));
  return out;
}

/** A `---`, `***` or `___` rule — dropped rather than printed as three dashes. */
const RULE = /^\s*([-*_])\1{2,}\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const ITEM = /^\s*[-*+]\s+(.*)$/;

/**
 * Splits release notes into blocks.
 *
 * A non-blank line while a list is open continues the last item rather than
 * starting a paragraph: every bullet in the changelog is wrapped over several
 * lines, and joining them with a space is what turns them back into sentences.
 */
export function parseMarkdown(src: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let items: string[] | null = null;

  const flushPara = () => {
    if (!para.length) return;
    blocks.push({ kind: "paragraph", content: parseInline(para.join(" ")) });
    para = [];
  };
  const flushList = () => {
    if (!items?.length) return void (items = null);
    blocks.push({ kind: "list", items: items.map(parseInline) });
    items = null;
  };

  for (const raw of src.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim() || RULE.test(line)) {
      flushPara();
      flushList();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushPara();
      flushList();
      blocks.push({
        kind: "heading",
        level: heading[1].length,
        content: parseInline(heading[2].trim()),
      });
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      flushPara();
      (items ??= []).push(item[1].trim());
      continue;
    }
    if (items?.length) {
      items[items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    para.push(line.trim());
  }
  flushPara();
  flushList();
  return blocks;
}
