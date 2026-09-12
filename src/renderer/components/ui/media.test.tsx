// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Avatar, Cover } from "./index";

const first = "sv-asset://remote/86cd4ebf-007c-4b24-8b0a-6b84097f304a";
const second = "sv-asset://remote/01b98d43-c2ef-4437-9613-002b2434716f";
afterEach(cleanup);

describe("media display recovery", () => {
  it("resets an Avatar's failed image when its local cache reference changes", () => {
    const view = render(<Avatar src={first} name="甲" color="red" />);
    fireEvent.error(view.container.querySelector("img")!);
    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.textContent).toBe("甲");
    view.rerender(<Avatar src={second} name="甲" color="red" />);
    expect(view.container.querySelector("img")?.getAttribute("src")).toBe(second);
    view.rerender(<Avatar src={first} name="甲" color="red" />);
    expect(view.container.querySelector("img")?.getAttribute("src")).toBe(first);
  });

  it("uses one cover placeholder for missing or failed images, without another source fallback", () => {
    const view = render(<Cover src={null} className="cover-size" />);
    expect(screen.getByRole("img", { name: "暂无封面" }).className).toBe("cover-size");
    view.rerender(<Cover src={first} className="cover-size" />);
    fireEvent.error(view.container.querySelector("img")!);
    expect(view.container.querySelector("img")).toBeNull();
    expect(screen.getByRole("img", { name: "暂无封面" })).toBeTruthy();
    expect(view.container.innerHTML).not.toContain("https:");
    view.rerender(<Cover src={second} className="cover-size" />);
    expect(view.container.querySelector("img")?.getAttribute("src")).toBe(second);
  });

  it("preserves explicitly projected observe-mode image display", () => {
    const source = "https://images.example.test/public.png";
    const view = render(<Cover src={source} />);
    expect(view.container.querySelector("img")?.getAttribute("src")).toBe(source);
    fireEvent.error(view.container.querySelector("img")!);
    expect(view.container.querySelector("img")).toBeNull();
  });
});
