import { handler } from './failure-handler';

describe('FailureHandler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    // Mock di fetch globale (disponibile in Node 18+)
    global.fetch = jest.fn() as jest.Mock;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('dovrebbe inviare correttamente la notifica di fallimento al webhook', async () => {
    process.env.DESTINATION_URL = 'https://webhook.com/fail';
    process.env.DESTINATION_API_KEY = 'fail-key-123';
    
    (global.fetch as jest.Mock).mockResolvedValue({
      status: 200,
      ok: true
    });

    const mockEvent = {
      jobId: 'job-failed-001',
      errorInfo: {
        Error: 'States.TaskFailed',
        Cause: 'Access Denied on S3'
      }
    };

    await handler(mockEvent);

    expect(global.fetch).toHaveBeenCalledWith(
      'https://webhook.com/fail',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'fail-key-123'
        },
        body: expect.stringContaining('"jobId":"job-failed-001"')
      })
    );
    
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.status).toBe('error');
    expect(body.errorType).toBe('States.TaskFailed');
    expect(body.message).toBe('Access Denied on S3');
  });

  it('dovrebbe essere compatibile con i campi error/cause minuscoli', async () => {
    process.env.DESTINATION_URL = 'https://webhook.com/fail';
    process.env.DESTINATION_API_KEY = 'fail-key-123';
    (global.fetch as jest.Mock).mockResolvedValue({ status: 200 });

    const mockEvent = {
      jobId: 'compat-001',
      errorInfo: {
        error: 'RuntimeError',
        cause: 'Out of memory'
      }
    };

    await handler(mockEvent);

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.errorType).toBe('RuntimeError');
    expect(body.message).toBe('Out of memory');
  });

  it('non dovrebbe inviare nulla se la configurazione URL/API_KEY è mancante', async () => {
    delete process.env.DESTINATION_URL;
    const mockEvent = { jobId: 'job-1' };

    await handler(mockEvent);

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('dovrebbe gestire un Cause fornito come oggetto complesso', async () => {
    process.env.DESTINATION_URL = 'https://webhook.com/fail';
    process.env.DESTINATION_API_KEY = 'key';
    (global.fetch as jest.Mock).mockResolvedValue({ status: 200 });

    const mockEvent = {
      jobId: 'obj-cause',
      errorInfo: {
        Cause: { internalCode: 500, detail: 'Critical failure' }
      }
    };

    await handler(mockEvent);

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.message).toBe('{"internalCode":500,"detail":"Critical failure"}');
  });

  it('dovrebbe gestire gli errori di rete durante la fetch senza propagare l\'eccezione', async () => {
    process.env.DESTINATION_URL = 'https://webhook.com/fail';
    process.env.DESTINATION_API_KEY = 'key';
    (global.fetch as jest.Mock).mockRejectedValue(new Error('DNS Failure'));

    const mockEvent = { jobId: 'network-fail' };

    // La Lambda non deve fallire (deve gestire l\'errore internamente)
    await expect(handler(mockEvent)).resolves.not.toThrow();
    expect(global.fetch).toHaveBeenCalled();
  });
});
