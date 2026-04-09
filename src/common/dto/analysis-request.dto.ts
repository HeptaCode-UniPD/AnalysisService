import { IsString, IsNotEmpty, IsUrl, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AnalysisRequestDto {
  @ApiProperty({
    description: 'URL del repository GitHub/GitLab da analizzare',
    example: 'https://github.com/HeptaCode-UniPD/AnalysisService.git',
    required: true,
  })
  @IsUrl()
  @IsNotEmpty()
  repoUrl!: string;

  @ApiProperty({
    description: 'ID univoco del job fornito dal chiamante per tracciamento',
    example: 'job-esterno-12345',
    required: true,
  })
  @IsString()
  @IsNotEmpty()
  jobId!: string;

  @ApiProperty({
    description: 'Hash del commit specifico da analizzare (opzionale)',
    example: 'abcdef1234567890',
    required: false,
  })
  @IsString()
  @IsOptional()
  commitSha!: string;
}