module.exports = {
  extends: ['universe/native', 'plugin:prettier/recommended'],
  plugins: ['@typescript-eslint', 'internal'],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaFeatures: { jsx: true },
    ecmaVersion: 2021,
    sourceType: 'module'
  },
  rules: {
    '@typescript-eslint/no-unused-vars': 'off',
    'no-undef': 'off',
    'no-unused-vars': 'off',
    'react/react-in-jsx-scope': 'off',
    'prettier/prettier': ['error', { endOfLine: 'auto' }]
  },
  env: {
    node: true,
    browser: true,
    jest: true
  },
  settings: {
    react: { version: 'detect' }
  }
};
