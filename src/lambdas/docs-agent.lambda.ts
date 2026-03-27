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

// Schema Zod per find_documentation_files
const FindDocumentationFilesInput = z.object({
  bucket: z.string().describe("Il nome del bucket S3 da esplorare"),
  prefix: z.string().describe("Il prefisso (cartella) dentro il bucket"),
});

const findDocumentationFiles = tool({
  name: "find_documentation_files",
  description: "Ottiene la lista dei file di documentazione (es. .md, .txt, cartella docs/, CHANGELOG).",
  inputSchema: zodToJsonSchema(FindDocumentationFilesInput) as any,
  callback: async ({ bucket, prefix }: z.infer<typeof FindDocumentationFilesInput>): Promise<string> => {
    const command = new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix });
    const response = await s3Client.send(command);

    if (!response.Contents || response.Contents.length === 0) return "Nessun file trovato.";

    const docFiles = response.Contents
      .map(item => item.Key?.replace(`${prefix}/`, ""))
      .filter(key => key && (
        key.endsWith(".md") ||
        key.includes("docs/") ||
        key.includes(".txt") ||
        key.toLowerCase().includes("changelog") ||
        key.toLowerCase().includes("readme")
      ));

    return docFiles.length > 0 ? docFiles.join("\n") : "Nessun file di documentazione trovato.";
  },
});

// Schema Zod per read_file_content
const ReadFileContentInput = z.object({
  bucket: z.string().describe("Il nome del bucket S3"),
  fileKey: z.string().describe("La chiave (path completo) del file da leggere"),
});

const readFileContent = tool({
  name: "read_file_content",
  description: "Usa questo tool per leggere il contenuto testuale di un file specifico per analizzarlo.",
  inputSchema: zodToJsonSchema(FindDocumentationFilesInput) as any,
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
const DocAgentEventSchema = z.object({
  s3Bucket: z.string(),
  s3Key: z.string(),
  orchestratorRaw: z.string().optional(),
});

// Schema Zod per l'output atteso dall'agente
const DocAuditOutputSchema = z.object({
  summary: z.string().describe("Sintesi generale della documentazione"),
  completeness_score: z.number().min(0).max(10).describe("Punteggio di completezza da 0 a 10"),
  missing_sections: z.array(z.string()).describe("Sezioni mancanti nella documentazione"),
  recommendations: z.array(z.string()).describe("Suggerimenti per migliorare la documentazione"),
  files_analyzed: z.array(z.string()).describe("Lista dei file analizzati"),
});

export type DocAuditOutput = z.infer<typeof DocAuditOutputSchema>;

export const docAgentHandler = async (event: unknown, context: unknown): Promise<DocAuditOutput> => {
  // Validazione dell'evento in ingresso
  const { s3Bucket: bucket, s3Key: key, orchestratorRaw } = DocAgentEventSchema.parse(event);

  const systemInstruction = `You are an expert technical writer and documentation auditor. 
    You have tools to explore the repository stored in S3.
    1. First, use 'find_documentation_files' to locate READMEs, ADRs, and guides.
    2. Read the main documentation files to evaluate setup instructions, API docs, and contribution guidelines.
    3. Evaluate documentation completeness and quality.
    
    Respond ONLY with valid JSON matching this exact schema, no markdown:
    ${JSON.stringify(DocAuditOutputSchema.shape)}`;

  const docAgent = new Agent({
    name: "Documentation_Auditor",
    model: bedrockModel,
    systemPrompt: systemInstruction,
    tools: [findDocumentationFiles, readFileContent],
  });

  const userPrompt = `Analyze documentation for repo in bucket '${bucket}' under prefix '${key}'. Context: ${orchestratorRaw ?? "none"}`;
  
const finalResponse = await docAgent.invoke(userPrompt); // (or the correct method name)

// Log the object to see its actual structure
console.log("Agent Response Object:", JSON.stringify(finalResponse, null, 2));

// Update this line based on what you see in the console logs
// Example assuming the property is called 'output':
const rawJson = JSON.parse(finalResponse.structuredOutput); 
return DocAuditOutputSchema.parse(rawJson);
};