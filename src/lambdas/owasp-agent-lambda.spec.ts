// 1. Definiamo i mock che devono essere accessibili dentro i factory (devono iniziare con 'mock')
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
  createManifestBundle: jest.fn(),
  createSourceChunks: jest.fn(),
  createFullChunks: jest.fn(),
  extractImportedLibraries: jest.fn(),
}));

jest.mock('./utils/agent-invoker', () => ({
  invokeSubAgent: jest.fn(),
  extractFirstMeaningfulLine: jest.fn(),
}));

import { unzipRepoToTemp } from './tools/decompressione-zip.tool';
import { 
  createManifestBundle, 
  createSourceChunks, 
  createFullChunks, 
  extractImportedLibraries 
} from './utils/smart-bundler';
import { invokeSubAgent, extractFirstMeaningfulLine } from './utils/agent-invoker';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { existsSync, rmSync } from 'fs';

describe('OwaspAgentHandler', () => {
  let owaspAgentHandler: any;
  const mockEvent = {
    s3Bucket: 'test-owasp-bucket',
    s3Key: 'repo-to-scan.zip',
    s3Prefix: 'reports/scan-001',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockS3Send.mockReset();
    
    // Isolamento modulo per catturare i mock e le variabili d'ambiente
    jest.isolateModules(() => {
      owaspAgentHandler = require('./owasp-agent-lambda').owaspAgentHandler;
    });

    // Reset implementations
    (unzipRepoToTemp as jest.Mock).mockResolvedValue('/tmp/owasp-work-dir');
    (createManifestBundle as jest.Mock).mockResolvedValue('Dep Manifests Content');
    (createSourceChunks as jest.Mock).mockResolvedValue(['Src Chunk 1', 'Src Chunk 2']);
    (createFullChunks as jest.Mock).mockResolvedValue(['Full Chunk 1']);
    (extractImportedLibraries as jest.Mock).mockReturnValue(['express', 'lodash']);
    (invokeSubAgent as jest.Mock).mockResolvedValue('Mocked Security Report Content');
    (extractFirstMeaningfulLine as jest.Mock).mockReturnValue('Mocked Security Summary');
    
    (existsSync as jest.Mock).mockReturnValue(true);
  });

  it('dovrebbe completare l\'analisi di sicurezza multi-agente con successo', async () => {
    mockS3Send.mockResolvedValue({ $metadata: { httpStatusCode: 200 } });

    const result = await owaspAgentHandler(mockEvent);

    // Verifiche flusso
    expect(unzipRepoToTemp).toHaveBeenCalledWith('test-owasp-bucket', 'repo-to-scan.zip');
    
    // 5 invocazioni (1 Dep + 1 Creds + 2 Core + 1 Lead)
    expect(invokeSubAgent).toHaveBeenCalledTimes(5);
    
    // Verifiche S3
    expect(mockS3Send).toHaveBeenCalled();

    // Verifiche cleanup
    expect(rmSync).toHaveBeenCalledWith('/tmp/owasp-work-dir', expect.objectContaining({ recursive: true }));

    expect(result).toEqual({
      agent: 'owasp',
      status: 'success',
      reportKey: 'reports/scan-001/owasp-report.json',
    });
  });

  it('dovrebbe gestire errori di schema evento (Zod)', async () => {
    const result = await owaspAgentHandler({ missing: 'fields' });

    expect(result.status).toBe('error');
    expect(result.error).toContain('invalid_type');
    expect(unzipRepoToTemp).not.toHaveBeenCalled();
  });

  it('dovrebbe catturare errori in fase di bundling e pulire il disco', async () => {
    (createSourceChunks as jest.Mock).mockRejectedValue(new Error('Bundling failed'));

    const result = await owaspAgentHandler(mockEvent);

    expect(result.status).toBe('error');
    expect(result.error).toBe('Bundling failed');
    expect(rmSync).toHaveBeenCalled();
  });

  it('dovrebbe gestire crash di Bedrock e pulire sempre la cartella temporanea', async () => {
    (invokeSubAgent as jest.Mock).mockRejectedValue(new Error('Bedrock Timeout'));

    const result = await owaspAgentHandler(mockEvent);

    expect(result.status).toBe('error');
    expect(result.error).toBe('Bedrock Timeout');
    expect(rmSync).toHaveBeenCalled();
  });

  it('dovrebbe gestire casi in cui extractPath non è definito', async () => {
    (unzipRepoToTemp as jest.Mock).mockRejectedValue(new Error('Unzip crash'));

    const result = await owaspAgentHandler(mockEvent);

    expect(result.status).toBe('error');
    // Non dovrebbe chiamare rmSync se extractPath è rimasto undefined
    expect(rmSync).not.toHaveBeenCalled();
  });

  it('dovrebbe utilizzare un summary di fallback se extractFirstMeaningfulLine fallisce', async () => {
    (extractFirstMeaningfulLine as jest.Mock).mockReturnValue(null);
    mockS3Send.mockResolvedValue({});

    const result = await owaspAgentHandler(mockEvent);

    expect(result.status).toBe('success');
    expect(mockS3Send).toHaveBeenCalled();
  });
});
