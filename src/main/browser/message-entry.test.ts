import { describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { buildDouyinMessageEntryScript } from "./message-entry";

function run(html: string, url = "https://www.douyin.com/jingxuan") {
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  try {
    const clicked = vi.fn();
    dom.window.document.addEventListener("click", event => { event.preventDefault(); clicked(); });
    dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 40, height: 20 }) as DOMRect;
    Object.defineProperty(dom.window.document, "cookie", { get() { throw new Error("no credential reads"); } });
    dom.window.fetch = () => { throw new Error("no requests"); };
    const result = dom.window.eval(buildDouyinMessageEntryScript());
    return { result, clicked: clicked.mock.calls.length };
  } finally { dom.window.close(); }
}

describe("official message navigation", () => {
  it("opens exactly one visible header entry without reading conversations", () => {
    expect(run('<header><button>消息 2</button><button>通知</button></header><main><button>发送</button></main>'))
      .toEqual({ result: true, clicked: 1 });
  });
  it.each([
    '<main><button>消息</button></main>',
    '<header><button>发送消息</button></header>',
    '<header><button>消息</button><button>消息</button></header>',
    '<header hidden><button>消息</button></header>',
    '<header><button disabled>消息</button></header>',
    '<header><form><button>消息</button></form></header>',
    '<header><a href="https://other.example/">消息</a></header>',
    '<header><a href="javascript:alert(1)">消息</a></header>',
    '<header><a href="https://user@www.douyin.com/">消息</a></header>',
  ])("does not activate ambiguous, non-navigation or unsafe controls: %s", html => {
    expect(run(html)).toEqual({ result: false, clicked: 0 });
  });
  it.each(["https://creator.douyin.com/", "https://www.douyin.com.evil.test/", "http://www.douyin.com/", "https://www.douyin.com:8443/"])(
    "does not operate outside the official public origin: %s", url => {
      expect(run('<header><button>消息</button></header>', url)).toEqual({ result: false, clicked: 0 });
    },
  );
});
