import js from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: [".pi-worktrees/**", "src/workflows/worker.mjs"] },
  {
    files: ["src/**/*.ts", "extensions/**/*.ts", "tests/**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
  },
  {
    files: ["scripts/**/*.mjs", "src/**/*.mjs", "eslint.config.js"],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.nodeBuiltin },
  },
  {
    files: ["{src,extensions,tests}/**/*.ts", "{src,scripts}/**/*.mjs", "eslint.config.js"],
    plugins: { "@stylistic": stylistic },
    rules: {
      curly: ["error", "all"],
      "no-nested-ternary": "error",
      "@stylistic/max-statements-per-line": ["error", { max: 1 }],
      "@stylistic/lines-between-class-members": [
        "error",
        {
          enforce: [
            { blankLine: "always", prev: "*", next: "method" },
            { blankLine: "always", prev: "method", next: "*" },
          ],
        },
      ],
      "@stylistic/padding-line-between-statements": [
        "error",
        {
          blankLine: "always",
          prev: "*",
          next: ["if", "for", "while", "do", "switch", "try", "return", "throw"],
        },
        { blankLine: "always", prev: "block-like", next: "*" },
        { blankLine: "always", prev: "*", next: "function" },
        { blankLine: "always", prev: "function", next: "*" },
      ],
    },
  },
);
