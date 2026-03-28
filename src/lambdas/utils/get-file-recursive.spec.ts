import { getFilesRecursive } from './get-file-recursive';
import { mkdir, writeFile, rm } from 'fs/promises';
import path from 'path';
import os from 'os';

describe('Test getFilesRecursive', () => {
  const testDir = path.join(os.tmpdir(), `test-repo-${Date.now()}`);

  beforeAll(async () => {
    await mkdir(testDir, { recursive: true });
    await writeFile(path.join(testDir, 'README.md'), '# Hello World');

    const subDir = path.join(testDir, 'src');
    await mkdir(subDir);
    await writeFile(path.join(subDir, 'index.ts'), 'console.log("test");');
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('dovrebbe trovare tutti i file esplorando le sottocartelle', async () => {
    const files = await getFilesRecursive(testDir);

    expect(files).toHaveLength(2);

    expect(files.some((f) => f.endsWith('README.md'))).toBe(true);
    expect(files.some((f) => f.endsWith('index.ts'))).toBe(true);
  });
});
