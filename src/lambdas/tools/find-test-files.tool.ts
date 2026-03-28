import { z } from 'zod';
import { tool } from '@strands-agents/sdk';
import { getFilesRecursive } from '../utils/get-file-recursive';

const FindTestFilesInput = z.object({
  basePath: z
    .string()
    .describe(
      'Il percorso completo della cartella locale estratta (es. /tmp/extracted_123)',
    ),
});

// Tool specifico per i test
export const findTestFiles = tool({
  name: 'find_test_files',
  description:
    'Ottiene la lista dei file di test (.test.ts, .spec.js, etc.) e configurazioni CI/CD.',
  inputSchema: z.toJSONSchema(FindTestFilesInput) as any,
  callback: async ({
    basePath,
  }: z.infer<typeof FindTestFilesInput>): Promise<string> => {
    try {
      const allFiles = await getFilesRecursive(basePath);

      const testFiles = allFiles.filter((filePath) => {
        const lowerPath = filePath.toLowerCase();
        return (
          lowerPath.includes('.test.') ||
          lowerPath.includes('.spec.') ||
          lowerPath.includes('tests/') ||
          lowerPath.includes('__tests__/') ||
          lowerPath.includes('jest.config') ||
          lowerPath.includes('cypress.json') ||
          lowerPath.includes('.github/workflows/')
        );
      });

      return testFiles.length > 0
        ? testFiles.join('\n')
        : 'Nessun file di test trovato nella cartella.';
    } catch (error: any) {
      return `Errore durante la scansione della cartella: ${error.message}`;
    }
  },
});
