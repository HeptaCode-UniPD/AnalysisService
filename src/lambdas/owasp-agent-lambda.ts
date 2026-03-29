import { z } from 'zod';

import { unzipRepo } from './tools/decompressione-zip.tool';
import { readFileContent } from './tools/read-file-content.tool';
import { listRepositoryFiles } from './tools/find-all-files.tool';

// Schema Zod per l'evento Lambda in ingresso
const OwaspAgentEventSchema = z.object({
  s3Bucket: z.string(),
  s3Key: z.string(),
  orchestratorRaw: z.string().optional(),
});

// Schema Zod per l'output atteso dall'agente
const OwaspAuditOutputSchema = z.object({
  summary: z.string().describe('Sintesi generale della documentazione'),
  completeness_score: z
    .number()
    .min(0)
    .max(10)
    .describe('Punteggio di completezza da 0 a 10'),
  missing_sections: z
    .array(z.string())
    .describe('Sezioni mancanti nella documentazione'),
  recommendations: z
    .array(z.string())
    .describe('Suggerimenti per migliorare la documentazione'),
  files_analyzed: z.array(z.string()).describe('Lista dei file analizzati'),
});

export type OwaspAuditOutput = z.infer<typeof OwaspAuditOutputSchema>;

export const owaspAgentHandler = async (
  event: unknown,
  context: unknown,
): Promise<OwaspAuditOutput> => {

  const { Agent } = await import('@strands-agents/sdk');
  const { BedrockModel } = await import('@strands-agents/sdk/bedrock');

  const bedrockModel = new BedrockModel({
    modelId: 'us.amazon.nova-pro-v1:0',
    region: 'us-east-1',
  });

  // Validazione dell'evento in ingresso
  const {
    s3Bucket: bucket,
    s3Key: key,
    orchestratorRaw,
  } = OwaspAgentEventSchema.parse(event);

  // Prompt di sistema aggiornato con la sequenza di estrazione locale
  const systemInstruction = `You are an expert security auditor specialized in OWASP. 
    You must follow this exact sequence of steps to explore the repository:
    1. First, use 'unzip_repo' with the provided S3 bucket and zip key to extract the repository locally. This will return a local base path.
    2. Second, use 'list_repository_files' passing the local base path returned from step 1 to understand the project structure.
    3. Third, use 'read_file_content' to read critical files (like package.json, requirements.txt, server.js, auth logic) based on the absolute paths you found.
    4. Finally, analyze the contents for OWASP vulnerabilities.
    
    Respond ONLY with valid JSON matching the exact schema requested, no markdown:
    ${JSON.stringify(OwaspAuditOutputSchema.shape)}`;

  const owaspAgent = new Agent({
    name: 'OWASP_Auditor', // Ho rinominato da Documentation_Auditor per coerenza
    model: bedrockModel,
    systemPrompt: systemInstruction,
    // Aggiunto unzipRepo ai tools disponibili
    tools: [unzipRepo, listRepositoryFiles, readFileContent],
  });

  // Aggiornato per specificare che la repo è zippata
  const userPrompt = `Analyze OWASP vulnerabilities for the zipped repo in bucket '${bucket}' with key '${key}'. Context: ${orchestratorRaw ?? 'none'}`;

  try {
    const finalResponse = await owaspAgent.invoke(userPrompt);
    console.log('Agent Response Object:', JSON.stringify(finalResponse, null, 2));
    return OwaspAuditOutputSchema.parse(finalResponse.structuredOutput);
  } catch (err: any) {
    console.error('Errore completo:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2));
    throw err;
  }
};
