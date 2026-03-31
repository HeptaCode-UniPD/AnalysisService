import {
  S3Client,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import {
  LambdaClient,
  InvokeCommand,
  InvocationType,
} from '@aws-sdk/client-lambda';
import { z } from 'zod';
import {
  AgentReportSchema,
  FindingSchema,
  type AgentReport,
} from './utils/extract-json-from-markdown';

// ==========================================
// SCHEMAS ORCHESTRATORE
// ==========================================
const MetadataExtractionSchema = z.object({
  area: z.string().default('UNKNOWN'),
  summary: z.string().default('Nessun sommario provvisto.'),
  totalIssues: z.number().default(0),
});

const FlatFindingSchema = z.object({
  filePath: z.string().default(''),
  reason: z.string().default(''),
  startLine: z.number().default(0),
  endLine: z.number().default(0),
  originalCode: z.string().default(''),
  proposedCorrection: z.string().default(''),
});

const s3Client = new S3Client({ region: process.env.AWS_REGION });
const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION });

const streamToString = (stream: any): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: any[] = [];
    stream.on('data', (chunk: any) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });

const MAX_RETRIES = 5;

// ==========================================
// Bedrock call helper (Two-Step validation retry)
// ==========================================
async function callAgentWithRetry<T = any>(
  agent: any,
  promptText: string,
  schema: z.ZodType<T>,
  maxAttempts = MAX_RETRIES,
): Promise<T | null> {
  let attempt = 1;
  let currentPrompt = promptText;

  while (attempt <= maxAttempts) {
    console.log(`[Bedrock Helper] Attempt ${attempt}/${maxAttempts}...`);
    try {
      const finalResponse = await agent.invoke(currentPrompt);
      const rawText =
        (finalResponse?.lastMessage?.content[0] as any)?.text || '';

      let jsonString = '';
      const startTag = '<JSON_START>';
      const endTag = '<JSON_END>';
      const sIdx = rawText.indexOf(startTag);
      const eIdx = rawText.lastIndexOf(endTag);

      if (sIdx !== -1 && eIdx !== -1 && eIdx > sIdx) {
        jsonString = rawText.substring(sIdx + startTag.length, eIdx);
      } else {
        const fBracket = rawText.indexOf('{');
        const lBracket = rawText.lastIndexOf('}');
        const fArr = rawText.indexOf('[');
        const lArr = rawText.lastIndexOf(']');
        const first = Math.min(
          fBracket !== -1 ? fBracket : Infinity,
          fArr !== -1 ? fArr : Infinity,
        );
        const last = Math.max(lBracket, lArr);
        if (first !== Infinity && last !== -1) {
          jsonString = rawText.substring(first, last + 1);
        }
      }

      if (!jsonString) throw new Error('No JSON structure found in output.');

      const parsed = JSON.parse(jsonString);
      const validation = schema.safeParse(parsed);

      if (validation.success) {
        return validation.data;
      } else {
        currentPrompt = `Invalid JSON. Zod Error: ${JSON.stringify(validation.error.format())}. Return ONLY corrected JSON wrapped in <JSON_START> and <JSON_END>. NEVER apologize.`;
      }
    } catch (e: any) {
      currentPrompt = `JSON parsing error: ${e.message}. Return valid JSON wrapped in <JSON_START> and <JSON_END>. NEVER apologize.`;
    }
    attempt++;
  }
  return null;
}

// ==========================================
// Re-invoke a specific agent Lambda
// ==========================================
async function reInvokeAgent(
  lambdaName: string,
  payload: object,
): Promise<{ reportKey?: string; status?: string }> {
  console.log(`[Orchestrator] Re-invoking agent Lambda: ${lambdaName}...`);
  try {
    const response = await lambdaClient.send(
      new InvokeCommand({
        FunctionName: lambdaName,
        InvocationType: InvocationType.RequestResponse,
        Payload: Buffer.from(JSON.stringify(payload)),
      }),
    );
    if (response.Payload) {
      const result = JSON.parse(Buffer.from(response.Payload).toString('utf-8'));
      return result?.Payload ?? result;
    }
  } catch (e: any) {
    console.error(`[Orchestrator] Re-invoke of ${lambdaName} failed: ${e.message}`);
  }
  return {};
}

