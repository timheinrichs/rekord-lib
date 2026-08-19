import { useState } from "react";
import Overlay from "./Overlay";
import { skippedAsText } from "../lib/skipped";
import type { SkippedFile } from "../types";

interface Props {
  files: SkippedFile[];
  onClose: () => void;
}

/**
 * The files the analysis could not use, with the reason each one gave.
 *
 * A mixed collection always contains a few of these, and skipping them is the
 * right behaviour — one broken file must not abort a run over thousands. What
 * was missing is the other half: which files, and why. The list is copyable
 * because the reasons come from ffprobe and are worth pasting somewhere.
 */
export default function SkippedModal({ files, onClose }: Props) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(skippedAsText(files));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Overlay>
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl">
        <header className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-medium">
            Skipped files
            <span className="ml-2 text-fg-subtle">
              {files.length === 1 ? "1 file" : `${files.length} files`}
            </span>
          </h2>
          <div className="flex items-center gap-3">
            <button
              onClick={() => void copy()}
              className="rounded-md border border-border-strong px-3 py-1.5 text-sm hover:border-accent-500"
              title="Copy the list with the reasons"
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              onClick={onClose}
              className="text-fg-muted hover:text-fg"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-5">
          <p className="mb-4 font-sans text-sm text-fg-subtle">
            These files were left out of the library. The rest of the scan
            finished normally.
          </p>
          <ul className="flex flex-col gap-2">
            {files.map((f) => (
              <li
                key={f.path}
                className="rounded-lg border border-border bg-surface-2 px-3 py-2"
              >
                <p className="truncate text-sm" title={f.path}>
                  {f.file_name}
                </p>
                <p className="mt-0.5 truncate text-xs text-fg-subtle" title={f.path}>
                  {f.path}
                </p>
                <p className="mt-1 text-xs text-warning-500">{f.reason}</p>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Overlay>
  );
}
