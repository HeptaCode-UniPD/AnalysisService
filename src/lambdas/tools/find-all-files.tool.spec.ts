jest.mock('@strands-agents/sdk', () => ({
  tool: jest.fn((config) => config),
}));

import { mkdir, writeFile, rm } from 'fs/promises';
import path from 'path';
import os from 'os';

import { listRepositoryFiles } from './find-all-files.tool';

describe('listRepositoryFiles - unit test', () => {
  const testDir = path.join(os.tmpdir(), `test-list-files-${Date.now()}`);

  beforeAll(async () => {
    await mkdir(path.join(testDir, 'src'), { recursive: true });
    await mkdir(path.join(testDir, 'docs'), { recursive: true });

    await writeFile(path.join(testDir, 'README.md'), '# Hello');
    await writeFile(path.join(testDir, 'src', 'index.ts'), 'console.log("hi")');
    await writeFile(path.join(testDir, 'docs', 'guide.md'), '# Guide');
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('dovrebbe restituire tutti i file come stringa separata da newline', async () => {
    const result = await (listRepositoryFiles as any).callback({
      basePath: testDir,
    });

    expect(result).toContain('README.md');
    expect(result).toContain('index.ts');
    expect(result).toContain('guide.md');

    const lines = result.split('\n');
    expect(lines).toHaveLength(3);
  });

  it('dovrebbe restituire messaggio se la cartella è vuota', async () => {
    const emptyDir = path.join(os.tmpdir(), `test-empty-${Date.now()}`);
    await mkdir(emptyDir, { recursive: true });

    const result = await (listRepositoryFiles as any).callback({
      basePath: emptyDir,
    });

    expect(result).toBe('Nessun file trovato nella cartella.');

    await rm(emptyDir, { recursive: true, force: true });
  });

  it('dovrebbe restituire errore con path inesistente', async () => {
    const result = await (listRepositoryFiles as any).callback({
      basePath: '/path/che/non/esiste',
    });

    expect(result).toMatch(/^Errore durante la lettura della directory/);
  });
});
