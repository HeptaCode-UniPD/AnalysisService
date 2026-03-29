import { z } from 'zod';
import { createUnzipRepoTool } from './tools/decompressione-zip.tool';
import { createReadFileContentTool } from './tools/read-file-content.tool';
import { createFindDocumentationFilesTool } from './tools/find-docs-files.tool';

const DocAgentEventSchema = z.object({
  s3Bucket: z.string(),
  s3Key: z.string(),
  orchestratorRaw: z.string().optional(),
});

const DocAuditOutputSchema = z.object({
  summary: z.string().describe('Sintesi generale della documentazione'),
  completeness_score: z.number().min(0).max(10).describe('Punteggio di completezza da 0 a 10'),
  missing_sections: z.array(z.string()).describe('Sezioni mancanti nella documentazione'),
  recommendations: z.array(z.string()).describe('Suggerimenti per migliorare la documentazione'),
  files_analyzed: z.array(z.string()).describe('Lista dei file analizzati'),
});

export type DocAuditOutput = z.infer<typeof DocAuditOutputSchema>;

export const docAgentHandler = async (event: unknown, context: unknown): Promise<DocAuditOutput> => {
  const { Agent } = await import('@strands-agents/sdk');
  const { BedrockModel } = await import('@strands-agents/sdk/bedrock');

  // ✅ Creiamo i tool tramite factory async
  const [unzipRepo, findDocumentationFiles, readFileContent] = await Promise.all([
    createUnzipRepoTool(),
    createFindDocumentationFilesTool(),
    createReadFileContentTool(),
  ]);

  const bedrockModel = new BedrockModel({ modelId: 'eu.amazon.nova-pro-v1:0', region: 'eu-central-1' });
  const { s3Bucket: bucket, s3Key: key, orchestratorRaw } = DocAgentEventSchema.parse(event);

  const systemInstruction = `You are an expert technical writer and documentation auditor. 
    You must follow this exact sequence of steps to explore the repository:
    1. First, use 'unzip_repo' with the provided S3 bucket and zip key to extract the repository locally. This will return a local base path.
    2. Second, use 'find_documentation_files' passing the local base path returned from step 1 to locate READMEs, ADRs, and guides.
    3. Third, use 'read_file_content' to read the main documentation files you found, in order to evaluate setup instructions, API docs, and contribution guidelines.
    4. Finally, evaluate the overall documentation completeness and quality.
    
    Respond ONLY with valid JSON matching this exact schema, no markdown:
    ${JSON.stringify(DocAuditOutputSchema.shape)}`;

  const docAgent = new Agent({
    name: 'Documentation_Auditor',
    model: bedrockModel,
    systemPrompt: systemInstruction,
    tools: [unzipRepo, findDocumentationFiles, readFileContent],
  });

  const userPrompt = `Analyze documentation for the zipped repo in bucket '${bucket}' with key '${key}'. Context: ${orchestratorRaw ?? 'none'}`;

  try {
    const finalResponse = await docAgent.invoke(userPrompt);
    console.log('Agent Response Object:', JSON.stringify(finalResponse, null, 2));
    return DocAuditOutputSchema.parse(finalResponse.structuredOutput);
  } catch (err: any) {
    console.error('Errore completo:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2));
    throw err;
  }
};