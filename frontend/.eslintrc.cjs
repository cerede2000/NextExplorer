/* eslint-env node */
module.exports = {
  root: true,
  extends: ['plugin:vue/vue3-essential', 'eslint:recommended', 'prettier'],
  parserOptions: {
    ecmaVersion: 'latest',
  },
  // `ecmaVersion: latest` sets the syntax and not what exists at run time, so
  // `globalThis` — standard since ES2020, and what a store reaches for when it has to
  // touch a timer or a listener the browser owns — read as an undefined name.
  env: {
    browser: true,
    es2022: true,
  },
};
