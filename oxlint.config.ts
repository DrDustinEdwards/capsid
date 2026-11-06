import { defineConfig } from "oxlint";
import { base, node, react, ignorePatterns } from "@dustinedwards/devkit/oxlint";

export default defineConfig({
  extends: [base],
  // `ignorePatterns` do not carry through `extends` (oxlint 1.92); devkit exports them. The dashboard and explorer build into their own folders.
  ignorePatterns: [...ignorePatterns, "dashboard/.react-router/", "dashboard/build/", "explorer/dist/"],
  overrides: [
    { files: ["scripts/**", "test/**", "test-integration/**"], ...node },
    // The Watch Floor app is React Router; the rest of the repository is Worker code.
    {
      files: ["dashboard/**"],
      ...react,
    },
  ],
});
