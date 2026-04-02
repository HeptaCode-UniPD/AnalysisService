import { S3Client, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { invokeSubAgent, extractFirstMeaningfulLine } from './utils/agent-invoker';
import { Readable } from 'stream';

// Mock delle dipendenze esterne
jest.mock('@aws-sdk/client-s3');
jest.mock('./utils/agent-invoker');

describe('OrchestratorHandler', () => {
  let orchestratorHandler: any;
  const mockS3Send = jest.fn();

  beforeEach(() => {
    mockS3Send.mockReset();
    (S3Client as jest.Mock).mockImplementation(() => ({
      send: mockS3Send,
    }));

    // Re-import dell'handler per ogni test per assicurarci che usi il mock aggiornato
    jest.isolateModules(() => {
      orchestratorHandler = require('./orchestrator-lambda').orchestratorHandler;
    });

    (invokeSubAgent as jest.Mock).mockResolvedValue('Mocked Agent Report Content');
    (extractFirstMeaningfulLine as jest.Mock).mockReturnValue('Mocked Summary');
    // Preveniamo errori dovuti a variabili d'ambiente mancanti nel polisher
    process.env.MASTER_LEAD_AGENT_ID = 'POLISHER_AGENT';
  });

  /**
   * Helper per simulare lo stream di risposta S3
   */
  const createMockStream = (content: string): Readable => {
    const s = new Readable();
    s.push(content);
    s.push(null);
    return s;
  };

  describe('Azioni Generali', () => {
    it('dovrebbe gestire azioni non riconosciute loggando un errore', async () => {
      const result = await orchestratorHandler({ action: 'NOT_EXIST', payload: { jobId: '123' } });
      expect(result.analysisDetails).toEqual([]);
      expect(result.jobId).toBe('123');
    });

    it('dovrebbe gestire un crash globale restituendo un array vuoto', async () => {
      // Forziamo un errore (es. payload null in AGGREGATE)
      const result = await orchestratorHandler({ action: 'AGGREGATE', payload: null });
      expect(result.analysisDetails).toEqual([]);
      expect(result.jobId).toBe('unknown');
    });
  });

  describe('Fase 1: PIANIFICAZIONE (PLAN)', () => {
    it('dovrebbe attivare runDocs se ci sono tag di release', async () => {
      const event = {
        action: 'PLAN',
        payload: { repoMetadata: { tags: ['v1.0.0'], hasChangelog: false } }
      };

      const result = await orchestratorHandler(event);
      expect(result).toEqual({
        runOwasp: true,
        runTest: true,
        runDocs: true
      });
    });

    it('dovrebbe attivare runDocs se è presente un changelog', async () => {
      const event = {
        action: 'PLAN',
        payload: { repoMetadata: { tags: [], hasChangelog: true } }
      };

      const result = await orchestratorHandler(event);
      expect(result.runDocs).toBe(true);
    });

    it('non dovrebbe attivare runDocs se mancano segnali (no tags, no changelog)', async () => {
      const event = {
        action: 'PLAN',
        payload: { repoMetadata: { tags: [], hasChangelog: false } }
      };

      const result = await orchestratorHandler(event);
      expect(result.runDocs).toBe(false);
    });

    it('dovrebbe attivare runDocs di default se i metadati mancano', async () => {
      const event = { action: 'PLAN', payload: {} }; // no repoMetadata
      const result = await orchestratorHandler(event);
      expect(result.runDocs).toBe(true);
    });
  });

  describe('Fase 2 & 3: AGGREGAZIONE e POLISHING', () => {
    const mockAggregateEvent = {
      action: 'AGGREGATE',
      payload: {
        jobId: 'job-agg-123',
        s3Bucket: 'my-bucket',
        reports: [
          { agent: 'owasp', status: 'success', reportKey: 'reports/owasp.json' },
          { agent: 'test', status: 'success', reportKey: 'reports/test.json' }
        ]
      }
    };

    it('dovrebbe recuperare report, aggregarli per area e raffinarli tramite AI', async () => {
      const owaspContent = JSON.stringify({
        area: 'OWASP_SCAN',
        summary: 'Vulnerabilità trovate',
        report: '## Report OWASP dettagliato'
      });
      const testContent = JSON.stringify({
        area: 'TEST_PLAN',
        summary: 'Copertura test',
        report: '## Report TEST dettagliato'
      });

      // Setup sequenza chiamate S3 (Get -> Delete -> Get -> Delete)
      mockS3Send
        .mockResolvedValueOnce({ Body: createMockStream(owaspContent) }) // Get OWASP
        .mockResolvedValueOnce({}) // Delete OWASP
        .mockResolvedValueOnce({ Body: createMockStream(testContent) }) // Get TEST
        .mockResolvedValueOnce({}); // Delete TEST

      (invokeSubAgent as jest.Mock).mockResolvedValue('POLISHED_MARKDOWN_CONTENT');

      const result = await orchestratorHandler(mockAggregateEvent);

      expect(result.jobId).toBe('job-agg-123');
      expect(result.analysisDetails).toHaveLength(2);
      
      // Verifica mapping aree
      expect(result.analysisDetails[0].agentName).toBe('OWASP');
      expect(result.analysisDetails[1].agentName).toBe('TEST');
      
      // Verifica invocazione polisher
      expect(invokeSubAgent).toHaveBeenCalledTimes(2);
      expect(mockS3Send).toHaveBeenCalledWith(expect.any(GetObjectCommand));
      expect(mockS3Send).toHaveBeenCalledWith(expect.any(DeleteObjectCommand));
    });

    it('dovrebbe gestire correttamente report con JSON non valido', async () => {
      mockS3Send.mockResolvedValueOnce({ Body: createMockStream('INVALID_JSON') });
      mockS3Send.mockResolvedValueOnce({}); // Delete

      const event = {
        action: 'AGGREGATE',
        payload: {
          jobId: 'job-bad-json',
          s3Bucket: 'b',
          reports: [{ agent: 'docs', status: 'success', reportKey: 'k' }]
        }
      };

      const result = await orchestratorHandler(event);
      expect(result.analysisDetails).toHaveLength(0);
    });

    it('dovrebbe saltare un report se il download da S3 fallisce', async () => {
      mockS3Send.mockRejectedValueOnce(new Error('S3 Access Denied'));
      
      const result = await orchestratorHandler(mockAggregateEvent);
      // Entrambi falliscono perché mockRejectedValueOnce qui si applica a tutto se non resettato, 
      // ma il punto è che analysisDetails deve essere vuoto
      expect(result.analysisDetails).toEqual([]);
    });

    it('dovrebbe aggregare summary e report della stessa area', async () => {
      const chunk1 = JSON.stringify({ area: 'DOCS', summary: 'S1', report: 'R1' });
      const chunk2 = JSON.stringify({ area: 'DOCS', summary: 'S1', report: 'R2' }); // S1 duplicato
      
      mockS3Send
        .mockResolvedValueOnce({ Body: createMockStream(chunk1) })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ Body: createMockStream(chunk2) })
        .mockResolvedValueOnce({});

      // Disabilitiamo il polisher per questo test specifico
      process.env.MASTER_LEAD_AGENT_ID = 'UNSET';
      let localOrchestrator: any;
      jest.isolateModules(() => {
        localOrchestrator = require('./orchestrator-lambda').orchestratorHandler;
      });

      const event = {
        action: 'AGGREGATE',
        payload: {
          jobId: 'job-multi',
          s3Bucket: 'b',
          reports: [
            { agent: 'docs', status: 'success', reportKey: 'k1' },
            { agent: 'docs', status: 'success', reportKey: 'k2' }
          ]
        }
      };

      const result = await localOrchestrator(event);
      expect(result.analysisDetails[0].report).toContain('R1\n\nR2');
      // extractFirstMeaningfulLine viene chiamato sul report unito e ritorna il mock
      expect(result.analysisDetails[0].summary).toBe('Mocked Summary'); 
    });

    it('dovrebbe gestire aree non standard e inizializzare correttamente la mappa', async () => {
      const customReport = JSON.stringify({ area: 'CUSTOM_SECURITY', summary: 'C1', report: 'RC1' });
      mockS3Send
        .mockResolvedValueOnce({ Body: createMockStream(customReport) })
        .mockResolvedValueOnce({});

      const event = {
        action: 'AGGREGATE',
        payload: {
          jobId: 'job-custom',
          s3Bucket: 'b',
          reports: [{ agent: 'custom-agent', status: 'success', reportKey: 'k' }]
        }
      };

      const result = await orchestratorHandler(event);
      expect(result.analysisDetails[0].agentName).toBe('CUSTOM_SECURITY');
    });

    it('dovrebbe utilizzare data.summary se extractFirstMeaningfulLine non trova nulla', async () => {
      (extractFirstMeaningfulLine as jest.Mock).mockReturnValueOnce(null);
      mockS3Send
        .mockResolvedValueOnce({ Body: createMockStream(JSON.stringify({ area: 'OWASP', summary: 'FALLBACK_S', report: 'R' })) })
        .mockResolvedValueOnce({});
      
      process.env.MASTER_LEAD_AGENT_ID = 'UNSET';
      let localOrchestrator: any;
      jest.isolateModules(() => {
        localOrchestrator = require('./orchestrator-lambda').orchestratorHandler;
      });

      const result = await localOrchestrator(mockAggregateEvent);
      expect(result.analysisDetails[0].summary).toBe('FALLBACK_S');
    });

    it('dovrebbe usare "unknown" come jobId se l\'azione è errata e il payload è vuoto', async () => {
      const result = await orchestratorHandler({ action: 'WRONG', payload: {} });
      expect(result.jobId).toBe('unknown');
    });

    it('dovrebbe gestire errori nel polishing mantenendo il report originale', async () => {
      mockS3Send.mockResolvedValueOnce({ Body: createMockStream(JSON.stringify({ area: 'OWASP', report: 'ORIGINAL' })) });
      mockS3Send.mockResolvedValueOnce({});
      
      process.env.MASTER_LEAD_AGENT_ID = 'POLISHER';
      (invokeSubAgent as jest.Mock).mockRejectedValueOnce(new Error('AI Crash'));

      const event = {
        action: 'AGGREGATE',
        payload: {
          jobId: 'polishing-fail',
          s3Bucket: 'b',
          reports: [{ agent: 'owasp', status: 'success', reportKey: 'k' }]
        }
      };

      const result = await orchestratorHandler(event);
      expect(result.analysisDetails[0].report).toBe('ORIGINAL');
    });
  });
});
