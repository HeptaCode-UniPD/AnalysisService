import { z } from 'zod';
import { createUnzipRepoTool } from './tools/decompressione-zip.tool';
import { createReadFileContentTool } from './tools/read-file-content.tool';
import { createListRepositoryFilesTool } from './tools/find-all-files.tool';

const OwaspAgentEventSchema = z.object({
  s3Bucket: z.string(),
  s3Key: z.string(),
  orchestratorRaw: z.string().optional(),
});

const OwaspReportSchema = z.object({
  copertura_generale: z
    .string()
    .describe(
      'Panoramica generale dello stato di sicurezza basata sul codice analizzato.',
    ),
  parametri_rispettati: z
    .array(z.string())
    .describe('Lista delle categorie OWASP rispettate dal codice.'),
  parametri_violati: z
    .array(z.string())
    .describe('Lista delle categorie OWASP violate dal codice.'),
  vulnerabilita: z
    .array(
      z.object({
        file_path: z
          .string()
          .describe('Percorso assoluto del file vulnerabile.'),
        commento_generale: z
          .string()
          .describe('Spiegazione del perché il codice è vulnerabile.'),
        linea_inizio: z
          .number()
          .int()
          .describe('Linea di inizio del problema.'),
        linea_fine: z.number().int().describe('Linea di fine del problema.'),
        codice_vulnerabile: z
          .string()
          .describe('Frammento di codice originale vulnerabile.'),
        correzione_proposta: z
          .string()
          .describe('Frammento di codice sicuro proposto in sostituzione.'),
      }),
    )
    .default([])
    .describe(
      'Lista delle vulnerabilità trovate. Vuota se il codice è sicuro.',
    ),
});

export type OwaspReport = z.infer<typeof OwaspReportSchema>;

export const owaspAgentHandler = async (event: unknown): Promise<string> => {
  const { Agent } = await import('@strands-agents/sdk');
  const { BedrockModel } = await import('@strands-agents/sdk/bedrock');

  const [unzipRepo, listRepositoryFiles, readFileContent] = await Promise.all([
    createUnzipRepoTool(),
    createListRepositoryFilesTool(),
    createReadFileContentTool(),
  ]);

  const bedrockModel = new BedrockModel({
    modelId: 'eu.amazon.nova-pro-v1:0',
    region: 'eu-central-1',
    additionalRequestFields: {
      temperature: 0,
    },
  });

  const {
    s3Bucket: bucket,
    s3Key: key,
    orchestratorRaw,
  } = OwaspAgentEventSchema.parse(event);

  const systemInstruction = `
    You are an automated security pipeline script.
    CRITICAL INSTRUCTION: You MUST begin by executing the tool 'unzip_repo'.
    Do NOT generate any text until AFTER you have successfully called 'unzip_repo'.

    YOUR WORKFLOW CONSISTS OF TWO STRICT PHASES:

    ### PHASE 1: EXPLORATION (TOOL USAGE)
    Use your tools to explore the repository. Do not guess.
    1. Call 'unzip_repo' with the provided S3 bucket and zip path to extract the code.
    2. Call 'list_repository_files' with the local base path to understand the structure.
    3. Call 'read_file_content' multiple times to inspect critical files (auth controllers, db queries, package.json, etc.).
    Take your time and use the tools as much as needed until you have enough context.

    ### PHASE 2: REPORTING (FINAL OUTPUT)
    Only after finishing the tool usage, produce your final structured report.
    Populate each field accurately based on the ACTUAL code you read:
    - 'copertura_generale': a concise overview of the security posture.
    - 'parametri_rispettati': OWASP categories that are correctly handled.
    - 'parametri_violati': OWASP categories that are violated.
    - 'vulnerabilita': one entry per issue found, with exact file path, line numbers,
      the vulnerable snippet, and a corrected version. Leave empty if no issues found.
  `;

  const owaspAgent = new Agent({
    name: 'OWASP_Auditor',
    model: bedrockModel,
    systemPrompt: systemInstruction,
    tools: [unzipRepo, listRepositoryFiles, readFileContent],
    structuredOutputSchema: OwaspReportSchema,
  });

  const userPrompt = `Analyze OWASP vulnerabilities for the zipped repo in bucket '${bucket}' with key '${key}'. Context: ${orchestratorRaw ?? 'none'}`;

  try {
    const finalResponse = await owaspAgent.invoke(userPrompt);
    console.log(
      'Agent Response Object:',
      JSON.stringify(finalResponse, null, 2),
    );

    const firstBlock = finalResponse?.lastMessage?.content[0] as any;

    if (!firstBlock || typeof firstBlock.text !== 'string') {
      throw new Error(
        'Il formato della risposta non contiene il testo atteso.',
      );
    }

    const parsedData = JSON.parse(firstBlock.text);
    const validatedData = OwaspReportSchema.parse(parsedData);
    return JSON.stringify(validatedData);
  } catch (err: any) {
    console.error(
      'Errore completo:',
      JSON.stringify(err, Object.getOwnPropertyNames(err), 2),
    );
    throw err;
  }
};
