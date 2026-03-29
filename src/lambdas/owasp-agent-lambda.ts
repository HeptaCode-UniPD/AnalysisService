import { z } from 'zod';
import { createUnzipRepoTool } from './tools/decompressione-zip.tool';
import { createReadFileContentTool } from './tools/read-file-content.tool';
import { createListRepositoryFilesTool } from './tools/find-all-files.tool';

const OwaspAgentEventSchema = z.object({
  s3Bucket: z.string(),
  s3Key: z.string(),
  orchestratorRaw: z.string().optional(),
});

const OwaspAuditOutputSchema = z.object({
  summary: z.string().describe('Sintesi generale della documentazione'),
  completeness_score: z.number().min(0).max(10).describe('Punteggio di completezza da 0 a 10'),
  missing_sections: z.array(z.string()).describe('Sezioni mancanti nella documentazione'),
  recommendations: z.array(z.string()).describe('Suggerimenti per migliorare la documentazione'),
  files_analyzed: z.array(z.string()).describe('Lista dei file analizzati'),
});

export type OwaspAuditOutput = z.infer<typeof OwaspAuditOutputSchema>;

export const owaspAgentHandler = async (event: unknown, context: unknown): Promise<OwaspAuditOutput> => {
  const { Agent } = await import('@strands-agents/sdk');
  const { BedrockModel } = await import('@strands-agents/sdk/bedrock');

  // ✅ Creiamo i tool tramite factory async
  const [unzipRepo, listRepositoryFiles, readFileContent] = await Promise.all([
    createUnzipRepoTool(),
    createListRepositoryFilesTool(),
    createReadFileContentTool(),
  ]);

  const bedrockModel = new BedrockModel({ modelId: 'eu.amazon.nova-pro-v1:0', region: 'eu-central-1' });
  const { s3Bucket: bucket, s3Key: key, orchestratorRaw } = OwaspAgentEventSchema.parse(event);

  const systemInstruction = `You are an expert security auditor specialized in OWASP. 
    You must follow this exact sequence of steps to explore the repository:
    1. First, use 'unzip_repo' with the provided S3 bucket and zip key to extract the repository locally. This will return a local base path.
    2. Second, use 'list_repository_files' passing the local base path returned from step 1 to understand the project structure.
    3. Third, use 'read_file_content' to read critical files (like package.json, requirements.txt, server.js, auth logic) based on the absolute paths you found.
    4. Finally, analyze the contents for OWASP vulnerabilities.
    
    Respond ONLY with valid JSON matching the exact schema requested, no markdown:
    ${JSON.stringify(OwaspAuditOutputSchema.shape)}`;

  const owaspAgent = new Agent({
    name: 'OWASP_Auditor',
    model: bedrockModel,
    systemPrompt: systemInstruction,
    tools: [unzipRepo, listRepositoryFiles, readFileContent],
  });

  const userPrompt = `Analyze OWASP vulnerabilities for the zipped repo in bucket '${bucket}' with key '${key}'. Context: ${orchestratorRaw ?? 'none'}`;

  try {
    const finalResponse = await owaspAgent.invoke(userPrompt);
    console.log('Agent Response Object:', JSON.stringify(finalResponse, null, 2));
    return OwaspAuditOutputSchema.parse(finalResponse.structuredOutput);
  } catch (err: any) {
    console.error('Errore completo:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2));
    throw err;
  }
};