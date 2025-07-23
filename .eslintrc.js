module.exports = {
    root: true, // From ChatterUI-Latest: Marks this as the root config file
    env: {
        node: true,
        jest: true // Added 'jest' for testing environments. 'browser' omitted for native app context.
    },
    extends: [
        'universe/native',
        'universe/shared/typescript-analysis', // From ChatterUI-Latest: For advanced TypeScript linting
        'plugin:prettier/recommended' // From ChatTCP-Tester: For Prettier integration
    ],
    // For type-aware linting with TypeScript, applied to specific file types
    overrides: [
        {
            files: ['*.ts', '*.tsx', '*.d.ts', '*.js', '*.jsx'], // Ensure it covers all relevant files
            parserOptions: {
                project: './tsconfig.json', // CRITICAL: Points to your tsconfig for type-aware linting
            },
        },
    ],
    // Primary parser for the project
    parser: '@typescript-eslint/parser',

    parserOptions: {
        ecmaFeatures: { jsx: true }, // Enables JSX parsing
        ecmaVersion: 'latest',       // Supports latest ECMAScript features
        sourceType: 'module',        // Allows use of import/export statements
    },
    plugins: [
        '@typescript-eslint',
        'prettier',
        'eslint-plugin-react-compiler', // From ChatterUI-Latest: For React Compiler linting
        'internal' // Custom internal plugin, if it exists
    ],
    rules: {
        // Rules that explicitly turn off common warnings for flexibility (from both)
        'no-unused-vars': 'off',
        '@typescript-eslint/no-unused-vars': 'off',
        'radix': 'off', // From ChatterUI-Latest
        'object-shorthand': ['off'], // From ChatterUI-Latest

        // Rules related to React JSX transform (standard for modern React)
        'react/react-in-jsx-scope': 'off',

        // New/updated rules from ChatterUI-Latest
        'internal/enforce-spacing-values': 'error', // Requires 'internal' plugin
        'react-compiler/react-compiler': 'error', // Requires 'eslint-plugin-react-compiler'

        // Prettier rule - use the more robust one from ChatterUI-Latest
        // This expects a .prettierrc file to define actual Prettier options
        'prettier/prettier': [
            'error',
            {}, // Empty object for inline Prettier options, as usePrettierrc is true
            {
                usePrettierrc: true, // IMPORTANT: Tells ESLint to look for .prettierrc
            },
        ],

        // 'no-undef' from ChatTCP-Tester removed. TypeScript's type checking often makes this redundant.
        // If you encounter issues with undeclared globals later, you can consider re-adding it.
    },
    settings: {
        react: { version: 'detect' }, // From ChatTCP-Tester, good for eslint-plugin-react
    },
};
