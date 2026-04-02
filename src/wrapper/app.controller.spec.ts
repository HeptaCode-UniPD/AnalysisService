import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AnalysisRequestDto } from '../common/dto/analysis-request.dto';

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
            triggerAnalysis: jest.fn().mockResolvedValue({
              executionArn: 'arn:simulato',
              jobId: 'job-123',
            }),
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

  it('dovrebbe chiamare il service e restituire la risposta corretta (startAnalysis)', async () => {
    // 1. Prepariamo un payload fittizio
    const mockPayload: AnalysisRequestDto = {
      repoUrl: 'https://github.com/owner/repo.git',
    } as AnalysisRequestDto;

    // 2. Chiamiamo il metodo del controller
    const result = await appController.startAnalysis(mockPayload);

    // 3. Verifichiamo che il service sia stato chiamato con il nostro payload
    expect(appService.triggerAnalysis).toHaveBeenCalledTimes(1);
    expect(appService.triggerAnalysis).toHaveBeenCalledWith(mockPayload);

    // 4. Verifichiamo che la risposta HTTP rispetti l'interfaccia prevista
    expect(result).toEqual({
      message: 'Analisi avviata con successo',
      jobId: 'job-123',
      executionArn: 'arn:simulato', // Deve corrispondere al mock nel beforeEach
    });
  });
});
