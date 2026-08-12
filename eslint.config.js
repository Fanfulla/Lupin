import tseslint from 'typescript-eslint';

export default tseslint.config(
  // .claude/ holds gitignored session artifacts (agent worktrees with their own
  // tsconfigs): linting them breaks `eslint .` locally while CI never sees them.
  { ignores: ['node_modules/**', 'dist/**', 'coverage/**', '.claude/**'] },
  ...tseslint.configs.recommended,
  {
    rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }] },
  },
);
