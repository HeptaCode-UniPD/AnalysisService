import { z } from 'zod';
import { getFilesRecursive } from '../utils/get-file-recursive';

const FindAllFilesInput = z.object({
  basePath: z
    .string()
    .describe(
      'Il percorso completo della cartella locale estratta (es. /tmp/extracted_123)',
    ),
});

const callback = async ({
  basePath,
}: z.infer<typeof FindAllFilesInput>): Promise<string> => {
  try {
    const allFiles = await getFilesRecursive(basePath);
    if (allFiles.length === 0) return 'Nessun file trovato nella cartella.';
    return allFiles.join('\n');
  } catch (error: any) {
    return `Errore durante la lettura della directory: ${error.message}`;
  }
};

// Factory async
export const createListRepositoryFilesTool = async () => {
  const { tool } = await import('@strands-agents/sdk');
  return tool({
    name: 'list_repository_files',
    description:
      'Usa questo tool per ottenere la lista completa di tutti i file presenti nel repository decompresso.',
    inputSchema: z.toJSONSchema(FindAllFilesInput as any) as any,
    callback,
  });
};

// Manteniamo per i test esistenti
export const listRepositoryFiles = { callback };
