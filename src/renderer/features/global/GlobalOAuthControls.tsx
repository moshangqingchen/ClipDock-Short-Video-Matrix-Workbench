import { useEffect, useRef, useState } from "react";
import type { GlobalAccount } from "@shared/global-accounts";
import {
  globalOAuthErrorCode,
  projectGlobalOAuthState,
  type GlobalOAuthErrorCode,
  type GlobalOAuthState,
} from "@shared/global-oauth";
import { Button } from "@renderer/components/ui";
import { api, hasBridge } from "@renderer/lib/api";

const ERRORS: Record<GlobalOAuthErrorCode, string> = {
  GLOBAL_OAUTH_INVALID_ACCOUNT: "账号记录已失效，请刷新列表。",
  GLOBAL_OAUTH_NOT_CONFIGURED: "请先配置该平台的开发者应用。",
  GLOBAL_OAUTH_ENCRYPTION_UNAVAILABLE: "本机加密存储不可用，暂不能保存授权。",
  GLOBAL_OAUTH_SECRET_UNAVAILABLE: "应用密钥缺失或无法解密，请重新填写。",
  GLOBAL_OAUTH_PROXY_UNVERIFIED: "代理链路尚未验证，未打开官方授权。",
  GLOBAL_OAUTH_BUSY: "此前授权仍在收尾，请稍后重试。",
  GLOBAL_OAUTH_REVOKED: "配置或网络条件已变化，本次授权已停止。",
  GLOBAL_OAUTH_CANCELLED: "授权已取消。",
  GLOBAL_OAUTH_EXPIRED: "授权已超时，请重试。",
  GLOBAL_OAUTH_FAILED: "官方授权未完成，请检查应用配置后重试。",
  GLOBAL_OAUTH_UNAVAILABLE: "授权服务暂不可用，请稍后重试。",
};
const active = (phase: GlobalOAuthState["phase"] | undefined) =>
  phase === "starting" || phase === "awaiting_user" || phase === "exchanging";
const order = (phase: GlobalOAuthState["phase"]) =>
  phase === "idle"
    ? -1
    : phase === "starting"
      ? 0
      : phase === "awaiting_user"
        ? 1
        : phase === "exchanging"
          ? 2
          : 3;
interface Lifetime {
  alive: boolean;
  version: number;
  events: number;
  cancelPending: boolean;
  current: GlobalOAuthState | null;
  retired: Set<string>;
  accept(raw: unknown): void;
}

/** Transaction projections live only in this mounted row; they are never persisted. */
export function GlobalOAuthControls(props: { account: GlobalAccount; onAuthorized(): void }) {
  const { account } = props;
  return (
    <MountedGlobalOAuthControls
      key={`${account.id}:${account.platformId}:${account.authStatus}:${account.updatedAt}`}
      {...props}
    />
  );
}

