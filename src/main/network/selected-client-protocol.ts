import { createDecipheriv, createHash } from "node:crypto";

/** Reviewed data layout only. No vendor source, key, IV or executable decoder is bundled. */
export const SELECTED_CLIENT_PROFILE = Object.freeze({
  id: "maomaoyun-5.5.6-main-2e66e4eb-v1",
  decoderIdentity: "maomaoyun-5.5.6-aes128cbc-data-v1",
  version: "5.5.6",
  packageSha256: "9440cfd13e7841e6ac960438aaac31e2028571257a2650590f6f5b2504449bd8",
  mainSha256: "2e66e4eb0592dc7d4c2be715d325784a3e473225ca149929963430406ef6e85c",
  mainBytes: 386698,
});

type Slice = readonly [number, number];
type Piece = { data: Slice; mode: "literal" | "base64" | "rc4"; key?: Slice };
const KEY: readonly Piece[] = [
  { data: [37749, 37767], mode: "base64" },
  { data: [101428, 101446], mode: "base64" },
  { data: [65062, 65080], mode: "base64" },
  { data: [86298, 86316], mode: "base64" },
  { data: [63168, 63198], mode: "rc4", key: [264351, 264369] },
  { data: [264389, 264395], mode: "literal" },
];
const IV: readonly Piece[] = [
  { data: [98599, 98625], mode: "rc4", key: [264415, 264433] },
  { data: [64415, 64445], mode: "rc4", key: [264456, 264474] },
  { data: [50157, 50175], mode: "base64" },
  { data: [50561, 50579], mode: "base64" },
  { data: [65360, 65386], mode: "rc4", key: [264571, 264589] },
  { data: [264591, 264597], mode: "literal" },
];
const SHA = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const reject = (): never => {
  throw new Error("CLIENT_DECODE_UNAVAILABLE");
};
function literal(source: string, [start, end]: Slice): string {
  const value = source.slice(start, end);
  if (!/^'(?:\\x[0-9a-f]{2}){1,128}'$/i.test(value)) return reject();
  return value
    .slice(1, -1)
    .replace(/\\x([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}
function tableText(value: string): string {
  // The reviewed string table swaps the upper/lower case sections of the base64 alphabet.
  const standard = value.replace(/[a-zA-Z]/g, (c) =>
    c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase(),
  );
  const bytes = Buffer.from(standard, "base64");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    bytes.fill(0);
  }
}
function rc4(value: string, key: string): string {
  if (!key.length || key.length > 128 || value.length > 128) return reject();
  const state = Uint8Array.from({ length: 256 }, (_, i) => i);
  let j = 0,
    out = "";
  try {
    for (let i = 0; i < 256; i++) {
      j = (j + state[i] + key.charCodeAt(i % key.length)) % 256;
      [state[i], state[j]] = [state[j], state[i]];
    }
    let i = 0;
    j = 0;
    for (let n = 0; n < value.length; n++) {
      i = (i + 1) % 256;
      j = (j + state[i]) % 256;
      [state[i], state[j]] = [state[j], state[i]];
      out += String.fromCharCode(value.charCodeAt(n) ^ state[(state[i] + state[j]) % 256]);
    }
    return out;
  } finally {
    state.fill(0);
  }
}
function material(source: string, pieces: readonly Piece[]): Buffer {
  const result = Buffer.from(
    pieces
      .map((piece) => {
        const data = literal(source, piece.data);
        if (piece.mode === "literal") return data;
        const decoded = tableText(data);
        return piece.mode === "rc4" ? rc4(decoded, literal(source, piece.key!)) : decoded;
      })
      .join(""),
    "utf8",
  );
  if (result.length !== 16) {
    result.fill(0);
    return reject();
  }
  return result;
}
function canonicalBase64(text: string, maxBytes: number): Buffer {
  if (
    !text ||
    text.length > Math.ceil(maxBytes / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)
  )
    return reject();
  const bytes = Buffer.from(text, "base64");
  if (bytes.length > maxBytes || bytes.toString("base64") !== text) {
    bytes.fill(0);
    return reject();
  }
  return bytes;
}

/** The caller owns the returned decoder. No API exposes its credential material. */
export function selectedClientDecoder(main: Uint8Array): {
  decode(bytes: Uint8Array, signal: AbortSignal): string;
  dispose(): void;
} {
  if (
    main.byteLength !== SELECTED_CLIENT_PROFILE.mainBytes ||
    SHA(main) !== SELECTED_CLIENT_PROFILE.mainSha256
  )
    return reject();
  let key: Buffer | null = null,
    iv: Buffer | null = null;
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(main);
    key = material(source, KEY);
    iv = material(source, IV);
  } catch {
    key?.fill(0);
    iv?.fill(0);
    return reject();
  }
  let disposed = false;
  return {
    decode(bytes, signal) {
      let encrypted: Buffer | null = null,
        inner: Buffer | null = null,
        decoded: Buffer | null = null;
      try {
        if (disposed || signal.aborted || bytes.byteLength > 8 * 1024 * 1024) return reject();
        const input = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        encrypted = canonicalBase64(input, 8 * 1024 * 1024);
        if (!encrypted.length || encrypted.length % 16) return reject();
        const cipher = createDecipheriv("aes-128-cbc", key!, iv!);
        inner = Buffer.concat([cipher.update(encrypted), cipher.final()]);
        decoded = canonicalBase64(new TextDecoder("utf-8", { fatal: true }).decode(inner), 4 * 1024 * 1024);
        const text = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
        if (signal.aborted || !text.trim()) return reject();
        return text;
      } catch {
        return reject();
      } finally {
        encrypted?.fill(0);
        inner?.fill(0);
        decoded?.fill(0);
      }
    },
    dispose() {
      disposed = true;
      key?.fill(0);
      iv?.fill(0);
      key = null;
      iv = null;
    },
  };
}
