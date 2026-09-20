// Global test setup: extends `expect` with jest-dom matchers.
import "@testing-library/jest-dom/vitest";

// jsdom has no ResizeObserver; provide a no-op stub for components that use it.
if (!("ResizeObserver" in globalThis)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    ResizeObserverStub;
}

// Neither does jsdom have IntersectionObserver (CoverThumb lazy-loads with it).
// This stub never reports an intersection, so covers stay unloaded unless a
// test drives them itself.
if (!("IntersectionObserver" in globalThis)) {
  class IntersectionObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
    IntersectionObserverStub;
}

// matchMedia is missing too; report "no preference" for every query so that
// prefers-reduced-motion branches take their default path.
if (!globalThis.matchMedia) {
  globalThis.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as typeof globalThis.matchMedia;
}

// jsdom implements no media playback at all: `play()` returns `undefined`
// where the DOM says a promise, which is what the player chains a `catch`
// onto, and `pause()` logs "Not implemented" on every flow test that has a
// player bar on screen. Stubs rather than mocks — the player's own logic still
// runs, it simply has an element that answers.
Object.assign(HTMLMediaElement.prototype, {
  play: () => Promise.resolve(),
  pause: () => {},
  load: () => {},
});

// Nor pointer capture, which the playlists view needs: without it a drag stops
// the moment the pointer leaves the row it began on, because the moves are
// then delivered to whatever is underneath.
Object.assign(Element.prototype, {
  setPointerCapture: () => {},
  releasePointerCapture: () => {},
  hasPointerCapture: () => false,
});
