import { Injectable, BadRequestException } from '@nestjs/common';
// In futuro inietteremo qui l'Adapter per AWS Step Functions

@Injectable()
export class AppService {
  
  async triggerAnalysis(payload: any): Promise<string> {
    // 1. Validazione (Regole di Business)
    if (!payload.repoUrl || !payload.jobId) {
      throw new BadRequestException('Parametri repoUrl e jobId sono obbligatori');
    }

    // Qui a breve chiameremo il file aws-step-functions.ts
    // Per ora simuliamo che la Step Function sia partita:
    console.log('Validazione superata. Simulo avvio Step Function per repo:', payload.repoUrl);
    
    return 'arn:aws:states:eu-central-1:123456789:execution:MyStateMachine:simulata';
  }
}