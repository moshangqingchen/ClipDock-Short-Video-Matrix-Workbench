import { describe, expect, it, beforeEach } from "vitest";
import { useUi } from "./index";

describe("creator account navigation", () => {
  beforeEach(() => {
    useUi.setState({ route: "metrics", creatorMode: "domestic", activeAccountId: null });
  });

  it("selectAccount keeps the current page", () => {
    useUi.getState().selectAccount("account-1");
    expect(useUi.getState()).toMatchObject({ route: "metrics", activeAccountId: "account-1" });
  });

  it("openAccount is the explicit workspace action", () => {
    useUi.getState().openAccount("account-2");
    expect(useUi.getState()).toMatchObject({ route: "creator", activeAccountId: "account-2" });
  });

  it("requests a fresh homepage entry even when the same account is opened again", () => {
    useUi.getState().openAccount("account-2");
    const revision = useUi.getState().accountEntryRevision;
    useUi.getState().openAccount("account-2");
    expect(useUi.getState()).toMatchObject({
      route: "creator",
      activeAccountId: "account-2",
      accountEntryRevision: revision + 1,
    });
  });

  it("opens a selected work once and clears its target on ordinary account entry", () => {
    useUi.getState().openWork("account-2", "https://www.douyin.com/video/123");
    expect(useUi.getState()).toMatchObject({
      route: "creator", activeAccountId: "account-2", accountEntryUrl: "https://www.douyin.com/video/123",
    });
    useUi.getState().openAccount("account-2");
    expect(useUi.getState().accountEntryUrl).toBeNull();
    useUi.getState().openWork("account-2", "https://www.douyin.com/video/123");
    useUi.getState().selectAccount("account-3");
    expect(useUi.getState().accountEntryUrl).toBeNull();
  });
});

it("account selection follows the current metrics page in either scope", () => {
  useUi.setState({ route: "metrics", creatorMode: "domestic", metricsAccountId: null });
  useUi.getState().selectAccount("domestic-1");
  expect(useUi.getState()).toMatchObject({ route: "metrics", metricsAccountId: "domestic-1" });
  useUi.getState().setCreatorMode("global");
  useUi.getState().setGlobalMetricsDetail(false);
  useUi.getState().selectGlobalAccount("global-1");
  expect(useUi.getState()).toMatchObject({
    route: "metrics",
    activeGlobalAccountId: "global-1",
    activeAccountId: "domestic-1",
    globalMetricsDetail: true,
  });
});
