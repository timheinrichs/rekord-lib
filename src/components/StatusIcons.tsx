import type { ComponentType } from "react";
import type { StatusKind, TrackStatus } from "../lib/format";
import { ConvertIcon, DownloadIcon, InfoIcon, TagIcon } from "./icons";

/**
 * Icon and colour per status kind. The colour is semantic: warning = something
 * still needs doing, success = done, accent = informational.
 */
const LOOK: Record<StatusKind, { Icon: ComponentType; tone: string }> = {
  convert: { Icon: ConvertIcon, tone: "text-warning-500" },
  incomplete: { Icon: TagIcon, tone: "text-warning-500" },
  complete: { Icon: TagIcon, tone: "text-success-500" },
  note: { Icon: InfoIcon, tone: "text-accent-300" },
  bandcamp: { Icon: DownloadIcon, tone: "text-accent-300" },
};

interface Props {
  items: TrackStatus[];
  /** Optional per-kind tally, shown next to the icon (group headers). */
  counts?: Partial<Record<StatusKind, number>>;
  /**
   * Spell the status out next to the icon. For detail views with room to
   * spare; the table column relies on the tooltip instead.
   */
  withLabels?: boolean;
}

/**
 * The status column's content: one small icon per marker, with the explanation
 * in the tooltip. Icons instead of text pills keep the column narrow and the
 * row height uniform — the pills used to wrap onto a second line.
 */
export default function StatusIcons({ items, counts, withLabels }: Props) {
  if (!items.length) {
    return withLabels ? <span className="text-fg-subtle">–</span> : null;
  }
  return (
    <div className={`flex items-center ${withLabels ? "gap-3" : "gap-1.5"}`}>
      {items.map((s) => {
        const { Icon, tone } = LOOK[s.kind];
        const count = counts?.[s.kind];
        // The first line of a tooltip is the label; the rest (e.g. the compat
        // issues) stays in the tooltip even when labels are shown.
        const label = s.title.split("\n")[0];
        const full = count != null ? `${s.title} (${count})` : s.title;
        return (
          <span
            key={s.kind}
            className={`flex items-center gap-1 ${tone}`}
            title={full}
            aria-label={withLabels ? undefined : full}
            role={withLabels ? undefined : "img"}
          >
            <Icon />
            {withLabels && <span className="text-xs">{label}</span>}
            {count != null && <span className="text-xs">{count}</span>}
          </span>
        );
      })}
    </div>
  );
}
