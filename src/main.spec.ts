import { NestFactory } from '@nestjs/core';
import * as fs from 'fs';

// Mocking NestFactory prima di importare main.ts per prevenire l'avvio reale del server
jest.mock('@nestjs/core', () => ({
  NestFactory: {
    create: jest.fn(),
  },
}));

// Mocking @nestjs/swagger per evitare dipendenze reali e crash dei decoratori
jest.mock('@nestjs/swagger', () => {
  const mockDecorator = () => jest.fn();
  return {
    SwaggerModule: {
      createDocument: jest.fn().mockReturnValue({ openapi: '3.0.0' }),
      setup: jest.fn(),
    },
    DocumentBuilder: jest.fn().mockImplementation(() => ({
      setTitle: jest.fn().mockReturnThis(),
      setDescription: jest.fn().mockReturnThis(),
      setVersion: jest.fn().mockReturnThis(),
      addApiKey: jest.fn().mockReturnThis(),
      build: jest.fn().mockReturnValue({}),
    })),
    ApiProperty: mockDecorator,
    ApiTags: mockDecorator,
    ApiOperation: mockDecorator,
    ApiResponse: mockDecorator,
    ApiSecurity: mockDecorator,
    ApiBody: mockDecorator,
  };
});

// Mock di fs per intercettare la scrittura del file swagger.json
jest.mock('fs', () => ({
  writeFileSync: jest.fn(),
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

  it('dovrebbe inizializzare NestJS, configurare Swagger e generare swagger.json', async () => {
    // Spia per silenziare i log di bootstrap durante i test
    const spyLog = jest.spyOn(console, 'log').mockImplementation(() => {});

    // Invochiamo bootstrap direttamente (grazie all'export in main.ts)
    const { bootstrap } = require('./main');
    await bootstrap();

    // Verifiche basiche NestJS
    expect(NestFactory.create).toHaveBeenCalled();
    expect(mockApp.useGlobalPipes).toHaveBeenCalled();
    expect(mockApp.listen).toHaveBeenCalledWith(3000);
    
    // Verifica Swagger
    const { SwaggerModule } = require('@nestjs/swagger');
    expect(SwaggerModule.createDocument).toHaveBeenCalled();
    expect(SwaggerModule.setup).toHaveBeenCalledWith('api/docs', mockApp, expect.any(Object));
    
    // Verifica scrittura file JSON
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('swagger.json'),
      expect.stringContaining('openapi')
    );

    // Pulizia
    spyLog.mockRestore();
  });
});
