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
