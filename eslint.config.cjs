module.exports = [
  {
    ignores: [
      "node_modules/**",
      "release/**",
      "test-results/**",
      "playwright-report/**",
      "native/.tools/**",
      "native/build/**",
      "native/bin/**",
      "host/bin/**",
    ],
  },
  {
    files: ["**/*.cjs", "**/*.js"],
    languageOptions: { ecmaVersion: "latest" },
    rules: {
      "no-constant-condition": "error",
      "no-duplicate-case": "error",
      "no-unreachable": "error",
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "no-var": "error",
      "prefer-const": "error",
      eqeqeq: "error",
    },
  },
];
