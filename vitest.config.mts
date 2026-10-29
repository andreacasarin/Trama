import { configDefaults, defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ".ai/bench/**"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      obsidian: fileURLToPath(new URL("./tests/obsidian.ts", import.meta.url)),
    },
  },
});
