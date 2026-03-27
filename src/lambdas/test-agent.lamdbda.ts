import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { Agent, tool } from 'strands';
import { BedrockModel } from '@strands-agents/bedrock';

const s3Client = new S3Client({});

const bedrockModel = new BedrockModel({
  modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  region: process.env.AWS_REGION,
});

// Tool specifico per i test
const findTestFiles = tool({
  name: 'find_test_files',
  description:
    'Ottiene la lista dei file di test (.test.ts, .spec.js, etc.) e configurazioni CI/CD.',
  handler: async (bucket: string, prefix: string): Promise<string> => {
    const command = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
    });
    const response = await s3Client.send(command);

    if (!response.Contents || response.Contents.length === 0)
      return 'Nessun file trovato.';

    const testFiles = response.Contents.map((item) =>
      item.Key?.replace(`${prefix}/`, ''),
    ).filter(
      (key) =>
        key &&
        (key.includes('.test.') ||
          key.includes('.spec.') ||
          key.includes('tests/') ||
          key.includes('__tests__/') ||
          key.includes('jest.config') ||
          key.includes('cypress.json') ||
          key.includes('.github/workflows/')),
    );

    return testFiles.length > 0
      ? testFiles.join('\n')
      : 'Nessun file di test trovato.';
  },
});

// Tool di lettura (riutilizzato)
const readFileContent = tool({
  name: 'read_file_content',
  description:
    'Usa questo tool per leggere il contenuto testuale di un file specifico per analizzarlo.',
  handler: async (bucket: string, fileKey: string): Promise<string> => {
    try {
      const command = new GetObjectCommand({ Bucket: bucket, Key: fileKey });
      const response = await s3Client.send(command);

      // In AWS SDK v3, usiamo transformToString() per convertire lo stream in stringa
      const content = await response.Body?.transformToString('utf-8');
      return content || '';
    } catch (error: any) {
      return `Errore durante la lettura del file: ${error.message}`;
    }
  },
});

export const testAgentHandler = async (event: any, context: any) => {
  const { s3Bucket: bucket, s3Key: key, orchestratorRaw } = event;

  const systemInstruction = `You are an expert QA engineer and test coverage analyst.
    You have tools to explore the repository stored in S3.
    1. First, use 'find_test_files' to locate unit/e2e tests and CI pipelines.
    2. Read a representative sample of test files to evaluate assertion quality and coverage estimation.
    3. Check CI/CD configuration to ensure tests are automated.
    
    Respond ONLY with valid JSON matching the requested schema, no markdown.`;

  const testAgent = new Agent({
    name: 'Test_Auditor',
    model: bedrockModel,
    systemPrompt: systemInstruction,
    tools: [findTestFiles, readFileContent],
  });

  const userPrompt = `Analyze test coverage and quality for repo in bucket '${bucket}' under prefix '${key}'. Context: ${orchestratorRaw}`;
  const finalResponse = await testAgent.run(userPrompt);

  return JSON.parse(finalResponse.text);
};
