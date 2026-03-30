import { z } from 'zod';
import { createUnzipRepoTool } from './tools/decompressione-zip.tool';
import { createReadFileContentTool } from './tools/read-file-content.tool';
import { createListRepositoryFilesTool } from './tools/find-all-files.tool';

const OwaspAgentEventSchema = z.object({
  s3Bucket: z.string(),
  s3Key: z.string(),
  orchestratorRaw: z.string().optional(),
});

// Nota: Il tipo di ritorno ora è Promise<string>, non più un oggetto Zod
export const owaspAgentHandler = async (event: unknown): Promise<string> => {
  const { Agent } = await import('@strands-agents/sdk');
  const { BedrockModel } = await import('@strands-agents/sdk/bedrock');

  // Creiamo i tool tramite factory async
  const [unzipRepo, listRepositoryFiles, readFileContent] = await Promise.all([
    createUnzipRepoTool(),
    createListRepositoryFilesTool(),
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
  } = OwaspAgentEventSchema.parse(event);

  const systemInstruction = `/no_think
    You are an expert QA security auditor specialized in OWASP. 
    You must follow this exact sequence of steps to explore the repository:
    1. First, use 'unzip_repo' with the provided S3 bucket and zip key to extract the repository locally. This will return a local base path.
    2. Second, use 'list_repository_files' passing the local base path returned from step 1 to understand the project structure.
    3. Third, use 'read_file_content' to read critical files (like package.json, requirements.txt, server.js, auth logic) based on the absolute paths you found.
    4. Finally, analyze the contents for OWASP vulnerabilities.
    
    CRITICAL OUTPUT INSTRUCTIONS:
    - NO PREAMBLE. NO INTRO. NO OUTRO.
    - DO NOT USE <thinking> TAGS.
    - START your response IMMEDIATELY with the characters "## Riepilogo OWASP".
    - If you use <thinking> tags, the system will fail. Output ONLY Markdown.

    ## Riepilogo OWASP
    - **Copertura Generale:** [Un breve paragrafo che descrive lo stato di sicurezza generale del repository]
    - **Parametri OWASP Rispettati:** [Lista separata da virgole delle categorie OWASP che sono state implementate correttamente, es. Cryptographic Failures, Security Misconfiguration]
    - **Parametri OWASP Violati:** [Lista separata da virgole delle vulnerabilità trovate, es. Injection, Broken Access Control]

    ## Dettagli per File
    [Ripeti il seguente blocco per OGNI file in cui hai trovato vulnerabilità. Se un file ha più vulnerabilità, crea un blocco per ciascuna]

    ### File: [Inserisci il percorso completo del file, es. /src/DBconnection.php]
    - **Commento Generale:** [Spiega brevemente perché questo file è vulnerabile e quale rischio comporta]
    - **Linee:** [Linea di inizio] - [Linea di fine]
    - **Codice Vulnerabile:**
    \`\`\`[linguaggio]
    [Inserisci qui il frammento di codice originale sbagliato]
    \`\`\`
    - **Correzione Proposta:**
    \`\`\`[linguaggio]
    [Inserisci qui il frammento di codice corretto e sicuro]
    \`\`\``;

  const owaspAgent = new Agent({
    name: 'OWASP_Auditor',
    model: bedrockModel,
    systemPrompt: systemInstruction,
    tools: [unzipRepo, listRepositoryFiles, readFileContent],
  });

  const userPrompt = `Analyze OWASP vulnerabilities for the zipped repo in bucket '${bucket}' with key '${key}'. Context: ${orchestratorRaw ?? 'none'}`;

  try {
    const finalResponse = await owaspAgent.invoke(userPrompt);
    console.log(
      'Agent Response Object:',
      JSON.stringify(finalResponse, null, 2),
    );

    // Estraiamo il primo blocco
    const firstBlock = finalResponse?.lastMessage?.content[0] as any;

    // Controllo di sicurezza a runtime
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
