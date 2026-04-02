// 1. Definiamo i mock che devono essere accessibili dentro i jest.mock (devono iniziare con 'mock')
const mockS3Send = jest.fn();

// 2. Mock delle dipendenze esterne
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({
    send: mockS3Send,
  })),
  PutObjectCommand: jest.fn(),
}));

jest.mock('fs', () => ({
  rmSync: jest.fn(),
  existsSync: jest.fn(),
}));

jest.mock('./tools/decompressione-zip.tool', () => ({
  unzipRepoToTemp: jest.fn(),
}));

jest.mock('./utils/smart-bundler', () => ({
  createFullChunks: jest.fn(),
}));

jest.mock('./utils/agent-invoker', () => ({
  invokeSubAgent: jest.fn(),
  extractFirstMeaningfulLine: jest.fn(),
}));

// Importiamo solo i tipi o i mock per le asserzioni (senza caricare i file reali se possibile)
// In Jest, quando un modulo è mockato, gli import restituiscono i mock.
import { unzipRepoToTemp } from './tools/decompressione-zip.tool';
import { createFullChunks } from './utils/smart-bundler';
import { invokeSubAgent, extractFirstMeaningfulLine } from './utils/agent-invoker';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { rmSync, existsSync } from 'fs';

// 2. Caricamento dell'handler
const { docAgentHandler } = require('./docs-agent-lambda');

describe('DocAgentHandler', () => {
  const mockEvent = {
    s3Bucket: 'test-bucket',
    s3Key: 'analysis/source.zip',
    s3Prefix: 'results/job-123',
  };

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup mock S3 Client
    (S3Client as jest.Mock).mockImplementation(() => ({
      send: mockS3Send,
    }));

    // Setup utility mocks
    (unzipRepoToTemp as jest.Mock).mockResolvedValue('/tmp/extracted-repo');
    (createFullChunks as jest.Mock).mockResolvedValue(['Chunk 1 content', 'Chunk 2 content']);
    (invokeSubAgent as jest.Mock).mockResolvedValue('Mocked Agent Report Content');
    (extractFirstMeaningfulLine as jest.Mock).mockReturnValue('Mocked Summary Line');

    // Setup FS mocks
    (existsSync as jest.Mock).mockReturnValue(true);
  });

  it('dovrebbe eseguire correttamente l\'analisi multi-agente e salvare il report', async () => {
    mockS3Send.mockResolvedValue({ $metadata: { httpStatusCode: 200 } });

    const result = await docAgentHandler(mockEvent);

    // Verifiche flusso principale
    expect(unzipRepoToTemp).toHaveBeenCalledWith('test-bucket', 'analysis/source.zip');
    expect(createFullChunks).toHaveBeenCalledWith('/tmp/extracted-repo');

    /**
     * Calcolo chiamate invokeSubAgent:
     * - 2 Tech Reviewers (uno per chunk)
     * - 2 Gov Reviewers (uno per chunk)
     * - 1 Lead Aggregator (finale)
     * Totale: 5 invocazioni
     */
    expect(invokeSubAgent).toHaveBeenCalledTimes(5);

    // Verifiche S3
    expect(mockS3Send).toHaveBeenCalled();
    const s3Call = mockS3Send.mock.calls[0][0];
    expect(s3Call).toBeDefined();

    // Verifiche cleanup
    expect(rmSync).toHaveBeenCalledWith('/tmp/extracted-repo', expect.objectContaining({ recursive: true }));

    expect(result).toEqual({
      agent: 'docs',
      status: 'success',
      reportKey: 'results/job-123/docs-report.json',
    });
  });

  it('dovrebbe gestire errori di validazione dell\'evento tramite Zod', async () => {
    const invalidEvent = { s3Bucket: 'missing-other-fields' };

    const result = await docAgentHandler(invalidEvent);

    expect(result.status).toBe('error');
    expect(result.error).toContain('invalid_type'); // Zod v3+ usa questo
    expect(unzipRepoToTemp).not.toHaveBeenCalled();
  });

  it('dovrebbe catturare eccezioni durante l\'esecuzione e pulire le risorse', async () => {
    // Simuliamo un errore durante il bundling
    (createFullChunks as jest.Mock).mockRejectedValue(new Error('Bundling failed'));

    const result = await docAgentHandler(mockEvent);

    expect(result.status).toBe('error');
    expect(result.error).toBe('Bundling failed');

    // Verifica che il cleanup sia comunque avvenuto
    expect(rmSync).toHaveBeenCalled();
  });

  it('dovrebbe gestire casi in cui extractPath non è definito (fallimento unzip)', async () => {
    (unzipRepoToTemp as jest.Mock).mockRejectedValue(new Error('Unzip failed'));

    const result = await docAgentHandler(mockEvent);

    expect(result.status).toBe('error');
    expect(rmSync).not.toHaveBeenCalled(); // Nulla da pulire
  });

  it('dovrebbe utilizzare un summary di fallback se extractFirstMeaningfulLine ritorna null', async () => {
    (extractFirstMeaningfulLine as jest.Mock).mockReturnValue(null);
    mockS3Send.mockResolvedValue({});

    await docAgentHandler(mockEvent);

    expect(mockS3Send).toHaveBeenCalled();
    const s3Call = mockS3Send.mock.calls[0][0];
    // Se PutObjectCommand è mockato come costruttore, s3Call è il risultato del mock
  });
});
