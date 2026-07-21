import { useLayoutEffect, useRef, useState } from "react";

interface Props {
  text: string;
  className?: string;
}

/** Horizontal scroll speed of the marquee (pixels per second). */
const PX_PER_SEC = 45;

/**
 * Shows `text` truncated; if it doesn't fit, it scrolls left in a seamless loop
 * while the surrounding row (an element with the `group` class) is hovered.
 * Overflow is measured with a hidden single-copy span, so the check stays
 * correct regardless of the display mode or window size (ResizeObserver).
 */
export default function MarqueeText({ text, className }: Props) {
  const outerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [durationMs, setDurationMs] = useState(0);

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const measure = measureRef.current;
    if (!outer || !measure) return;
    const check = () => {
      const full = measure.scrollWidth;
      const over = full > outer.clientWidth + 1;
      setOverflow(over);
      if (over) setDurationMs(Math.max(3000, ((full + 40) / PX_PER_SEC) * 1000));
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(outer);
    return () => ro.disconnect();
  }, [text]);

  return (
    <div ref={outerRef} className={`relative overflow-hidden ${className ?? ""}`}>
      {/* Hidden single-copy measurer. */}
      <span
        ref={measureRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute whitespace-nowrap"
      >
        {text}
      </span>
      {overflow ? (
        <div
          className="marquee-track inline-flex w-max flex-nowrap whitespace-nowrap"
          style={{ animationDuration: `${durationMs}ms` }}
        >
          <span className="pr-10">{text}</span>
          <span className="pr-10" aria-hidden="true">
            {text}
          </span>
        </div>
      ) : (
        <div className="truncate">{text}</div>
      )}
    </div>
  );
}
