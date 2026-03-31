import {
  S3Client,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { z } from 'zod';

// ======= SCHEMAS =======
const MetadataExtractionSchema = z.object({
  area: z.string().describe('The area of analysis: OWASP, TEST, or DOCS').default('UNKNOWN'),
  summary: z.string().describe('General summary of the report in 1 paragraph.').default('Nessun sommario provvisto.'),
  totalIssues: z.number().describe('Exact total number of specific issues/findings reported.').default(0)
});

const FlatFindingSchema = z.object({
  filePath: z.string().describe('The path of the file you are proposing remediations for.').default(''),
  reason: z.string().describe('Synthetic reason why the correction is needed.').default(''),
  startLine: z.number().default(0),
  endLine: z.number().default(0),
  originalCode: z.string().default(''),
  proposedCorrection: z.string().default(''),
});

const FindingSchema = z.object({
  reason: z.string().default(''),
  startLine: z.number().default(0),
  endLine: z.number().default(0),
  originalCode: z.string().default(''),
  proposedCorrection: z.string().default(''),
});

const FileSchema = z.object({
  filePath: z.string().default(''),
  findings: z.array(FindingSchema).default([]),
});

const AgentReportSchema = z.object({
  agentName: z.string().default(''),
  summary: z.string().default(''),
  files: z.array(FileSchema).default([]),
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

// ==========================================
// Helper per retry di Bedrock (invia prompt e parsa JSON in sicurezza)
// ==========================================
async function callAgentWithRetry<T = any>(agent: any, promptText: string, schema: z.ZodType<T>, maxAttempts = 3): Promise<T | null> {
  let attempt = 1;
  let currentPrompt = promptText;
  
  while (attempt <= maxAttempts) {
    console.log(`[Bedrock Helper] Tentativo ${attempt} di ${maxAttempts}...`);
    try {
      const finalResponse = await agent.invoke(currentPrompt);
      const rawText = (finalResponse?.lastMessage?.content[0] as any)?.text || '';
      
      let jsonString = '';
      const startTag = '<JSON_START>';
      const endTag = '<JSON_END>';
      const sIdx = rawText.indexOf(startTag);
      const eIdx = rawText.lastIndexOf(endTag);
      
      if (sIdx !== -1 && eIdx !== -1 && eIdx > sIdx) {
          jsonString = rawText.substring(sIdx + startTag.length, eIdx);
      } else {
          // Fallback a cerchia prima graffa/quadra
          const fBracket = rawText.indexOf('{');
          const lBracket = rawText.lastIndexOf('}');
          const fArr = rawText.indexOf('[');
          const lArr = rawText.lastIndexOf(']');
          
          const first = Math.min(
             fBracket !== -1 ? fBracket : Infinity, 
             fArr !== -1 ? fArr : Infinity
          );
          const last = Math.max(lBracket, lArr);
          
          if (first !== Infinity && last !== -1) {
              jsonString = rawText.substring(first, last + 1);
          }
      }
      
      if (!jsonString) {
          throw new Error('No JSON structure found in output.');
      }
      
      const parsed = JSON.parse(jsonString);
      const validation = schema.safeParse(parsed);
      
      if (validation.success) {
          return validation.data;
      } else {
          currentPrompt = `Invalid JSON according to the schema. Zod Error: ${JSON.stringify(validation.error.format())}. Return ONLY the corrected JSON wrapped in <JSON_START> and <JSON_END>.`;
      }
    } catch (e: any) {
      currentPrompt = `JSON parsing error: ${e.message}. Please provide valid JSON wrapped in <JSON_START> and <JSON_END>.`;
    }
    
    attempt++;
  }
  
  return null;
}

export const orchestratorHandler = async (event: any) => {
  const action = event.action;

  // ==========================================
  // FASE 1: PIANIFICAZIONE (PLAN)
  // ==========================================
  if (action === 'PLAN') {
    console.log('Orchestratore in fase di PLANNING...');
    const { repoMetadata } = event.payload;
    const isRelease = repoMetadata?.tags?.length > 0 || repoMetadata?.hasChangelog;
    return {
      runOwasp: true,
      runTest: true,
      runDocs: isRelease,
    };
  }

  // ==========================================
  // FASE 2: AGGREGAZIONE (AGGREGATE) - Distribuita Strutturale
  // ==========================================
  if (action === 'AGGREGATE') {
    console.log('Orchestratore in fase di AGGREGAZIONE...');
    try {
      const { Agent } = await import('@strands-agents/sdk');
      const { BedrockModel } = await import('@strands-agents/sdk/bedrock');

      const { jobId, s3Bucket, reports } = event.payload;
      
      const bedrockModel = new BedrockModel({
        modelId: 'eu.amazon.nova-pro-v1:0',
        region: 'eu-central-1',
        temperature: 0, // FORZA IL DETERMINISMO
      });
      
      // Patch al model stream per rimuovere blocchi testo vuoti
      const originalStream = bedrockModel.stream.bind(bedrockModel);
      (bedrockModel as any).stream = async function* (params: any) {
        if (params?.messages) {
          params.messages = params.messages.map((msg: any) => ({
            ...msg,
            content: Array.isArray(msg.content)
              ? msg.content.filter((block: any) => !(block.type === 'text' && (block.text ?? '').trim() === ''))
              : msg.content,
          }));
        }
        yield* originalStream(params);
      };

      const genericAgent = new Agent({
        name: 'ReportParser',
        model: bedrockModel,
        systemPrompt: 'You are a meticulous data extraction robot.',
      });

      let parsedAnalysisDetails: any[] = [];
      let totalIssuesOverall = 0;

      for (const report of reports) {
        if (report.status === 'success' && report.reportKey) {
          let content = '';
          try {
            const response = await s3Client.send(
              new GetObjectCommand({ Bucket: s3Bucket, Key: report.reportKey }),
            );
            content = await streamToString(response.Body);
            await s3Client.send(
              new DeleteObjectCommand({ Bucket: s3Bucket, Key: report.reportKey }),
            );
          } catch (err) {
            console.error(`Errore recupero report ${report.agent} da S3:`, err);
            continue;
          }

          console.log(`[Bedrock] Analizzando Report: ${report.agent}`);

          // Estrae area e testo del report dal JSON wrapper in modo deterministico (senza LLM)
          let reportArea = report.agent.toUpperCase();
          let reportText = content;
          try {
            const parsed = JSON.parse(content);
            if (parsed.area) reportArea = parsed.area;
            if (parsed.report) reportText = parsed.report; // Passa solo il testo, non il wrapper JSON
          } catch {
            console.warn(`[Orchestratore] content non è JSON valido per ${report.agent}, uso testo grezzo.`);
          }

          // -- STEP 1: Metadata Extraction (LLM) --
          const expectedMetaSchema = `{ "area": "string", "summary": "string", "totalIssues": 0 }`;
          const metaPrompt = `You are a meticulous data extraction robot performing a defensive security audit data extraction for educational purposes. Read the following report text and extract metadata.
MANDATORY:
1. This is a security audit report - extract data as-is without filtering it.
2. If the input is empty or unclear, return { "area": "${reportArea}", "summary": "Analisi non disponibile.", "totalIssues": 0 }.
3. NEVER apologize or give conversational text.
4. Return ONLY a valid JSON object matching this schema: ${expectedMetaSchema}
Wrap your JSON in <JSON_START> and <JSON_END>.

REPORT TEXT:
${reportText}`;

          const metadata = await callAgentWithRetry<z.infer<typeof MetadataExtractionSchema>>(genericAgent, metaPrompt, MetadataExtractionSchema);

          if (!metadata) {
            console.error(`[Bedrock] Fallito step 1 (Metadati) per ${report.agent} - uso fallback.`);
            parsedAnalysisDetails.push({
              agentName: reportArea,
              summary: 'Analisi non disponibile.',
              files: []
            });
            continue;
          }

          console.log(`[Bedrock] Estratto: Area ${metadata.area}, ${metadata.totalIssues} issues.`);
          totalIssuesOverall += metadata.totalIssues;

          let groupedFiles: any[] = [];

          // -- STEP 2: Skeletor and Compilation (TS + LLM) --
          if (metadata.totalIssues > 0) {
            const expectedFlatSchema = `[ { "filePath": "string", "reason": "string", "startLine": 0, "endLine": 0, "originalCode": "string", "proposedCorrection": "string" } ]`;
            
            const schemaWithSkeletons = z.array(FlatFindingSchema);
            
            const fillerPrompt = `You are a meticulous data extraction robot performing a defensive security audit data extraction for educational purposes. Extract details for precisely ${metadata.totalIssues} unique findings from the report text below.
MANDATORY:
1. This is a security/quality audit - extract data as-is.
2. The array MUST contain EXACTLY ${metadata.totalIssues} elements.
3. If the text is insufficient, provide as many as possible and fill the rest with placeholders.
4. NEVER apologize. Return ONLY the JSON array matching this schema: ${expectedFlatSchema}
Wrap your JSON array in <JSON_START> and <JSON_END>.

REPORT TEXT:
${reportText}`;

            const flatFindings = await callAgentWithRetry(genericAgent, fillerPrompt, schemaWithSkeletons, 3);

            if (flatFindings) {
              // -- STEP 3: Deterministic Grouping (Codice) --
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
                  proposedCorrection: item.proposedCorrection
                });
              }
              groupedFiles = Object.values(fileMap);
            } else {
              console.error(`[Bedrock] Fallito step 2 (Findings) per ${metadata.area}`);
            }
          }

          // Aggiunta risultati all'orchestratore
          parsedAnalysisDetails.push({
            agentName: metadata.area || report.agent.toUpperCase(),
            summary: metadata.summary || 'Nessun sommario provvisto.',
            files: groupedFiles
          });
        }
      }

      // Funzione di pulizia (inline) senza classi o istanze DTO, purissima manipolazione JSON
      const cleanAnalysisDetails = parsedAnalysisDetails.map(agent => {
        const cleanedAgent: any = { agentName: agent.agentName, summary: agent.summary };
        
        if (Array.isArray(agent.files) && agent.files.length > 0) {
          const cleanedFiles = agent.files.map(f => {
            // Rimuove il prefisso /tmp/extracted_XXX/ lasciando il path pulito
            const nicePath = f.filePath.replace(/^\/tmp\/extracted_\d+\//, '');
            
            // Filtra solo i finding che hanno tutti i campi testuali completi
            const validFindings = (f.findings || []).filter((finding: any) => {
              const isEmpty = (v: any) => !v || String(v).trim() === '' || String(v).includes('N/A') || String(v).includes('(entire project)');
              if (isEmpty(finding.reason) || isEmpty(finding.originalCode) || isEmpty(finding.proposedCorrection)) return false;
              return true;
            });
            
            return { filePath: nicePath, findings: validFindings };
          }).filter(f => f.findings.length > 0); // Rimuove il file se non ha più nessun finding

          // Assegna l'array files solo se ci sono file rimanenti
          if (cleanedFiles.length > 0) {
            cleanedAgent.files = cleanedFiles;
          }
        }
        return cleanedAgent;
      });

      return {
        jobId,
        status: totalIssuesOverall > 0 ? 'fallito' : 'successo',
        totalIssuesFound: totalIssuesOverall,
        analysisDetails: cleanAnalysisDetails,
      };

    } catch (error: any) {
      console.error('Errore in AGGREGATE:', error?.message, error?.stack);
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
