/**
 * Mutable-index identity helpers. The counter is a cache invalidation token,
 * not a publication generation and is never persisted by the UI layer.
 */
const encoder = new TextEncoder();

/** Normalize a vault-relative path without changing its case. */
export function normalizeVaultPath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/");
}

/** Exact-path or directory-boundary matching used by corpus inputs. */
export function isPathExcluded(path: string, excludedPath: string): boolean {
  const candidate = normalizeVaultPath(path);
  const excluded = normalizeVaultPath(excludedPath);
  return !!excluded && (candidate === excluded || candidate.startsWith(`${excluded}/`));
}

export function normalizeEmbeddingEndpoint(value: string): string {
  return value.trim().replace(/\/$/, "").toLowerCase();
}

export interface CorpusIdentityInput {
  readonly schemaVersion: number;
  readonly extractionVersion: number;
  readonly chunking: {
    readonly algorithmVersion: number;
    readonly size: number;
    readonly overlap: number;
  };
  readonly excludedPaths: readonly string[];
}

export interface EmbeddingIdentityInput {
  readonly embeddingBaseUrl: string;
  readonly modelId: string;
  readonly dimensions: number;
  readonly preprocessingVersion?: number | string;
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

/** Stable JSON input for the corpus identity; embedding settings are excluded. */
export function corpusIdentityInput(input: CorpusIdentityInput): string {
  return canonical({
    schemaVersion: input.schemaVersion,
    extractionVersion: input.extractionVersion,
    chunking: input.chunking,
    excludedPaths: [...new Set(input.excludedPaths.map(normalizeVaultPath))].sort(compareCodeUnits),
  });
}

/** Stable JSON input for the configured semantic embedding space. */
export function embeddingIdentityInput(input: EmbeddingIdentityInput): string {
  return canonical({
    modelId: input.modelId.trim(),
    dimensions: input.dimensions,
    ...(input.preprocessingVersion === undefined
      ? {}
      : { preprocessingVersion: input.preprocessingVersion }),
  });
}

export function createCorpusFingerprint(input: CorpusIdentityInput): Promise<string> {
  return sha256Hex(corpusIdentityInput(input));
}

export function createEmbeddingFingerprint(input: EmbeddingIdentityInput): Promise<string> {
  return sha256Hex(embeddingIdentityInput(input));
}

/** Locale-independent UTF-16 code-unit ordering for persisted and ranked data. */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function bytesToHex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

export function hexToBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) throw new Error("Invalid hexadecimal value");
  const result = new Uint8Array(hex.length / 2);
  for (let index = 0; index < result.length; index++)
    result[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return result;
}

export async function sha256Bytes(value: ArrayBuffer | Uint8Array | string): Promise<Uint8Array> {
  const bytes =
    typeof value === "string"
      ? encoder.encode(value)
      : value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : value;
  if (bytes.byteLength > 256 * 1024 * 1024)
    throw new Error("SHA-256 input exceeds the supported size");
  const subtle = (globalThis as typeof globalThis & { crypto?: Crypto }).crypto?.subtle;
  if (subtle) return new Uint8Array(await subtle.digest("SHA-256", bytes as BufferSource));
  return sha256Fallback(bytes);
}

function sha256Fallback(input: Uint8Array): Uint8Array {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const bitLength = input.byteLength * 8;
  const padded = new Uint8Array(((input.length + 9 + 63) >> 6) << 6);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, bitLength >>> 0);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  let h0 = 0x6a09e667,
    h1 = 0xbb67ae85,
    h2 = 0x3c6ef372,
    h3 = 0xa54ff53a;
  let h4 = 0x510e527f,
    h5 = 0x9b05688c,
    h6 = 0x1f83d9ab,
    h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15],
        b = w[i - 2];
      w[i] =
        ((((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3)) +
          w[i - 16] +
          (((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10)) +
          w[i - 7]) |
        0;
    }
    let a = h0,
      b = h1,
      c = h2,
      d = h3,
      e = h4,
      f = h5,
      g = h6,
      h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }
  const out = new Uint8Array(32),
    values = [h0, h1, h2, h3, h4, h5, h6, h7];
  for (let i = 0; i < 8; i++) view.setUint32(i * 4, values[i]);
  out.set(new Uint8Array(view.buffer, 0, 32));
  return out;
}

