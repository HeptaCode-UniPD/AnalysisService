import { NestFactory } from '@nestjs/core';

// Mocking NestFactory prima di importare main.ts per prevenire l'avvio reale del server
jest.mock('@nestjs/core', () => ({
  NestFactory: {
    create: jest.fn(),
  },
}));

describe('Main Bootstrap (Development Entry Point)', () => {
  let mockApp: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockApp = {
      useGlobalPipes: jest.fn(),
      listen: jest.fn().mockResolvedValue(true),
      getUrl: jest.fn().mockResolvedValue('http://localhost:3000'),
    };
    (NestFactory.create as jest.Mock).mockResolvedValue(mockApp);
  });

  it('dovrebbe inizializzare NestJS, configurare i Pipe e avviare il listen sulla porta 3000', async () => {
    // Spia per silenziare i log di bootstrap durante i test
    const spyLog = jest.spyOn(console, 'log').mockImplementation(() => {});

    // Il caricamento del modulo main.ts esegue automaticamente la funzione bootstrap() alla fine del file
    // Usiamo isolateModules per garantire che venga eseguito ex-novo in questo test
    // Carica il modulo main.ts, triggers bootstrap();
    await jest.isolateModules(() => {
      require('./main');
    });

    // Attendiamo che la funzione asincrona bootstrap() completi (importante per app.getUrl() e console.log)
    await new Promise(resolve => setTimeout(resolve, 100));

    // Verifiche
    expect(NestFactory.create).toHaveBeenCalled();
    expect(mockApp.useGlobalPipes).toHaveBeenCalled();
    expect(mockApp.listen).toHaveBeenCalledWith(3000);
    expect(spyLog).toHaveBeenCalledWith(expect.stringContaining('Applicazione in ascolto su: http://localhost:3000'));

    // Pulizia
    spyLog.mockRestore();
  });
});
