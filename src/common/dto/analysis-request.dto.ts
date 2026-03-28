import { IsString, IsUrl, IsNotEmpty, IsOptional } from 'class-validator';

export class AnalysisRequestDto {
  @IsString()
  @IsNotEmpty()
  jobId: string;

  @IsUrl()
  @IsNotEmpty()
  repoUrl: string;

  @IsString()
  @IsNotEmpty()
  commitSha: string;

  @IsUrl()
  @IsNotEmpty()
  webhookUrl: string;
}
