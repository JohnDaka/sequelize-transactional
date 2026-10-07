// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** `===`, `!==`, `==` and `!=`. */
const COMPARISON = '/^[!=]==?$/';

/** A string literal with at least one character: `''` (empty) is allowed, like the number 0. */
const TEXT = 'Literal[raw=/^[\'"][^\'"]/]';

/** Why a text written in place is refused. */
const NAMED_TEXT =
  'Compare against a named constant (an `as const` object and its type), not a text written in place.';

/**
 * No magic values: a text is compared through a named constant, and every number is a named,
 * documented constant. 0 and 1 (empty, first, one more) and array indexes stay inline.
 */
const NO_MAGIC_VALUES = {
  '@typescript-eslint/no-magic-numbers': [
    'error',
    {
      ignore: [0, 1],
      ignoreArrayIndexes: true,
      ignoreEnums: true,
      ignoreNumericLiteralTypes: true,
      ignoreReadonlyClassProperties: true,
      ignoreTypeIndexes: true,
      enforceConst: true,
    },
  ],
  'no-restricted-syntax': [
    'error',
    { selector: `BinaryExpression[operator=${COMPARISON}] > ${TEXT}`, message: NAMED_TEXT },
    { selector: `BinaryExpression[operator=${COMPARISON}] > TemplateLiteral`, message: NAMED_TEXT },
    { selector: `SwitchCase > ${TEXT}`, message: NAMED_TEXT },
  ],
};

export default tseslint.config(
  { ignores: ['dist/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...NO_MAGIC_VALUES,
      // A leading underscore marks an argument a signature needs but the body does not.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Fixtures are data: literal texts and numbers are what a spec is about. The fakes the specs
    // share (src/testing) are fixtures too.
    files: ['**/*.spec.ts', 'src/testing/**/*.ts'],
    rules: {
      '@typescript-eslint/no-magic-numbers': 'off',
      'no-restricted-syntax': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      // Fakes answer like the real async API without awaiting anything themselves.
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    // Plain JavaScript tooling: no TypeScript project to check its types against.
    files: ['**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
);
