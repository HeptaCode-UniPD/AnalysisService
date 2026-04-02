import { IsString, IsNotEmpty, IsUrl } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AnalysisRequestDto {
  @ApiProperty({
    description: 'URL del repository GitHub/GitLab da analizzare',
    example: 'https://github.com/HeptaCode-UniPD/AnalysisService.git',
  })
  @IsUrl()
  @IsNotEmpty()
  repoUrl!: string;
}
