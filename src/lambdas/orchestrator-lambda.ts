import { S3Client, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { z } from 'zod';

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
    const isRelease = repoMetadata?.tags?.length > 0 || repoMetadata?.hasChangelog;
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
            const response = await s3Client.send(new GetObjectCommand({
              Bucket: s3Bucket, Key: report.reportKey,
            }));
            let content = await streamToString(response.Body);
            if (content.length > 8000) {
              content = content.substring(0, 8000) + '\n...[TRUNCATED DUE TO LENGTH]';
            }
            combinedMarkdown += `\n--- ${report.agent.toUpperCase()} REPORT ---\n${content}\n`;
            await s3Client.send(new DeleteObjectCommand({
              Bucket: s3Bucket, Key: report.reportKey,
            }));
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

      // 2. Chiamata a Bedrock
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
                  (block: any) => !(block.type === 'text' && (block.text ?? '').trim() === '')
                )
              : msg.content,
          }));
        }
        yield* originalStream(params);
      };

      const systemInstruction = `You are a strict data extraction tool. Extract ONLY the vulnerabilities, code snippets, and coverage issues from the provided reports.

RULES:
1. Output ONLY a raw JSON Array.
2. Wrap your JSON array exactly in <JSON_START> and <JSON_END> tags.
3. Do NOT add any conversational text or summarize the reports in markdown.
4. If there are NO issues, return an empty array: <JSON_START>[]<JSON_END>

REQUIRED ARRAY SCHEMA:
[
  {
    "agentName": "string",
    "files": [
      {
        "filePath": "string",
        "findings": [
          { "startLine": 0, "endLine": 0, "reason": "string", "originalCode": "string", "proposedCorrection": "string" }
        ]
      }
    ]
  }
]`;

      const aggregatorAgent = new Agent({
        name: 'Final_Orchestrator',
        model: bedrockModel,
        systemPrompt: systemInstruction,
      });

      const finalResponse = await aggregatorAgent.invoke(
        `Analyze the following reports and extract all findings into a strict JSON array matching the requested schema. DO NOT output any markdown reports, ONLY output the JSON array.\n\nREPORTS to process:\n\n${combinedMarkdown}`
      );

      const rawText = (finalResponse?.lastMessage?.content[0] as any)?.text || '';

      const startTag = '<JSON_START>';
      const endTag = '<JSON_END>';
      const startIndex = rawText.indexOf(startTag);
      const endIndex = rawText.lastIndexOf(endTag);

      let parsedArray: any[] = [];
      if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
        const jsonString = rawText.substring(startIndex + startTag.length, endIndex);
        try {
          parsedArray = JSON.parse(jsonString);
        } catch (parseError: any) {
          console.error('Errore durante il parsing del JSON (nei tag) generato da Bedrock:', parseError.message);
          parsedArray = [];
        }
      } else {
        console.warn('Tag JSON_START o JSON_END non trovati, tento parsing di fallback...');
        const firstBracket = rawText.indexOf('[');
        const lastBracket = rawText.lastIndexOf(']');
        if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
          const jsonString = rawText.substring(firstBracket, lastBracket + 1);
          try {
            parsedArray = JSON.parse(jsonString);
          } catch (e: any) {
            console.error('Fallback JSON parsing failed:', e.message);
          }
        }
      }

      let totalIssues = 0;
      if (Array.isArray(parsedArray)) {
        parsedArray.forEach((agent) => {
          if (agent.files && Array.isArray(agent.files)) {
            agent.files.forEach((file: any) => {
              totalIssues += file.findings?.length || 0;
            });
          }
        });
      }

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