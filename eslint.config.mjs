// Documented Community baseline plus the stricter checks for new submissions.
// Metadata validation stays enabled locally rather than relying on a hosted task.
// https://github.com/obsidianmd/eslint-plugin/blob/master/docs/configuration.md
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["eslint.config.*"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  ...obsidianmd.configs.recommended,

  {
    files: ["**/*.{ts,cts,mts,tsx,js,cjs,mjs,jsx}"],
    rules: {
      // Security — keep as errors
      "no-eval": "error",
      "no-unsanitized/method": "error",
      "no-unsanitized/property": "error",
      "obsidianmd/regex-lookbehind": "error",
      "obsidianmd/no-forbidden-elements": "error",
      "obsidianmd/settings-tab/no-manual-html-headings": "error",
      "obsidianmd/settings-tab/no-problematic-settings-headings": "error",
      "obsidianmd/sample-names": "error",
      "obsidianmd/no-sample-code": "error",
      "obsidianmd/platform": "error",
      "obsidianmd/no-plugin-as-component": "error",
      "obsidianmd/detach-leaves": "error",
      "obsidianmd/no-static-styles-assignment": "error",
      "obsidianmd/no-view-references-in-plugin": "error",
      "obsidianmd/no-unsupported-api": "error",

      // New submissions retain the scanner’s unsafe-value advisories.
      "no-undef": "off",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "import/no-unresolved": "off",

      // New submissions must not repeat the plugin ID in command IDs.
      "obsidianmd/commands/no-command-in-command-id": "warn",
      "obsidianmd/commands/no-plugin-id-in-command-id": "error",
    },
  },

  {
    // Security — implied eval, once per call: the core rule in JavaScript,
    // typescript-eslint's in TypeScript, where the recommended config turns the
    // core rule off. An "error" for the core rule in the block above would turn
    // it back on in TypeScript and report each call twice.
    files: ["**/*.{js,cjs,mjs,jsx}"],
    rules: {
      "no-implied-eval": "error",
    },
  },
  {
    files: ["**/*.{ts,cts,mts,tsx}"],
    rules: {
      "@typescript-eslint/no-implied-eval": "error",
    },
  },

  {
    // Validate required release metadata locally as well as in the directory.
    files: ["manifest.json"],
    rules: {
      "obsidianmd/validate-manifest": "error",
    },
  },

  {
    // Scanner handles this separately. It must be switched off under the glob
    // the rule actually runs on -- LICENSE matches no source glob, so an "off"
    // in the block above would not reach it.
    files: ["LICENSE", "LICENSE.md", "LICENSE.txt"],
    rules: {
      "obsidianmd/validate-license": "error",
    },
  },

  {
    // The scanner honours disable comments but does not report unused ones
    linterOptions: {
      reportUnusedDisableDirectives: "off",
      reportUnusedInlineConfigs: "off",
    },
  },

  globalIgnores([
    // Local generated vaults, clean-build copies, and caches are not source.
    ".artifacts",
    ".cache",
    ".ai/bench",
    // Not in the scanner's list: the scanner recognises bundled and minified
    // JavaScript by its name and, in a TypeScript project, by its content.
    // These names stand in for that here. Drop "main.js" if your plugin is
    // written in JavaScript and main.js is its source.
    "main.js",
    "**/*.min.js",
    "**/{dist,build,out,release}/**/*.{js,cjs,mjs,jsx}",
    "node_modules",
    "dist",
    "build",
    "pkg",
    "test-vault",
    ".obsidian",
    "**/.obsidian/**",
    "esbuild.config.mjs",
    "version-bump.mjs",
    "**/*.test.*",
    "**/*.tests.*",
    "**/*.spec.*",
    "**/*.specs.*",
    "**/test/**",
    "**/tests/**",
    "**/__tests__/**",
    "**/mocks/**",
    "**/__mocks__/**",
    "**/*.cjs",
    "**/*.mjs",
    "**/*.cts",
    "**/*.mts",
    "**/vite*",
    "**/scripts/**",
    "**/docs/**",
    "**/i18n/**",
    "**/i18next/**",
    "**/locale/**",
    "**/locales/**",
    "**/translations/**",
    "**/l10n/**",
    ".pnpm-store",
    "**/*.spec.ts",
    "**/testUtils**",
    "automation/**",
    "**/e2e/**",
    "**/e2e-tests/**",
    "**/*.e2e.*",
    "**/wdio.conf.*",
    "**/wdio.*.conf.*",
    "**/playwright.config.*",
    "**/{astro,babel,commitlint,docusaurus,esbuild,eslint,jest,oxlint,postcss,prettier,rolldown,rollup,stylelint,svelte,tailwind,tsdown,tsup,uno,webpack}.config.*",
    "**/{eslint,jest}.*.config.*",
    "**/jest.setup.*",
    "**/.{babelrc,eslintrc,mocharc,prettierrc}.*",
  ]),
]);
