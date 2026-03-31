import {
  S3Client,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { z } from 'zod';

const FindingSchema = z.object({
  reason: z
    .string()
    .describe('the sinthetic reason why the correction is needed.')
    .default(''),
  startLine: z.number().default(0),
  endLine: z.number().default(0),
  originalCode: z.string().default(''),
  proposedCorrection: z.string().default(''),
});

const FileSchema = z.object({
  filePath: z
    .string()
    .describe('the path of the file you are proposing remediations for.'),
  findings: z
    .array(FindingSchema)
    .describe('every file analyzed by the agent.')
    .default([]),
});

const AgentReportSchema = z.object({
  agentName: z
    .string()
    .describe('the name of the agent must be OWASP, TEST or DOCS.'),
  files: z
    .array(FileSchema)
    .describe('every file analyzed by the agent.')
    .default([]),
});

const FinalReportSchema = z.array(AgentReportSchema);

const s3Client = new S3Client({ region: process.env.AWS_REGION });

const streamToString = (stream: any): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: any[] = [];
    stream.on('data', (chunk: any) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });

export const orchestratorHandler = async (event: any) => {
  const action = event.action;

  // ==========================================
  // FASE 1: PIANIFICAZIONE (PLAN)
  // ==========================================
  if (action === 'PLAN') {
    console.log('Orchestratore in fase di PLANNING...');
    const { repoMetadata } = event.payload;
    const isRelease =
      repoMetadata?.tags?.length > 0 || repoMetadata?.hasChangelog;
    return {
      runOwasp: true,
      runTest: true,
      runDocs: isRelease,
    };
  }

  // ==========================================
  // FASE 2: AGGREGAZIONE (AGGREGATE)
  // ==========================================
  if (action === 'AGGREGATE') {
    console.log('Orchestratore in fase di AGGREGAZIONE...');
    try {
      const { Agent } = await import('@strands-agents/sdk');
      const { BedrockModel } = await import('@strands-agents/sdk/bedrock');

      const { jobId, s3Bucket, reports } = event.payload;
      let combinedMarkdown = '';

      // 1. Recupera i report da S3
      for (const report of reports) {
        if (report.status === 'success' && report.reportKey) {
          try {
            const response = await s3Client.send(
              new GetObjectCommand({
                Bucket: s3Bucket,
                Key: report.reportKey,
              }),
            );
            let content = await streamToString(response.Body);
            if (content.length > 8000) {
              content =
                content.substring(0, 8000) + '\n...[TRUNCATED DUE TO LENGTH]';
            }
            combinedMarkdown += `\n--- ${report.agent.toUpperCase()} REPORT ---\n${content}\n`;
            await s3Client.send(
              new DeleteObjectCommand({
                Bucket: s3Bucket,
                Key: report.reportKey,
              }),
            );
          } catch (err) {
            console.error(`Errore download report ${report.agent}:`, err);
            combinedMarkdown += `\n--- ${report.agent.toUpperCase()} REPORT ---\nErrore recupero S3.\n`;
          }
        } else if (report.status === 'skipped') {
          combinedMarkdown += `\n--- ${report.agent.toUpperCase()} REPORT ---\nAgente ignorato.\n`;
        } else {
          combinedMarkdown += `\n--- ${report.agent.toUpperCase()} REPORT ---\nErrore agente: ${report.error}\n`;
        }
      }

      // 2. Setup Bedrock Model
      const bedrockModel = new BedrockModel({
        modelId: 'eu.amazon.nova-pro-v1:0',
        region: 'eu-central-1',
      });

      const originalStream = bedrockModel.stream.bind(bedrockModel);
      (bedrockModel as any).stream = async function* (params: any) {
        if (params?.messages) {
          params.messages = params.messages.map((msg: any) => ({
            ...msg,
            content: Array.isArray(msg.content)
              ? msg.content.filter(
                  (block: any) =>
                    !(
                      block.type === 'text' && (block.text ?? '').trim() === ''
                    ),
                )
              : msg.content,
          }));
        }
        yield* originalStream(params);
      };

      // 3. System Instruction con Few-Shot Prompting
      const systemInstruction = `You are a strict data extraction tool. Extract ONLY the vulnerabilities, code snippets, and coverage issues from the provided reports.

RULES:
1. Output ONLY a raw JSON Array.
2. Wrap your JSON array exactly in <JSON_START> and <JSON_END> tags.
3. Do NOT add any conversational text or summarize the reports in markdown.
4. If there are more suggestions for a single file, DIVIDE THEM in two "files".
5. If there are NO issues, return an empty array: <JSON_START>[]<JSON_END>

REQUIRED ARRAY SCHEMA:
${FinalReportSchema}

EXAMPLE OF EXPECTED OUTPUT:
<JSON_START>
[
  {
    "agentName": "OWASP",
    "files": [
      {
        "filePath": "src/Container.cpp",
        "findings": [
          {
            "reason:": "Memory Leak due to missing smart pointers.",
            "startLine": 11,
            "endLine": 13,
            "originalCode": "wrong code{...}",
            "proposedCorrection": "corrected code{...}"
          }
        ]
      }
    ],
    "agentName": "TEST",
    "files": [ . . .],
    "agentName": "DOCS",
    "files": [ . . .],
  }
]
<JSON_END>`;

      const aggregatorAgent = new Agent({
        name: 'Final_Orchestrator',
        model: bedrockModel,
        systemPrompt: systemInstruction,
        // Mantengo il tuo schema per l'SDK, ma ci affidiamo alla nostra validazione manuale
        structuredOutputSchema: FinalReportSchema,
      });

      // ==========================================
      // 4. ESTRAZIONE CON AUTO-RETRY
      // ==========================================
      let attempt = 1;
      const maxAttempts = 3;
      let isSuccess = false;
      let parsedArray: z.infer<typeof FinalReportSchema> = [];

      let currentPrompt = `Analyze the following reports and extract all findings into a strict JSON array matching the requested schema. DO NOT output any markdown reports, ONLY output the JSON array.\n\nREPORTS to process:\n\n${combinedMarkdown}`;

      while (attempt <= maxAttempts && !isSuccess) {
        console.log(
          `[Bedrock] Tentativo di estrazione ${attempt} di ${maxAttempts}...`,
        );

        try {
          const finalResponse = await aggregatorAgent.invoke(currentPrompt);
          const rawText =
            (finalResponse?.lastMessage?.content[0] as any)?.text || '';

          // Estrazione sicura della stringa JSON
          let jsonStringToParse = '';
          const startTag = '<JSON_START>';
          const endTag = '<JSON_END>';
          const startIndex = rawText.indexOf(startTag);
          const endIndex = rawText.lastIndexOf(endTag);

          if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
            jsonStringToParse = rawText.substring(
              startIndex + startTag.length,
              endIndex,
            );
          } else {
            console.warn(
              `[Bedrock] Tag <JSON_START>/<JSON_END> assenti. Tento fallback array...`,
            );
            const firstBracket = rawText.indexOf('[');
            const lastBracket = rawText.lastIndexOf(']');
            if (
              firstBracket !== -1 &&
              lastBracket !== -1 &&
              lastBracket > firstBracket
            ) {
              jsonStringToParse = rawText.substring(
                firstBracket,
                lastBracket + 1,
              );
            }
          }

          if (!jsonStringToParse) {
            throw new Error(
              'Nessuna struttura JSON rilevata nel testo restituito.',
            );
          }

          // Parsing puro
          const rawJson = JSON.parse(jsonStringToParse);

          // Validazione con Zod (safeParse non lancia eccezioni)
          const validation = FinalReportSchema.safeParse(rawJson);

          if (validation.success) {
            parsedArray = validation.data;
            isSuccess = true;
            console.log(
              `[Bedrock] Estrazione completata e validata con successo al tentativo ${attempt}!`,
            );
          } else {
            // Se lo schema è errato, prepariamo il modello a riprovare
            console.warn(
              `[Bedrock] Validazione Zod fallita al tentativo ${attempt}. Chiedo correzione al modello...`,
            );

            // Passiamo l'errore esatto di Zod al modello in modo che capisca dove ha sbagliato
            const errorMessage = JSON.stringify(validation.error.format());
            currentPrompt = `Your previous JSON output was structurally invalid according to the required schema. 
Zod Validation Error: ${errorMessage}

Please fix the JSON structure to exactly match the REQUIRED ARRAY SCHEMA. Do not add any new properties. Return ONLY the corrected JSON wrapped in <JSON_START> and <JSON_END> tags.`;
          }
        } catch (error: any) {
          console.warn(
            `[Bedrock] Errore di esecuzione al tentativo ${attempt}: ${error.message}`,
          );
          currentPrompt = `Your previous output caused a parsing error: ${error.message}. 
Ensure you output valid JSON and remember to wrap it inside <JSON_START> and <JSON_END>. Try again.`;
        }

        attempt++;
      }

      // Se dopo tutti i tentativi fallisce, usiamo un fallback vuoto per non bloccare tutto
      if (!isSuccess) {
        console.error(
          `[Bedrock] Impossibile estrarre un JSON valido dopo ${maxAttempts} tentativi. Restituisco array vuoto.`,
        );
        parsedArray = [];
      }

      // 5. Calcolo totali usando i dati validati
      let totalIssues = 0;
      parsedArray.forEach((agent) => {
        agent.files?.forEach((file: any) => {
          totalIssues += file.findings?.length || 0;
        });
      });

      return {
        jobId,
        status: totalIssues > 0 ? 'fallito' : 'successo',
        totalIssuesFound: totalIssues,
        analysisDetails: parsedArray,
      };
    } catch (error: any) {
      console.error('Errore AGGREGATE:', error?.message, error?.stack);
      return {
        jobId: event.payload?.jobId ?? 'unknown',
        status: 'fallito',
        totalIssuesFound: 0,
        analysisDetails: [],
      };
    }
  }

  // Azione non riconosciuta
  console.error('Azione non riconosciuta:', event.action);
  return {
    jobId: event.payload?.jobId ?? 'unknown',
    status: 'fallito',
    totalIssuesFound: 0,
    analysisDetails: [],
  };
};
