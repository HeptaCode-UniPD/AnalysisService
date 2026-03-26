// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      // Regole base già presenti
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      'prettier/prettier': ['error', { endOfLine: 'auto' }],

      // --- Integrazione Metriche HeptaCode ---

      // MPD07: Complessità Ciclomatica (Accettabile <= 15, Ottimale <= 10)
      complexity: ['error', 15],

      // MPD08: Parametri per metodo (Accettabile <= 6, Ottimale <= 4)
      'max-params': ['error', 6],

      // MPD09: Linee di codice per metodo (Accettabile < 35, Ottimale <= 20)
      'max-lines-per-function': [
        'warn',
        { max: 35, skipBlankLines: true, skipComments: true },
      ],

      // MPD10: Linee di codice per file (Accettabile < 120, Ottimale <= 80)
      'max-lines': [
        'warn',
        { max: 120, skipBlankLines: true, skipComments: true },
      ],

      // Altre regole per la Manutenibilità (Sezione 5.5.1)

      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error'],
      'no-console': 'warn',
    },
  },
);
