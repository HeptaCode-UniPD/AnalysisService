import { Controller, Post, Body, HttpCode, UseGuards } from '@nestjs/common';
import { AppService } from './app.service';
import { AnalysisRequestDto } from '../common/dto/analysis-request.dto';
import { ApiKeyGuard } from '../common/guards/api-key.guards';

@Controller()
@UseGuards(ApiKeyGuard)
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Post('analyze')
  @HttpCode(200)
  async startAnalysis(@Body() payload: AnalysisRequestDto) {
    const { executionArn, jobId } = await this.appService.triggerAnalysis(payload);

    return {
      message: 'Analisi avviata con successo',
      jobId,
      executionArn,
    };
  }
}