function MountedGlobalOAuthControls({
  account,
  onAuthorized,
}: {
  account: GlobalAccount;
  onAuthorized(): void;
}) {
  const [state, setState] = useState<GlobalOAuthState | null>(null);
  const [ready, setReady] = useState(!hasBridge);
  const [pending, setPending] = useState<"start" | "startDraft" | "startUpload" | "cancel" | null>(null);
  const [error, setError] = useState<GlobalOAuthErrorCode | null>(null);
  const lifetime = useRef<Lifetime | null>(null);
  const authorized = useRef(onAuthorized);
  useEffect(() => {
    authorized.current = onAuthorized;
  }, [onAuthorized]);

  useEffect(() => {
    const current: Lifetime = {
      alive: true,
      version: 0,
      events: 0,
      cancelPending: false,
      current: null,
      retired: new Set(),
      accept: () => undefined,
    };
    lifetime.current = current;
    current.accept = (raw) => {
      if (!current.alive) return;
      const next = projectGlobalOAuthState(raw);
      if (!next || next.accountId !== account.id || next.platformId !== account.platformId) return;
      if (next.transactionId && current.retired.has(next.transactionId)) return;
      if (current.cancelPending && (active(next.phase) || next.phase === "authorized")) return;
      const previous = current.current;
      if (previous?.transactionId) {
        if (previous.transactionId === next.transactionId) {
          if (!active(previous.phase) && previous.phase !== next.phase) return;
          if (order(next.phase) < order(previous.phase)) return;
        } else if (next.phase === "starting" && !active(previous.phase)) {
          current.retired.add(previous.transactionId);
        } else if (next.phase !== "idle") return;
      }
      current.current = next;
      setState(next);
      setError(null);
      if (next.phase === "authorized" && previous?.phase !== "authorized") authorized.current();
    };
    if (!hasBridge) {
      return () => {
        current.alive = false;
      };
    }
    const unsubscribe = api.globalOAuth.onState((next) => {
      const value = projectGlobalOAuthState(next);
      if (!value || value.accountId !== account.id || value.platformId !== account.platformId) return;
      current.events += 1;
      if (value.phase === "authorized") {
        const event = current.events;
        const version = current.version;
        // A queued event can outlive a local disconnect or a mounted row. Read
        // current main state before letting an authorization event refresh DB UI.
        void api.globalOAuth
          .state(account.id)
          .then((latest) => {
            if (
              current.alive &&
              current.events === event &&
              current.version === version &&
              latest.phase === "authorized" &&
              latest.transactionId === value.transactionId
            )
              current.accept(latest);
          })
          .catch(() => undefined);
        return;
      }
      current.accept(value);
    });
    const queryEvents = current.events;
    void api.globalOAuth
      .state(account.id)
      .then((next) => {
        if (current.version === 0 && current.events === queryEvents) current.accept(next);
      })
      .catch(() => {
        if (current.alive && current.version === 0 && current.events === queryEvents)
          setError("GLOBAL_OAUTH_UNAVAILABLE");
      })
      .finally(() => {
        if (current.alive) setReady(true);
      });
    return () => {
      current.alive = false;
      unsubscribe();
    };
  }, [account.id, account.platformId, account.authStatus, account.updatedAt]);

  const request = async (action: "start" | "startDraft" | "startUpload" | "cancel") => {
    const current = lifetime.current;
    if (
      !hasBridge ||
      !ready ||
      !current?.alive ||
      pending === "cancel" ||
      (action !== "cancel" && (pending !== null || active(current.current?.phase)))
    )
      return;
    const version = ++current.version;
    setPending(action);
    setError(null);
    if (action !== "cancel") {
      if (current.current?.transactionId) current.retired.add(current.current.transactionId);
      current.cancelPending = false;
      current.current = null;
      current.accept({
        accountId: account.id,
        platformId: account.platformId,
        transactionId: null,
        phase: "starting",
        errorCode: null,
      });
    } else current.cancelPending = true;
    try {
      const result = await api.globalOAuth[action](account.id);
      if (!current.alive || version !== current.version) return;
      // cancel() can truthfully report that a commit already finished. Only its
      // direct current response may lift suppression; a delayed event cannot.
      if (action === "cancel" && result.phase === "authorized") current.cancelPending = false;
      current.accept(result);
    } catch (failure) {
      if (current.alive && version === current.version) {
        setError(globalOAuthErrorCode(failure));
        if (action !== "cancel") {
          current.current = null;
          setState(null);
        }
      }
    } finally {
      if (current.alive && version === current.version) setPending(null);
    }
  };
  const status = state?.errorCode
    ? ERRORS[state.errorCode]
    : state?.phase === "starting"
      ? "正在检查授权条件…"
      : state?.phase === "awaiting_user"
        ? "请在系统浏览器完成官方授权。"
        : state?.phase === "exchanging"
          ? "正在核对并保存官方授权…"
          : state?.phase === "authorized"
            ? "官方授权已完成。"
            : state?.phase === "cancelled"
              ? ERRORS.GLOBAL_OAUTH_CANCELLED
              : state?.phase === "expired"
                ? ERRORS.GLOBAL_OAUTH_EXPIRED
                : null;
  return (
    <div aria-label={`${account.displayName} 的官方授权`}>
      <Button
        disabled={!hasBridge || !ready || pending !== null || active(state?.phase)}
        onClick={() => void request("start")}
        title={
          !hasBridge
            ? "浏览器预览不能发起真实授权，请使用桌面端"
            : "由主进程检查应用配置和代理后打开系统浏览器"
        }
      >
        官方授权
      </Button>
      {account.platformId === "tiktok" ? (
        <Button
          disabled={!hasBridge || !ready || pending !== null || active(state?.phase)}
          onClick={() => void request("startDraft")}
          title="申请上传到 TikTok 收件箱的权限，最终发布仍由你在 TikTok 内确认"
        >
          授权草稿上传
        </Button>
      ) : null}
      {hasBridge && (active(state?.phase) || pending === "cancel") ? (
        <Button disabled={pending === "cancel"} onClick={() => void request("cancel")}>
          取消授权
        </Button>
      ) : null}
      {account.platformId === "youtube" ? (
        <Button
          disabled={!hasBridge || !ready || pending !== null || active(state?.phase)}
          onClick={() => void request("startUpload")}
          title="单独申请 YouTube 视频上传权限"
        >
          授权视频上传
        </Button>
      ) : null}
      {pending === "cancel" ? (
        <p role="status">正在取消授权…</p>
      ) : status ? (
        <p role="status">{status}</p>
      ) : null}
      {error ? <p role="alert">{ERRORS[error]}</p> : null}
      {!hasBridge ? <p>浏览器预览不能发起真实授权。</p> : null}
    </div>
  );
}
