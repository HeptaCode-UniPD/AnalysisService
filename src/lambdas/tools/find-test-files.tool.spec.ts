jest.mock('@strands-agents/sdk', () => ({
  tool: jest.fn((config) => config),
}));

import { mkdir, writeFile, rm } from 'fs/promises';
import path from 'path';
import os from 'os';
import { findTestFiles } from './find-test-files.tool';

describe('findTestFiles - unit test', () => {
  const testDir = path.join(os.tmpdir(), `test-find-test-files-${Date.now()}`);

  beforeAll(async () => {
    await mkdir(path.join(testDir, 'src'), { recursive: true });
    await mkdir(path.join(testDir, '__tests__'), { recursive: true });
    await mkdir(path.join(testDir, 'tests'), { recursive: true });
    await mkdir(path.join(testDir, '.github', 'workflows'), {
      recursive: true,
    });

    // File di test attesi
    await writeFile(path.join(testDir, 'src', 'app.test.ts'), '// test');
    await writeFile(path.join(testDir, 'src', 'utils.spec.js'), '// spec');
    await writeFile(path.join(testDir, '__tests__', 'helper.ts'), '// helper');
    await writeFile(
      path.join(testDir, 'tests', 'integration.ts'),
      '// integration',
    );
    await writeFile(
      path.join(testDir, 'jest.config.js'),
      'module.exports = {}',
    );
    await writeFile(
      path.join(testDir, '.github', 'workflows', 'ci.yml'),
      'name: CI',
    );

    // File non di test
    await writeFile(path.join(testDir, 'src', 'index.ts'), 'console.log("hi")');
    await writeFile(path.join(testDir, 'src', 'app.ts'), '// app');
    await writeFile(path.join(testDir, 'README.md'), '# Hello');
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('dovrebbe restituire tutti i file di test come stringa separata da newline', async () => {
    const result = await (findTestFiles as any).callback({
      basePath: testDir,
    });

    expect(result).toContain('app.test.ts');
    expect(result).toContain('utils.spec.js');
    expect(result).toContain('helper.ts');
    expect(result).toContain('integration.ts');
    expect(result).toContain('jest.config.js');
    expect(result).toContain('ci.yml');

    expect(result).not.toContain('index.ts');
    expect(result).not.toContain('app.ts');
    expect(result).not.toContain('README.md');

    const lines = result.split('\n');
    expect(lines).toHaveLength(6);
  });

  it('dovrebbe restituire messaggio se la cartella non ha file di test', async () => {
    const noTestsDir = path.join(os.tmpdir(), `test-no-tests-${Date.now()}`);
    await mkdir(noTestsDir, { recursive: true });
    await writeFile(path.join(noTestsDir, 'index.ts'), 'console.log("hi")');

    const result = await (findTestFiles as any).callback({
      basePath: noTestsDir,
    });

    expect(result).toBe('Nessun file di test trovato nella cartella.');

    await rm(noTestsDir, { recursive: true, force: true });
  });

  it('dovrebbe restituire errore con path inesistente', async () => {
    const result = await (findTestFiles as any).callback({
      basePath: '/path/che/non/esiste',
    });

    expect(result).toMatch(/^Errore durante la scansione della cartella/);
  });
});
