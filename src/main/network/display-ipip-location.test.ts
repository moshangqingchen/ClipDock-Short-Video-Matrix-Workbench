import { describe, expect, it } from "vitest";
import { parseDisplayIpipLocation } from "./display-ipip-location";
import { parseDomesticEgress } from "@main/api/proxy-egress-probe";

const body = (location: string) => Buffer.from(`当前 IP： 110.43.50.20  来自于： ${location}\n`);
describe("IPIP display-only location parsing", () => {
  it.each([
    ["中国 四川 成都 电信", "四川", "成都"],
    ["中国 广东省 深圳市 联通", "广东", "深圳市"],
    ["中国 内蒙古自治区 呼和浩特市 移动", "内蒙古", "呼和浩特市"],
    ["中国 北京 北京 电信", "北京", "北京"],
  ])("reads bounded city labels from %s", (input, region, city) => {
    expect(parseDisplayIpipLocation(body(input))).toEqual({ country: "中国", region, city });
  });
  it.each(["中国 北京", "中国 北京 电信", "中国 北京 鹏博士", "中国 北京 未知"])(
    "falls back to the region when no city is present: %s",
    (input) => {
      expect(parseDisplayIpipLocation(body(input))).toEqual({ country: "中国", region: "北京", city: null });
    },
  );
  it("retains country-only information without inventing a city", () => {
    expect(parseDisplayIpipLocation(body("中国"))).toEqual({ country: "中国", region: null, city: null });
  });
  it.each([
    "<html>中国 北京</html>",
    "当前 IP： 110.43.50.20 来自于： 中国 北京\n<script>bad</script>",
    "当前 IP： 110.43.50.20 来自于： 中国 北京\u0000",
    "当前 IP： 110.43.50.20 来自于： 中国\t北京",
    "当前 IP： 110.43.50.20 来自于： 中国 北京 \u202e成都",
    "当前 IP：\n110.43.50.20 来自于： 中国 北京",
    "当前 IP： 999.43.50.20 来自于： 中国 北京",
    "当前 IP： 110.43.50.20 来自于： 美国 加州",
    "当前 IP： 110.43.50.20 来自于： 中国 不存在省份",
    "当前 IP： 110.43.50.20 来自于： 中国 香港",
  ])("rejects malformed/untrusted display text", (text) => {
    expect(parseDisplayIpipLocation(Buffer.from(text))).toBeNull();
  });
  it("rejects oversized and invalid UTF-8 while leaving the original permission parser unchanged", () => {
    expect(parseDisplayIpipLocation(Buffer.alloc(4097, 65))).toBeNull();
    expect(parseDisplayIpipLocation(Buffer.from([0xc0, 0xaf]))).toBeNull();
    const knownIpUnknownRegion = body("中国 未识别区域");
    expect(parseDomesticEgress(knownIpUnknownRegion)).toEqual({ ip: "110.43.50.20", countryCode: "CN" });
    expect(parseDisplayIpipLocation(knownIpUnknownRegion)).toBeNull();
  });
});
