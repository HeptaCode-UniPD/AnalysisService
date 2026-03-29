jest.mock('@strands-agents/sdk', () => ({
  tool: jest.fn((config) => config),
}));

import { writeFile, rm } from 'fs/promises';
import path from 'path';
import os from 'os';
import { readFileContent } from './read-file-content.tool';

describe('readFileContent - unit test', () => {
  const tmpFile = path.join(os.tmpdir(), `test-read-file-${Date.now()}.txt`);
  const fileContent = 'Contenuto di esempio\nSeconda riga';

  beforeAll(async () => {
    await writeFile(tmpFile, fileContent, 'utf-8');
  });

  afterAll(async () => {
    await rm(tmpFile, { force: true });
  });

  it('dovrebbe restituire il contenuto del file', async () => {
    const result = await (readFileContent as any).callback({
      filePath: tmpFile,
    });

    expect(result).toBe(`----- ${tmpFile} -----\n${fileContent}`);
  });

  it('dovrebbe restituire stringa vuota per file vuoto', async () => {
    const emptyFile = path.join(os.tmpdir(), `test-empty-${Date.now()}.txt`);
    await writeFile(emptyFile, '', 'utf-8');

    const result = await (readFileContent as any).callback({
      filePath: emptyFile,
    });

    expect(result).toBe(`----- ${emptyFile} -----\n`);

    await rm(emptyFile, { force: true });
  });

  it('dovrebbe restituire errore con path inesistente', async () => {
    const result = await (readFileContent as any).callback({
      filePath: '/path/che/non/esiste/file.txt',
    });

    expect(result).toMatch(
      /^Errore durante la lettura del file \/path\/che\/non\/esiste\/file\.txt/,
    );
  });
});
