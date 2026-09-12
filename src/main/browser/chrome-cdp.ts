/** Main-process-only CDP transport. No socket, renderer script or personal profile. */
export interface CdpPacket {
  id?: number;
  sessionId?: string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

export class ChromePipe {
  private sequence = 0;
  private disposed = false;
  private pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  private listeners = new Set<(packet: CdpPacket) => void>();
  constructor(private readonly send: (payload: string) => void) {}

  request<T = Record<string, unknown>>(
    method: string,
    params: object = {},
    sessionId?: string,
    timeout = 12000,
  ): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("GLOBAL_WEB_BROWSER_UNAVAILABLE"));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("GLOBAL_WEB_BROWSER_UNAVAILABLE"));
      }, timeout);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      try {
        this.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("GLOBAL_WEB_BROWSER_UNAVAILABLE"));
      }
    });
  }
  receive(payload: string): void {
    if (this.disposed || payload.length > 2097152) return;
    let packet: CdpPacket;
    try {
      packet = JSON.parse(payload) as CdpPacket;
    } catch {
      this.close();
      return;
    }
    if (typeof packet.id === "number") {
      const pending = this.pending.get(packet.id);
      if (!pending) return;
      this.pending.delete(packet.id);
      clearTimeout(pending.timer);
      if (packet.error) pending.reject(new Error("GLOBAL_WEB_BROWSER_UNAVAILABLE"));
      else pending.resolve(packet.result ?? {});
    } else for (const listener of this.listeners) listener(packet);
  }
  subscribe(listener: (packet: CdpPacket) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  close(): void {
    this.disposed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("GLOBAL_WEB_BROWSER_UNAVAILABLE"));
    }
    this.pending.clear();
    this.listeners.clear();
  }
}

