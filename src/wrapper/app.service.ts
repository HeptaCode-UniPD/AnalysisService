import { Injectable, BadRequestException } from '@nestjs/common';
import { startStepFunctionExecution } from './adapters/aws-step-functions';

@Injectable()
export class AppService {
  async triggerAnalysis(payload: any): Promise<string> {
    if (!payload.repoUrl || !payload.jobId) {
      throw new BadRequestException('repoUrl e jobId sono obbligatori');
    }

    console.log('Validazione superata. Avvio reale Step Function per repo:', payload.repoUrl);

    try {
      // Chiama la funzione che utilizza l'SDK AWS @aws-sdk/client-sfn
      const executionArn = await startStepFunctionExecution(payload);
      return executionArn;
    } catch (error: any) {
      console.error("Errore avvio Step Function:", error);
      throw new Error("Impossibile contattare AWS Step Functions in questo ambiente.");
    }
  }
}