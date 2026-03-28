import { z } from 'zod';
import { tool } from '@strands-agents/sdk';
import { readFile } from 'fs/promises';

const ReadFileContentInput = z.object({
  filePath: z
    .string()
    .describe('Il percorso assoluto del file locale da leggere'),
});

export const readFileContent = tool({
  name: 'read_file_content',
  description:
    'Legge il contenuto testuale di un file specifico dal file system locale.',
  inputSchema: z.toJSONSchema(ReadFileContentInput) as any,
  callback: async ({
    filePath,
  }: z.infer<typeof ReadFileContentInput>): Promise<string> => {
    try {
      // Legge il file in locale con codifica utf-8
      const content = await readFile(filePath, 'utf-8');
      return content || '';
    } catch (error: any) {
      return `Errore durante la lettura del file ${filePath}: ${error.message}`;
    }
  },
});
