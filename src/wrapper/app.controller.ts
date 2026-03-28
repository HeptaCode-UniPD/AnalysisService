import { Controller, Post, Body, HttpCode, Inject } from '@nestjs/common';
import { AppService } from './app.service';
import { AnalysisRequestDto } from '../common/dto/analysis-request.dto';

@Controller()
export class AppController {
  constructor(@Inject(AppService) private readonly appService: AppService) {}

  @Post('analyze') // Risponderà a POST /analyze
  @HttpCode(200) // Rispondiamo subito con 200 OK
  async startAnalysis(@Body() payload: AnalysisRequestDto) {
    // 1. Deleghiamo la logica di business al Service
    const executionArn = await this.appService.triggerAnalysis(payload);

    // 2. Rispondiamo a MS1 dicendo "Ho preso in carico la richiesta"
    return {
      message: 'Analisi avviata con successo',
      jobId: payload.jobId,
      executionArn: executionArn,
    };
  }
}
