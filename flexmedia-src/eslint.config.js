import globals from "globals";
import pluginJs from "@eslint/js";
import pluginReact from "eslint-plugin-react";
import pluginReactHooks from "eslint-plugin-react-hooks";
import pluginUnusedImports from "eslint-plugin-unused-imports";

export default [
  {
    files: [
      "src/components/**/*.{js,mjs,cjs,jsx}",
      "src/pages/**/*.{js,mjs,cjs,jsx}",
      "src/Layout.jsx",
    ],
    ignores: ["src/lib/**/*", "src/components/ui/**/*"],
    ...pluginJs.configs.recommended,
    ...pluginReact.configs.flat.recommended,
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    settings: {
      react: {
        version: "detect",
      },
    },
    plugins: {
      react: pluginReact,
      "react-hooks": pluginReactHooks,
      "unused-imports": pluginUnusedImports,
    },
    rules: {
      "no-unused-vars": "off",
      "react/jsx-uses-vars": "error",
      "react/jsx-uses-react": "error",
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "warn",
        {
          vars: "all",
          varsIgnorePattern: "^_",
          args: "after-used",
          argsIgnorePattern: "^_",
        },
      ],
      "react/prop-types": "off",
      "react/react-in-jsx-scope": "off",
      "react/no-unknown-property": [
        "error",
        { ignore: ["cmdk-input-wrapper", "toast-close"] },
      ],
      "react-hooks/rules-of-hooks": "error",
    },
  },
  // ── TDZ guard for drone-related modules ──────────────────────────────────
  // Two TDZ regressions shipped to prod (DroneRendersSubtab
  // `optimisticRenderColumns` and PinEditor `cachedPoiItems`) — both useMemo
  // deps referencing const variables declared 100+ lines later. Vite
  // production build doesn't catch these; only runtime does. This rule
  // surfaces them at lint time. Scoped to drone + themes files (cascade
  // surface) to avoid waking pre-existing TDZ patterns elsewhere.
  {
    files: [
      "src/components/drone/**/*.{js,mjs,cjs,jsx}",
      "src/components/projects/Drone*.{js,mjs,cjs,jsx}",
      "src/components/themes/**/*.{js,mjs,cjs,jsx}",
      "src/pages/Drone*.{js,mjs,cjs,jsx}",
    ],
    rules: {
      "no-use-before-define": [
        "error",
        {
          functions: false, // function declarations are hoisted, OK
          classes: true,
          variables: true, // const/let TDZ
          allowNamedExports: false,
        },
      ],
    },
  },
];
