import { describe, expect, it } from "vitest";
import { firstDouyinCoverUrl } from "./douyin";
import { firstUrl } from "./shared";

const webp =
  "https://p3-sign.douyinpic.com/tos-cn-p-0015/cover~tplv-dy-resize-walign-adapt-aq:540:q75.webp?x-expires=123&x-signature=one%2Btwo%2Fthree%3D";
const webp2 = webp.replace("p3-sign", "p9-sign");
const jpeg =
  "https://p3-sign.douyinpic.com/tos-cn-p-0015/cover~tplv-dy-resize-walign-adapt-aq:540:q75.jpeg?x-expires=123&x-signature=A%2Bb%2Fc%3D&from=321";
const png = "https://p3-sign.douyinpic.com/tos-cn-p-0015/cover.png?x-signature=PNG%2Bsignature%3D";

describe("Douyin static work cover selection", () => {
  it("selects the JPEG from the observed WebP, WebP, JPEG response without changing its signature", () => {
    const response = {
      aweme_list: [
        {
          aweme_id: "123",
          video: {
            cover: {
              uri: "tos-cn-p-0015/cover",
              url_list: [webp, webp2, jpeg],
              width: 540,
              height: 960,
            },
          },
        },
      ],
    };
    const before = structuredClone(response);
    expect(firstDouyinCoverUrl(response.aweme_list[0].video.cover)).toBe(jpeg);
    expect(response).toEqual(before);
    expect(firstUrl(response.aweme_list[0].video.cover)).toBe(webp);
  });

  it("preserves platform order among supported JPEG and PNG variants", () => {
    expect(firstDouyinCoverUrl({ url_list: [webp, png, jpeg] })).toBe(png);
    expect(firstDouyinCoverUrl([jpeg, png])).toBe(jpeg);
  });

  it("recognizes explicit query formats without inspecting or rewriting signed query values", () => {
    const queryJpeg =
      "https://p3-sign.douyinpic.com/cover?format=jpeg&x-signature=A%2Bb%2Fc%3D&x-expires=123";
    expect(firstDouyinCoverUrl([webp, queryJpeg])).toBe(queryJpeg);
    expect(firstDouyinCoverUrl([webp + "&x-signature=misleading.jpg", png])).toBe(png);
    expect(firstDouyinCoverUrl([jpeg + "&format=webp", png])).toBe(png);
    const queryPng = queryJpeg.replace("format=jpeg", "fm=PNG");
    expect(firstDouyinCoverUrl([webp, queryPng])).toBe(queryPng);
  });

  it("supports URI objects and the existing nested URL list shapes", () => {
    expect(firstDouyinCoverUrl({ url_list: [{ uri: webp }, { uri: jpeg }] })).toBe(jpeg);
    expect(firstDouyinCoverUrl({ url: [{ src: webp }, { url: png }] })).toBe(png);
    expect(firstDouyinCoverUrl({ uri: jpeg })).toBe(jpeg);
  });

  it.each([webp, { url_list: [webp, webp2] }, { uri: "tos-cn-p-0015/cover" }, null, []])(
    "keeps the original first-URL fallback when no supported variant exists: %j",
    (value) => {
      expect(firstDouyinCoverUrl(value)).toBe(firstUrl(value));
    },
  );
});
