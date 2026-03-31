import { z } from 'zod';
import { readFile } from 'fs/promises';

const ReadFileContentInput = z.object({
  filePath: z
    .string()
    .describe('Il percorso assoluto del file locale da leggere'),
});

const callback = async ({
  filePath,
}: z.infer<typeof ReadFileContentInput>): Promise<string> => {
  try {
    const content = await readFile(filePath, 'utf-8');
    if (!content) return `----- ${filePath} -----\n(Empty file)`;
    const lines = content.split('\n');
    const numberedContent = lines
      .map((line, index) => `${index + 1}: ${line}`)
      .join('\n');
    return `----- ${filePath} -----\n${numberedContent}`;
  } catch (error: any) {
    return `Errore durante la lettura del file ${filePath}: ${error.message}`;
  }
};

export const createReadFileContentTool = async () => {
  const { tool } = await import('@strands-agents/sdk');
  return tool({
    name: 'read_file_content',
    description:
      'Legge il contenuto testuale di un file specifico dal file system locale. Usa i percorsi assoluti restituiti da list_repository_files o find_documentation_files o find_test_files.',
    inputSchema: ReadFileContentInput,
    callback,
  });
};

export const readFileContent = { callback };
