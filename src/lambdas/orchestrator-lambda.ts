import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
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

// 1. Schema condiviso per l'input del tool
const SubAgentToolInput = z.object({
  bucket: z.string().describe('Il nome del bucket S3'),
  key: z.string().describe('La chiave S3 o il prefisso del repository'),
  context: z
    .string()
    .describe("Contesto raw dell'orchestratore da passare al sub-agent"),
});

type ToolInput = z.infer<typeof SubAgentToolInput>;

// 2. Schema Zod per l'evento Lambda in ingresso
const OrchestratorEventSchema = z.object({
  s3Bucket: z.string(),
  s3Key: z.string(),
  isRelease: z.boolean().describe('Flag per determinare se è una release'),
  orchestratorRaw: z.string(),
});

// 3. Schema Zod per l'output finale dell'Orchestratore
const FindingSchema = z.object({
  startLine: z.number().int().describe('Linea di inizio del problema'),
  endLine: z.number().int().describe('Linea di fine del problema'),
  reason: z.string().describe('Spiegazione della correzione nel diff'),
  originalCode: z.string().describe('Il frammento di codice originale'),
  proposedCorrection: z.string().describe('Il codice corretto proposto'),
});

const FileAnalysisSchema = z.object({
  filePath: z.string().describe('Percorso del file analizzato'),
  findings: z
    .array(FindingSchema)
    .describe('Lista dei problemi trovati nel file'),
});

const AnalysisDetailSchema = z.object({
  agentName: z
    .string()
    .describe("Nome dell'agente che ha effettuato l'analisi (es. OWASP, QA)"),
  files: z
    .array(FileAnalysisSchema)
    .describe('Lista dei file analizzati da questo agente'),
});

const OrchestratorOutputSchema = z.object({
  jobId: z.string().describe('ID univoco del job di analisi'),
  status: z
    .enum(['successo', 'fallito'])
    .describe("Stato complessivo dell'analisi"),
  totalIssuesFound: z
    .number()
    .int()
    .describe('Numero totale di problemi trovati in tutti i file'),
  analysisDetails: z
    .array(AnalysisDetailSchema)
    .describe("Dettagli dell'analisi divisi per agente"),
});

export type OrchestratorOutput = z.infer<typeof OrchestratorOutputSchema>;

// Handler dell'Orchestratore
export const orchestratorHandler = async (
  event: unknown,
  context: any,
): Promise<OrchestratorOutput> => {
  // === IMPORT DINAMICI (Fix per l'errore ES Module in CommonJS) ===
  const { Agent, tool } = await import('@strands-agents/sdk');
  const { BedrockModel } = await import('@strands-agents/sdk/bedrock');

  // === INIZIALIZZAZIONE RISORSE STRANDS ===
  const bedrockModel = new BedrockModel({
    modelId: 'us.amazon.nova-pro-v1:0',
    region: 'us-east-1',
  });

  const runDocumentationAnalysis = tool({
    name: 'run_documentation_analysis',
    description:
      "Avvia l'analisi della documentazione. Usalo SOLO se determini dal contesto che il repository è una 'release'.",
    inputSchema: z.toJSONSchema(SubAgentToolInput as any) as any,
    callback: async ({ bucket, key, context }: ToolInput): Promise<string> => {
      console.log(`[TOOL] Invocazione LAMBDA_DOCS_NAME per bucket: ${bucket}, key: ${key}`);
      
      try {
        const result = await invokeAgentLambda(process.env.LAMBDA_DOCS_NAME!, {
          s3Bucket: bucket,
          s3Key: key,
          orchestratorRaw: context,
        });
        
        console.log(`[TOOL] Risultato da LAMBDA_DOCS_NAME (primi 100 char):`, result.substring(0, 100));
        return result;
      } catch (toolError: any) {
        console.error(`[TOOL] ❌ Errore durante l'esecuzione di LAMBDA_DOCS_NAME!`);
        console.error(JSON.stringify(toolError, Object.getOwnPropertyNames(toolError), 2));
        
        return `Errore interno durante l'analisi della documentazione: ${toolError.message || 'Errore sconosciuto'}`;
      }
    },
  });

  // === PARSING DELL'EVENTO ===
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

  // B. DELEGA DELLA DECISIONE ALL'AGENTE LLM
const systemInstruction = `You are a Lead Repository Auditor and Orchestrator.
  You have already been provided with the pre-computed OWASP and Test & QA analysis results.
  
  RULES:
  1. Analyze the provided Context and Status.
  2. IF it explicitly states this is a "RELEASE", you MUST decide to use the 'run_documentation_analysis' tool to fetch documentation data.
  3. IF it is NOT a release, do not use the tool.
  4. Synthesize all results (OWASP, QA, and potentially Docs) into a final comprehensive executive summary.
  
  CRITICAL TOOL INSTRUCTION:
  If you decide to use a tool, you MUST write a brief text explanation of why you are using it BEFORE the tool call. NEVER output an empty text block.
  
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

  let finalResponse: any;
  try {
    finalResponse = await orchestratorAgent.invoke(userPrompt);
  } catch (err: any) {
    console.error('=== ERRORE ORCHESTRATORE RAW ===');
    console.error('typeof err:', typeof err);
    console.error('err keys:', Object.getOwnPropertyNames(err));
    console.error('err stringified:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2));
    if (err.cause) {
      console.error('err.cause:', JSON.stringify(err.cause, Object.getOwnPropertyNames(err.cause), 2));
    }
    if (err.originalError) {
      console.error('err.originalError:', JSON.stringify(err.originalError, Object.getOwnPropertyNames(err.originalError), 2));
    }
    throw new Error(`Orchestratore fallito: ${JSON.stringify(err, Object.getOwnPropertyNames(err), 2)}`);
  }

  console.log("Risposta grezza dal modello:", JSON.stringify(finalResponse, null, 2));
  console.log("Tipo risposta:", typeof finalResponse);
  console.log("Chiavi risposta:", Object.keys(finalResponse ?? {}));
  const rawText = finalResponse.text || finalResponse.content || finalResponse.output || (typeof finalResponse === 'string' ? finalResponse : '');

  if (!rawText) {
    throw new Error("Il modello non ha restituito alcun testo valido.");
  }

  const cleanJsonString = rawText
  .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
  .replace(/```json/gi, '')
  .replace(/```/g, '')
  .trim();
  const parsedData = JSON.parse(cleanJsonString);

  return OrchestratorOutputSchema.parse(parsedData);

};