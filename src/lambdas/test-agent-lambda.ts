import { z } from 'zod';
import { createUnzipRepoTool } from './tools/decompressione-zip.tool';
import { createReadFileContentTool } from './tools/read-file-content.tool';
import { createFindTestFilesTool } from './tools/find-test-files.tool';

// Zod rimane solo per validare l'evento di ingresso
const TestAgentEventSchema = z.object({
  s3Bucket: z.string(),
  s3Key: z.string(),
  orchestratorRaw: z.string().optional(),
});

// Nota: Il tipo di ritorno ora è Promise<string>, niente più oggetti o Zod!
export const testAgentHandler = async (event: unknown): Promise<string> => {
  const { Agent } = await import('@strands-agents/sdk');
  const { BedrockModel } = await import('@strands-agents/sdk/bedrock');

  // Creiamo i tool tramite factory async
  const [unzipRepo, findTestFiles, readFileContent] = await Promise.all([
    createUnzipRepoTool(),
    createFindTestFilesTool(),
    createReadFileContentTool(),
  ]);

  const bedrockModel = new BedrockModel({
    modelId: 'qwen.qwen3-235b-a22b-2507-v1:0',
    region: 'eu-central-1',
    additionalRequestFields: {
      thinking: { type: 'disabled' },
      temperature: 0,
    },
  });

  // Monkey-patch corretto: preserva il tipo async generator
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

  // === NUOVO PROMPT IN MARKDOWN STRUTTURATO ===
  const systemInstruction = `/no_think
    You are an expert QA engineer and test coverage analyst.
    You must follow this exact sequence of steps to explore the repository:
    1. First, use 'unzip_repo' with the provided S3 bucket and zip key to extract the repository locally. This will return a local base path.
    2. Second, use 'find_test_files' passing the local base path returned from step 1 to locate unit/e2e tests and CI pipelines.
    3. Third, use 'read_file_content' to read a representative sample of the local test files to evaluate assertion quality and coverage estimation.
    4. Finally, evaluate the CI/CD configuration and overall test coverage.
    
    CRITICAL OUTPUT INSTRUCTIONS:
    - NO PREAMBLE. NO INTRO. NO OUTRO.
    - DO NOT USE <thinking> TAGS.
    - START your response IMMEDIATELY with the characters "## Riepilogo Test e QA".
    - If you use <thinking> tags, the system will fail. Output ONLY Markdown.

    ## Riepilogo Test e QA
    - **Copertura Generale:** [Breve paragrafo: ci sono test unitari? e2e? pipeline CI/CD? Se non c'è nulla, specificalo chiaramente]
    - **Punteggio Completezza:** [Assegna un voto da 0 a 10 in base alla presenza e qualità dei test]
    - **Raccomandazioni:** [Lista separata da virgole dei suggerimenti per migliorare la copertura, es. "Aggiungere test unitari per i controller", "Configurare GitHub Actions"]

    ## Dettagli per File
    [Ripeti il seguente blocco per OGNI file analizzato che manca di test, ha asserzioni deboli o richiede un refactoring dei test. Se il repository non ha alcun test, indica 1 o 2 file principali del codice sorgente (es. /src/main.js) suggerendo come iniziare a testarli.]

    ### File: [Inserisci il percorso completo del file, es. /src/utils.js o /tests/utils.test.js]
    - **Linee:** [Linea di inizio] - [Linea di fine] (Se applicabile, altrimenti 0 - 0)
    - **Commento Generale:** [Spiega perché manca copertura qui o cosa c'è di sbagliato]
    - **Codice Vulnerabile:**
    \`\`\`text
    [Inserisci qui la funzione non testata o il test esistente scritto male]
    \`\`\`
    - **Correzione Proposta:**
    \`\`\`text
    [Inserisci qui l'esempio di test unitario o la configurazione CI/CD proposta]
    \`\`\``;

  const testAgent = new Agent({
    name: 'Test_Auditor',
    model: bedrockModel,
    systemPrompt: systemInstruction,
    tools: [unzipRepo, findTestFiles, readFileContent],
  });

  const userPrompt = `Analyze test coverage for the zipped repo in bucket '${bucket}' with key '${key}'. Context: ${orchestratorRaw ?? 'none'}`;

  try {
    const finalResponse = await testAgent.invoke(userPrompt);
    console.log(
      'Agent Response Object:',
      JSON.stringify(finalResponse, null, 2),
    );

    // Estrazione sicura del testo
    const firstBlock = finalResponse?.lastMessage?.content[0] as any;

    if (!firstBlock || typeof firstBlock.text !== 'string') {
      throw new Error(
        'Il formato della risposta non contiene il testo atteso.',
      );
    }

    // Sostituisci la tua logica di pulizia con questa
    const responseText = firstBlock.text;

    // Rimuove TUTTO ciò che sta dentro <thinking> compresi i tag stessi
    // La 's' flag permette al punto (.) di includere anche i newline
    let cleanMarkdown = responseText
      .replace(/<thinking>.*?<\/thinking>/gs, '')
      .trim();

    // Se il modello è così testardo da iniziare comunque con testo sporco prima del MD
    // Forziamo l'inizio dal primo header Markdown
    const startIndex = cleanMarkdown.indexOf('## Riepilogo');
    if (startIndex !== -1) {
      cleanMarkdown = cleanMarkdown.substring(startIndex);
    }

    return cleanMarkdown;
  } catch (err: any) {
    console.error(
      'Errore completo:',
      JSON.stringify(err, Object.getOwnPropertyNames(err), 2),
    );
    throw err;
  }
};
