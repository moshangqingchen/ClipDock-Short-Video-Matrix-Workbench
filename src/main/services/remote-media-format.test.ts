import { describe, expect, it } from "vitest";
import { inspectRemoteMedia } from "./remote-media-format";

// Synthetic container/header fixtures only. Pixel decoding and PNG CRC validation belong to the
// separate Chromium decode step; these bytes are never written as pictures or sent to the network.
function pngChunk(kind: string, data = Buffer.alloc(0)): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(kind, 4, "ascii");
  data.copy(chunk, 8);
  return chunk;
}
function png(width: number, height: number, extra: Buffer[] = []): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    ...extra,
    pngChunk("IDAT", Buffer.from([0])),
    pngChunk("IEND"),
  ]);
}
function jpegSegment(marker: number, body: Buffer): Buffer {
  const header = Buffer.from([0xff, marker, 0, 0]);
  header.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([header, body]);
}
function jpeg(width: number, height: number): Buffer {
  const frame = Buffer.from([8, 0, 0, 0, 0, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]);
  frame.writeUInt16BE(height, 1);
  frame.writeUInt16BE(width, 3);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSegment(0xe0, Buffer.from("JFIF\0")),
    jpegSegment(0xc0, frame),
    Buffer.from([0xff, 0xd9]),
  ]);
}
function webpChunk(kind: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(kind, 0, "ascii");
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, Buffer.alloc(data.length % 2)]);
}
function webp(...chunks: Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from("WEBP"), ...chunks]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0, "ascii");
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}
function vp8x(width: number, height: number, flags = 0): Buffer {
  const payload = Buffer.alloc(10);
  payload[0] = flags;
  payload.writeUIntLE(width - 1, 4, 3);
  payload.writeUIntLE(height - 1, 7, 3);
  return webpChunk("VP8X", payload);
}
function vp8l(width: number, height: number): Buffer {
  const payload = Buffer.alloc(5);
  payload[0] = 0x2f;
  payload.writeUInt32LE((width - 1) | ((height - 1) << 14), 1);
  return webpChunk("VP8L", payload);
}
function vp8(width: number, height: number): Buffer {
  const payload = Buffer.from([0x10, 0, 0, 0x9d, 0x01, 0x2a, 0, 0, 0, 0]);
  payload.writeUInt16LE(width, 6);
  payload.writeUInt16LE(height, 8);
  return webpChunk("VP8 ", payload);
}
const inspect = (input: Uint8Array) => inspectRemoteMedia(input, 10_000, 1000);

