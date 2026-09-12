// @vitest-environment jsdom
import { it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Menu, MenuItem, Modal } from "./index";
import { useUi } from "@renderer/store";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it.each([
  [0, 0],
  [1000, 0],
  [0, 760],
  [1000, 760],
])("keeps a measured menu inside the window at %s,%s", (x, y) => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 240,
    height: 220,
  } as DOMRect);
  const close = vi.fn(),
    anchor = new DOMRect(x, y, 20, 20);
  render(
    <Menu anchor={anchor} onClose={close}>
      <MenuItem>First</MenuItem>
      <MenuItem disabled>Disabled</MenuItem>
      <MenuItem>Last</MenuItem>
    </Menu>,
  );
  const menu = screen.getByRole("menu");
  expect(parseFloat(menu.style.left)).toBeGreaterThanOrEqual(8);
  expect(parseFloat(menu.style.left) + 240).toBeLessThanOrEqual(innerWidth - 8);
  expect(parseFloat(menu.style.top) + 220).toBeLessThanOrEqual(innerHeight - 8);
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "First" }));
  fireEvent.keyDown(window, { key: "ArrowDown" });
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Last" }));
  fireEvent.keyDown(window, { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
});
it("owns one native overlay per modal and restores focus on unmount", () => {
  const button = document.createElement("button");
  document.body.append(button);
  button.focus();
  const before = useUi.getState().overlayCount;
  const host = render(
    <Modal open title="Rename" onClose={() => undefined}>
      <input aria-label="Name" />
    </Modal>,
  );
  expect(useUi.getState().overlayCount).toBe(before + 1);
  expect(screen.getByRole("dialog")).toHaveAccessibleName("Rename");
  host.unmount();
  expect(useUi.getState().overlayCount).toBe(before);
  expect(document.activeElement).toBe(button);
  button.remove();
});
