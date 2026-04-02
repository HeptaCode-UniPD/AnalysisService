import { ApiProperty } from '@nestjs/swagger';

export class AnalysisResponseDto {
  @ApiProperty({
    description: 'Messaggio di conferma dell\'avvio della pipeline',
    example: 'Analisi avviata con successo',
  })
  message!: string;

  @ApiProperty({
    description: 'ID univoco del job di analisi generato dal sistema',
    example: '5f9a1b2c-3d4e-5f6g-7h8i-9j0k1l2m3n4o',
  })
  jobId!: string;

  @ApiProperty({
    description: 'ARN dell\'esecuzione della State Machine AWS Step Functions',
    example: 'arn:aws:states:eu-central-1:123456789012:execution:ms2-pipeline-dev:5f9a1b2c-3d4e...',
  })
  executionArn!: string;
}
