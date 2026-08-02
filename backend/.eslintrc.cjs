/* eslint-env node */
module.exports = {
  env: {
    node: true,
  },
  overrides: [
    {
      // The test suites are ESM (import/export) while src is CommonJS.
      files: ['tests/**/*.js', 'vitest.config.js'],
      parserOptions: {
        sourceType: 'module',
      },
      env: {
        node: true,
        es2022: true,
      },
    },
  ],
};
