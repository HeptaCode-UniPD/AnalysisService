import { IsString, IsNotEmpty, IsUrl, isNotEmpty } from 'class-validator';

export class AnalysisRequestDto {
  @IsUrl()
  @IsNotEmpty()
  repoUrl!: string;
}
