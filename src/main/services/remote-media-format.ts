export interface MediaDimensions {
  width: number;
  height: number;
  mime: "image/png" | "image/jpeg" | "image/webp";
}

/** Header inspection precedes Chromium decoding; unsupported/animated containers are refused. */
export function inspectRemoteMedia(
  bytes: Uint8Array,
  maxPixels: number,
  maxDimension: number,
): MediaDimensions | null {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const checked = (width: number, height: number, mime: MediaDimensions["mime"]): MediaDimensions | null =>
    width > 0 && height > 0 && width <= maxDimension && height <= maxDimension && width * height <= maxPixels
      ? { width, height, mime }
      : null;
  if (data.length >= 33 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (data.readUInt32BE(8) !== 13 || data.toString("ascii", 12, 16) !== "IHDR") return null;
    let offset = 8;
    let imageData = false,
      end = false;
    while (offset + 12 <= data.length) {
      const length = data.readUInt32BE(offset);
      if (length > data.length - offset - 12) return null;
      const kind = data.toString("ascii", offset + 4, offset + 8);
      if (kind === "acTL" || (kind === "IHDR" && offset !== 8) || end) return null;
      if (kind === "IDAT") imageData = true;
      if (kind === "IEND") {
        if (length !== 0) return null;
        end = true;
      }
      offset += length + 12;
    }
    if (offset !== data.length || !imageData || !end) return null;
    return checked(data.readUInt32BE(16), data.readUInt32BE(20), "image/png");
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset < data.length) {
      if (data[offset++] !== 0xff) return null;
      while (data[offset] === 0xff) offset++;
      const marker = data[offset++];
      if (marker === undefined || marker === 0xd9 || marker === 0xda) return null;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > data.length) return null;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) return null;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8) return null;
        return checked(data.readUInt16BE(offset + 5), data.readUInt16BE(offset + 3), "image/jpeg");
      }
      offset += length;
    }
    return null;
  }
  if (
    data.length >= 20 &&
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP"
  ) {
    if (data.readUInt32LE(4) !== data.length - 8) return null;
    let offset = 12;
    let canvas: MediaDimensions | null = null,
      frame: MediaDimensions | null = null;
    while (offset + 8 <= data.length) {
      const kind = data.toString("ascii", offset, offset + 4);
      const length = data.readUInt32LE(offset + 4);
      const payload = offset + 8;
      if (length > data.length - payload || kind === "ANIM" || kind === "ANMF") return null;
      if (kind === "VP8X") {
        if (offset !== 12 || length !== 10 || data[payload] & 0x02) return null;
        canvas = checked(
          data.readUIntLE(payload + 4, 3) + 1,
          data.readUIntLE(payload + 7, 3) + 1,
          "image/webp",
        );
        if (!canvas) return null;
      } else if (kind === "VP8L" || kind === "VP8 ") {
        if (frame) return null;
        if (kind === "VP8L" && length >= 5 && data[payload] === 0x2f) {
          const bits = data.readUInt32LE(payload + 1);
          frame = checked((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1, "image/webp");
        } else if (
          kind === "VP8 " &&
          length >= 10 &&
          data.subarray(payload + 3, payload + 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))
        ) {
          frame = checked(
            data.readUInt16LE(payload + 6) & 0x3fff,
            data.readUInt16LE(payload + 8) & 0x3fff,
            "image/webp",
          );
        }
        if (!frame) return null;
      }
      offset = payload + length + (length % 2);
    }
    if (
      offset !== data.length ||
      !frame ||
      (canvas && (canvas.width !== frame.width || canvas.height !== frame.height))
    )
      return null;
    return frame;
  }
  return null;
}
