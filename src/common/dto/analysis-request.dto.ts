import { IsString, IsNotEmpty, IsUrl, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AnalysisRequestDto {
  @ApiProperty({
    description: 'URL del repository GitHub/GitLab da analizzare',
    example: 'https://github.com/HeptaCode-UniPD/AnalysisService.git',
  })
  @IsUrl()
  @IsNotEmpty()
  repoUrl!: string;

  @ApiProperty({
    description: 'ID univoco del job fornito dal chiamante',
    example: 'job-esterno-12345',
  })
  @IsString()
  @IsNotEmpty()
  jobId!: string;

  @ApiProperty({
    description: 'Hash del commit specifico da analizzare (opzionale)',
    example: 'abcdef1234567890',
  })
  @IsString()
  @IsOptional()
  commitSha!: string;
}