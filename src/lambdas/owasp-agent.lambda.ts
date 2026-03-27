import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { Agent, tool } from "@strands-agents/sdk";
import { BedrockModel } from "@strands-agents/sdk/bedrock";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const s3Client = new S3Client({});

const bedrockModel = new BedrockModel({
  modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
  region: process.env.AWS_REGION,
});

// Schema Zod per list_repository_files
const FindAllFilesInput = z.object({
  bucket: z.string().describe("Il nome del bucket S3 da esplorare"),
  prefix: z.string().describe("Il prefisso (cartella) dentro il bucket"),
});

// 1. Definiamo i Tools per l'agente
const listRepositoryFiles = tool({
    name: "list_repository_files",
    description: "Usa questo tool per ottenere la lista di tutti i file nel repository.",
    inputSchema: zodToJsonSchema(FindAllFilesInput) as any,
    callback: async ({ bucket, prefix }: z.infer<typeof FindAllFilesInput>): Promise<string> => {
        const command = new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix });
        const response = await s3Client.send(command);

        if (!response.Contents || response.Contents.length === 0) return "Nessun file trovato.";
        
        // Estraiamo le chiavi e rimuoviamo il prefisso per restituire percorsi puliti
        const files = response.Contents
            .map(item => item.Key?.replace(`${prefix}/`, ''))
            .filter(Boolean); // Rimuove eventuali valori undefined
            
        return files.join("\n");
    }
});

// Schema Zod per read_file_content
const ReadFileContentInput = z.object({
  bucket: z.string().describe("Il nome del bucket S3"),
  fileKey: z.string().describe("La chiave (path completo) del file da leggere"),
});

const readFileContent = tool({
  name: "read_file_content",
  description: "Usa questo tool per leggere il contenuto testuale di un file specifico per analizzarlo.",
  inputSchema: zodToJsonSchema(FindAllFilesInput) as any,
  callback: async ({ bucket, fileKey }: z.infer<typeof ReadFileContentInput>): Promise<string> => {
    try {
      const command = new GetObjectCommand({ Bucket: bucket, Key: fileKey });
      const response = await s3Client.send(command);
      const content = await response.Body?.transformToString("utf-8");
      return content || "";
    } catch (error: any) {
      return `Errore durante la lettura del file: ${error.message}`;
    }
  },
});

// Schema Zod per l'evento Lambda in ingresso
const OwaspAgentEventSchema = z.object({
  s3Bucket: z.string(),
  s3Key: z.string(),
  orchestratorRaw: z.string().optional(),
});

// Schema Zod per l'output atteso dall'agente
const OwaspAuditOutputSchema = z.object({
  summary: z.string().describe("Sintesi generale della documentazione"),
  completeness_score: z.number().min(0).max(10).describe("Punteggio di completezza da 0 a 10"),
  missing_sections: z.array(z.string()).describe("Sezioni mancanti nella documentazione"),
  recommendations: z.array(z.string()).describe("Suggerimenti per migliorare la documentazione"),
  files_analyzed: z.array(z.string()).describe("Lista dei file analizzati"),
});

export type OwaspAuditOutput = z.infer<typeof OwaspAuditOutputSchema>;

export const owaspAgentHandler = async (event: unknown, context: unknown): Promise<OwaspAuditOutput> => {
  // Validazione dell'evento in ingresso
  const { s3Bucket: bucket, s3Key: key, orchestratorRaw } = OwaspAgentEventSchema.parse(event);

    const systemInstruction = `You are an expert security auditor specialized in OWASP. 
    You have tools to explore the repository stored in S3. 
    1. First, list the files to understand the project structure.
    2. Read critical files (like package.json, requirements.txt, server.js, auth logic).
    3. Analyze for OWASP vulnerabilities.
    
    Respond ONLY with valid JSON matching the exact schema requested, no markdown.:
    ${JSON.stringify(OwaspAuditOutputSchema.shape)}`;

  const owaspAgent = new Agent({
    name: "Documentation_Auditor",
    model: bedrockModel,
    systemPrompt: systemInstruction,
    tools: [listRepositoryFiles, readFileContent],
  });

  const userPrompt = `Analyze Owasp vulnerabilities for repo in bucket '${bucket}' under prefix '${key}'. Context: ${orchestratorRaw ?? "none"}`;
  
const finalResponse = await owaspAgent.invoke(userPrompt);

// Log the object to see its actual structure
console.log("Agent Response Object:", JSON.stringify(finalResponse, null, 2));

// Update this line based on what you see in the console logs
// Example assuming the property is called 'output':
const rawJson = JSON.parse(finalResponse.structuredOutput); 
return OwaspAuditOutputSchema.parse(rawJson);
};