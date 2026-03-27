import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './wrapper/app.controller';
import { AppService } from './wrapper/app.service';

describe('AppController', () => {
  let appController: AppController;
  let appService: AppService;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        // Facciamo il mock del Service per isolare il test
        {
          provide: AppService,
          useValue: {
            triggerAnalysis: jest.fn().mockResolvedValue('arn:simulato'),
          },
        },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
    appService = app.get<AppService>(AppService);
  });

  it('dovrebbe essere definito', () => {
    expect(appController).toBeDefined();
  });
});