import { z } from 'zod';
import { createUnzipRepoTool } from './tools/decompressione-zip.tool';
import { createReadFileContentTool } from './tools/read-file-content.tool';
import { createFindTestFilesTool } from './tools/find-test-files.tool';

const TestAgentEventSchema = z.object({
  s3Bucket: z.string(),
  s3Key: z.string(),
  orchestratorRaw: z.string().optional(),
});

const TestReportSchema = z.object({
  punteggio_completezza: z
    .number()
    .int()
    .min(0)
    .max(10)
    .describe(
      'Punteggio da 0 a 10 sulla presenza e qualità dei test nel repository.',
    ),
  copertura_generale: z
    .string()
    .describe(
      'Panoramica: ci sono test unitari? e2e? pipeline CI/CD? Se non esiste nulla, specificarlo chiaramente.',
    ),
  raccomandazioni: z
    .array(z.string())
    .describe(
      'Lista di suggerimenti per migliorare la copertura, es. ["Aggiungere test unitari per i controller", "Configurare GitHub Actions"].',
    ),
  file_analizzati: z
    .array(
      z.object({
        file_path: z
          .string()
          .describe(
            'Percorso completo del file analizzato, es. /src/utils.js o /tests/utils.test.js.',
          ),
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
            "Spiegazione del perché manca copertura qui o cosa c'è di sbagliato nel test esistente.",
          ),
        codice_mancante: z
          .string()
          .describe(
            'La funzione non testata o il test esistente scritto male. Stringa vuota se non applicabile.',
          ),
        correzione_proposta: z
          .string()
          .describe(
            'Esempio di test unitario proposto o configurazione CI/CD suggerita.',
          ),
      }),
    )
    .describe(
      'Un blocco per ogni file che manca di test o ha asserzioni deboli. ' +
        'Se il repository non ha alcun test, includere 1-2 file sorgente principali ' +
        'suggerendo come iniziare a testarli.',
    ),
});

export type TestReport = z.infer<typeof TestReportSchema>;

export const testAgentHandler = async (event: unknown): Promise<string> => {
  const { Agent } = await import('@strands-agents/sdk');
  const { BedrockModel } = await import('@strands-agents/sdk/bedrock');

  const [unzipRepo, findTestFiles, readFileContent] = await Promise.all([
    createUnzipRepoTool(),
    createFindTestFilesTool(),
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
  } = TestAgentEventSchema.parse(event);

  const systemInstruction = `
    You are an expert QA engineer and test coverage analyst.
    You must follow this exact sequence of steps to explore the repository:
    1. Use 'unzip_repo' with the provided S3 bucket and zip key to extract the repository. This returns a local base path.
    2. Use 'find_test_files' with the local base path to locate unit/e2e tests and CI pipelines.
    3. Use 'read_file_content' to read a representative sample of test files, evaluating assertion quality and coverage.
    4. Evaluate the CI/CD configuration and overall test coverage.

    After completing the tool usage, produce your final structured report by populating each field:
    - 'punteggio_completezza': integer from 0 to 10.
    - 'copertura_generale': concise overview of what testing infrastructure exists (unit, e2e, CI/CD).
    - 'raccomandazioni': list of actionable improvement suggestions.
    - 'file_analizzati': one entry per file that is missing tests or has weak assertions.
      If the repository has no tests at all, include 1-2 main source files as entry points
      and suggest how to start testing them. Use empty string for 'codice_mancante' when not applicable.
  `;

  const testAgent = new Agent({
    name: 'Test_Auditor',
    model: bedrockModel,
    systemPrompt: systemInstruction,
    tools: [unzipRepo, findTestFiles, readFileContent],
    structuredOutputSchema: TestReportSchema,
  });

  const userPrompt = `Analyze test coverage for the zipped repo in bucket '${bucket}' with key '${key}'. Context: ${orchestratorRaw ?? 'none'}`;

  try {
    const finalResponse = await testAgent.invoke(userPrompt);
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
    const validatedData = TestReportSchema.parse(parsedData);
    return JSON.stringify(validatedData);
  } catch (err: any) {
    console.error(
      'Errore completo:',
      JSON.stringify(err, Object.getOwnPropertyNames(err), 2),
    );
    throw err;
  }
};
