/** Validate stored Float32 values and return their squared magnitude for normalization. */
export function validateVector(values: readonly number[], dimensions?: number): number {
  if (
    !Array.isArray(values) ||
    !values.length ||
    (dimensions !== undefined && values.length !== dimensions)
  )
    throw new TypeError("Embedding vector dimensions are invalid");
  let magnitude = 0;
  for (const value of values) {
    const stored = Math.fround(value);
    if (!Number.isFinite(value) || !Number.isFinite(stored))
      throw new TypeError("Embedding vector values must be finite and fit Float32");
    magnitude += stored * stored;
  }
  if (!Number.isFinite(magnitude) || magnitude === 0)
    throw new TypeError("Embedding vector magnitude is invalid");
  return magnitude;
}

export function encodeVector(values: number[], dimensions: number): Uint8Array {
  validateVector(values, dimensions);
  const bytes = new Uint8Array(dimensions * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return bytes;
}

export function decodeVector(bytes: Uint8Array, dimensions: number): number[] {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== dimensions * 4)
    throw new TypeError("Cached embedding dimensions are invalid");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = Array.from({ length: dimensions }, (_, index) => view.getFloat32(index * 4, true));
  validateVector(values, dimensions);
  return values;
}
