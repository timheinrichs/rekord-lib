import { useEffect, useState } from "react";

/**
 * Liefert true, sobald das Fenster mehr als `threshold` Pixel gescrollt ist.
 * Für sticky-„Andock"-Animationen und den Back-to-Top-Button.
 */
export function useScrolled(threshold = 4): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > threshold);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [threshold]);
  return scrolled;
}
