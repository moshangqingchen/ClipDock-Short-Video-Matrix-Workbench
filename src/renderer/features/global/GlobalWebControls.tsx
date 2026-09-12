import { useEffect, useRef, useState } from "react";
import { Globe, X } from "lucide-react";
import type { GlobalAccount } from "@shared/global-accounts";
import { globalWebErrorCode, type GlobalWebErrorCode, type GlobalWebState } from "@shared/global-web";
import { api, hasBridge } from "@renderer/lib/api";
import { Badge, Button } from "@renderer/components/ui";
import { isGlobalProxyEnabled, useNetwork } from "@renderer/store/network";
import styles from "./global.module.css";

const LABELS: Record<GlobalWebState["phase"], string> = {
  closed: "官网窗口未打开",
  checking: "正在检查代理状态",
  opening: "正在打开软件内窗口",
  open: "官网窗口已打开",
  closing: "正在关闭窗口",
  dormant: "休眠 · 等待代理",
  error: "窗口暂不可用",
};
const ERRORS: Record<GlobalWebErrorCode, string> = {
  GLOBAL_WEB_PROXY_UNVERIFIED: "请先开启代理，再打开国外平台官网。",
  GLOBAL_WEB_BROWSER_UNAVAILABLE: "软件内网页暂时无法打开，请重试。",
  GLOBAL_WEB_PROFILE_BUSY: "这个账号的浏览器目录仍被占用，请先关闭它的旧窗口。",
  GLOBAL_WEB_BUSY: "同时打开的国外账号已达上限，请先关闭一个窗口。",
  GLOBAL_WEB_CLEANUP_FAILED: "旧网页尚未关闭完成，请点击“重试关闭”后重新打开。",
  GLOBAL_WEB_UNAVAILABLE: "官网窗口暂不可用，请刷新后重试。",
  GLOBAL_WEB_ROUTE_UNAVAILABLE: "该平台未提供此快捷入口，请在官网内操作。",
};
export function GlobalWebControls({ account }: { account: GlobalAccount }) {
  const [state, setState] = useState<GlobalWebState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<GlobalWebErrorCode | null>(null);
  const generation = useRef(0);
  const live = useRef(false);
  const switching = useNetwork((value) => value.snapshot.switching);
  const proxyOn = isGlobalProxyEnabled(switching);
  useEffect(() => {
    live.current = true;
    const current = ++generation.current;
    const unsubscribe = api.globalWeb.onChanged((next) => {
      if (next.accountId !== account.id) return;
      generation.current++;
      setState(next);
      setError(next.errorCode);
    });
    void api.globalWeb
      .state(account.id)
      .then((next) => {
        if (live.current && current === generation.current) {
          setState(next);
          setError(next.errorCode);
        }
      })
      .catch(() => {
        if (live.current && current === generation.current) setError("GLOBAL_WEB_UNAVAILABLE");
      });
    return () => {
      live.current = false;
      unsubscribe();
    };
  }, [account.id]);
  const act = async (action: "open" | "close") => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const current = ++generation.current;
    try {
      const next = await api.globalWeb[action](account.id);
      if (live.current && generation.current === current) {
        setState(next);
        setError(next.errorCode);
      }
    } catch (failure) {
      if (live.current) setError(globalWebErrorCode(failure));
    } finally {
      if (live.current) setBusy(false);
    }
  };
  const active = !!state && ["checking", "opening", "open", "closing"].includes(state.phase);
  const cleanupNeeded = error === "GLOBAL_WEB_CLEANUP_FAILED";
  return (
    <section aria-label={`${account.displayName} 的官网窗口`} className={styles.webPending}>
      <Badge>{state ? LABELS[state.phase] : "正在读取窗口状态"}</Badge>
      <div className={styles.actions}>
        <Button
          icon={Globe}
          disabled={!hasBridge || busy || !state || active || cleanupNeeded || !proxyOn}
          onClick={() => void act("open")}
        >
          打开官网
        </Button>
        <Button
          icon={X}
          variant="ghost"
          disabled={busy || (!active && !cleanupNeeded)}
          onClick={() => void act("close")}
        >
          {cleanupNeeded ? "重试关闭" : "关闭窗口"}
        </Button>
      </div>
      <p>在软件内打开官网，完成登录、查看后台和人工发布。每个账号独立保存登录环境。</p>
      {!proxyOn ? <p>国外平台已休眠；开启代理后可点击“打开官网”。</p> : null}
      {!hasBridge ? <p>浏览器预览不能启动本机账号窗口，请在桌面工作台操作。</p> : null}
      {error ? <p role="alert">{ERRORS[error]}</p> : null}
    </section>
  );
}
