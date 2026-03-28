import { readdir, stat } from 'fs/promises';
import path from 'path';

// Funzione di supporto per leggere ricorsivamente tutti i file in una directory
export async function getFilesRecursive(dir: string): Promise<string[]> {
  let results: string[] = [];
  const list = await readdir(dir);

  for (const file of list) {
    const filePath = path.join(dir, file);
    const fileStat = await stat(filePath);

    if (fileStat.isDirectory()) {
      results = results.concat(await getFilesRecursive(filePath));
    } else {
      results.push(filePath);
    }
  }
  return results;
}
