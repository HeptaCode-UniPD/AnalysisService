// 1. Definiamo i mock
const mockBedrockSend = jest.fn();

// 2. Mock delle dipendenze esterne
jest.mock('@aws-sdk/client-bedrock-agent-runtime', () => ({
  BedrockAgentRuntimeClient: jest.fn().mockImplementation(() => ({
    send: mockBedrockSend,
  })),
  InvokeAgentCommand: jest.fn().mockImplementation((input: any) => ({ input })),
}));

jest.mock('timers/promises', () => ({
  setTimeout: jest.fn(() => Promise.resolve()),
}));

import { setTimeout } from 'timers/promises';
import { invokeSubAgent, extractFirstMeaningfulLine } from './agent-invoker';

describe('AgentInvoker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBedrockSend.mockReset();
    
    // Forziamo le variabili d'ambiente necessarie
    process.env.AWS_REGION = 'us-east-1';
  });

  /**
   * Helper per simulare lo stream Bedrock (Async Iterable)
   */
  async function* createMockStream(events: any[]) {
    for (const event of events) {
      yield event;
    }
  }

  describe('invokeSubAgent', () => {
    it('dovrebbe gestire una risposta testuale semplice (senza tool)', async () => {
      const mockResponse = {
        completion: createMockStream([
          { chunk: { bytes: new TextEncoder().encode('Risposta dell\'agente') } }
        ])
      };
      mockBedrockSend.mockResolvedValue(mockResponse);

      const result = await invokeSubAgent('agent-1', 'alias-1', 'prompt', 'TestAgent', false);
      
      expect(result).toBe('Risposta dell\'agente');
      expect(mockBedrockSend).toHaveBeenCalledTimes(1);
    });

    it('dovrebbe gestire ReturnControl per Function Invocation e negare l\'uso del tool', async () => {
      // Prima chiamata: Bedrock tenta di usare un tool
      const mockResponse1 = {
        completion: createMockStream([
          {
            returnControl: {
              invocationId: 'inv-seq-1',
              invocationInputs: [{
                functionInvocationInput: { 
                  actionGroup: 'security-tools',
                  function: 'list-users' 
                }
              }]
            }
          }
        ])
      };

      // Seconda chiamata: l'agente riceve il diniego e conclude
      const mockResponse2 = {
        completion: createMockStream([
          { chunk: { bytes: new TextEncoder().encode('Ok, non userò tool.') } }
        ])
      };

      mockBedrockSend
        .mockResolvedValueOnce(mockResponse1)
        .mockResolvedValueOnce(mockResponse2);

      const result = await invokeSubAgent('a', 'b', 'p', 'Agent', false);

      expect(result).toBe('Ok, non userò tool.');
      expect(mockBedrockSend).toHaveBeenCalledTimes(2);

      // Verifica che i risultati del controllo siano stati passati nella seconda chiamata
      const secondCall = mockBedrockSend.mock.calls[1][0];
      expect(secondCall.input.sessionState.returnControlInvocationResults[0].functionResult).toMatchObject({
        function: 'list-users',
        actionGroup: 'security-tools'
      });
    });

    it('dovrebbe gestire ReturnControl per API Invocation', async () => {
        const mockResponse1 = {
          completion: createMockStream([
            {
              returnControl: {
                invocationId: 'inv-api-1',
                invocationInputs: [{
                  apiInvocationInput: { 
                    actionGroup: 'external-api',
                    apiPath: '/get-data',
                    httpMethod: 'GET'
                  }
                }]
              }
            }
          ])
        };
        const mockResponse2 = {
          completion: createMockStream([{ chunk: { bytes: new TextEncoder().encode('Done') } }])
        };
  
        mockBedrockSend.mockResolvedValueOnce(mockResponse1).mockResolvedValueOnce(mockResponse2);
  
        await invokeSubAgent('a', 'b', 'p', 'Agent', false);
        
        const secondCall = mockBedrockSend.mock.calls[1][0];
        expect(secondCall.input.sessionState.returnControlInvocationResults[0].apiResult).toBeDefined();
        expect(secondCall.input.sessionState.returnControlInvocationResults[0].apiResult.httpStatusCode).toBe(403);
    });

    it('dovrebbe gestire errori di rete o dell\'API Bedrock', async () => {
      mockBedrockSend.mockRejectedValue(new Error('Bedrock Service Unavailable'));

      const result = await invokeSubAgent('a', 'b', 'p', 'Agent', false);
      expect(result).toContain('Errore analisi Agent');
      expect(result).toContain('Service Unavailable');
    });

    it('dovrebbe fermarsi al raggiungimento di MAX_LOOPS', async () => {
      // Simula un agente che continua a chiedere tool
      mockBedrockSend.mockImplementation(() => Promise.resolve({
        completion: createMockStream([{ returnControl: { invocationId: 'id', invocationInputs: [] } }])
      }));

      const result = await invokeSubAgent('a', 'b', 'p', 'Agent', false);
      expect(result).toContain('Analisi Agent incompleta');
      expect(result).toContain('massimo di iterazioni');
    });

    it('dovrebbe loggare un warning se completion è undefined', async () => {
        mockBedrockSend.mockResolvedValue({ completion: null });
        const result = await invokeSubAgent('a', 'b', 'p', 'Agent', false);
        expect(result).toBe('');
    });

    it('dovrebbe gestire completion definita ma vuota (senza chunk e senza returnControl)', async () => {
        mockBedrockSend.mockResolvedValue({ completion: createMockStream([]) });
        const result = await invokeSubAgent('a', 'b', 'p', 'Agent', false);
        expect(result).toBe('');
    });

    describe('Resilienza (Retry Logic)', () => {
      const throttlingError = Object.assign(new Error('Throttling'), { name: 'ThrottlingException' });
      const serverError = Object.assign(new Error('Service Unavailable'), { $metadata: { httpStatusCode: 503 } });

      it('dovrebbe riprovare l\'invocazione se riceve ThrottlingException e poi riuscire', async () => {
        const mockResponse = {
          completion: createMockStream([
            { chunk: { bytes: new TextEncoder().encode('Riuscito dopo retry') } }
          ])
        };

        mockBedrockSend
          .mockRejectedValueOnce(throttlingError)
          .mockResolvedValueOnce(mockResponse);

        const result = await invokeSubAgent('a', 'b', 'p', 'Agent', false);

        expect(result).toBe('Riuscito dopo retry');
        expect(mockBedrockSend).toHaveBeenCalledTimes(2);
        expect(setTimeout).toHaveBeenCalled();
      });

      it('dovrebbe riprovare fino al limite massimo (5 tentativi) e poi fallire', async () => {
        mockBedrockSend.mockRejectedValue(throttlingError);

        const result = await invokeSubAgent('a', 'b', 'p', 'Agent', false);

        // Bedrock invocato 5 volte prima di lanciare l'errore finale (nel loop di retry)
        // Nota: invokeSubAgent cattura l'errore finale e ritorna un messaggio amichevole
        expect(mockBedrockSend).toHaveBeenCalledTimes(5);
        expect(result).toContain('Errore analisi Agent');
      });

      it('dovrebbe riprovare anche con errore 503 (Service Unavailable)', async () => {
        const mockResponse = {
          completion: createMockStream([
            { chunk: { bytes: new TextEncoder().encode('OK') } }
          ])
        };

        mockBedrockSend
          .mockRejectedValueOnce(serverError)
          .mockResolvedValueOnce(mockResponse);

        const result = await invokeSubAgent('a', 'b', 'p', 'Agent', false);
        expect(result).toBe('OK');
        expect(mockBedrockSend).toHaveBeenCalledTimes(2);
      });

      it('non dovrebbe riprovare per errori non-throttling (es. 400 Bad Request)', async () => {
        const badRequest = Object.assign(new Error('Validation Exception'), { $metadata: { httpStatusCode: 400 } });
        mockBedrockSend.mockRejectedValue(badRequest);

        const result = await invokeSubAgent('a', 'b', 'p', 'Agent', false);
        expect(mockBedrockSend).toHaveBeenCalledTimes(1);
        expect(setTimeout).not.toHaveBeenCalled();
        expect(result).toContain('Validation Exception');
      });
    });
  });

  describe('extractFirstMeaningfulLine', () => {
    it('dovrebbe saltare header e separatori', () => {
        const report = '# Title\n---\n=== Header ===\nQuesta è la riga valida che stiamo cercando.';
        const result = extractFirstMeaningfulLine(report, /emoji/g);
        expect(result).toBe('Questa è la riga valida che stiamo cercando.');
    });

    it('dovrebbe pulire bold e emoji', () => {
        const report = '🚀 **Importante**: Rilevato rischio critico.';
        const result = extractFirstMeaningfulLine(report, /[🚀]/g);
        expect(result).toBe('Importante: Rilevato rischio critico.');
    });

    it('dovrebbe restituire stringa vuota se non trova righe valide', () => {
        expect(extractFirstMeaningfulLine('short', /e/g)).toBe('');
    });
  });
});
