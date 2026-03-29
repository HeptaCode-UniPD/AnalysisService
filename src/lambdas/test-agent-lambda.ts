import { z } from 'zod';
import { createUnzipRepoTool } from './tools/decompressione-zip.tool';
import { createReadFileContentTool } from './tools/read-file-content.tool';
import { createFindTestFilesTool } from './tools/find-test-files.tool';

const TestAgentEventSchema = z.object({
  s3Bucket: z.string(),
  s3Key: z.string(),
  orchestratorRaw: z.string().optional(),
});

const TestAuditOutputSchema = z.object({
  summary: z.string().describe('Sintesi generale della documentazione'),
  completeness_score: z.number().min(0).max(10).describe('Punteggio di completezza da 0 a 10'),
  missing_sections: z.array(z.string()).describe('Sezioni mancanti nella documentazione'),
  recommendations: z.array(z.string()).describe('Suggerimenti per migliorare la documentazione'),
  files_analyzed: z.array(z.string()).describe('Lista dei file analizzati'),
});

export type TestAuditOutput = z.infer<typeof TestAuditOutputSchema>;

export const testAgentHandler = async (event: unknown, context: unknown): Promise<TestAuditOutput> => {
  const { Agent } = await import('@strands-agents/sdk');
  const { BedrockModel } = await import('@strands-agents/sdk/bedrock');

  // ✅ Creiamo i tool tramite factory async
  const [unzipRepo, findTestFiles, readFileContent] = await Promise.all([
    createUnzipRepoTool(),
    createFindTestFilesTool(),
    createReadFileContentTool(),
  ]);

  const bedrockModel = new BedrockModel({ modelId: 'eu.amazon.nova-pro-v1:0', region: 'eu-central-1' });
  const { s3Bucket: bucket, s3Key: key, orchestratorRaw } = TestAgentEventSchema.parse(event);

  const systemInstruction = `You are an expert QA engineer and test coverage analyst.
    You must follow this exact sequence of steps to explore the repository:
    1. First, use 'unzip_repo' with the provided S3 bucket and zip key to extract the repository locally. This will return a local base path.
    2. Second, use 'find_test_files' passing the local base path returned from step 1 to locate unit/e2e tests and CI pipelines.
    3. Third, use 'read_file_content' to read a representative sample of the local test files to evaluate assertion quality and coverage estimation.
    4. Finally, evaluate the CI/CD configuration and overall test coverage.
    
    Respond ONLY with valid JSON matching the requested schema, no markdown:
    ${JSON.stringify(TestAuditOutputSchema.shape)}`;

  const testAgent = new Agent({
    name: 'Test_Auditor',
    model: bedrockModel,
    systemPrompt: systemInstruction,
    tools: [unzipRepo, findTestFiles, readFileContent],
  });

  const userPrompt = `Analyze test coverage for the zipped repo in bucket '${bucket}' with key '${key}'. Context: ${orchestratorRaw ?? 'none'}`;

  try {
    const finalResponse = await testAgent.invoke(userPrompt);
    console.log('Agent Response Object:', JSON.stringify(finalResponse, null, 2));
    return TestAuditOutputSchema.parse(finalResponse.structuredOutput);
  } catch (err: any) {
    console.error('Errore completo:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2));
    throw err;
  }
};