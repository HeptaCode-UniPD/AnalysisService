import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { Agent, tool } from '@strands-agents/sdk';
import { BedrockModel } from '@strands-agents/sdk/bedrock';
import { z } from 'zod';

const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION });

const invokeAgentLambda = async (
  functionName: string,
  payload: Record<string, any>,
): Promise<string> => {
  try {
    const command = new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify(payload)),
    });

    const response = await lambdaClient.send(command);

    if (!response.Payload)
      return JSON.stringify({ error: `Nessun risultato da ${functionName}` });
    return Buffer.from(response.Payload).toString('utf-8');
  } catch (error: any) {
    return JSON.stringify({ error: error.message });
  }
};

const bedrockModel = new BedrockModel({
  modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  region: process.env.AWS_REGION,
});

// 1. Schema condiviso per l'input del tool
const SubAgentToolInput = z.object({
  bucket: z.string().describe('Il nome del bucket S3'),
  key: z.string().describe('La chiave S3 o il prefisso del repository'),
  context: z
    .string()
    .describe("Contesto raw dell'orchestratore da passare al sub-agent"),
});

type ToolInput = z.infer<typeof SubAgentToolInput>;

// IL TOOL OPZIONALE: Lo diamo all'LLM in modo che decida lui se usarlo
const runDocumentationAnalysis = tool({
  name: 'run_documentation_analysis',
  description:
    "Avvia l'analisi della documentazione. Usalo SOLO se determini dal contesto che il repository è una 'release'.",
  inputSchema: z.toJSONSchema(SubAgentToolInput) as any,
  callback: async ({ bucket, key, context }: ToolInput): Promise<string> => {
    return await invokeAgentLambda(process.env.LAMBDA_DOCS_NAME!, {
      s3Bucket: bucket,
      s3Key: key,
      orchestratorRaw: context,
    });
  },
});

// 2. Schema Zod per l'evento Lambda in ingresso
const OrchestratorEventSchema = z.object({
  s3Bucket: z.string(),
  s3Key: z.string(),
  isRelease: z.boolean().describe('Flag per determinare se è una release'),
  orchestratorRaw: z.string(),
});

// 3. Schema Zod per l'output finale dell'Orchestratore
const OrchestratorOutputSchema = z.object({
  executive_summary: z
    .string()
    .describe('Sintesi generale dei risultati di tutte le analisi'),
  owasp_status: z.string().describe("Risultato dell'analisi OWASP"),
  test_qa_status: z.string().describe("Risultato dell'analisi Test & QA"),
  documentation_status: z
    .string()
    .optional()
    .describe("Risultato dell'analisi della documentazione, se eseguita"),
  overall_score: z
    .number()
    .min(0)
    .max(10)
    .describe('Punteggio complessivo del repository'),
});

export type OrchestratorOutput = z.infer<typeof OrchestratorOutputSchema>;

// Handler dell'Orchestratore
export const orchestratorHandler = async (
  event: unknown,
  context: any,
): Promise<OrchestratorOutput> => {
  const {
    s3Bucket: bucket,
    s3Key: key,
    isRelease,
    orchestratorRaw,
  } = OrchestratorEventSchema.parse(event);
  const payload = { s3Bucket: bucket, s3Key: key, orchestratorRaw };

  // A. ESECUZIONE PARALLELA DEI TASK OBBLIGATORI (Velocità)
  console.log('Esecuzione parallela dei task obbligatori (OWASP e QA)...');
  const [owaspResult, testResult] = await Promise.all([
    invokeAgentLambda(process.env.LAMBDA_OWASP_NAME!, payload),
    invokeAgentLambda(process.env.LAMBDA_TEST_NAME!, payload),
  ]);

  // B. DELEGA DELLA DECISIONE ALL'AGENTE LLM (Il tuo requisito)
  const systemInstruction = `You are a Lead Repository Auditor and Orchestrator.
  You have already been provided with the pre-computed OWASP and Test & QA analysis results.
  
  RULES:
  1. Analyze the provided Context and Status.
  2. IF it explicitly states this is a "RELEASE", you MUST decide to use the 'run_documentation_analysis' tool to fetch documentation data.
  3. IF it is NOT a release, do not use the tool.
  4. Synthesize all results (OWASP, QA, and potentially Docs) into a final comprehensive executive summary.
  
  Respond ONLY with valid JSON matching this exact schema, no markdown:
  ${JSON.stringify(OrchestratorOutputSchema.shape)}`;

  const orchestratorAgent = new Agent({
    name: 'Main_Orchestrator',
    model: bedrockModel,
    systemPrompt: systemInstruction,
    tools: [runDocumentationAnalysis],
  });

  const releaseStatus = isRelease
    ? 'This IS a RELEASE.'
    : 'This IS NOT a release.';

  // Passiamo tutto all'agente: i risultati paralleli e il contesto su cui deve decidere
  const userPrompt = `Analyze the repo in bucket '${bucket}' under prefix '${key}'. 
  Status: ${releaseStatus}
  Context: ${orchestratorRaw}
  
  --- PRE-COMPUTED OWASP ANALYSIS ---
  ${owaspResult}
  
  --- PRE-COMPUTED TEST & QA ANALYSIS ---
  ${testResult}`;

  console.log("Invocazione dell'Orchestratore per la decisione e sintesi...");
  const finalResponse = await orchestratorAgent.invoke(userPrompt);

  return OrchestratorOutputSchema.parse(finalResponse.structuredOutput);
};
