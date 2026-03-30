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
    .describe("Nome dell'agente che ha effettuato l'analisi (es. OWASP, QA, Documentation)"),
  files: z
    .array(FileAnalysisSchema)
    .describe('Lista dei file analizzati da questo agente'),
});

const OrchestratorOutputSchema = z.object({
  jobId: z.string(),
  status: z.enum(['successo', 'fallito']),
  totalIssuesFound: z.number().int(),
  analysisDetails: z.array(AnalysisDetailSchema).optional(),
  rawMarkdownReport: z.string().optional().describe("Il report testuale completo in formato Markdown")
});

export type OrchestratorOutput = z.infer<typeof OrchestratorOutputSchema>;

// Handler dell'Orchestratore
export const orchestratorHandler = async (
  event: unknown,
): Promise<OrchestratorOutput> => {
  // === IMPORT DINAMICI ===
  const { Agent, tool } = await import('@strands-agents/sdk');
  const { BedrockModel } = await import('@strands-agents/sdk/bedrock');

  // === INIZIALIZZAZIONE RISORSE STRANDS ===
  const bedrockModel = new BedrockModel({
    modelId: 'eu.amazon.nova-pro-v1:0',
    region: 'eu-central-1',
  });

  // Monkey-patch corretto: preserva il tipo async generator
  const originalStream = bedrockModel.stream.bind(bedrockModel);
  (bedrockModel as any).stream = async function* (params: any) {
    if (params?.messages) {
      params.messages = params.messages.map((msg: any) => ({
        ...msg,
        content: Array.isArray(msg.content)
          ? msg.content.filter(
              (block: any) =>
                !(block.type === 'text' && (block.text ?? '').trim() === '')
            )
          : msg.content,
      }));
    }
    yield* originalStream(params);
  };

  const runDocumentationAnalysis = tool({
    name: 'run_documentation_analysis',
    description:
      "Avvia l'analisi della documentazione. Usalo SOLO se determini dal contesto che il repository è una 'release'.",
    inputSchema: z.toJSONSchema(SubAgentToolInput as any) as any,
    callback: async ({ bucket, key, context }: ToolInput): Promise<string> => {
      console.log(
        `[TOOL] Invocazione LAMBDA_DOCS_NAME per bucket: ${bucket}, key: ${key}`,
      );

      try {
        const result = await invokeAgentLambda(process.env.LAMBDA_DOCS_NAME!, {
          s3Bucket: bucket,
          s3Key: key,
          orchestratorRaw: context,
        });

        console.log(
          `[TOOL] Risultato da LAMBDA_DOCS_NAME (primi 100 char):`,
          result.substring(0, 100),
        );
        return result; // L'orchestratore ora riceverà una stringa Markdown
      } catch (toolError: any) {
        console.error(
          `[TOOL] ❌ Errore durante l'esecuzione di LAMBDA_DOCS_NAME!`,
        );
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

  const systemInstruction = `You are a data converter. Your EXCLUSIVE goal is to transform Markdown security reports into a SINGLE valid JSON object.

  RULES:
  1. OUTPUT ONLY VALID JSON. No conversational text, no preambles, no "Here is the analysis".
  2. If the input is Markdown, parse it and map it to the schema below.
  3. DATA MAPPING:
    - Extract 'filePath' from headers or bullet points, remove the first 2 directories.
    - Extract 'startLine' and 'endLine' from patterns like "Linee: X-Y". If not found, use 0.
    - Use the description of the vulnerability as 'reason'.
    - If 'originalCode' or 'proposedCorrection' are missing in the Markdown, use an empty string "" but NEVER omit the field.

  REQUIRED JSON STRUCTURE:
  {
    "jobId": "string",
    "status": "successo" | "fallito",
    "totalIssuesFound": number,
    "analysisDetails": [
      {
        "agentName": "OWASP" | "QA" | "Documentation",
        "files": [
          {
            "filePath": "string",
            "findings": [
              { "startLine": 0, "endLine": 0, "reason": "string", "originalCode": "string", "proposedCorrection": "string" }
            ]
          }
        ]
      }
    ]
  }`;

  const orchestratorAgent = new Agent({
    name: 'Main_Orchestrator',
    model: bedrockModel,
    systemPrompt: systemInstruction,
    tools: [runDocumentationAnalysis],
  });

  const releaseStatus = isRelease
    ? 'This IS a RELEASE.'
    : 'This IS NOT a release.';

  // Passiamo tutto all'agente: i risultati paralleli testuali (Markdown) e il contesto su cui deve decidere
  const userPrompt = `Analyze the repo in bucket '${bucket}' under prefix '${key}'. 
  Status: ${releaseStatus}
  Context: ${orchestratorRaw}
  
  --- PRE-COMPUTED OWASP ANALYSIS (MARKDOWN) ---
  ${owaspResult}
  
  --- PRE-COMPUTED TEST & QA ANALYSIS (MARKDOWN) ---
  ${testResult}`;

  console.log("Invocazione dell'Orchestratore per la decisione e sintesi...");

  let finalResponse: any;
  try {
    finalResponse = await orchestratorAgent.invoke(userPrompt);
  } catch (err: any) {
    console.error('=== ERRORE PROFONDO ===');
    
    // 1. Logga l'errore intero su CloudWatch (non perdoniamo nulla)
    console.error(JSON.stringify(err, Object.getOwnPropertyNames(err), 2));

    // 2. Estrai il messaggio in modo sicuro
    let errorDetails = "Errore sconosciuto";
    if (err instanceof Error) {
        errorDetails = err.message;
    } else if (typeof err === 'object' && err !== null) {
        errorDetails = JSON.stringify(err);
    } else {
        errorDetails = String(err);
    }

    throw new Error(`Orchestratore fallito: ${errorDetails}`);
  }

  console.log(
    'Risposta grezza dal modello:',
    JSON.stringify(finalResponse, null, 2),
  );

  // 1. NAVIGHIAMO L'OGGETTO CORRETTAMENTE
  const lastMessageContent = finalResponse?.lastMessage?.content;

  if (
    !Array.isArray(lastMessageContent) ||
    lastMessageContent.length === 0 ||
    typeof lastMessageContent[0].text !== 'string'
  ) {
    throw new Error(
      "Il formato della risposta non contiene il testo atteso nell'array lastMessage.content.",
    );
  }

  const rawText = lastMessageContent[0].text;

  // Cerca la prima '{' e l'ultima '}' per estrarre solo il blocco JSON
  const firstBracket = rawText.indexOf('{');
  const lastBracket = rawText.lastIndexOf('}');

  if (firstBracket === -1 || lastBracket === -1) {
    throw new Error(`Il modello non ha generato un JSON. Testo ricevuto: ${rawText.substring(0, 100)}...`);
  }

  const jsonString = rawText.substring(firstBracket, lastBracket + 1);

  try {
    const parsedData = JSON.parse(jsonString);
    // Validazione finale con Zod
    return OrchestratorOutputSchema.parse(parsedData);
  } catch (e) {
    console.error("Errore nel parsing del JSON estratto:", jsonString);
    throw new Error(`JSON malformato: ${e.message}`);
  }
};