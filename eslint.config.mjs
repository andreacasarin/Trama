import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "main.js",
      "sqlite-worker.mjs",
      "sqlite3.mjs",
      "sqlite3.wasm",
      "coverage/**",
      ".artifacts/**",
      ".cache/**",
      ".ai/bench/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,ts,tsx}"],
    languageOptions: { globals: { process: "readonly" } },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { args: "all", argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["src/**/*.{js,mjs,ts,tsx}"],
    rules: { "no-console": "error" },
  },
  {
    files: ["scripts/sqlite-wasm/**/*.{js,mjs}"],
    languageOptions: { globals: { console: "readonly", URL: "readonly", WebAssembly: "readonly" } },
  }
);
