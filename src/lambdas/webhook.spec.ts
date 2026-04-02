describe('WebhookHandler', () => {
  let webhookHandler: any;
  const mockReport = { jobId: 'job-webhook-123', status: 'completed', details: [] };

  beforeEach(() => {
    jest.resetModules();
    process.env.DESTINATION_API_KEY = 'EXTERNAL_SECURE_KEY';
    process.env.DESTINATION_URL = 'https://api.external.com/webhook';
    
    // Mock di global.fetch
    global.fetch = jest.fn();
    
    webhookHandler = require('./webhook').handler;
  });

  afterEach(() => {
    // Pulizia delle variabili d'ambiente per evitare side effects
    delete process.env.DESTINATION_API_KEY;
    delete process.env.DESTINATION_URL;
  });

  it('dovrebbe inviare il webhook con successo', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
    });

    const mockEvent = { 
      report: mockReport, 
      repoUrl: 'https://github.com/user/repo' 
    };
    
    const result = await webhookHandler(mockEvent);

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.external.com/webhook',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'EXTERNAL_SECURE_KEY',
        },
        body: JSON.stringify({
          ...mockReport,
          repoUrl: 'https://github.com/user/repo'
        }),
      })
    );
    expect(result).toEqual({ success: true });
  });

  it('dovrebbe lanciare errore se la configurazione API_KEY è mancante', async () => {
    delete process.env.DESTINATION_API_KEY;
    await expect(webhookHandler({ report: mockReport })).rejects.toThrow('Configurazione mancante');
  });

  it('dovrebbe lanciare errore se la configurazione URL è mancante', async () => {
    delete process.env.DESTINATION_URL;
    await expect(webhookHandler({ report: mockReport })).rejects.toThrow('Configurazione mancante');
  });

  it('dovrebbe gestire risposte HTTP non riuscite (e.g. 500)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    await expect(webhookHandler({ report: mockReport })).rejects.toThrow('Errore HTTP: 500');
  });

  it('dovrebbe catturare errori di rete o DNS', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error('DNS Lookup Failed'));

    await expect(webhookHandler({ report: mockReport })).rejects.toThrow('Impossibile inviare il webhook: DNS Lookup Failed');
  });
});
