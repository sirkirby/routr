// One rule, the one that would have caught the 0.1.14 updater regression (an undeclared name after a refactor).
// Run with `bun run lint`; CI runs it beside the tests. No package is installed: bunx fetches ESLint on demand.
import globals from "globals";
export default [
  { files: ["src/**/*.mjs", "test/**/*.mjs"], languageOptions: { ecmaVersion: "latest", sourceType: "module",
      globals: { ...globals.node, Bun: "readonly", ROUTR_BUILD_VERSION: "readonly", fetch: "readonly", AbortSignal: "readonly" } },
    rules: { "no-undef": "error", "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }] } },
];
