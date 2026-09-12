import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const assets = {
  "douyin.ico": "https://lf3-static.bytednsdoc.com/obj/eden-cn/yvahlyj_upfbvk_zlp/ljhwZthlaukjlkulzlp/pc_creator/favicon_v2_7145ff0.ico",
  "kuaishou.png": "https://static.yximgs.com/udata/pkg/frontend-explore/material-lib-www/pure-logo-1-min.png",
  "xiaohongshu.png": "https://picasso-static.xiaohongshu.com/fe-platform/f43dc4a8baf03678996c62d8db6ebc01a82256ff.png",
  "bilibili.png": "https://i0.hdslb.com/bfs/static/jinkela/long/images/512.png",
  "baijiahao.ico": "https://baijiahao.baidu.com/favicon.ico",
  "weixin_channels.ico": "https://res.wx.qq.com/t/wx_fed/finder/helper/finder-helper-web/res/favicon-v2.ico",
  "youtube.png": "https://www.youtube.com/s/desktop/e60429bd/img/favicon_144x144.png",
  "tiktok.png": "https://www.tiktok.com/apple-touch-icon.png",
  "x.ico": "https://x.com/favicon.ico",
};
const directory = new URL("../src/renderer/assets/platforms/", import.meta.url);
await mkdir(directory, { recursive: true });
await Promise.all(Object.entries(assets).map(async ([name, url]) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok || !response.headers.get("content-type")?.startsWith("image/")) throw new Error(`Invalid official logo: ${name}`);
  await writeFile(new URL(name, directory), new Uint8Array(await response.arrayBuffer()));
  console.log(`Downloaded ${name}`);
}));
console.log(fileURLToPath(directory));
