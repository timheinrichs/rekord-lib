/**
 * Where a floating surface actually lands, in a real window.
 *
 * The claim no other level can make. `menuPlacement.test.ts` reads the source
 * and rejects the two spellings that were wrong; a jsdom flow test renders the
 * panel, finds its buttons by role and clicks them happily — because jsdom has
 * no layout at all and `getBoundingClientRect` answers zero for everything
 * there. So "the panel is off the top of the window" is invisible to both, and
 * it shipped: "Add to playlist" opened upward out of the 64 px sticky header
 * and could not be clicked (fixed in 0.8.1).
 *
 * That menu is a dialog now (0.10.0), and both shapes are measured here,
 * because they make opposite promises. A menu must hang below the trigger it
 * belongs to. A dialog must not depend on a trigger at all — which is the
 * property the picker was changed to get, and the only place it can be
 * checked.
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

interface DialogPlacement {
  panel: Rect;
  backdrop: Rect;
  viewport: { width: number; height: number };
}

/** The library is filled by a scan of the fixture library, which takes a while. */
async function waitForRows() {
  await browser.waitUntil(
    async () =>
      await browser.execute(
        () => document.querySelectorAll('input[type="checkbox"]').length > 0,
      ),
    {
      timeout: 180_000,
      interval: 5_000,
      timeoutMsg: "no rows — the library never appeared",
    },
  );
}

describe("a floating surface opens where it can be used", () => {
  it("hangs the column menu below its trigger, inside the window", async () => {
    await waitForRows();

    // The column menu needs no selection, which is what makes it the right
    // subject now: it is a plain dropdown in the same sticky header, so the
    // rule is measured without the setup the old subject required.
    const opened = await browser.execute(() => {
      const button = document.querySelector<HTMLButtonElement>(
        '[aria-label="Choose columns"]',
      );
      if (!button) return false;
      button.click();
      return true;
    });
    expect(opened).toBe(true);
    await beat();

    const placement = (await browser.execute(() => {
      const button = document.querySelector<HTMLButtonElement>(
        '[aria-label="Choose columns"]',
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

    // Leave the window as it was found, so the next test starts clean.
    await browser.keys(["Escape"]);
    await beat();
  });

  it("centres the playlist picker, and covers the window behind it", async () => {
    await waitForRows();

    // A selection is what puts the trigger in the header at all. The first
    // checkbox in the table is the header's select-all.
    await browser.execute(() => {
      const boxes = Array.from(
        document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
      );
      if (boxes.length && !boxes[0].checked) boxes[0].click();
    });
    await beat();

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
      const panel = document.querySelector<HTMLElement>('[role="dialog"]');
      const backdrop = document.querySelector<HTMLElement>(
        "div.fixed.inset-0.z-50",
      );
      if (!panel || !backdrop) return null;
      const rect = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
      };
      return {
        panel: rect(panel),
        backdrop: rect(backdrop),
        viewport: { width: window.innerWidth, height: window.innerHeight },
      };
    })) as DialogPlacement | null;

    await browser.saveScreenshot(".dev/dialog-placement.png");

    if (!placement) throw new Error("the dialog did not open");
    const { panel, backdrop, viewport } = placement;

    // Inside the window, the same question the menu answers.
    expect(panel.top).toBeGreaterThanOrEqual(0);
    expect(panel.bottom).toBeLessThanOrEqual(viewport.height);
    expect(panel.left).toBeGreaterThanOrEqual(0);
    expect(panel.right).toBeLessThanOrEqual(viewport.width);
    expect(panel.bottom - panel.top).toBeGreaterThan(20);

    // And the thing a dropdown could never promise: it is in the middle,
    // wherever its trigger happens to be. That is the whole reason the picker
    // stopped being a menu — its trigger moves with the selection.
    const centre = (a: number, b: number) => (a + b) / 2;
    expect(
      Math.abs(centre(panel.top, panel.bottom) - viewport.height / 2),
    ).toBeLessThanOrEqual(8);
    expect(
      Math.abs(centre(panel.left, panel.right) - viewport.width / 2),
    ).toBeLessThanOrEqual(8);

    // `Overlay`'s docblock claims the portal escapes any ancestor transform.
    // This is the only place that claim can be measured: a backdrop anchored
    // to the document rather than the viewport would start below the fold.
    expect(backdrop.top).toBe(0);
    expect(backdrop.left).toBe(0);
    expect(backdrop.bottom).toBe(viewport.height);
    expect(backdrop.right).toBe(viewport.width);
  });
});
