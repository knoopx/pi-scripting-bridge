import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Files outside the TS project must not be type-checked.
    // tsconfig includes all *.ts (incl. vitest.config.ts) and excludes only node_modules.
    ignores: ["node_modules/**", "coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Type-aware linting against the project tsconfig.json (covers all *.ts).
        project: true,
      },
    },
  },
);