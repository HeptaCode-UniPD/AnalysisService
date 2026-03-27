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

  //token opzionale
  @IsString()
  @IsOptional()
  userToken?: string; 

  @IsUrl()
  @IsNotEmpty()
  webhookUrl: string;
}
