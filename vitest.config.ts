import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      obsidian: fileURLToPath(new URL("./tests/obsidian.ts", import.meta.url)),
    },
  },
});
