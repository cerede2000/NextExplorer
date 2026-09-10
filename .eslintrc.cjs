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
    {
      // Les outils de verification sont des modules ES: sans sourceType, eslint
      // lit leur premier import comme une erreur de syntaxe.
      files: ['scripts/**/*.mjs'],
      env: {
        node: true,
      },
      parserOptions: {
        sourceType: 'module',
      },
    },
  ],
};
