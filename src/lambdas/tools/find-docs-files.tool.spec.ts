jest.mock('@strands-agents/sdk', () => ({
  tool: jest.fn((config) => config),
}));

import { mkdir, writeFile, rm } from 'fs/promises';
import path from 'path';
import os from 'os';
import { findDocumentationFiles } from './find-docs-files.tool';

describe('findDocumentationFiles - unit test', () => {
  const testDir = path.join(os.tmpdir(), `test-list-files-${Date.now()}`);

  beforeAll(async () => {
    await mkdir(path.join(testDir, 'src'), { recursive: true });
    await mkdir(path.join(testDir, 'docs'), { recursive: true });

    await writeFile(path.join(testDir, 'README.md'), '# Hello');
    await writeFile(path.join(testDir, 'istruzioni.txt'), '# file txt');

    await writeFile(path.join(testDir, 'src', 'index.ts'), 'console.log("hi")');
    await writeFile(path.join(testDir, 'src', 'guide.md'), '# Guide');

    await writeFile(path.join(testDir, 'docs', 'api-reference.odf'), '# Guide');
    await writeFile(path.join(testDir, 'docs', 'changelog.odf'), '# Changelog');
    await writeFile(path.join(testDir, 'docs', 'readme.html'), '# readme');
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('dovrebbe restituire tutti i file di documentazione come stringa separata da newline', async () => {
    const result = await (findDocumentationFiles as any).callback({
      basePath: testDir,
    });

    expect(result).toContain('README.md');
    expect(result).toContain('guide.md');
    expect(result).toContain('istruzioni.txt');

    expect(result).toContain('api-reference.odf');
    expect(result).toContain('changelog.odf');
    expect(result).toContain('readme.html');

    expect(result).not.toContain('index.ts');

    const lines = result.split('\n');
    expect(lines).toHaveLength(6);
  });

  it('dovrebbe restituire messaggio se la cartella non ha file di documentazione', async () => {
    const noDocsDir = path.join(os.tmpdir(), `test-no-docs-${Date.now()}`);
    await mkdir(noDocsDir, { recursive: true });
    await writeFile(path.join(noDocsDir, 'hello-world.c++'), 'Hello World');

    const result = await (findDocumentationFiles as any).callback({
      basePath: noDocsDir,
    });

    expect(result).toBe(
      'Nessun file di documentazione trovato nella cartella.',
    );

    await rm(noDocsDir, { recursive: true, force: true });
  });

  it('dovrebbe restituire errore con path inesistente', async () => {
    const result = await (findDocumentationFiles as any).callback({
      basePath: '/path/che/non/esiste',
    });

    expect(result).toMatch(/^Errore durante la scansione della cartella/);
  });
});
