/* eslint-env node */
module.exports = {
  root: true,
  env: {
    es2022: true,
  },
  extends: ['eslint:recommended', 'prettier'],
  ignorePatterns: [
    'node_modules/',
    'coverage/',
    'dist/',
    'dist-ssr/',
    'storybook-static/',
    '.vitepress/cache/',
    '.vitepress/dist/',
  ],
  parserOptions: {
    ecmaVersion: 'latest',
  },
  overrides: [
    {
      // Helper scripts shipped with the image run under plain Node.
      files: ['docker/**/*.js', 'scripts/**/*.js', '*.cjs', '**/*.config.cjs'],
      env: {
        node: true,
      },
    },
  ],
};
