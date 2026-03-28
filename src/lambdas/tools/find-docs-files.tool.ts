import { z } from 'zod';
import { tool } from '@strands-agents/sdk';
import { getFilesRecursive } from '../utils/get-file-recursive';

const FindDocumentationFilesInput = z.object({
  basePath: z
    .string()
    .describe(
      'Il percorso completo della cartella locale estratta (es. /tmp/extracted_123)',
    ),
});

export const findDocumentationFiles = tool({
  name: 'find_documentation_files',
  description:
    'Esplora la cartella locale del repository e restituisce i percorsi assoluti dei file di documentazione (es. .md, .txt, cartella docs/, CHANGELOG).',
  inputSchema: z.toJSONSchema(FindDocumentationFilesInput) as any,
  callback: async ({
    basePath,
  }: z.infer<typeof FindDocumentationFilesInput>): Promise<string> => {
    try {
      const allFiles = await getFilesRecursive(basePath);

      const docFiles = allFiles.filter((filePath) => {
        const lowerPath = filePath.toLowerCase();
        return (
          lowerPath.endsWith('.md') ||
          lowerPath.endsWith('.txt') ||
          lowerPath.includes('/docs/') ||
          lowerPath.includes('changelog') ||
          lowerPath.includes('readme')
        );
      });

      return docFiles.length > 0
        ? docFiles.join('\n')
        : 'Nessun file di documentazione trovato nella cartella.';
    } catch (error: any) {
      return `Errore durante la scansione della cartella: ${error.message}`;
    }
  },
});
