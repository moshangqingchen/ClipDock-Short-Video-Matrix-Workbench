// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import App from "./App";

describe("App (browser preview mode)", () => {
  it("renders the shell with navigation, account tree and overview", async () => {
    render(<App />);
    expect(screen.getByRole("navigation", { name: "主导航" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "账号列表" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "总览" })).toBeInTheDocument());
    // preview data populates the platform groups
    await waitFor(() => expect(screen.getAllByText(/品牌官方号/).length).toBeGreaterThan(0));
  });
});
