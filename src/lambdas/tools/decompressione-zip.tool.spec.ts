jest.mock('@strands-agents/sdk', () => ({
  tool: jest.fn((config) => config), // restituisce la config così com'è
}));

import { executeUnzipRepo } from './decompressione-zip.tool';
import { existsSync, readdirSync } from 'fs';

const BUCKET = process.env.TEST_S3_BUCKET!;
const ZIP_KEY = process.env.TEST_S3_ZIP_KEY!;

describe('executeUnzipRepo - integration test S3 reale', () => {
  beforeAll(() => {
    if (!BUCKET || !ZIP_KEY) {
      throw new Error(
        '❌ TEST_S3_BUCKET e TEST_S3_ZIP_KEY devono essere nel .env',
      );
    }
  });

  it('dovrebbe scaricare e decomprimere lo zip da S3', async () => {
    const result = await executeUnzipRepo({ bucket: BUCKET, zipKey: ZIP_KEY });

    expect(result).not.toMatch(/^Errore/);
    expect(result).toContain('Decompressione completata con successo');

    const match = result.match(/percorso locale: (.+)$/);
    expect(match).not.toBeNull();

    const extractedPath = match![1];
    expect(existsSync(extractedPath)).toBe(true);

    const files = readdirSync(extractedPath);
    expect(files.length).toBeGreaterThan(0);

    console.log(`📁 File estratti in ${extractedPath}:`, files);
  });

  it('dovrebbe restituire errore con bucket inesistente', async () => {
    const result = await executeUnzipRepo({
      bucket: 'bucket-inesistente-xyz-000',
      zipKey: ZIP_KEY,
    });
    expect(result).toMatch(/^Errore/);
  });

  it('dovrebbe restituire errore con chiave inesistente', async () => {
    const result = await executeUnzipRepo({
      bucket: BUCKET,
      zipKey: 'file-che-non-esiste.zip',
    });
    expect(result).toMatch(/^Errore/);
  });
});
