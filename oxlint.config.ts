import { defineConfig } from "oxlint";
import { base, node, react } from "@dustinedwards/devkit/oxlint";

export default defineConfig({
  extends: [base],
  // The shared ignorePatterns do not carry through `extends` (oxlint 1.92), so the generated and built paths are named here.
  ignorePatterns: ["worker-configuration.d.ts", "dashboard/.react-router/", "dashboard/build/", "explorer/dist/"],
  overrides: [
    { files: ["scripts/**", "test/**", "test-integration/**"], ...node },
    // The Watch Floor app is React Router; the rest of the repository is Worker code.
    { files: ["dashboard/**"], ...react },
    {
      files: ["dashboard/src/**"],
      plugins: react.plugins,
      rules: {
        // The app is not compiled with the React Compiler, and these three are its rules. Each finding is a deliberate
        // pattern with a comment at the site: an effect that sets state after hydration so the server's HTML and the first
        // browser render agree (App.tsx useTick, the rail preference, the skew), a ref that holds the latest value for a
        // callback (App.tsx csrfRef), and callbacks the compiler cannot see through. Rewriting them is a behavior change
        // that needs the browser suite; they come back on with the app's move to the compiler.
        "react/set-state-in-effect": "off",
        "react/refs": "off",
        "react/preserve-manual-memoization": "off",
      },
    },
    {
      // Fast Refresh is a development-time nicety, and these files export a helper beside their component (a hook, a
      // formatter, a row builder) that the other views and the unit tests import from the same place. The route modules
      // (dashboard/src/routes) keep the rule: a route's default export is a named component.
      files: ["dashboard/src/{app,lib,ui,views}/**"],
      plugins: react.plugins,
      rules: { "react/only-export-components": "off" },
    },
  ],
});
