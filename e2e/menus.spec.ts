/**
 * A menu, opened in a real window, is inside that window.
 *
 * The claim no other level can make. `menuPlacement.test.ts` reads the source
 * and rejects the two spellings that were wrong; a jsdom flow test renders the
 * panel, finds its buttons by role and clicks them happily — because jsdom has
 * no layout at all and `getBoundingClientRect` answers zero for everything
 * there. So "the panel is off the top of the window" is invisible to both, and
 * it shipped: "Add to playlist" opened upward out of the 64 px sticky header
 * and could not be clicked (fixed in 0.8.1).
 *
 * This asks the question that catches the general case rather than the two
 * spellings: where did the panel actually land?
 *
 * Round trips are counted here. Each `execute` pays the five-second probe (see
 * the CSP note in docs/TESTING.md), so the work is batched into as few calls as
 * the state changes allow, and the beat React needs between a click and its
 * result is spent in Node, where it is free.
 */
const beat = () => new Promise((r) => setTimeout(r, 800));

interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface Placement {
  panel: Rect;
  trigger: Rect;
  viewport: { width: number; height: number };
}

describe("a menu opens where it can be used", () => {
  it("puts the playlist panel inside the window, below the header", async () => {
    // The rows arrive from a scan of the fixture library, so the table is empty
    // for the first moments of this app's life and there is nothing to select.
    await browser.waitUntil(
      async () =>
        await browser.execute(
          () => document.querySelectorAll('input[type="checkbox"]').length > 0,
        ),
      {
        timeout: 180_000,
        interval: 5_000,
        timeoutMsg: "no rows to select — the library never appeared",
      },
    );

    // A selection is what puts the trigger in the header at all. The first
    // checkbox in the table is the header's select-all.
    await browser.execute(() => {
      const boxes = Array.from(
        document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
      );
      if (boxes.length && !boxes[0].checked) boxes[0].click();
    });
    await beat();

    // Found by its label, the way a person finds it. The callback is
    // serialised and run in the page, so it can reach nothing from this module.
    const opened = await browser.execute(() => {
      const button = Array.from(document.querySelectorAll("button")).find((b) =>
        b.textContent?.trim().startsWith("Add to playlist"),
      );
      if (!button) return false;
      button.click();
      return true;
    });
    expect(opened).toBe(true);
    await beat();

    const placement = (await browser.execute(() => {
      const button = Array.from(document.querySelectorAll("button")).find((b) =>
        b.textContent?.trim().startsWith("Add to playlist"),
      );
      const panel =
        button?.parentElement?.querySelector<HTMLElement>(":scope > div");
      if (!button || !panel) return null;
      const rect = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
      };
      return {
        panel: rect(panel),
        trigger: rect(button),
        viewport: { width: window.innerWidth, height: window.innerHeight },
      };
    })) as Placement | null;

    // Kept whatever the assertions say: a picture of the open menu is the
    // artefact a person would have looked at, and `.dev/` is gitignored.
    await browser.saveScreenshot(".dev/menu-placement.png");

    if (!placement) throw new Error("the panel did not open");
    const { panel, trigger, viewport } = placement;

    // Measured against the *trigger*, not against the header. A dropdown
    // anchored to a button inside the header starts at that button's bottom
    // edge, which is a few pixels above the header's own — overlapping the
    // last 6 px of a 64 px bar is what every menu in the app does, and
    // asserting otherwise fails a correct layout.
    expect(panel.top).toBeGreaterThanOrEqual(trigger.bottom - 1);
    // The failure that shipped, and the general case in one: `bottom-full`
    // inside the header made this negative — the panel was above the top edge
    // of the window. Any placement that leaves the window fails here, not only
    // that one spelling.
    expect(panel.top).toBeGreaterThanOrEqual(0);
    expect(panel.bottom).toBeLessThanOrEqual(viewport.height);
    expect(panel.left).toBeGreaterThanOrEqual(0);
    expect(panel.right).toBeLessThanOrEqual(viewport.width);
    // A panel with no size is "inside the window" too, and says nothing.
    expect(panel.bottom - panel.top).toBeGreaterThan(20);
  });
});
