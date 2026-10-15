import type { SlopRuleName } from "eslint-plugin-slop";
import { defineConfig } from "oxlint";

const slop = (level: "error" | "warn", ...rules: SlopRuleName[]) =>
  Object.fromEntries(rules.map((rule) => [`slop/${rule}`, [level, { inspection: "full" }]] as const));

/** What a call site may do to a component from `src/components/ui`. */
const callSiteMayDo = [
  "layout",
  "truncate",
  "tabular-nums",
  "text-muted-foreground",
  "hover:text-foreground",
  "text-destructive",
  "opacity-0",
  "opacity-100",
  "transition-opacity",
];

export default defineConfig({
  plugins: ["eslint", "typescript", "unicorn", "oxc", "import", "jsx-a11y"],
  jsPlugins: ["eslint-plugin-slop", "@shadcn/lint"],
  categories: { correctness: "error", suspicious: "warn", perf: "warn" },
  env: { browser: true, node: true, es2024: true },
  settings: {
    shadcn: { ui: "~/components/ui" },
  },
  rules: {
    // Effect's discriminant on tagged errors and values.
    "no-underscore-dangle": ["warn", { allow: ["_tag"] }],
    "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    "no-shadow": "off",
    // Ordered async loops are deliberate (sequential file steps, retries).
    "no-await-in-loop": "off",
    "import/no-cycle": "error",
    "import/no-unassigned-import": "off",
    "typescript/no-non-null-assertion": "off",
    "jsx-a11y/no-static-element-interactions": "off",
    "jsx-a11y/click-events-have-key-events": "off",
    "shadcn/no-restyle": ["error", { allow: callSiteMayDo }],
    "shadcn/no-raw-colors": "error",
    "shadcn/no-unknown-classes": "error",
    ...slop(
      "error",
      "no-em-dash",
      "no-jargon",
      "max-comment-length",
      "no-trivial-functions",
      "no-trivial-type-aliases",
      "no-static-only-class",
      "no-chained-type-assertions",
    ),
    ...slop("warn", "prefer-jsdoc"),
  },
  overrides: [
    {
      files: ["apps/studio/src/**/*.{ts,tsx}"],
      jsPlugins: ["eslint-plugin-solid"],
      rules: {
        "solid/components-return-once": "warn",
        "solid/reactivity": "warn",
        "solid/event-handlers": "warn",
        "solid/jsx-no-duplicate-props": "error",
        "solid/jsx-no-script-url": "error",
        "solid/jsx-no-undef": "error",
        "solid/no-destructure": "error",
        "solid/no-innerhtml": "error",
        "solid/no-react-deps": "warn",
        "solid/no-react-specific-props": "error",
        "solid/no-unknown-namespaces": "error",
        "solid/prefer-for": "warn",
        "solid/self-closing-comp": "warn",
        "solid/style-prop": "warn",
      },
    },
    {
      // Tests and scripts keep helpers beside the code that uses them, and build fixtures
      // with spreads where speed doesn't matter.
      files: ["**/e2e/**", "**/scripts/**", "**/tests/**", "**/*.test.{ts,tsx}"],
      rules: { "unicorn/consistent-function-scoping": "off", "oxc/no-map-spread": "off" },
    },
    {
      // The design system owns styling. Label wraps or points at controls its callers pass in.
      files: ["apps/studio/src/components/ui/**"],
      rules: { "shadcn/no-restyle": "off", "jsx-a11y/label-has-associated-control": "off" },
    },
  ],
  ignorePatterns: [
    "**/dist",
    "**/dist-electron",
    "**/release",
    "**/.electron-app",
    "**/.tanstack",
    "**/node_modules",
    "**/routeTree.gen.ts",
    "**/migrations.gen.ts",
    "**/test-results",
    ".local",
    "**/.repro",
  ],
});
