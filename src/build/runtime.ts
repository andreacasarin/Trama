declare const __TRAMA_RUNTIME_BUILD_ID__: string | undefined;

export const TRAMA_RUNTIME_BUILD_ID =
  typeof __TRAMA_RUNTIME_BUILD_ID__ === "string" ? __TRAMA_RUNTIME_BUILD_ID__ : "development";
