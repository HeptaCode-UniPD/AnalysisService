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
  ApiBody 
} from '@nestjs/swagger';

@ApiTags('Pipeline Analysis')
@ApiSecurity('x-api-key')
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
      - **Output Finale**: Una volta completata (fino a 15 min), il sistema invierà una notifica POST all'URL di Webhook pre-configurato con il report Markdown finale.
    `
  })
  @ApiBody({ type: AnalysisRequestDto })
  @ApiResponse({ 
    status: 200, 
    description: 'Richiesta accettata. L\'analisi è stata accodata con successo.',
    type: AnalysisResponseDto
  })
  @ApiResponse({ status: 401, description: 'API Key mancante o non valida.' })
  async startAnalysis(@Body() payload: AnalysisRequestDto): Promise<AnalysisResponseDto> {
    const { executionArn, jobId } = await this.appService.triggerAnalysis(payload);

    return {
      message: 'Analisi avviata con successo',
      jobId,
      executionArn,
    };
  }
}
