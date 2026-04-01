import { Injectable } from '@nestjs/common';
import { startStepFunctionExecution } from './adapters/aws-step-functions';
import { AnalysisRequestDto } from '../common/dto/analysis-request.dto';

@Injectable()
export class AppService {
  async triggerAnalysis(payload: AnalysisRequestDto): Promise<string> {
    console.log(
      'Validazione superata automaticamente. Avvio reale Step Function per repo:',
      payload.repoUrl,
    );

    return await startStepFunctionExecution(payload);
  }
}
