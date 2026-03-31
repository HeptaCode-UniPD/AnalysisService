import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { z } from 'zod';

// =====================================================
// SCHEMA CONDIVISO (usato da tutti gli agenti e dall'orchestratore)
// =====================================================
export const FindingSchema = z.object({
  reason: z.string().default(''),
  startLine: z.number().default(0),
  endLine: z.number().default(0),
  originalCode: z.string().default(''),
  proposedCorrection: z.string().default(''),
});

export const FileSchema = z.object({
  filePath: z.string().default(''),
  findings: z.array(FindingSchema).default([]),
});

export const AgentReportSchema = z.object({
  agentName: z.enum(['OWASP', 'TEST', 'DOCS']),
  summary: z.string().default(''),
  totalIssues: z.number().default(0),
  files: z.array(FileSchema).default([]),
});

export type AgentReport = z.infer<typeof AgentReportSchema>;

const bedrockRuntimeClient = new BedrockRuntimeClient({ region: 'eu-central-1' });
const MAX_RETRIES = 5;

const SCHEMA_EXAMPLE = JSON.stringify({
  agentName: 'OWASP',
  summary: '1-paragraph summary of the analysis area.',
  totalIssues: 2,
  files: [
    {
      filePath: '/tmp/extracted_xxx/src/app.php',
      findings: [
        {
          reason: 'Reason why this is an issue.',
          startLine: 10,
          endLine: 12,
          originalCode: 'the original code snippet',
          proposedCorrection: 'the corrected code snippet',
        },
      ],
    },
  ],
}, null, 2);

function extractJsonBlock(text: string): string | null {
  const startTag = '<JSON_START>';
  const endTag = '<JSON_END>';
  const sIdx = text.indexOf(startTag);
  const eIdx = text.lastIndexOf(endTag);
  if (sIdx !== -1 && eIdx !== -1 && eIdx > sIdx) {
    return text.substring(sIdx + startTag.length, eIdx).trim();
  }
  // Fallback: first { to last }
  const fBrace = text.indexOf('{');
  const lBrace = text.lastIndexOf('}');
  if (fBrace !== -1 && lBrace !== -1 && lBrace > fBrace) {
    return text.substring(fBrace, lBrace + 1).trim();
  }
  return null;
}

export async function extractJsonFromMarkdown(
  markdownText: string,
  agentName: 'OWASP' | 'TEST' | 'DOCS',
): Promise<AgentReport | null> {
  let currentPrompt = buildPrompt(markdownText, agentName);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`[extractJson:${agentName}] Attempt ${attempt}/${MAX_RETRIES}`);
    try {
      const body = JSON.stringify({
        messages: [{ role: 'user', content: currentPrompt }],
        inferenceConfig: { temperature: 0, maxTokens: 4096 },
      });

      const command = new InvokeModelCommand({
        modelId: 'eu.amazon.nova-pro-v1:0',
        contentType: 'application/json',
        accept: 'application/json',
        body: Buffer.from(body),
      });

      const response = await bedrockRuntimeClient.send(command);
      const rawBody = Buffer.from(response.body).toString('utf-8');
      const parsed = JSON.parse(rawBody);
      const rawText: string =
        parsed?.output?.message?.content?.[0]?.text ||
        parsed?.content?.[0]?.text ||
        '';

      const jsonBlock = extractJsonBlock(rawText);
      if (!jsonBlock) {
        throw new Error('No JSON block found in model output.');
      }

      const rawJson = JSON.parse(jsonBlock);
      const validation = AgentReportSchema.safeParse({
        ...rawJson,
        agentName, // enforce correct agent name
      });

      if (validation.success) {
        console.log(`[extractJson:${agentName}] SUCCESS on attempt ${attempt}.`);
        return validation.data;
      } else {
        const errorMsg = JSON.stringify(validation.error.format());
        console.warn(`[extractJson:${agentName}] Zod validation failed: ${errorMsg}`);
        currentPrompt = `Your previous JSON was structurally invalid. Zod Error: ${errorMsg}.\nFix the JSON and return it wrapped in <JSON_START> and <JSON_END>. The agentName MUST be "${agentName}".`;
      }
    } catch (e: any) {
      console.warn(`[extractJson:${agentName}] Error on attempt ${attempt}: ${e.message}`);
      currentPrompt = `Your previous output caused an error: ${e.message}.\nReturn ONLY valid JSON wrapped in <JSON_START> and <JSON_END>.`;
    }
  }

  console.error(`[extractJson:${agentName}] FAILED after ${MAX_RETRIES} attempts. Returning null.`);
  return null;
}

function buildPrompt(markdown: string, agentName: string): string {
  return `You are a strict data extraction robot. You NEVER apologize and NEVER output explanations.

Read the following analysis report and convert it into a single JSON object.

MANDATORY RULES:
1. The "agentName" field MUST be exactly "${agentName}".
2. The "files" array must contain one entry per file mentioned with issues.
3. Each finding MUST have all fields: reason, startLine, endLine, originalCode, proposedCorrection.
4. If no issues were found, return an empty "files" array and set "totalIssues" to 0.
5. NEVER include apologies, explanations, or markdown formatting.
6. Wrap your output in <JSON_START> and <JSON_END> tags.

REQUIRED JSON SCHEMA:
${SCHEMA_EXAMPLE}

REPORT TO CONVERT:
${markdown.substring(0, 16000)}`;
}