// ==========================================
// Validates and standardizes an AgentReport
// using the Two-Step LLM pattern
// ==========================================
async function standardizeReport(
  agent: any,
  agentName: string,
  reportJson: any,
): Promise<AgentReport> {
  // --- STEP 1: Extract metadata (from JSON, very simple) ---
  const metaPrompt = `You are a strict data extraction robot. NEVER apologize.
Read this JSON object and extract: area (agent name), summary (string), totalIssues (integer).
Return ONLY JSON matching { "area": "string", "summary": "string", "totalIssues": 0 } wrapped in <JSON_START> and <JSON_END>.

INPUT JSON:
${JSON.stringify(reportJson).substring(0, 4000)}`;

  const metadata = await callAgentWithRetry(agent, metaPrompt, MetadataExtractionSchema);

  const area = metadata?.area || agentName.toUpperCase();
  const summary = metadata?.summary || 'Nessun sommario provvisto.';
  const totalIssues = metadata?.totalIssues ?? (reportJson?.files?.flatMap((f: any) => f.findings ?? []).length || 0);

  let groupedFiles: any[] = [];

  // --- STEP 2: Fill findings if present ---
  if (totalIssues > 0) {
    const expectedFlatSchema = `[ { "filePath": "string", "reason": "string", "startLine": 0, "endLine": 0, "originalCode": "string", "proposedCorrection": "string" } ]`;
    const schemaWithSkeletons = z.array(FlatFindingSchema);

    const fillerPrompt = `You are a strict data extraction robot. NEVER apologize.
Extract details for precisely ${totalIssues} unique issues from the JSON below.
Return ONLY a JSON array with EXACTLY ${totalIssues} elements matching: ${expectedFlatSchema}
Wrap in <JSON_START> and <JSON_END>.

REPORT JSON:
${JSON.stringify(reportJson).substring(0, 12000)}`;

    const flatFindings = await callAgentWithRetry(agent, fillerPrompt, schemaWithSkeletons, MAX_RETRIES);

    if (flatFindings) {
      const fileMap: Record<string, any> = {};
      for (const item of flatFindings) {
        if (!fileMap[item.filePath]) {
          fileMap[item.filePath] = { filePath: item.filePath, findings: [] };
        }
        fileMap[item.filePath].findings.push({
          reason: item.reason,
          startLine: item.startLine,
          endLine: item.endLine,
          originalCode: item.originalCode,
          proposedCorrection: item.proposedCorrection,
        });
      }
      groupedFiles = Object.values(fileMap);
    } else {
      // Fallback: use files directly from input JSON if LLM fails
      groupedFiles = reportJson?.files ?? [];
    }
  }

  return {
    agentName: area as 'OWASP' | 'TEST' | 'DOCS',
    summary,
    totalIssues,
    files: groupedFiles,
  };
}

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

      const { jobId, s3Bucket, reports, agentPayloads } = event.payload;

      const bedrockModel = new BedrockModel({
        modelId: 'eu.amazon.nova-pro-v1:0',
        region: 'eu-central-1',
        temperature: 0,
      });

      // Patch to remove empty text blocks
      const originalStream = bedrockModel.stream.bind(bedrockModel);
      (bedrockModel as any).stream = async function* (params: any) {
        if (params?.messages) {
          params.messages = params.messages.map((msg: any) => ({
            ...msg,
            content: Array.isArray(msg.content)
              ? msg.content.filter(
                  (block: any) =>
                    !(block.type === 'text' && (block.text ?? '').trim() === ''),
                )
              : msg.content,
          }));
        }
        yield* originalStream(params);
      };

      const standardizerAgent = new Agent({
        name: 'ReportStandardizer',
        model: bedrockModel,
        systemPrompt:
          'You are a strict JSON extraction robot. You NEVER apologize and NEVER output conversational text. You only output valid JSON.',
      });

      let parsedAnalysisDetails: AgentReport[] = [];
      let totalIssuesOverall = 0;

      for (const report of reports) {
        const agentLabel = report.agent?.toUpperCase() || 'UNKNOWN';

        // Determine S3 key (use .json if available, fallback aware)
        const reportKey = report.reportKey;
        if (!reportKey) {
          console.warn(`[Orchestrator] No reportKey for agent ${agentLabel}, skipping.`);
          continue;
        }

        // --- Download JSON from S3 ---
        let reportJson: any = null;
        try {
          const response = await s3Client.send(
            new GetObjectCommand({ Bucket: s3Bucket, Key: reportKey }),
          );
          const rawContent = await streamToString(response.Body);
          reportJson = JSON.parse(rawContent);

          await s3Client.send(
            new DeleteObjectCommand({ Bucket: s3Bucket, Key: reportKey }),
          );
        } catch (err: any) {
          console.error(`[Orchestrator] Failed to download/parse JSON for ${agentLabel}: ${err.message}`);
        }

        // --- Zod primary validation ---
        let isValid = false;
        if (reportJson) {
          const v = AgentReportSchema.safeParse(reportJson);
          isValid = v.success;
          if (!isValid) {
            console.warn(`[Orchestrator] Agent ${agentLabel} JSON failed primary Zod validation. Will re-invoke.`);
          }
        }

        // --- Re-invoke agent if JSON invalid/missing ---
        if (!isValid && agentPayloads?.[report.agent]) {
          console.log(`[Orchestrator] Re-invoking ${agentLabel} Lambda...`);
          const lambdaName = `ms2-analysis-service-${process.env.STAGE || 'v2'}-${report.agent}Agent`;
          const reResult = await reInvokeAgent(lambdaName, agentPayloads[report.agent]);

          if (reResult?.reportKey) {
            try {
              const reResponse = await s3Client.send(
                new GetObjectCommand({ Bucket: s3Bucket, Key: reResult.reportKey }),
              );
              const rawContent = await streamToString(reResponse.Body);
              reportJson = JSON.parse(rawContent);
              await s3Client.send(
                new DeleteObjectCommand({ Bucket: s3Bucket, Key: reResult.reportKey }),
              );
            } catch (err: any) {
              console.error(`[Orchestrator] Re-invoke download failed for ${agentLabel}: ${err.message}`);
            }
          }
        }

        // --- Two-Step Standardization ---
        if (reportJson) {
          console.log(`[Orchestrator] Standardizing report for ${agentLabel}...`);
          const standardized = await standardizeReport(standardizerAgent, agentLabel, reportJson);
          parsedAnalysisDetails.push(standardized);
          totalIssuesOverall += standardized.totalIssues;
        } else {
          // Clean empty fallback
          parsedAnalysisDetails.push({
            agentName: agentLabel as 'OWASP' | 'TEST' | 'DOCS',
            summary: 'Analisi non disponibile.',
            totalIssues: 0,
            files: [],
          });
        }
      }

      return {
        jobId,
        status: totalIssuesOverall > 0 ? 'fallito' : 'successo',
        totalIssuesFound: totalIssuesOverall,
        analysisDetails: parsedAnalysisDetails,
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

  console.error('Azione non riconosciuta:', event.action);
  return {
    jobId: event.payload?.jobId ?? 'unknown',
    status: 'fallito',
    totalIssuesFound: 0,
    analysisDetails: [],
  };
};
