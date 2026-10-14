// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Account, PublishRecord } from "@shared/types";
import { api } from "@renderer/lib/api";
import { draftStorageKey, readPublishDraft, savePublishDraft } from "@renderer/lib/publish-drafts";
import { useAccounts, useUi } from "@renderer/store";
import { PublishPage } from "./PublishPage";
import { PublishAssist } from "./PublishAssist";

const account = { id: "publish-one", platformId: "douyin", displayName: "测试账号", status: "online" } as Account;
const record = { id: "record-1", accountId: account.id, platformId: "douyin", title: "原有发布计划", description: "", tags: [], assetIds: [], status: "planned", createdAt: "2026-10-12T00:00:00Z", updatedAt: "2026-10-12T00:00:00Z" } as PublishRecord;
beforeEach(() => {
  localStorage.clear();
  useAccounts.setState({ accounts: [account, { ...account, id: "publish-two", displayName: "账号二" }] });
  useUi.setState({ creatorMode: "domestic", activeAccountId: account.id, selectedAssetIds: [], drawerOpen: false, drawerTab: "data" });
  vi.spyOn(api.assets, "list").mockResolvedValue([]);
  vi.spyOn(api.publish, "list").mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("autosaves edits and restores the correct account after switching and remounting", async () => {
  const view = render(<PublishPage />);
  fireEvent.change(screen.getByPlaceholderText("作品标题"), { target: { value: "账号一的草稿" } });
  fireEvent.change(screen.getByPlaceholderText("正文 / 描述"), { target: { value: "重启后继续" } });
  await waitFor(() => expect(readPublishDraft("domestic", account.id).draft?.description).toBe("重启后继续"));
  await act(async () => useUi.getState().selectAccount("publish-two"));
  expect(screen.getByPlaceholderText("作品标题")).toHaveValue("");
  fireEvent.change(screen.getByPlaceholderText("作品标题"), { target: { value: "账号二的草稿" } });
  await act(async () => useUi.getState().selectAccount(account.id));
  expect(screen.getByPlaceholderText("作品标题")).toHaveValue("账号一的草稿");
  view.unmount();
  render(<PublishPage />);
  expect(screen.getByPlaceholderText("正文 / 描述")).toHaveValue("重启后继续");
});

it("preserves unreadable stored data during strict-mode mounting", async () => {
  const key = draftStorageKey("domestic", account.id);
  localStorage.setItem(key, "broken");
  render(<StrictMode><PublishPage /></StrictMode>);
  expect(await screen.findByRole("alert")).toHaveTextContent("读取失败");
  expect(localStorage.getItem(key)).toBe("broken");
});

it("shows read failures rather than claiming there are no publication records", async () => {
  vi.mocked(api.publish.list).mockRejectedValueOnce(new Error("read failed")).mockResolvedValueOnce([record]);
  render(<PublishPage />);
  expect(await screen.findByRole("alert")).toHaveTextContent("发布记录读取失败");
  expect(screen.queryByText("还没有发布记录")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "重试读取记录" }));
  expect(await screen.findByText("原有发布计划")).toBeInTheDocument();
});

it("retains prior records when a refresh after saving fails", async () => {
  vi.mocked(api.publish.list).mockResolvedValueOnce([record]).mockRejectedValueOnce(new Error("refresh failed"));
  vi.spyOn(api.publish, "save").mockResolvedValue(record);
  render(<PublishPage />);
  fireEvent.click(await screen.findByText("原有发布计划"));
  fireEvent.click(screen.getByRole("button", { name: "保存为计划" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("已保留上次结果");
  expect(screen.getByText("原有发布计划")).toBeInTheDocument();
});

it("does not steal account focus when an earlier upload request completes after switching accounts", async () => {
  let complete!: () => void;
  vi.spyOn(api.publish, "openUpload").mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  render(<PublishPage />);
  fireEvent.change(screen.getByPlaceholderText("作品标题"), { target: { value: "原账号未完成上传" } });
  fireEvent.click(screen.getByRole("button", { name: "打开上传页" }));
  await act(async () => useUi.getState().selectAccount("publish-two"));
  await act(async () => complete());
  expect(useUi.getState().activeAccountId).toBe("publish-two");
  expect(useUi.getState().drawerOpen).toBe(false);
  expect(readPublishDraft("domestic", account.id).draft?.title).toBe("原账号未完成上传");
});

it("opens the official page with a scoped draft still available in the publishing assistant", async () => {
  vi.spyOn(api.publish, "openUpload").mockResolvedValue(undefined);
  const view = render(<PublishPage />);
  fireEvent.change(screen.getByPlaceholderText("作品标题"), { target: { value: "带到平台旁边的文案" } });
  fireEvent.click(screen.getByRole("button", { name: "打开上传页" }));
  await waitFor(() => expect(useUi.getState()).toMatchObject({ route: "creator", drawerOpen: true, drawerTab: "publish" }));
  view.unmount();
  render(<PublishAssist scope="domestic" accountId={account.id} />);
  expect(screen.getByText("带到平台旁边的文案")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "复制完整文案" })).toBeEnabled();
});

it("only adds the saved plan ID when a newer edit was written after leaving the assistant", async () => {
  const draft = { title: "提交前标题", description: "旧文案", tags: [], selected: [] };
  savePublishDraft("domestic", account.id, draft);
  let complete!: (value: PublishRecord) => void;
  vi.spyOn(api.publish, "save").mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const view = render(<PublishAssist scope="domestic" accountId={account.id} />);
  fireEvent.click(screen.getByRole("button", { name: "保存为计划" }));
  view.unmount();
  savePublishDraft("domestic", account.id, { ...draft, title: "编辑后的新标题", description: "保存过程中更新的文案" });
  await act(async () => complete(record));
  expect(readPublishDraft("domestic", account.id).draft).toMatchObject({
    title: "编辑后的新标题", description: "保存过程中更新的文案", recordId: record.id,
  });
});
