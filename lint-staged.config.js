/**
 * lint-staged config
 * Runs ESLint --fix on TS/JS files, then Prettier across formattable files.
 * Husky `pre-commit` hook invokes this.
 */
export default {
  '*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}': ['eslint --fix', 'prettier --write'],
  '*.{json,md,mdx,yaml,yml,css,html}': ['prettier --write'],
};
