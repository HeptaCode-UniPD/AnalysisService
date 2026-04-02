import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from './app.module';
import { AppController } from './wrapper/app.controller';
import { AppService } from './wrapper/app.service';

// Mock del client AWS Step Functions inizializzato staticamente nell'adapter
jest.mock('@aws-sdk/client-sfn', () => ({
  SFNClient: jest.fn().mockImplementation(() => ({
    send: jest.fn(),
  })),
  StartExecutionCommand: jest.fn(),
}));

describe('AppModule', () => {
  let testingModule: TestingModule;

  beforeEach(async () => {
    testingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
  });

  it('dovrebbe riuscire a compilare il modulo correttamente', () => {
    expect(testingModule).toBeDefined();
  });

  it('dovrebbe registrare ed esporre AppController', () => {
    const controller = testingModule.get<AppController>(AppController);
    expect(controller).toBeDefined();
  });

  it('dovrebbe registrare ed esporre AppService', () => {
    const service = testingModule.get<AppService>(AppService);
    expect(service).toBeDefined();
  });
});
