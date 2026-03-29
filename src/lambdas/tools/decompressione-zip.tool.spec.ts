import { executeUnzipRepo } from './decompressione-zip.tool';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { execSync } from 'child_process';
import AdmZip from 'adm-zip'; // <-- IMPORTANTE: Aggiungi questo

const mockSend = jest.fn();

jest.mock('@strands-agents/sdk', () => ({
  tool: jest.fn((config) => config),
}));

// Mock di adm-zip: deve restituire un costruttore mockato
jest.mock('adm-zip', () => {
  return jest.fn().mockImplementation(() => ({
    extractAllTo: jest.fn(),
  }));
});

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({
    send: (...args: any[]) => mockSend(...args),
  })),
  GetObjectCommand: jest.fn(),
}));

jest.mock('fs', () => ({
  createWriteStream: jest.fn(),
  rmSync: jest.fn(),
}));

jest.mock('stream/promises', () => ({
  pipeline: jest.fn(),
}));

describe('executeUnzipRepo', () => {
  beforeEach(() => {
    jest.clearAllMocks(); // Usa clearAllMocks invece di reset per pulire anche i mock delle classi
    (pipeline as jest.Mock).mockResolvedValue(undefined);
    (createWriteStream as jest.Mock).mockReturnValue({
      on: jest.fn().mockImplementation((event, cb) => {
        if (event === 'finish') cb();
        return this;
      }),
    });
  });

  it('dovrebbe restituire messaggio di successo quando tutto va bene', async () => {
    const fakeBody = { pipe: jest.fn() };
    mockSend.mockResolvedValue({ Body: fakeBody });

    const result = await executeUnzipRepo({
      bucket: 'my-bucket',
      zipKey: 'repo.zip',
    });

    expect(result).toContain('Decompressione completata con successo');
    expect(result).toContain('percorso locale:');
    expect(result).not.toMatch(/^Errore/);
  });

  it('dovrebbe chiamare GetObjectCommand con bucket e key corretti', async () => {
    const fakeBody = { pipe: jest.fn() };
    mockSend.mockResolvedValue({ Body: fakeBody });

    await executeUnzipRepo({ bucket: 'my-bucket', zipKey: 'path/to/repo.zip' });

    expect(GetObjectCommand).toHaveBeenCalledWith({
      Bucket: 'my-bucket',
      Key: 'path/to/repo.zip',
    });
  });

  it('dovrebbe restituire errore se response.Body è null', async () => {
    mockSend.mockResolvedValue({ Body: null });

    const result = await executeUnzipRepo({
      bucket: 'my-bucket',
      zipKey: 'repo.zip',
    });

    expect(result).toMatch(/^Errore/);
    expect(result).toContain('vuoto o inesistente');
  });

  it('dovrebbe restituire errore se response.Body è null', async () => {
    mockSend.mockResolvedValue({ Body: null });

    const result = await executeUnzipRepo({
      bucket: 'my-bucket',
      zipKey: 'repo.zip',
    });

    expect(result).toMatch(/^Errore/);
    expect(result).toContain('vuoto o inesistente');
  });

  it('dovrebbe restituire errore se response.Body è undefined', async () => {
    mockSend.mockResolvedValue({});

    const result = await executeUnzipRepo({
      bucket: 'my-bucket',
      zipKey: 'repo.zip',
    });

    expect(result).toMatch(/^Errore/);
    expect(result).toContain('vuoto o inesistente');
  });

  it('dovrebbe restituire errore se s3Client.send rigetta (es. bucket inesistente)', async () => {
    mockSend.mockRejectedValue(new Error('NoSuchBucket'));

    const result = await executeUnzipRepo({
      bucket: 'bucket-inesistente',
      zipKey: 'repo.zip',
    });

    expect(result).toMatch(/^Errore/);
    expect(result).toContain('NoSuchBucket');
  });

  it('dovrebbe restituire errore se s3Client.send rigetta (es. chiave inesistente)', async () => {
    mockSend.mockRejectedValue(new Error('NoSuchKey'));

    const result = await executeUnzipRepo({
      bucket: 'my-bucket',
      zipKey: 'file-inesistente.zip',
    });

    expect(result).toMatch(/^Errore/);
    expect(result).toContain('NoSuchKey');
  });

  it('dovrebbe restituire errore se pipeline fallisce durante la scrittura', async () => {
    const fakeBody = { pipe: jest.fn() };
    mockSend.mockResolvedValue({ Body: fakeBody });
    (pipeline as jest.Mock).mockRejectedValue(new Error('write error'));

    const result = await executeUnzipRepo({
      bucket: 'my-bucket',
      zipKey: 'repo.zip',
    });

    expect(result).toMatch(/^Errore/);
    expect(result).toContain('write error');
  });

  it('dovrebbe restituire errore se adm-zip fallisce', async () => {
    const fakeBody = { pipe: jest.fn() };
    mockSend.mockResolvedValue({ Body: fakeBody });

    (AdmZip as unknown as jest.Mock).mockImplementation(() => ({
      extractAllTo: () => {
        throw new Error('Zip crash');
      },
    }));

    const result = await executeUnzipRepo({
      bucket: 'my-bucket',
      zipKey: 'repo.zip',
    });

    expect(result).toContain(
      'Errore durante il download o la decompressione: Zip crash',
    );
  });
});
