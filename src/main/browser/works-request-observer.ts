import type { WebContents } from "electron";
import { acquireDebugger } from "./debugger-lease";
import { canUseBusinessNetwork } from "@main/network/business-access";

export interface ObservedWorksRequest { url: string; method: string; body?: string }
const endpoint = "https://channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin/post/post_list";
function matches(url: string): boolean {
  try { const parsed = new URL(url); return parsed.origin + parsed.pathname === endpoint; } catch { return false; }
}
/** Only a request made by this document is usable. Security context stays in memory. */
export class WorksRequestObserver {
  private request: (ObservedWorksRequest & { at: number }) | null = null;
  private epoch = 0;
  private disposed = false;
  private release: (() => void) | null = null;
  constructor(private readonly contents: WebContents, private readonly accountId: string) {
    try {
      this.release = acquireDebugger(contents);
      contents.debugger.on("message", this.onMessage);
      contents.debugger.on("detach", this.invalidate);
      contents.on("did-start-navigation", this.navigate);
      void contents.debugger.sendCommand("Network.enable").catch(this.invalidate);
    } catch { this.invalidate(); }
  }
  private readonly navigate = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
    if (mainFrame && !inPlace) this.invalidate();
  };
  private readonly invalidate = () => { this.request = null; this.epoch++; };
  private readonly onMessage = (_event: unknown, method: string, params: Record<string, any>) => {
    if (method !== "Network.requestWillBeSent" || this.disposed) return;
    if (!canUseBusinessNetwork(this.accountId)) { this.invalidate(); return; }
    const request = params.request;
    if (!request || !matches(String(request.url)) || request.method !== "POST") return;
    const epoch = this.epoch;
    const accept = (body: string) => {
      if (this.disposed || epoch !== this.epoch || body.length > 64_000 || !canUseBusinessNetwork(this.accountId)) return;
      try {
        const data = JSON.parse(body);
        if (!data || typeof data !== "object" || Array.isArray(data)) return;
        // Do not allow our own collection request to renew the native template's lifetime.
        if (this.request && Date.now() - this.request.at < 30_000) return;
        this.request = { url: endpoint, method: "POST", body, at: Date.now() };
      } catch { /* No request can be constructed without a valid page body. */ }
    };
    if (typeof request.postData === "string") accept(request.postData);
    else if (request.hasPostData) void this.contents.debugger.sendCommand("Network.getRequestPostData", { requestId: params.requestId })
      .then((result) => { if (typeof result.postData === "string") accept(result.postData); }).catch(() => undefined);
  };
  read(): ObservedWorksRequest | null {
    if (!this.request || Date.now() - this.request.at > 30_000 || !canUseBusinessNetwork(this.accountId)) return null;
    return { url: this.request.url, method: this.request.method, body: this.request.body };
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.invalidate();
    this.contents.debugger?.removeListener("message", this.onMessage);
    this.contents.debugger?.removeListener("detach", this.invalidate);
    this.contents.removeListener("did-start-navigation", this.navigate);
    this.release?.();
  }
}
