import { z } from 'zod';
import { createUnzipRepoTool } from './tools/decompressione-zip.tool';
import { createReadFileContentTool } from './tools/read-file-content.tool';
import { createFindDocumentationFilesTool } from './tools/find-docs-files.tool';

// Manteniamo Zod solo per validare l'input in ingresso
const DocAgentEventSchema = z.object({
  s3Bucket: z.string(),
  s3Key: z.string(),
  orchestratorRaw: z.string().optional(),
});

// Nota: Il tipo di ritorno ora è Promise<string>, non più l'oggetto Zod
export const docAgentHandler = async (event: unknown): Promise<string> => {
  const { Agent } = await import('@strands-agents/sdk');
  const { BedrockModel } = await import('@strands-agents/sdk/bedrock');

  // Creiamo i tool tramite factory async
  const [unzipRepo, findDocumentationFiles, readFileContent] =
    await Promise.all([
      createUnzipRepoTool(),
      createFindDocumentationFilesTool(),
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
                !(block.type === 'text' && (block.text ?? '').trim() === '')
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

  // === NUOVO PROMPT IN MARKDOWN STRUTTURATO ===
  const systemInstruction = `/no_think
    You are an expert technical writer and documentation auditor. 
    You must follow this exact sequence of steps to explore the repository:
    1. First, use 'unzip_repo' with the provided S3 bucket and zip key to extract the repository locally. This will return a local base path.
    2. Second, use 'find_documentation_files' passing the local base path returned from step 1 to locate READMEs, ADRs, and guides.
    3. Third, use 'read_file_content' to read the main documentation files you found, in order to evaluate setup instructions, API docs, and contribution guidelines.
    4. Finally, evaluate the overall documentation completeness and quality.
    
    CRITICAL OUTPUT INSTRUCTIONS:
    - NO PREAMBLE. NO INTRO. NO OUTRO.
    - DO NOT USE <thinking> TAGS.
    - START your response IMMEDIATELY with the characters "## Riepilogo Documentazione".
    - If you use <thinking> tags, the system will fail. Output ONLY Markdown.

    ## Riepilogo Documentazione
    - **Punteggio Completezza:** [Assegna un voto da 0 a 10]
    - **Sintesi Generale:** [Un breve paragrafo sulla qualità generale della documentazione]
    - **Sezioni Mancanti:** [Lista separata da virgole delle sezioni assenti, es. Changelog, API Docs, Contribution Guidelines]
    - **Raccomandazioni:** [Lista separata da virgole dei suggerimenti per migliorare]

    ## Dettagli per File
    [Ripeti il seguente blocco per OGNI file analizzato che necessita di migliorie. Se non ci sono file o la repo è vuota, scrivi "Nessun file di documentazione trovato."]

    ### File: [Inserisci il percorso completo del file, es. /README.md]
    - **Linee:** [Linea di inizio] - [Linea di fine] (Se applicabile, altrimenti 0 - 0)
    - **Commento Generale:** [Spiega brevemente cosa manca o cosa è scritto male]
    - **Codice Vulnerabile:**
    \`\`\`text
    [Inserisci qui l'eventuale pezzo di testo mancante o confuso, o lascia vuoto]
    \`\`\`
    - **Correzione Proposta:**
    \`\`\`text
    [Inserisci qui la proposta di testo o l'integrazione da fare]
    \`\`\``;

  const docAgent = new Agent({
    name: 'Documentation_Auditor',
    model: bedrockModel,
    systemPrompt: systemInstruction,
    tools: [unzipRepo, findDocumentationFiles, readFileContent],
  });

  const userPrompt = `Analyze documentation for the zipped repo in bucket '${bucket}' with key '${key}'. Context: ${orchestratorRaw ?? 'none'}`;

  try {
    const finalResponse = await docAgent.invoke(userPrompt);
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
    let cleanMarkdown = responseText.replace(/<thinking>.*?<\/thinking>/gs, '').trim();

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
