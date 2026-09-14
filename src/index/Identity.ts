/**
 * Mutable-index identity helpers. The counter is a cache invalidation token,
 * not a publication generation and is never persisted by the UI layer.
 */
const encoder = new TextEncoder();

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
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice()));
}

export async function sha256Hex(value: ArrayBuffer | Uint8Array | string): Promise<string> {
  return bytesToHex(await sha256Bytes(value));
}

export function utf8Encode(value: string): Uint8Array {
  return encoder.encode(value);
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
