import { sha256 } from "@langchain/core/utils/hash";

export function sha256Hex(value: string): string {
  const hash: unknown = sha256(value);
  if (typeof hash !== "string") throw new TypeError("Expected a SHA-256 hex digest");
  return hash;
}
