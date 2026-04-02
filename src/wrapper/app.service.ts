import { Injectable } from '@nestjs/common';
import { startStepFunctionExecution } from './adapters/aws-step-functions';
import { AnalysisRequestDto } from '../common/dto/analysis-request.dto';

@Injectable()
export class AppService {
  async triggerAnalysis(
    payload: AnalysisRequestDto,
  ): Promise<{ executionArn: string; jobId: string }> {
    console.log(
      'Validazione superata automaticamente. Avvio reale Step Function per repo:',
      payload.repoUrl,
    );

    const executionArn = await startStepFunctionExecution(payload);
    // L'ultimo segmento dell'ARN di esecuzione è il nome dell'esecuzione (jobId)
    const jobId = executionArn.split(':').pop() || 'unknown';

    return { executionArn, jobId };
  }
}
