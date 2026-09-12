import { describe, expect, it, vi } from "vitest";
import type { CollectorContext } from "./shared";
import type * as Shared from "./shared";
const mocks=vi.hoisted(()=>({json:vi.fn(),dom:vi.fn()}));
vi.mock("./shared",async importOriginal=>({...await importOriginal<typeof Shared>(),firstJson:mocks.json,domScrapeNumbers:mocks.dom}));
import { baijiahaoCollector } from "./baijiahao";
describe("Baijiahao page metric fallback",()=>{
  it("retains likes, following, comments, shares and favorites including zero",async()=>{
    mocks.json.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce({data:{list:[]}});
    mocks.dom.mockResolvedValue({following:3,likes:0,comments:2,shares:4,favorites:5});
    const result=await baijiahaoCollector.collect({account:{id:"account",platformId:"baijiahao"},webContents:{}} as CollectorContext);
    expect(Object.fromEntries(result.metrics.map(m=>[m.metric,m.value]))).toEqual({following:3,likes:0,comments:2,shares:4,favorites:5});
    expect(result.warnings).toEqual(["部分数据从页面读取"]);
  });
});
