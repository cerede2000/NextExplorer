import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';
import pluginVue from 'eslint-plugin-vue';

/**
 * One configuration for the whole repository.
 *
 * It replaces three `.eslintrc.cjs` files — root, backend, frontend — that
 * ESLint 9 stopped reading. Flat configuration has no `env` and no
 * `/* eslint-env *\/` comment: what a file may refer to is declared here, by
 * the paths it applies to, which is why the sections below are grouped by
 * where the code runs rather than by which package it belongs to.
 */

/**
 * Deleting someone's files goes through the trash. Removing from disk directly
 * is allowed only in the files below, which remove what the application itself
 * created (temporary uploads, caches, extraction staging) or implement the
 * permanent deletion the trash hands back to. A new file that deletes content
 * must go through services/trash, or be added here with the reason it does not.
 */
const mayDeleteFromDisk = [
  'backend/src/services/trash/**',
  'backend/src/services/versions/**',
  'backend/src/services/fileTransferService.js',
  // Its own staging copy of the index database, under the cache directory.
  'backend/src/services/indexDb.js',
  // What an operation recorded itself as writing, after a stop interrupted it.
  'backend/src/services/inFlightFiles.js',
  // A rename that refuses to overwrite: the old name of a file it has just
  // linked, or an empty placeholder of its own.
  'backend/src/utils/placeWithoutOverwrite.js',
  // What an undone operation wrote, told apart by inode from what others added.
  'backend/src/utils/ownedTree.js',
  // Its own decompressed copies of archives, under the cache directory: made
  // again from the archive whenever they are missing, so nothing is lost by
  // taking one away.
  'backend/src/services/archiveCacheService.js',
  'backend/src/services/archiveService.js',
  'backend/src/services/rawPreviewService.js',
  'backend/src/services/thumbnailService.js',
  'backend/src/services/tusUploadService.js',
  'backend/src/services/uploadRemnants.js',
  'backend/src/services/uploadService.js',
  'backend/src/routes/onlyoffice.js',
  // A logo it wrote into /config/logos, once another has replaced it, or when
  // the settings could not be switched to it.
  'backend/src/services/brandingLogo.js',
  // The hidden folder it extracts into, which it made itself and which never
  // holds anything but what came out of the archive.
  'backend/src/routes/archive.js',
  'backend/src/routes/zip.js',
  'backend/src/scripts/**',
];

const deletionGoesThroughTheTrash =
  'Deleting from disk goes through services/trash (see eslint.config.mjs).';

const FS_OBJECTS = ['fs', 'fsp', 'fss', 'fsSync', 'fsPromises', 'promises'];
const FS_DELETIONS = ['rm', 'rmSync', 'unlink', 'unlinkSync', 'rmdir', 'rmdirSync'];

export default [
  {
    ignores: [
      '**/coverage/',
      '**/dist/',
      '**/dist-ssr/',
      '**/storybook-static/',
      '**/.vitepress/cache/',
      '**/.vitepress/dist/',
      // The frontend build, copied where the image serves it (and where the
      // browser tests put it): minified output, not source.
      'backend/src/public/',
    ],
  },

  js.configs.recommended,

  // Everything, unless a section below says otherwise: modern syntax, and the
  // globals every JavaScript runtime has.
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.es2022 },
    },
    rules: {
      // An error nobody reads is a decision, and this is how the codebase
      // writes it down: `catch (_)`. ESLint 10 began reporting every caught
      // name that goes unused, which is worth having — for the ones that were
      // given a real name and then forgotten.
      'no-unused-vars': ['error', { caughtErrorsIgnorePattern: '^_' }],
    },
  },

  // The backend: CommonJS, running under Node.
  {
    files: ['backend/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },

  // Its suites and its vitest configuration are ES modules, while src is not.
  {
    files: ['backend/tests/**/*.js', 'backend/vitest.config.js'],
    languageOptions: { sourceType: 'module' },
  },

  {
    files: ['backend/src/**/*.js'],
    ignores: mayDeleteFromDisk,
    rules: {
      'no-restricted-properties': [
        'error',
        ...FS_OBJECTS.flatMap((object) =>
          FS_DELETIONS.map((property) => ({
            object,
            property,
            message: deletionGoesThroughTheTrash,
          }))
        ),
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.name='spawn'][arguments.0.value='rm'], CallExpression[callee.property.name='spawn'][arguments.0.value='rm']",
          message: deletionGoesThroughTheTrash,
        },
        {
          selector:
            "VariableDeclarator[init.callee.name='require'][init.arguments.0.value=/^(node:)?fs(\\u002Fpromises)?$/] > ObjectPattern > Property[key.name=/^(rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)$/]",
          message: deletionGoesThroughTheTrash,
        },
      ],
    },
  },

  // The frontend: ES modules in a browser, with Vue's own rules.
  ...pluginVue.configs['flat/essential'].map((config) => ({
    ...config,
    files: config.files ?? ['frontend/**/*.{js,vue}'],
  })),
  {
    files: ['frontend/**/*.{js,vue}'],
    languageOptions: { globals: { ...globals.browser } },
  },
  // The documentation site's own components, which run in the reader's browser.
  {
    files: ['docs/.vitepress/theme/**/*.{js,vue}'],
    languageOptions: { globals: { ...globals.browser } },
  },

  // What builds and tests the frontend runs under Node, not in a browser — and
  // the end-to-end suite drives a browser from Node, so it refers to both.
  {
    files: ['frontend/*.config.js', 'frontend/vitest.setup.js', 'frontend/e2e/**/*.{js,mjs}'],
    languageOptions: { globals: { ...globals.node } },
  },

  // Helper scripts, the ones shipped with the image and the ones that are not.
  {
    files: ['docker/**/*.js', 'scripts/**/*.js', '**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },
  {
    files: ['scripts/**/*.mjs', 'docs/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },

  // Last, so that everything Prettier decides is switched off here rather than
  // argued about twice.
  prettier,
];