export interface ChromePageState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}
export class ChromePage {
  sessionId = "";
  targetId = "";
  private generation = 0;
  private mainFrameId = "";
  private state: ChromePageState = {
    url: "",
    title: "",
    loading: true,
    canGoBack: false,
    canGoForward: false,
  };
  private listeners = new Set<(state: ChromePageState) => void>();
  constructor(
    readonly pipe: ChromePipe,
    private readonly documentChanged: (url: string) => void,
  ) {}
  async start(): Promise<void> {
    const { targetInfos } = await this.pipe.request<{
      targetInfos: Array<{ targetId: string; type: string; url: string }>;
    }>("Target.getTargets");
    const target = targetInfos.find((value) => value.type === "page" && !value.url.startsWith("devtools:"));
    if (!target) throw new Error("GLOBAL_WEB_BROWSER_UNAVAILABLE");
    this.targetId = target.targetId;
    this.sessionId = (
      await this.pipe.request<{ sessionId: string }>("Target.attachToTarget", {
        targetId: this.targetId,
        flatten: true,
      })
    ).sessionId;
    this.pipe.subscribe((packet) => {
      if (packet.sessionId !== this.sessionId) return;
      if (packet.method === "Page.frameNavigated") {
        const frame = packet.params?.frame as { id?: string; parentId?: string; url?: string } | undefined;
        if (frame && !frame.parentId && frame.url) {
          this.mainFrameId = frame.id ?? this.mainFrameId;
          this.navigation(frame.url);
        }
      }
      if (
        packet.method === "Page.navigatedWithinDocument" &&
        packet.params?.frameId === this.mainFrameId &&
        typeof packet.params?.url === "string"
      )
        this.navigation(packet.params.url);
      if (packet.method === "Page.frameStartedLoading" && packet.params?.frameId === this.mainFrameId) {
        this.state.loading = true;
        this.emit();
      }
      if (
        packet.method === "Page.loadEventFired" ||
        (packet.method === "Page.frameStoppedLoading" && packet.params?.frameId === this.mainFrameId)
      ) {
        this.state.loading = false;
        void this.refresh().catch(() => undefined);
      }
    });
    await this.call("Page.enable");
    await this.call("Runtime.enable");
    const { frameTree } = await this.call<{ frameTree: { frame: { id: string; url: string } } }>(
      "Page.getFrameTree",
    );
    this.mainFrameId = frameTree.frame.id;
    this.navigation(frameTree.frame.url);
    await this.refresh();
  }
  private navigation(url: string): void {
    this.generation++;
    this.state.url = url;
    this.documentChanged(url);
    this.emit();
    void this.refresh().catch(() => undefined);
  }
  private emit(): void {
    for (const listener of this.listeners) listener({ ...this.state });
  }
  subscribe(listener: (state: ChromePageState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  getState(): ChromePageState {
    return { ...this.state };
  }
  call<T = Record<string, unknown>>(
    method: string,
    params: object = {},
    sessionId = this.sessionId,
  ): Promise<T> {
    return this.pipe.request<T>(method, params, sessionId);
  }
  async evaluate<T>(expression: string, sessionId = this.sessionId): Promise<T> {
    const value = await this.call<{ result: { value: T }; exceptionDetails?: unknown }>(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (value.exceptionDetails) throw new Error("WEB_OBSERVE_UNAVAILABLE");
    return value.result.value;
  }
  async refresh(): Promise<void> {
    const generation = this.generation;
    const [history, title] = await Promise.all([
      this.call<{ currentIndex: number; entries: Array<{ id: number }> }>("Page.getNavigationHistory"),
      this.evaluate<string>("document.title"),
    ]);
    if (generation !== this.generation) return;
    this.state = {
      ...this.state,
      title,
      canGoBack: history.currentIndex > 0,
      canGoForward: history.currentIndex < history.entries.length - 1,
    };
    this.emit();
  }
  async navigate(url: string): Promise<void> {
    await this.call("Page.navigate", { url });
  }
  async command(command: "back" | "forward" | "reload"): Promise<void> {
    if (command === "reload") {
      await this.call("Page.reload");
      return;
    }
    const history = await this.call<{ currentIndex: number; entries: Array<{ id: number }> }>(
      "Page.getNavigationHistory",
    );
    const entry = history.entries[history.currentIndex + (command === "back" ? -1 : 1)];
    if (entry) await this.call("Page.navigateToHistoryEntry", { entryId: entry.id });
  }
  async read<T>(expression: string): Promise<T> {
    const generation = this.generation;
    const value = await this.evaluate<T>(expression);
    if (generation !== this.generation) throw new Error("WEB_OBSERVE_CANCELLED");
    return value;
  }
  async devTools(): Promise<void> {
    await this.pipe.request("Target.openDevTools", { targetId: this.targetId });
  }
  async background<T>(url: string, expression: string, assertCurrent: () => void): Promise<T> {
    assertCurrent();
    const { targetId } = await this.pipe.request<{ targetId: string }>("Target.createTarget", {
      url: "about:blank",
      hidden: true,
      background: true,
    });
    try {
      const { sessionId } = await this.pipe.request<{ sessionId: string }>("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      await this.call("Page.enable", {}, sessionId);
      await this.call("Page.navigate", { url }, sessionId);
      for (let attempt = 0; attempt < 40; attempt++) {
        assertCurrent();
        await new Promise((resolve) => setTimeout(resolve, 400));
        try {
          const ready = await this.evaluate<boolean>(
            "document.readyState === 'complete' && document.body.innerText.length > 60",
            sessionId,
          );
          if (!ready) continue;
          // SPA creator dashboards populate shortly after the document completes.
          await new Promise((resolve) => setTimeout(resolve, 1000));
          const value = await this.evaluate<T>(expression, sessionId);
          assertCurrent();
          return value;
        } catch {
          assertCurrent();
        }
      }
      throw new Error("WEB_OBSERVE_UNAVAILABLE");
    } finally {
      await this.pipe.request("Target.closeTarget", { targetId }).catch(() => undefined);
    }
  }
}
