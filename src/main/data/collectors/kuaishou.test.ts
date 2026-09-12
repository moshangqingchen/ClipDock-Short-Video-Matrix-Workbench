import {expect,it,vi} from "vitest";
import type {CollectorContext} from "./shared";
import type * as Shared from "./shared";
const calls=vi.hoisted(()=>({json:vi.fn()}));
vi.mock("./shared",async importOriginal=>({...await importOriginal<typeof Shared>(),firstJson:calls.json}));
import {kuaishouCollector} from "./kuaishou";
it("uses verified live identity without replaying empty authentication requests",async()=>{
  const identityProfile={externalId:"self",followers:0,following:2,likes:3};
  const context={account:{id:"account",platformId:"kuaishou"},webContents:{},identityProfile} as CollectorContext;
  expect(await kuaishouCollector.fetchProfile!(context)).toBe(identityProfile);
  expect(calls.json).not.toHaveBeenCalled();
  calls.json.mockResolvedValue({data:{list:[]}});
  const result=await kuaishouCollector.collect(context);
  expect(Object.fromEntries(result.metrics.map(m=>[m.metric,m.value]))).toEqual({followers:0,following:2,likes:3});
  expect(calls.json).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(calls.json.mock.calls[0][1])).not.toContain('/home/info');
});
