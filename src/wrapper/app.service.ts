import { Injectable } from '@nestjs/common';
import { startStepFunctionExecution } from './adapters/aws-step-functions';
import { AnalysisRequestDto } from '../common/dto/analysis-request.dto';

@Injectable()
export class AppService {
  async triggerAnalysis(
    payload: AnalysisRequestDto,
  ): Promise<{ executionArn: string; jobId: string }> {
    console.log(
      `Avvio reale Step Function per repo: ${payload.repoUrl} con jobId: ${payload.jobId}`,
    );

    const executionArn = await startStepFunctionExecution(payload);

    // Restituiamo il jobId ricevuto in input
    return { executionArn, jobId: payload.jobId };
  }
}