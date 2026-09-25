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
      // Deleting someone's files goes through the trash. Removing from disk
      // directly is allowed only in the files below, which remove what the
      // application itself created (temporary uploads, caches, extraction
      // staging) or implement the permanent deletion the trash hands back to.
      // A new file that deletes content must go through services/trash, or be
      // added here with the reason it does not.
      files: ['backend/src/**/*.js'],
      excludedFiles: [
        'backend/src/services/trash/**',
        'backend/src/services/fileTransferService.js',
        // Its own in-flight journal, and the placement/undo utilities that
        // remove only empty placeholders and what an operation itself wrote.
        'backend/src/services/inFlightFiles.js',
        'backend/src/utils/placeWithoutOverwrite.js',
        'backend/src/utils/ownedTree.js',
        'backend/src/services/archiveService.js',
        'backend/src/services/rawPreviewService.js',
        'backend/src/services/thumbnailService.js',
        'backend/src/services/tusUploadService.js',
        'backend/src/services/uploadRemnants.js',
        'backend/src/services/uploadService.js',
        'backend/src/routes/onlyoffice.js',
        'backend/src/routes/settings.js',
        'backend/src/routes/zip.js',
        'backend/src/scripts/**',
      ],
      rules: {
        'no-restricted-properties': [
          'error',
          ...['fs', 'fsp', 'fss', 'fsSync', 'fsPromises', 'promises'].flatMap((object) =>
            ['rm', 'rmSync', 'unlink', 'unlinkSync', 'rmdir', 'rmdirSync'].map((property) => ({
              object,
              property,
              message: 'Deleting from disk goes through services/trash (see .eslintrc.cjs).',
            }))
          ),
        ],
        'no-restricted-syntax': [
          'error',
          {
            selector:
              "CallExpression[callee.name='spawn'][arguments.0.value='rm'], CallExpression[callee.property.name='spawn'][arguments.0.value='rm']",
            message: 'Deleting from disk goes through services/trash (see .eslintrc.cjs).',
          },
          {
            selector:
              "VariableDeclarator[init.callee.name='require'][init.arguments.0.value=/^(node:)?fs(\\u002Fpromises)?$/] > ObjectPattern > Property[key.name=/^(rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)$/]",
            message: 'Deleting from disk goes through services/trash (see .eslintrc.cjs).',
          },
        ],
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
