import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { tool } from '@strands-agents/sdk';
import { getFilesRecursive } from '../utils/get-file-recursive';

// Schema Zod aggiornato: ora si aspetta la cartella locale invece di bucket/prefix
const FindAllFilesInput = z.object({
  basePath: z
    .string()
    .describe(
      'Il percorso completo della cartella locale estratta (es. /tmp/extracted_123)',
    ),
});

export const listRepositoryFiles = tool({
  name: 'list_repository_files',
  description:
    'Usa questo tool per ottenere la lista completa di tutti i file presenti nel repository decompresso.',
  inputSchema: zodToJsonSchema(FindAllFilesInput as any) as any,
  callback: async ({
    basePath,
  }: z.infer<typeof FindAllFilesInput>): Promise<string> => {
    try {
      const allFiles = await getFilesRecursive(basePath);

      if (allFiles.length === 0) return 'Nessun file trovato nella cartella.';

      // Restituiamo direttamente i percorsi assoluti separati da newline.
      // In questo modo, l'agente può passare direttamente queste stringhe al tool 'read_file_content'.
      return allFiles.join('\n');
    } catch (error: any) {
      return `Errore durante la lettura della directory: ${error.message}`;
    }
  },
});
