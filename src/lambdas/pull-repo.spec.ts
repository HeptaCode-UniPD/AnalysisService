import { handler } from './pull-repo';
import { execSync } from 'child_process';
import { readFileSync, rmSync, existsSync } from 'fs';

// 1. Diciamo a Jest di intercettare e simulare queste librerie
jest.mock('child_process');
jest.mock('fs');
jest.mock('@aws-sdk/client-s3', () => {
  return {
    S3Client: jest.fn().mockImplementation(() => ({
      send: jest.fn().mockResolvedValue({}), // Simula un caricamento S3 con successo
    })),
    PutObjectCommand: jest.fn(),
  };
});

describe('Lambda: pullRepoToS3', () => {
  const mockEvent = {
    jobId: '12345',
    repoUrl: 'https://github.com/owner/repo.git',
    commitSha: 'abcdef123456',
    s3Prefix: 'repos/12345/abcdef123456',
  };

  beforeEach(() => {
    // Impostiamo la variabile d'ambiente finta prima di ogni test
    process.env.S3_BUCKET_NAME = 'test-bucket';
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.clearAllMocks(); // Ripulisce lo storico delle chiamate fittizie
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('dovrebbe eseguire git clone, comprimere e caricare su S3', async () => {
    // Configuriamo le risposte fittizie per il file system e i comandi di sistema
    (existsSync as jest.Mock).mockReturnValue(true); // Finge che il CHANGELOG esista
    (execSync as jest.Mock).mockReturnValue(Buffer.from('v1.0.0')); // Finge l'output di git tag
    (readFileSync as jest.Mock).mockReturnValue(Buffer.from('finto-file-zip'));

    // Eseguiamo l'handler
    const result = await handler(mockEvent);

    // 2. Verifichiamo che la Lambda abbia restituito il formato corretto per la Step Function
    expect(result.s3Bucket).toBe('test-bucket');
    expect(result.s3Key).toBe('repos/12345/abcdef123456/source.tar.gz');
    expect(result.repoMetadata.hasChangelog).toBe(true);

    // 3. Verifichiamo che i comandi di sistema siano stati lanciati con l'URL corretto (incluso il token)
    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('https://github.com/owner/repo.git'),
      expect.anything(), // Aggiungiamo questo per coprire l'oggetto { stdio: 'ignore' }
    );

    // Il comando tar non aveva un secondo argomento nel nostro codice, quindi questo rimane invariato
    expect(execSync).toHaveBeenCalledWith(expect.stringContaining('tar -czf'));

    // 4. Verifichiamo che la pulizia finale sia sempre stata eseguita
    expect(rmSync).toHaveBeenCalledTimes(2);
  });

  it('dovrebbe lanciare un errore se manca S3_BUCKET_NAME', async () => {
    delete process.env.S3_BUCKET_NAME;
    await expect(handler(mockEvent)).rejects.toThrow(
      'Configurazione mancante: S3_BUCKET_NAME',
    );
  });

  it("dovrebbe intercettare gli errori, lanciare un'eccezione formattata e svuotare /tmp", async () => {
    // 1. Forziamo il comando 'execSync' a fallire simulando un errore di Git
    (execSync as jest.Mock).mockImplementationOnce(() => {
      throw new Error('Git repository not found');
    });

    // 2. Verifichiamo che la Lambda catturi l'errore e lanci la nostra stringa personalizzata
    await expect(handler(mockEvent)).rejects.toThrow(
      'Impossibile scaricare la repository: Git repository not found',
    );

    // 3. IMPORTANTISSIMO: Verifichiamo che il blocco 'finally' abbia comunque pulito la cartella /tmp
    expect(rmSync).toHaveBeenCalledTimes(2);
  });

  it('dovrebbe restituire tags e branches vuoti se git non ne trova', async () => {
    (existsSync as jest.Mock).mockReturnValue(false);
    (execSync as jest.Mock).mockReturnValue(Buffer.from(''));
    (readFileSync as jest.Mock).mockReturnValue(Buffer.from('finto-file-zip'));

    const result = await handler(mockEvent);

    expect(result.repoMetadata.hasChangelog).toBe(false);
    expect(result.repoMetadata.tags).toEqual([]);
    expect(result.repoMetadata.branches).toEqual([]);
  });

  it('dovrebbe parsare correttamente tags e branches multipli', async () => {
    (existsSync as jest.Mock).mockReturnValue(false);
    (execSync as jest.Mock)
      .mockReturnValueOnce(Buffer.from(''))
      .mockReturnValueOnce(Buffer.from(''))
      .mockReturnValueOnce(Buffer.from('v1.0.0\nv1.1.0\nv2.0.0'))
      .mockReturnValueOnce(Buffer.from('  origin/main\n  origin/develop'))
      .mockReturnValueOnce(Buffer.from('')); // tar
    (readFileSync as jest.Mock).mockReturnValue(Buffer.from('finto-file-zip'));

    const result = await handler(mockEvent);

    expect(result.repoMetadata.tags).toEqual(['v1.0.0', 'v1.1.0', 'v2.0.0']);
    expect(result.repoMetadata.branches).toEqual([
      'origin/main',
      'origin/develop',
    ]);
  });
});
