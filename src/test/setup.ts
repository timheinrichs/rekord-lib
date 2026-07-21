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
