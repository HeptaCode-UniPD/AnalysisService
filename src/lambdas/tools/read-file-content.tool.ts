import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
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
  inputSchema: zodToJsonSchema(ReadFileContentInput as any) as any,
  callback: async ({
    filePath,
  }: z.infer<typeof ReadFileContentInput>): Promise<string> => {
    try {
      const content = await readFile(filePath, 'utf-8');
      return `----- ${filePath} -----\n${content || ''}`;
    } catch (error: any) {
      return `Errore durante la lettura del file ${filePath}: ${error.message}`;
    }
  },
});
