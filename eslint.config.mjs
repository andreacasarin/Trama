import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "main.js",
      "@taladb/**",
      "coverage/**",
      "candidate/taladb/.generated/**",
      "benchmarks/taladb/.generated/**",
      "tests/taladb/gate0/.generated/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,ts,tsx}"],
    languageOptions: {
      globals: {
        process: "readonly",
        URL: "readonly",
        console: "readonly",
        window: "readonly",
        location: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    files: ["src/**/*.{js,mjs,ts,tsx}"],
    rules: { "no-console": "error" },
  },
  {
    files: ["tests/taladb/native-*.mjs"],
    languageOptions: {
      globals: {
        AbortController: "readonly",
        clearInterval: "readonly",
        navigator: "readonly",
        performance: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly",
      },
    },
  }
);
