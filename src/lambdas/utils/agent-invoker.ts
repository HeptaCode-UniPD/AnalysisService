import {
  BedrockAgentRuntimeClient,
  InvokeAgentCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { randomUUID } from 'crypto';
import { sanitizeMarkdown, rawAgentOutput } from './markdown-helper';

const bedrockClient = new BedrockAgentRuntimeClient({ region: process.env.AWS_REGION });

const TOOL_DENIAL_RESPONSE = (functionName: string) =>
  `Tool "${functionName}" is not available in this execution context. ` +
  `You have already received all the necessary context in the prompt. ` +
  `Analyze only the text provided and produce the requested Markdown report without using any tools.`;

/**
 * Invoca un Agente Bedrock gestendo returnControl (tentativo di tool use).
 *
 * @param isLead - se true, applica sanitizeMarkdown al risultato finale
 *                 (rimuove backtick wrapper e tag XML).
 *                 Per i sotto-agenti intermedi usare false: il loro output
 *                 viene concatenato grezzo e pulito solo alla fine dal Lead.
 */
export async function invokeSubAgent(
  agentId: string,
  agentAliasId: string,
  prompt: string,
  agentName: string,
  isLead = false,
): Promise<string> {
  const sessionId = randomUUID();
  let invocationId: string | undefined;
  let returnControlResults: any[] = [];
  let loopCount = 0;
  const MAX_LOOPS = 10;

  while (loopCount < MAX_LOOPS) {
    loopCount++;

    const command = new InvokeAgentCommand({
      agentId,
      agentAliasId,
      sessionId,
      ...(invocationId
        ? {
            sessionState: {
              invocationId,
              returnControlInvocationResults: returnControlResults,
            },
          }
        : { inputText: prompt }),
    });

    let fullText = '';
    let returnControlDetected = false;
    invocationId = undefined;
    returnControlResults = [];

    try {
      const response = await bedrockClient.send(command);

      if (!response.completion) {
        console.warn(`[${agentName}] response.completion undefined al loop ${loopCount}`);
        break;
      }

      for await (const event of response.completion) {
        if (event.chunk) {
          fullText += new TextDecoder().decode(event.chunk.bytes);
        } else if (event.returnControl) {
          returnControlDetected = true;
          invocationId = event.returnControl.invocationId;

          for (const inv of event.returnControl.invocationInputs || []) {
            const isFn  = !!inv.functionInvocationInput;
            const isApi = !!inv.apiInvocationInput;

            const actionGroup  = isFn ? inv.functionInvocationInput!.actionGroup  : inv.apiInvocationInput!.actionGroup;
            const functionName = isFn ? inv.functionInvocationInput!.function     : inv.apiInvocationInput!.apiPath?.replace(/^\//, '') || 'unknown';

            console.warn(`[${agentName}] Tool use intercettato: ${functionName} — rispondo con diniego.`);

            if (isFn) {
              returnControlResults.push({
                functionResult: {
                  actionGroup,
                  function: functionName,
                  responseBody: { TEXT: { body: TOOL_DENIAL_RESPONSE(functionName!) } },
                },
              });
            } else {
              returnControlResults.push({
                apiResult: {
                  actionGroup,
                  apiPath:        inv.apiInvocationInput!.apiPath!,
                  httpMethod:     inv.apiInvocationInput!.httpMethod || 'POST',
                  httpStatusCode: 403,
                  responseBody: {
                    'application/json': {
                      body: JSON.stringify({ error: TOOL_DENIAL_RESPONSE(functionName!) }),
                    },
                  },
                },
              });
            }
          }
        }
      }

      if (!returnControlDetected) {
        console.log(`[${agentName}] Invocazione completata (loop ${loopCount}).`);
        // Lead → sanitize completo; sotto-agenti → solo trim, nessun taglio
        return isLead ? sanitizeMarkdown(fullText) : rawAgentOutput(fullText);
      }

      console.log(`[${agentName}] returnControl gestito, continuo al loop ${loopCount + 1}...`);

    } catch (err: any) {
      console.error(`[${agentName}] Errore Bedrock al loop ${loopCount}:`, err?.message);
      return `## Errore analisi ${agentName}\n\nImpossibile completare: ${err?.message}`;
    }
  }

  console.error(`[${agentName}] Raggiunto MAX_LOOPS (${MAX_LOOPS}).`);
  return `## Analisi ${agentName} incompleta\n\nL'agente ha superato il numero massimo di iterazioni tool.`;
}

/**
 * Estrae la prima riga significativa di un report Markdown per il summary dinamico.
 */
export function extractFirstMeaningfulLine(report: string, emojiPattern: RegExp): string {
  const lines = report.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (line.startsWith('#') || line.startsWith('---') || line.startsWith('===')) continue;
    if (line.length < 20) continue;
    return line.replace(/\*\*/g, '').replace(emojiPattern, '').trim().substring(0, 200);
  }
  return '';
}