const encoder = new TextEncoder();

export function bytesToHex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

export function hexToBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) throw new Error("Invalid hexadecimal value");
  const result = new Uint8Array(hex.length / 2);
  for (let i = 0; i < result.length; i++)
    result[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return result;
}

export async function sha256Bytes(value: ArrayBuffer | Uint8Array | string): Promise<Uint8Array> {
  const bytes =
    typeof value === "string"
      ? encoder.encode(value)
      : value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : value;
  const safe = bytes.slice();
  return new Uint8Array(await crypto.subtle.digest("SHA-256", safe));
}

export async function sha256Hex(value: ArrayBuffer | Uint8Array | string): Promise<string> {
  return bytesToHex(await sha256Bytes(value));
}

export function utf8Encode(value: string): Uint8Array {
  return encoder.encode(value);
}

export function utf8DecodeFatal(value: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(value);
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((value, index) => value === b[index]);
}

export async function deriveNoteContentId(fingerprint: string, markdown: string): Promise<string> {
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
