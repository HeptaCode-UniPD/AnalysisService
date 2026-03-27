import { Injectable, BadRequestException } from '@nestjs/common';

@Injectable()
export class AppService {
  
  async triggerAnalysis(payload: any): Promise<string> {
    if (!payload.repoUrl || !payload.jobId) {
      throw new BadRequestException('repoUrl e jobId sono obbligatori');
    }

    console.log('Validazione superata. Simulo avvio Step Function per repo:', payload.repoUrl);
    
    return 'arn:aws:states:eu-central-1:123456789:execution:MyStateMachine:simulata';
  }
}
