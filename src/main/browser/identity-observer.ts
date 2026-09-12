import type { WebContents } from "electron";
import type { PlatformId } from "@shared/platforms";
import { canUseBusinessNetwork } from "@main/network/business-access";
import { acquireDebugger } from "./debugger-lease";
import { isIdentityEndpoint, parseIdentityResponse, type IdentityEvidence } from "./identity-evidence";

interface Pending {
  url: string;
  sequence: number;
  epoch: number;
  status?: number;
}

/** Observes first-party identity responses without changing or replaying page requests. */
export class IdentityObserver {
  private pending = new Map<string, Pending>();
  private evidence: IdentityEvidence | null = null;
  private subject: string | null = null;
  private epoch = 0;
  private sequence = 0;
  private disposed = false;
  private release: (() => void) | null = null;

  constructor(
    private readonly contents: WebContents,
    private readonly accountId: string,
    private readonly platform: PlatformId,
    private readonly changed: () => void,
  ) {
    if (platform !== "kuaishou" && platform !== "weixin_channels") return;
    try {
      this.release = acquireDebugger(contents);
      contents.debugger.on("message", this.onMessage);
      contents.debugger.on("detach", this.onDetach);
      contents.on("did-start-navigation", this.onNavigate);
      void contents.debugger
        .sendCommand("Network.enable", {
          maxTotalBufferSize: 1048576,
          maxResourceBufferSize: 262144,
          maxPostDataSize: 0,
        })
        .catch(this.onDetach);
    } catch {
      this.onDetach();
    }
  }

  read(): IdentityEvidence | null {
    if (!this.evidence || Date.now() - this.evidence.observedAt > 30000) return null;
    return this.evidence;
  }
  /** Document identity for race checks only; never fresh login/profile evidence. */
  readSubject(): string | null {
    return this.subject;
  }
  invalidate(): void {
    this.epoch++;
    this.pending.clear();
    this.evidence = null;
    this.subject = null;
  }
  private readonly onNavigate = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
    if (mainFrame && !inPlace) this.invalidate();
  };
  private readonly onDetach = () => {
    this.invalidate();
    if (this.disposed) return;
    const sequence = ++this.sequence;
    this.evidence = {
      kind: "unconfirmed",
      reason: "身份观察连接已断开，重新加载账号页面后复核",
      sequence,
      observedAt: Date.now(),
      key: `${this.contents.id}:${this.epoch}:${sequence}`,
    };
    this.changed();
  };
  private readonly onMessage = (_event: unknown, method: string, params: Record<string, unknown>) => {
    if (this.disposed || !canUseBusinessNetwork(this.accountId)) {
      this.invalidate();
      return;
    }
    const id = String(params.requestId ?? "");
    if (method === "Network.requestWillBeSent") {
      const request = params.request as { url?: string } | undefined;
      this.pending.delete(id);
      if (!request?.url || !isIdentityEndpoint(this.platform, request.url)) return;
      if (this.pending.size >= 32) this.pending.delete(this.pending.keys().next().value!);
      this.pending.set(id, { url: request.url, sequence: ++this.sequence, epoch: this.epoch });
    } else if (method === "Network.responseReceived") {
      const pending = this.pending.get(id);
      const response = params.response as {
        url: string;
        status: number;
        fromDiskCache?: boolean;
        fromServiceWorker?: boolean;
      };
      if (
        !pending ||
        !response ||
        !isIdentityEndpoint(this.platform, response.url) ||
        response.fromDiskCache ||
        response.fromServiceWorker
      ) {
        this.pending.delete(id);
        return;
      }
      pending.url = response.url;
      pending.status = response.status;
    } else if (method === "Network.loadingFailed") {
      this.pending.delete(id);
    } else if (method === "Network.loadingFinished") {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      if (!pending || pending.status === undefined || Number(params.encodedDataLength) > 262144) return;
      void this.consume(id, pending);
    }
  };
  private async consume(id: string, pending: Pending): Promise<void> {
    try {
      const body = (await this.contents.debugger.sendCommand("Network.getResponseBody", {
        requestId: id,
      })) as { body: string; base64Encoded: boolean };
      if (
        this.disposed ||
        pending.epoch !== this.epoch ||
        !canUseBusinessNetwork(this.accountId) ||
        pending.sequence < this.sequence ||
        typeof body.body !== "string" ||
        body.body.length > 350000
      )
        return;
      const text = body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body;
      const verdict = parseIdentityResponse(this.platform, pending.url, pending.status!, text);
      if (verdict.kind === "online") this.subject = verdict.subject ?? null;
      else if (verdict.kind === "offline") this.subject = null;
      this.evidence = {
        ...verdict,
        sequence: pending.sequence,
        observedAt: Date.now(),
        key: `${this.contents.id}:${this.epoch}:${pending.sequence}`,
      };
      this.changed();
    } catch {
      /* Unavailable data cannot change an authentication conclusion. */
    }
  }
  dispose(): void {
    this.disposed = true;
    this.invalidate();
    this.contents.debugger?.removeListener("message", this.onMessage);
    this.contents.debugger?.removeListener("detach", this.onDetach);
    this.contents.removeListener("did-start-navigation", this.onNavigate);
    try {
      this.release?.();
    } catch {
      /* Native destruction may already have detached it. */
    }
    this.release = null;
  }
}
