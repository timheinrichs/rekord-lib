import { Fragment, useMemo } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { parseMarkdown, type Block, type Inline } from "../lib/markdown";


interface Props {
  /**
   * The release body, already reduced by `renderableNotes` — which is where the
   * severity marker is taken out. Stripping here as well would take a second
   * marker-shaped line out of the middle of the notes, which is nobody's
   * intention.
   */
  notes: string;
  /** Settings prints the notes smaller than the start-up dialog does. */
  size?: "xs" | "sm";
}

/**
 * A link in release notes points outward, so it opens in the browser rather
 * than in the app window — and only if it is a web link. The notes arrive over
 * the network, and no scheme beyond http(s) has any business being handed to the
 * OS from here; anything else stays visible as its own text.
 */
function isWebLink(href: string): boolean {
  try {
    const { protocol } = new URL(href);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function InlineRun({ run }: { run: Inline }) {
  switch (run.kind) {
    case "strong":
      // Weight, not boldness: the styleguide has 400 and 500 and nothing else.
      return <strong className="font-medium text-fg">{run.text}</strong>;
    case "em":
      return <em className="italic">{run.text}</em>;
    case "code":
      return (
        <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.9em] text-fg">
          {run.text}
        </code>
      );
    case "link":
      // A link we will not open is shown the way it was written, target and
      // all: dropping the destination would lose what the `<pre>` still showed.
      return isWebLink(run.href) ? (
        <button
          type="button"
          onClick={() => void openUrl(run.href)}
          // The `<pre>` this replaced showed every link's target. A label can
          // say one thing and point at another, so the target stays reachable
          // rather than being hidden behind the words.
          title={run.href}
          className="text-accent-400 underline decoration-dotted underline-offset-2 hover:text-accent-300"
        >
          {run.text}
        </button>
      ) : (
        <>{`[${run.text}](${run.href})`}</>
      );
    default:
      return <>{run.text}</>;
  }
}

function Runs({ content }: { content: Inline[] }) {
  return (
    <>
      {content.map((run, i) => (
        <Fragment key={i}>
          <InlineRun run={run} />
        </Fragment>
      ))}
    </>
  );
}

/**
 * Release notes, rendered.
 *
 * They arrive as the changelog section for a version and used to be printed
 * raw, asterisks and all — the one place in the app where a reader had to know
 * what `###` means. Everything here is presentational; the parsing is pure and
 * lives in `lib/markdown`.
 */
export default function ReleaseNotes({ notes, size = "sm" }: Props) {
  const blocks = useMemo<Block[]>(() => parseMarkdown(notes), [notes]);
  const body = size === "xs" ? "text-xs" : "text-sm";
  if (!blocks.length) return null;

  return (
    <div className="space-y-3" data-release-notes>
      {blocks.map((block, i) => {
        if (block.kind === "heading") {
          // Mono and small: these are the changelog's section labels (Added,
          // Fixed), which are labels rather than prose.
          const Tag = block.level <= 3 ? "h3" : "h4";
          return (
            <Tag key={i} className="font-mono text-xs font-medium text-fg">
              <Runs content={block.content} />
            </Tag>
          );
        }
        if (block.kind === "list") {
          return (
            <ul
              key={i}
              className={`list-disc space-y-1.5 pl-4 font-sans ${body} text-fg-muted marker:text-fg-subtle`}
            >
              {block.items.map((item, j) => (
                <li key={j}>
                  <Runs content={item} />
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i} className={`font-sans ${body} text-fg-muted`}>
            <Runs content={block.content} />
          </p>
        );
      })}
    </div>
  );
}
