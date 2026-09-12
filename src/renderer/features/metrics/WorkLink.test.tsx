// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Account, Work } from "@shared/types";
import { useUi } from "@renderer/store";
import { WorkLink, workLinkUrl } from "./WorkLink";

const account = { id: "owner", platformId: "xiaohongshu" } as Account;
const work = {
  id: "note", accountId: account.id, platformId: account.platformId, title: "测试作品",
  url: "https://www.xiaohongshu.com/explore/abc?xsec_token=note-token", remoteId: "abc",
} as Work;

beforeEach(() => useUi.setState({ route: "metrics", activeAccountId: "another", accountEntryUrl: null }));
afterEach(cleanup);

it("opens the cover, title and card through the owning account and supports Enter and Space", async () => {
  const user = userEvent.setup();
  render(<WorkLink account={account} work={work}>
    <img alt="作品封面" src="/cover.jpg" /><strong>{work.title}</strong>
  </WorkLink>);
  const card = screen.getByRole("button", { name: "打开作品：测试作品" });
  for (const target of [screen.getByAltText("作品封面"), screen.getByText(work.title), card]) {
    await user.click(target);
    expect(useUi.getState()).toMatchObject({
      activeAccountId: "owner", creatorMode: "domestic", route: "creator", accountEntryUrl: work.url,
    });
  }
  card.focus();
  const revision = useUi.getState().accountEntryRevision;
  await user.keyboard("{Enter} ");
  expect(useUi.getState().accountEntryRevision).toBe(revision + 2);
});

it.each([
  null, "", "not-a-url", "javascript:alert(1)", "file:///C:/secret", "https://evil.test/",
  "https://www.xiaohongshu.com.evil.test/explore/abc", "https://user@www.xiaohongshu.com/explore/abc",
  "https://www.xiaohongshu.com:8888/explore/abc",
])("disables works without an allowed platform URL: %s", async (url) => {
  const invalid = { ...work, url };
  expect(workLinkUrl(invalid, account)).toBeNull();
  render(<WorkLink account={account} work={invalid}>作品</WorkLink>);
  const card = screen.getByRole("button");
  expect(card).toBeDisabled();
  expect(card).toHaveAttribute("title", "暂无可用作品链接");
  await userEvent.click(card);
  expect(useUi.getState().route).toBe("metrics");
});

it("rejects another account's work and preserves signed platform URLs while upgrading HTTP", () => {
  expect(workLinkUrl({ ...work, accountId: "another" }, account)).toBeNull();
  expect(workLinkUrl({ ...work, platformId: "douyin" }, account)).toBeNull();
  expect(workLinkUrl({ ...work, url: work.url!.replace("https:", "http:") }, account)).toBe(work.url);
});
