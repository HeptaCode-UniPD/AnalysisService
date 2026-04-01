import { handler } from './pull-repo';
import { execSync } from 'child_process';
import { rmSync, existsSync } from 'fs';
import AdmZip from 'adm-zip';

// 1. Diciamo a Jest di intercettare e simulare queste librerie
jest.mock('child_process');
jest.mock('fs');
jest.mock('adm-zip', () => {
  return jest.fn().mockImplementation(() => ({
    addLocalFolder: jest.fn(),
    toBuffer: jest.fn().mockReturnValue(Buffer.from('finto-file-zip')),
  }));
});
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
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.clearAllMocks(); // Ripulisce lo storico delle chiamate fittizie
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('dovrebbe eseguire git clone, comprimere con adm-zip e caricare su S3', async () => {
    // Configuriamo le risposte fittizie per il file system e i comandi di sistema
    (existsSync as jest.Mock).mockReturnValue(true); // Finge che il CHANGELOG esista
    (execSync as jest.Mock).mockReturnValue(Buffer.from('v1.0.0')); // Finge l'output di git tag

    // Eseguiamo l'handler
    const result = await handler(mockEvent);

    // 2. Verifichiamo che la Lambda abbia restituito il formato corretto per la Step Function
    expect(result.s3Bucket).toBe('test-bucket');
    expect(result.s3Key).toBe('repos/12345/abcdef123456/source.zip'); // Aggiornato a .zip
    expect(result.repoMetadata.hasChangelog).toBe(true);

    // 3. Verifichiamo che git clone sia stato lanciato
    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('git clone https://github.com/owner/repo.git'),
      expect.anything(),
    );

    // 4. Verifichiamo che adm-zip sia stato utilizzato
    expect(AdmZip).toHaveBeenCalled();

    // 5. Verifichiamo che la pulizia della cartella .git e di /tmp sia stata eseguita
    expect(rmSync).toHaveBeenCalledTimes(2);
  });

  it('dovrebbe gestire il fallimento di git checkout emettendo un warning', async () => {
    (existsSync as jest.Mock).mockReturnValue(true);

    // Forziamo SOLO il comando git checkout a fallire
    (execSync as jest.Mock).mockImplementation((cmd: string) => {
      if (cmd.includes('git checkout')) {
        throw new Error('Checkout failed');
      }
      return Buffer.from('');
    });

    await handler(mockEvent);

    // Verifichiamo che il warning sia stato emesso correttamente
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('ATTENZIONE: Checkout di abcdef123456 fallito'),
    );
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

    // 2. Verifichiamo che la Lambda catturi l'errore e lanci la nuova stringa personalizzata
    await expect(handler(mockEvent)).rejects.toThrow(
      'Impossibile scaricare o zippare la repository: Git repository not found',
    );

    // 3. Verifichiamo che il blocco 'finally' abbia comunque pulito la cartella /tmp
    expect(rmSync).toHaveBeenCalledTimes(1); // Chiamato 1 volta nel blocco finally
  });

  it('dovrebbe restituire tags e branches vuoti se git non ne trova', async () => {
    (existsSync as jest.Mock).mockReturnValue(false);
    (execSync as jest.Mock).mockReturnValue(Buffer.from(''));

    const result = await handler(mockEvent);

    expect(result.repoMetadata.hasChangelog).toBe(false);
    expect(result.repoMetadata.tags).toEqual([]);
    expect(result.repoMetadata.branches).toEqual([]);
  });

  it('dovrebbe parsare correttamente tags e branches multipli', async () => {
    (existsSync as jest.Mock).mockReturnValue(false);
    (execSync as jest.Mock)
      .mockReturnValueOnce(Buffer.from('')) // git clone
      .mockReturnValueOnce(Buffer.from('')) // git checkout
      .mockReturnValueOnce(Buffer.from('v1.0.0\nv1.1.0\nv2.0.0')) // git tag
      .mockReturnValueOnce(Buffer.from('  origin/main\n  origin/develop')); // git branch

    const result = await handler(mockEvent);

    expect(result.repoMetadata.tags).toEqual(['v1.0.0', 'v1.1.0', 'v2.0.0']);
    expect(result.repoMetadata.branches).toEqual([
      'origin/main',
      'origin/develop',
    ]);
  });
});
