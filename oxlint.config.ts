import { defineConfig } from "oxlint";
import { base, node, react } from "@dustinedwards/devkit/oxlint";

export default defineConfig({
  extends: [base],
  // `ignorePatterns` do not carry through `extends` (oxlint 1.92); devkit 0.24.0 exports them.
  ignorePatterns: ["worker-configuration.d.ts", "dashboard/.react-router/", "dashboard/build/", "explorer/dist/"],
  rules: {
    // off in devkit 0.24.0
    "typescript/no-non-null-assertion": "off",
  },
  overrides: [
    { files: ["scripts/**", "test/**", "test-integration/**"], ...node },
    // The Watch Floor app is React Router; the rest of the repository is Worker code.
    {
      files: ["dashboard/**"],
      ...react,
      rules: {
        ...react.rules,
        // off in devkit 0.24.0
        "react/only-export-components": "off",
        "jsx-a11y/prefer-tag-over-role": "off",
        "jsx-a11y/control-has-associated-label": "off",
        "jsx-a11y/media-has-caption": "off",
      },
    },
  ],
});
