import { NestFactory } from '@nestjs/core';
import { configure } from '@vendia/serverless-express';

// Mock di NestJS e dell'adattatore express
jest.mock('@nestjs/core', () => ({
  NestFactory: {
    create: jest.fn(),
  },
}));

jest.mock('@vendia/serverless-express', () => ({
  configure: jest.fn(),
}));

describe('LambdaHandler (Express Wrapper)', () => {
  let handlerModule: any;

  beforeEach(() => {
    jest.clearAllMocks();
    // Isoliamo il modulo in ogni test per resettare la variabile locale 'cachedServer'
    // Questo ci permette di testare sia il Cold Start che il Warm Start in modo indipendente.
    jest.isolateModules(() => {
      handlerModule = require('./handler');
    });
  });

  it('dovrebbe inizializzare NestJS e configurare il server al primo caricamento (Cold Start)', async () => {
    const mockApp = {
      useGlobalPipes: jest.fn(),
      init: jest.fn(),
      getHttpAdapter: jest.fn().mockReturnValue({
        getInstance: jest.fn().mockReturnValue({ express: true })
      })
    };
    (NestFactory.create as jest.Mock).mockResolvedValue(mockApp);
    
    // Il mock del server restituito da configure() deve essere a sua volta una funzione (il server express configurato)
    const mockServerFn = jest.fn().mockResolvedValue({ statusCode: 200, body: 'OK' });
    (configure as jest.Mock).mockReturnValue(mockServerFn);

    const event = { path: '/test' };
    const context = { functionName: 'testLambda' };

    const result = await handlerModule.startAnalysis(event, context, jest.fn());

    expect(NestFactory.create).toHaveBeenCalled();
    expect(mockApp.init).toHaveBeenCalled();
    expect(configure).toHaveBeenCalledWith({ app: { express: true } });
    expect(mockServerFn).toHaveBeenCalledWith(event, context, expect.any(Function));
    expect(result).toEqual({ statusCode: 200, body: 'OK' });
  });

  it('dovrebbe riutilizzare il server esistente nelle invocazioni successive (Warm Start)', async () => {
    const mockApp = {
      useGlobalPipes: jest.fn(),
      init: jest.fn(),
      getHttpAdapter: jest.fn().mockReturnValue({
        getInstance: jest.fn().mockReturnValue({})
      })
    };
    (NestFactory.create as jest.Mock).mockResolvedValue(mockApp);
    const mockServerFn = jest.fn();
    (configure as jest.Mock).mockReturnValue(mockServerFn);

    // Invocazione 1 (Cold)
    await handlerModule.startAnalysis({ id: 1 }, {}, jest.fn());
    // Invocazione 2 (Warm)
    await handlerModule.startAnalysis({ id: 2 }, {}, jest.fn());

    // NestFactory deve essere chiamato una sola volta
    expect(NestFactory.create).toHaveBeenCalledTimes(1);
    // Il server configurato deve essere chiamato due volte
    expect(mockServerFn).toHaveBeenCalledTimes(2);
  });
});
