import { Controller, Post, Body, HttpCode, UseGuards } from '@nestjs/common';
import { AppService } from './app.service';
import { AnalysisRequestDto } from '../common/dto/analysis-request.dto';
import { AnalysisResponseDto } from '../common/dto/analysis-response.dto';
import { ApiKeyGuard } from '../common/guards/api-key.guards';
import { 
  ApiTags, 
  ApiOperation, 
  ApiResponse, 
  ApiSecurity,
  ApiBody, 
  ApiExtraModels
} from '@nestjs/swagger';
import { AnalysisWebhookPayloadDto } from '../common/dto/analysis-webhook-payload.dto';

@ApiTags('Pipeline Analysis')
@ApiSecurity('x-api-key')
@ApiExtraModels(AnalysisWebhookPayloadDto)
@Controller()
@UseGuards(ApiKeyGuard)
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Post('analyze')
  @HttpCode(200)
  @ApiOperation({ 
    summary: 'Avvia l\'analisi asincrona di un repository',
    description: `
      Questa operazione avvia una pipeline di analisi asincrona.
      - **Input**: URL di un repository pubblico.
      - **Processo**: Esegue Pull Repo -> Bundling -> Analisi AI (Docs, OWASP, Test).
      - **Output Immediato**: Conferma dell'accodamento con un jobId.
      - **Output Finale (Webhook)**: Una volta completata (fino a 15 min), il sistema invierà una notifica POST all'URL di Webhook pre-configurato.
      
      Il payload inviato al Webhook seguirà lo schema 'AnalysisWebhookPayloadDto'.
    `
  })
  @ApiBody({ type: AnalysisRequestDto })
  @ApiResponse({ 
    status: 200, 
    description: 'Richiesta accettata. L\'analisi è stata accodata con successo.',
    type: AnalysisResponseDto
  })
  @ApiResponse({ status: 401, description: 'API Key mancante o non valida.' })
  @ApiResponse({ status: 400, description: 'Richiesta non valida. Parametri mancanti o URL non corretto.' })
  @ApiResponse({ status: 500, description: 'Errore interno del server durante l\'avvio della pipeline.' })
  async startAnalysis(@Body() payload: AnalysisRequestDto): Promise<AnalysisResponseDto> {
    const { executionArn, jobId } = await this.appService.triggerAnalysis(payload);

    return {
      message: 'Analisi avviata con successo',
      jobId,
      executionArn,
    };
  }
}
