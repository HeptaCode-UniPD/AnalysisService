// 1. Definiamo i mock (devono iniziare con 'mock')
const mockS3Send = jest.fn();

// 2. Mock delle dipendenze esterne
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({
    send: mockS3Send,
  })),
  PutObjectCommand: jest.fn().mockImplementation((input: any) => ({ input })),
}));

jest.mock('fs', () => ({
  rmSync: jest.fn(),
  existsSync: jest.fn(),
}));

jest.mock('./tools/decompressione-zip.tool', () => ({
  unzipRepoToTemp: jest.fn(),
}));

jest.mock('./utils/smart-bundler', () => ({
  createSourceChunks: jest.fn(),
}));

jest.mock('./utils/agent-invoker', () => ({
  invokeSubAgent: jest.fn(),
  extractFirstMeaningfulLine: jest.fn(),
}));

import { unzipRepoToTemp } from './tools/decompressione-zip.tool';
import { createSourceChunks } from './utils/smart-bundler';
import { invokeSubAgent, extractFirstMeaningfulLine } from './utils/agent-invoker';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { existsSync, rmSync } from 'fs';

describe('TestAgentHandler', () => {
  let testAgentHandler: any;
  const mockEvent = {
    s3Bucket: 'test-qa-bucket',
    s3Key: 'repo.zip',
    s3Prefix: 'results/test-scan-001',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockS3Send.mockReset();
    
    // Isolamento modulo per catturare i mock e le variabili d'ambiente
    jest.isolateModules(() => {
      testAgentHandler = require('./test-agent-lambda').testAgentHandler;
    });

    // Setup implementazioni mock
    (unzipRepoToTemp as jest.Mock).mockResolvedValue('/tmp/test-agent-dir');
    // Simuliamo che il primo chunk contenga il README (ora incluso nel bunder)
    (createSourceChunks as jest.Mock).mockResolvedValue(['# README.md\nProject Context\nCHUNK1', 'CHUNK2']);
    (invokeSubAgent as jest.Mock).mockResolvedValue('## Quality Report Content');
    (extractFirstMeaningfulLine as jest.Mock).mockReturnValue('Summary of Code Quality');
    
    (existsSync as jest.Mock).mockReturnValue(true);
  });

  it('dovrebbe eseguire l\'analisi completa QA/Quality e fornire contesto all\'Architect', async () => {
    mockS3Send.mockResolvedValue({ $metadata: { httpStatusCode: 200 } });

    const result = await testAgentHandler(mockEvent);

    expect(unzipRepoToTemp).toHaveBeenCalledWith('test-qa-bucket', 'repo.zip');
    
    // 6 invocazioni (2 QA + 1 Architect + 2 Audit + 1 Lead)
    expect(invokeSubAgent).toHaveBeenCalledTimes(6);
    
    // Verifica che l'Architect (Test Architect) abbia ricevuto il primo chunk (con README)
    // Il nome passato a invokeSpec è 'TEST_ARCHITECT'
    const archCall = (invokeSubAgent as jest.Mock).mock.calls.find(c => c[3] === 'TEST_ARCHITECT');
    expect(archCall[2]).toContain('# README.md');
    
    expect(mockS3Send).toHaveBeenCalled();
    const s3Call = mockS3Send.mock.calls[0][0] as any;
    expect(JSON.parse(s3Call.input.Body)).toMatchObject({ area: 'TEST' });

    expect(rmSync).toHaveBeenCalledWith('/tmp/test-agent-dir', expect.objectContaining({ recursive: true }));
    expect(result.status).toBe('success');
  });

  it('dovrebbe gestire errori di schema evento (Zod)', async () => {
    const result = await testAgentHandler({ bad: 'input' });
    expect(result.status).toBe('error');
    expect(result.error).toContain('invalid_type');
  });

  it('dovrebbe gestire crash degli agenti Bedrock e assicurare il cleanup', async () => {
    (invokeSubAgent as jest.Mock).mockRejectedValue(new Error('AI Unresponsive'));
    const result = await testAgentHandler(mockEvent);
    expect(result.status).toBe('error');
    expect(rmSync).toHaveBeenCalled();
  });

  it('dovrebbe utilizzare un summary di fallback se l\'AI non produce header validi', async () => {
    (extractFirstMeaningfulLine as jest.Mock).mockReturnValue(null);
    mockS3Send.mockResolvedValue({});
    await testAgentHandler(mockEvent);
    const s3Call = mockS3Send.mock.calls[0][0] as any;
    expect(JSON.parse(s3Call.input.Body).summary).toBe('Analisi TEST completata.');
  });
});
