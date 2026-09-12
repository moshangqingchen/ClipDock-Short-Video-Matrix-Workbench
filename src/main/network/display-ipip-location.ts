import { isIP } from "node:net";

export interface DisplayIpipLocation {
  country: string;
  region: string | null;
  city: string | null;
}
const regions = new Set([
  "北京",
  "天津",
  "上海",
  "重庆",
  "河北",
  "山西",
  "辽宁",
  "吉林",
  "黑龙江",
  "江苏",
  "浙江",
  "安徽",
  "福建",
  "江西",
  "山东",
  "河南",
  "湖北",
  "湖南",
  "广东",
  "海南",
  "四川",
  "贵州",
  "云南",
  "陕西",
  "甘肃",
  "青海",
  "内蒙古",
  "广西",
  "西藏",
  "宁夏",
  "新疆",
]);
const operator =
  /电信|联通|移动|广电|铁通|教育|科技|通信|网络|数据|服务|公司|互联|宽带|骨干|有线|长城|鹏博士|华为|阿里|腾讯|百度|亚马逊|Cloud|^ISP$|^AS\d+$/i;
const unknown = /^(?:未知|未知地区|未知城市|不详|省级|全国|其他|其它|全省|局域网|保留地址)$/;

/** Informational labels only. This does not grant route permission or replace parseDomesticEgress. */
export function parseDisplayIpipLocation(body: Buffer): DisplayIpipLocation | null {
  if (!body.length || body.length > 4096) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    if (text.length > 1024 || /[<>\x00-\x09\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(text))
      return null;
    const match =
      /^当前 IP[：:][ ]*(\d{1,3}(?:\.\d{1,3}){3})[ ]+来自于[：:][ ]*中国(?:[ ]+([^\r\n]+))?$/.exec(
        text.trim(),
      );
    if (!match || isIP(match[1]) !== 4) return null;
    const fields = (match[2] ?? "").split(/ +/).filter(Boolean);
    if (!fields.length) return { country: "中国", region: null, city: null };
    if (fields.length > 6 || fields.some((field) => field.length > 48)) return null;
    const region = fields[0].replace(/(?:壮族自治区|回族自治区|维吾尔自治区|自治区|省|市)$/, "");
    if (!regions.has(region)) return null;
    const candidate = fields[1];
    const city =
      candidate &&
      /^[\u3400-\u9fff·]{2,24}$/.test(candidate) &&
      !operator.test(candidate) &&
      !unknown.test(candidate)
        ? candidate
        : null;
    return { country: "中国", region, city };
  } catch {
    return null;
  }
}
