import { z } from 'zod';
import { createUnzipRepoTool } from './tools/decompressione-zip.tool';
import { createReadFileContentTool } from './tools/read-file-content.tool';
import { createFindDocumentationFilesTool } from './tools/find-docs-files.tool';

const DocAgentEventSchema = z.object({
  s3Bucket: z.string(),
  s3Key: z.string(),
  orchestratorRaw: z.string().optional(),
});

const DocsReportSchema = z.object({
  punteggio_completezza: z
    .number()
    .int()
    .min(0)
    .max(10)
    .describe('Punteggio da 0 a 10 sulla completezza della documentazione.'),
  sintesi_generale: z
    .string()
    .describe('Breve paragrafo sulla qualità generale della documentazione.'),
  sezioni_mancanti: z
    .array(z.string())
    .describe(
      'Lista delle sezioni assenti, es. ["Changelog", "API Docs", "Contribution Guidelines"].',
    ),
  raccomandazioni: z
    .array(z.string())
    .describe('Lista di suggerimenti per migliorare la documentazione.'),
  file_analizzati: z
    .array(
      z.object({
        file_path: z
          .string()
          .describe('Percorso completo del file analizzato, es. /README.md.'),
        linea_inizio: z
          .number()
          .int()
          .describe('Linea di inizio del problema. 0 se non applicabile.'),
        linea_fine: z
          .number()
          .int()
          .describe('Linea di fine del problema. 0 se non applicabile.'),
        commento_generale: z
          .string()
          .describe(
            'Spiegazione di cosa manca o è scritto male in questo file.',
          ),
        testo_problematico: z
          .string()
          .describe(
            'Pezzo di testo mancante o confuso. Stringa vuota se non applicabile.',
          ),
        correzione_proposta: z
          .string()
          .describe('Testo proposto o integrazione da fare.'),
      }),
    )
    .describe(
      'Un blocco per ogni file di documentazione che necessita di migliorie. Vuoto se la repo non ha documentazione.',
    ),
});

export type DocsReport = z.infer<typeof DocsReportSchema>;

export const docAgentHandler = async (event: unknown): Promise<string> => {
  const { Agent } = await import('@strands-agents/sdk');
  const { BedrockModel } = await import('@strands-agents/sdk/bedrock');

  const [unzipRepo, findDocumentationFiles, readFileContent] =
    await Promise.all([
      createUnzipRepoTool(),
      createFindDocumentationFilesTool(),
      createReadFileContentTool(),
    ]);

  const bedrockModel = new BedrockModel({
    modelId: 'eu.amazon.nova-pro-v1:0',
    region: 'eu-central-1',
    additionalRequestFields: {
      thinking: { type: 'disabled' },
      temperature: 0,
    },
  });

  // Monkey-patch: filtra i blocchi di testo vuoti che causano errori con Nova
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

  const {
    s3Bucket: bucket,
    s3Key: key,
    orchestratorRaw,
  } = DocAgentEventSchema.parse(event);

  const systemInstruction = `
    You are an expert technical writer and documentation auditor.
    You must follow this exact sequence of steps to explore the repository:
    1. Use 'unzip_repo' with the provided S3 bucket and zip key to extract the repository. This returns a local base path.
    2. Use 'find_documentation_files' with the local base path to locate READMEs, ADRs, and guides.
    3. Use 'read_file_content' to read the main documentation files found, evaluating setup instructions, API docs, and contribution guidelines.
    4. Evaluate the overall documentation completeness and quality.

    After completing the tool usage, produce your final structured report by populating each field:
    - 'punteggio_completezza': integer from 0 to 10.
    - 'sintesi_generale': concise overview of the documentation quality.
    - 'sezioni_mancanti': list of missing sections (e.g. "Changelog", "API Docs").
    - 'raccomandazioni': list of actionable improvement suggestions.
    - 'file_analizzati': one entry per file that needs improvement, with path, line range,
      a comment explaining the issue, the problematic text, and a proposed correction.
      If no documentation files are found, return an empty array.
  `;

  const docAgent = new Agent({
    name: 'Documentation_Auditor',
    model: bedrockModel,
    systemPrompt: systemInstruction,
    tools: [unzipRepo, findDocumentationFiles, readFileContent],
    structuredOutputSchema: DocsReportSchema,
  });

  const userPrompt = `Analyze documentation for the zipped repo in bucket '${bucket}' with key '${key}'. Context: ${orchestratorRaw ?? 'none'}`;

  try {
    const finalResponse = await docAgent.invoke(userPrompt);
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
    const validatedData = DocsReportSchema.parse(parsedData);
    return JSON.stringify(validatedData);
  } catch (err: any) {
    console.error(
      'Errore completo:',
      JSON.stringify(err, Object.getOwnPropertyNames(err), 2),
    );
    throw err;
  }
};