export async function sha256Hex(value: ArrayBuffer | Uint8Array | string): Promise<string> {
  return bytesToHex(await sha256Bytes(value));
}

export function utf8Encode(value: string): Uint8Array {
  return encoder.encode(value);
}

export const MAX_MARKDOWN_UTF8_BYTES = 16 * 1024 * 1024;
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      i + 1 < value.length &&
      value.charCodeAt(i + 1) >= 0xdc00 &&
      value.charCodeAt(i + 1) <= 0xdfff
    ) {
      bytes += 4;
      i++;
    } else bytes += 3;
    if (bytes > MAX_MARKDOWN_UTF8_BYTES) return bytes;
  }
  return bytes;
}

export function deriveNoteContentId(fingerprint: string, markdown: string): Promise<string> {
  const prefix = hexToBytes(fingerprint);
  const body = utf8Encode(markdown);
  const input = new Uint8Array(prefix.byteLength + body.byteLength);
  input.set(prefix);
  input.set(body, prefix.byteLength);
  return sha256Hex(input);
}

export function chunkId(contentId: string, ordinal: number): string {
  if (!/^[0-9a-f]{64}$/i.test(contentId) || !Number.isSafeInteger(ordinal) || ordinal < 0)
    throw new Error("Invalid chunk identity");
  return `${contentId.toLowerCase()}:${ordinal}`;
}

export function indexIdentity(changeCounter: number): string {
  return `counter:${Math.max(0, Math.floor(changeCounter))}`;
}

export function noteIdentity(changeCounter: number, path: string, contentId: string): string {
  return `${indexIdentity(changeCounter)}\0${path}\0${contentId}`;
}

export interface EmbeddingInputDescriptor {
  readonly identity: string;
  readonly occurrence: number;
}

export function normalizeMarkdownLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

/** Versioned, unambiguous text sent to an embedding service. */
export function serializeEmbeddingInput(headingContext: readonly string[], body: string): string {
  return JSON.stringify({
    v: 1,
    heading: headingContext.map(normalizeMarkdownLineEndings),
    body: normalizeMarkdownLineEndings(body),
  });
}

function sortedCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedCanonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort(compareCodeUnits)
      .map(
        (key) =>
          `${JSON.stringify(key)}:${sortedCanonical((value as Record<string, unknown>)[key])}`
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function domainInput(domain: string, parts: readonly string[]): string {
  return `${domain}\0${parts.map((part) => `${part.length}:\0${part}`).join("")}`;
}

export function canonicalEmbeddingOptions(options: unknown): string {
  return sortedCanonical(options);
}

export function createSourceDigest(source: string): Promise<string> {
  return sha256Hex(domainInput("trama-source-v1", [normalizeMarkdownLineEndings(source)]));
}

export function createInputDigest(input: string): Promise<string> {
  return sha256Hex(domainInput("trama-input-v1", [normalizeMarkdownLineEndings(input)]));
}

export const EMBEDDING_PREPROCESSING_VERSION = "normalized-float32-v1" as const;
export const EMBEDDING_ACTION_OPTIONS = Object.freeze({ inputVersion: 1 });

export function createRevisionDigest(
  extractionIdentity: string,
  chunks: readonly EmbeddingInputDescriptor[]
): Promise<string> {
  const ordered = chunks.map((chunk) => ({
    identity: chunk.identity,
    occurrence: chunk.occurrence,
  }));
  return sha256Hex(
    domainInput("trama-revision-v1", [extractionIdentity, sortedCanonical(ordered)])
  );
}

export function createEmbeddingActionKey(
  exactInput: string,
  embeddingFingerprint: string,
  preprocessing: string,
  options: unknown
): string {
  return JSON.stringify({
    exactInput,
    embeddingFingerprint,
    preprocessing,
    options: JSON.parse(canonicalEmbeddingOptions(options)),
  });
}

export const embeddingActionKey = createEmbeddingActionKey;
