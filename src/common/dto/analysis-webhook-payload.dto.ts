import { ApiProperty } from '@nestjs/swagger';

export class AnalysisDetailDto {
  @ApiProperty({
    description: 'Nome dell\'area o dell\'agente (OWASP, TEST, DOCS)',
    example: 'OWASP',
  })
  agentName!: string;

  @ApiProperty({
    description: 'Breve sintesi dell\'esito dell\'analisi',
    example: 'Trovate 3 vulnerabilità critiche.',
  })
  summary!: string;

  @ApiProperty({
    description: 'Report completo in formato Markdown',
    example: '### Vulnerabilità...\n...',
  })
  report!: string;
}

export class AnalysisWebhookPayloadDto {
  @ApiProperty({
    description: 'Lista dei dettagli granulari per ogni area di analisi',
    type: [AnalysisDetailDto],
  })
  analysisDetails!: AnalysisDetailDto[];

  @ApiProperty({
    description: 'URL del repository analizzato',
    example: 'https://github.com/HeptaCode-UniPD/AnalysisService.git',
  })
  repoUrl!: string;

  @ApiProperty({
    description: 'ID del commit analizzato',
    example: 'abcdef1234567890',
  })
  commitId!: string;

  @ApiProperty({
    description: 'ID univoco del job di analisi',
    example: 'job-esterno-12345',
  })
  jobId!: string;

  @ApiProperty({
    description: 'Stato finale della pipeline',
    example: 'done',
    enum: ['done', 'failed'],
  })
  status!: string;
}