describe("remote media header limits", () => {
  it.each([
    ["PNG", () => png(73, 41), "image/png"],
    ["JPEG with application metadata", () => jpeg(73, 41), "image/jpeg"],
    ["WebP VP8X and lossless frame", () => webp(vp8x(73, 41), vp8l(73, 41)), "image/webp"],
    ["WebP lossless", () => webp(vp8l(73, 41)), "image/webp"],
    ["WebP lossy", () => webp(vp8(73, 41)), "image/webp"],
  ] as const)("reads independent width/height from %s", (_name, make, mime) => {
    expect(inspect(make())).toEqual({ width: 73, height: 41, mime });
  });

  it.each([
    ["PNG", png],
    ["JPEG", jpeg],
    ["WebP VP8X", (w: number, h: number) => webp(vp8x(w, h), vp8l(w, h))],
    ["WebP VP8L", (w: number, h: number) => webp(vp8l(w, h))],
    ["WebP VP8", (w: number, h: number) => webp(vp8(w, h))],
  ] as const)("bounds both dimensions and total pixels for %s", (_name, make) => {
    expect(inspect(make(100, 100))).toMatchObject({ width: 100, height: 100 });
    expect(inspect(make(100, 101))).toBeNull();
    expect(inspect(make(1001, 1))).toBeNull();
    expect(inspect(make(1, 1001))).toBeNull();
  });

  it.each([png, jpeg])("rejects zero dimensions before decode", (make) => {
    expect(inspect(make(0, 1))).toBeNull();
    expect(inspect(make(1, 0))).toBeNull();
  });

  it("rejects APNG, duplicate PNG dimensions, missing terminal chunks and truncated chunk data", () => {
    expect(inspect(png(20, 20, [pngChunk("acTL", Buffer.alloc(8))]))).toBeNull();
    expect(inspect(png(20, 20, [pngChunk("IHDR", Buffer.alloc(13))]))).toBeNull();
    const valid = png(20, 20);
    expect(inspect(valid.subarray(0, valid.length - 12))).toBeNull(); // Missing IEND.
    expect(inspect(valid.subarray(0, valid.length - 1))).toBeNull();
    expect(inspect(Buffer.concat([valid, pngChunk("IDAT", Buffer.from([1]))]))).toBeNull();
    const oversizedChunk = Buffer.from(valid);
    oversizedChunk.writeUInt32BE(0xffffffff, 33); // IDAT cannot claim bytes beyond the bounded input.
    expect(inspect(oversizedChunk)).toBeNull();
  });

  it("rejects a PNG header without image data and refuses an invalid first chunk", () => {
    const valid = png(20, 20);
    expect(inspect(Buffer.concat([valid.subarray(0, 33), pngChunk("IEND")]))).toBeNull();
    const renamed = Buffer.from(valid);
    renamed.write("IDAT", 12, "ascii");
    expect(inspect(renamed)).toBeNull();
  });

  it("rejects JPEG metadata overruns, missing frame dimensions and truncated SOF segments", () => {
    const valid = jpeg(20, 20);
    const oversizedMetadata = Buffer.from(valid);
    oversizedMetadata.writeUInt16BE(0xffff, 4);
    expect(inspect(oversizedMetadata)).toBeNull();
    expect(inspect(valid.subarray(0, valid.length - 3))).toBeNull();
    expect(inspect(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
    expect(inspect(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBeNull();
  });

  it("rejects animation flags and animation chunks even when a static frame is present", () => {
    expect(inspect(webp(vp8x(20, 20, 0x02), vp8l(20, 20)))).toBeNull();
    expect(inspect(webp(vp8x(20, 20), webpChunk("ANIM", Buffer.alloc(6)), vp8l(20, 20)))).toBeNull();
    expect(inspect(webp(vp8x(20, 20), vp8l(20, 20), webpChunk("ANMF", Buffer.alloc(16))))).toBeNull();
  });

  it("requires WebP canvas and frame dimensions to agree and allows only one static frame", () => {
    expect(inspect(webp(vp8x(10, 10), vp8l(20, 20)))).toBeNull();
    expect(inspect(webp(vp8x(20, 20)))).toBeNull();
    expect(inspect(webp(vp8l(20, 20), vp8l(20, 20)))).toBeNull();
    expect(inspect(webp(vp8l(20, 20), vp8x(20, 20)))).toBeNull();
  });

  it("rejects mismatched RIFF lengths, truncated chunks, missing odd-byte padding and bad VP8 signatures", () => {
    const valid = webp(vp8l(20, 20));
    const wrongLength = Buffer.from(valid);
    wrongLength.writeUInt32LE(valid.length - 9, 4);
    expect(inspect(wrongLength)).toBeNull();
    expect(inspect(valid.subarray(0, valid.length - 2))).toBeNull();
    const noPadding = Buffer.from(valid.subarray(0, valid.length - 1));
    noPadding.writeUInt32LE(noPadding.length - 8, 4);
    expect(inspect(noPadding)).toBeNull();
    const badSignature = webp(vp8(20, 20));
    badSignature[23] = 0;
    expect(inspect(badSignature)).toBeNull();
  });

  it.each([
    Buffer.alloc(0),
    Buffer.from("<html><img src='https://example.test'></html>"),
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'),
    Buffer.from("GIF89a"),
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    Buffer.from("RIFF0000WEBP"),
  ])("refuses unsupported active content and incomplete magic bytes without throwing", (bytes) => {
    expect(inspect(bytes)).toBeNull();
  });

  it("respects a Uint8Array view's bounds instead of inspecting unrelated backing-buffer bytes", () => {
    const bytes = png(73, 41);
    const backing = Buffer.concat([Buffer.from("junk"), bytes, Buffer.from("tail")]);
    const view = new Uint8Array(backing.buffer, backing.byteOffset + 4, bytes.length);
    expect(inspect(view)).toEqual({ width: 73, height: 41, mime: "image/png" });
    expect(inspect(backing)).toBeNull();
  });
});
