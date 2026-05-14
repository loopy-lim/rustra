import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      "**/dist/**",
      "**/dist-ts/**",
      "**/node_modules/**",
      "**/*.d.ts",
      "examples/react-native-calculator/**",
      "examples/calculator-napi/**",
    ],
  },
  {
    files: ["packages/*/src/**/*.ts", "packages/cli/src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  }
);
