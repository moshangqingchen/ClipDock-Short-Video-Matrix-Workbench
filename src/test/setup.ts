import "@testing-library/jest-dom/vitest";

// jsdom lacks a few browser APIs the shell relies on.
if (typeof window !== "undefined") {
  if (!window.matchMedia) {
    window.matchMedia = () =>
      ({
        matches: false,
        media: "",
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => false,
      }) as MediaQueryList;
  }
  if (!("ResizeObserver" in window)) {
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (!window.crypto?.randomUUID) {
    Object.defineProperty(window, "crypto", {
      value: {
        randomUUID: () =>
          `00000000-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, "0")}`,
      },
    });
  }
}
