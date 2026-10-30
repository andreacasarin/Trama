/** Generated assets are embedded by esbuild; no runtime file reads are needed. */
declare module "*?raw" {
  const source: string;
  export default source;
}
declare module "*.wasm" {
  const bytes: Uint8Array<ArrayBuffer>;
  export default bytes;
}
