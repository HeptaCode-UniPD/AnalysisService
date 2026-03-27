import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { Agent, tool } from "@strands-agents/sdk"; 
import { BedrockModel } from "@strands-agents/sdk/bedrock";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION });

const invokeAgentLambda = async (functionName: string, payload: Record<string, any>): Promise<string> => {
  try {
    const command = new InvokeCommand({
      FunctionName: functionName,
      InvocationType: "RequestResponse", 
      Payload: Buffer.from(JSON.stringify(payload)),
    });

    const response = await lambdaClient.send(command);

    if (!response.Payload) {
      return JSON.stringify({ error: `Nessun risultato restituito da ${functionName}` });
    }

    const resultString = Buffer.from(response.Payload).toString("utf-8");
    
    return resultString;
  } catch (error: any) {
    console.error(`Errore nell'invocazione di ${functionName}:`, error);
    return JSON.stringify({ error: error.message });
  }
};

const bedrockModel = new BedrockModel({
  modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
  region: process.env.AWS_REGION,
});

// 1. Schema condiviso per l'input dei tool (tutti e 3 richiedono gli stessi parametri)
const SubAgentToolInput = z.object({
  bucket: z.string().describe("Il nome del bucket S3"),
  key: z.string().describe("La chiave S3 o il prefisso del repository"),
  context: z.string().describe("Contesto raw dell'orchestratore da passare al sub-agent"),
});

type ToolInput = z.infer<typeof SubAgentToolInput>;

const runOwaspAnalysis = tool({
  name: "run_owasp_analysis",
  description: "Avvia l'analisi di sicurezza OWASP. Usalo sempre per ogni repository.",
  inputSchema: zodToJsonSchema(SubAgentToolInput) as any,
  callback: async ({ bucket, key, context }: ToolInput): Promise<string> => {
      const result = await invokeAgentLambda(process.env.LAMBDA_OWASP_NAME!, {
          s3Bucket: bucket,
          s3Key: key,
          orchestratorRaw: context
      });
      
      return result; 
  }
});

const runTestAnalysis = tool({
  name: "run_test_analysis",
  description: "Avvia l'analisi della test coverage e QA. Usalo sempre per ogni repository.",
  inputSchema: zodToJsonSchema(SubAgentToolInput) as any,
  callback: async ({ bucket, key, context }: ToolInput): Promise<string> => {
      const result = await invokeAgentLambda(process.env.LAMBDA_TEST_NAME!, {
          s3Bucket: bucket,
          s3Key: key,
          orchestratorRaw: context
      });
      
      return result; 
  }
});

const runDocumentationAnalysis = tool({
  name: "run_documentation_analysis",
  description: "Avvia l'analisi della documentazione. Usalo SOLO se il repository è contrassegnato come 'release'.",
  inputSchema: zodToJsonSchema(SubAgentToolInput) as any,
  callback: async ({ bucket, key, context }: ToolInput): Promise<string> => {
      return await invokeAgentLambda(process.env.LAMBDA_DOCS_NAME!, {
          s3Bucket: bucket,
          s3Key: key,
          orchestratorRaw: context
      });
  }
});

// 2. Schema Zod per l'evento Lambda in ingresso
const OrchestratorEventSchema = z.object({
  s3Bucket: z.string(),
  s3Key: z.string(),
  isRelease: z.boolean().describe("Flag per determinare se è una release"),
  orchestratorRaw: z.string(),
});

// 3. Schema Zod per l'output finale dell'Orchestratore
const OrchestratorOutputSchema = z.object({
  executive_summary: z.string().describe("Sintesi generale dei risultati di tutte le analisi"),
  owasp_status: z.string().describe("Risultato dell'analisi OWASP"),
  test_qa_status: z.string().describe("Risultato dell'analisi Test & QA"),
  documentation_status: z.string().optional().describe("Risultato dell'analisi della documentazione, se eseguita"),
  overall_score: z.number().min(0).max(10).describe("Punteggio complessivo del repository")
});

export type OrchestratorOutput = z.infer<typeof OrchestratorOutputSchema>;


// Handler dell'Orchestratore
export const orchestratorHandler = async (event: unknown, context: any): Promise<OrchestratorOutput> => {
  // Validazione in ingresso
  const { s3Bucket: bucket, s3Key: key, isRelease, orchestratorRaw } = OrchestratorEventSchema.parse(event);
  
  const systemInstruction = `You are a Lead Repository Auditor and Orchestrator.
  Your job is to coordinate specific sub-agents to analyze a repository stored in S3.
  
  RULES:
  1. ALWAYS run the OWASP security analysis.
  2. ALWAYS run the Test & QA analysis.
  3. ONLY run the Documentation analysis IF the provided context explicitly states this is a "RELEASE".
  
  Once you have gathered the results from the necessary tools, synthesize them into a final comprehensive executive summary.
  Respond ONLY with valid JSON matching this exact schema, no markdown:
  ${JSON.stringify(OrchestratorOutputSchema.shape)}`;
  
  const orchestratorAgent = new Agent({
      name: "Main_Orchestrator",
      model: bedrockModel,
      systemPrompt: systemInstruction,
      tools: [runOwaspAnalysis, runTestAnalysis, runDocumentationAnalysis]
  });
  
  const releaseStatus = isRelease ? "This IS a RELEASE." : "This IS NOT a release.";
  const userPrompt = `Analyze the repo in bucket '${bucket}' under prefix '${key}'. 
  Status: ${releaseStatus}
  Context: ${orchestratorRaw}`;
  
  // Utilizzo di invoke come nel secondo script
  const finalResponse = await orchestratorAgent.invoke(userPrompt);
  
// Log the object to see its actual structure
console.log("Agent Response Object:", JSON.stringify(finalResponse, null, 2));

// Update this line based on what you see in the console logs
// Example assuming the property is called 'output':
const rawJson = JSON.parse(finalResponse.structuredOutput); 
return OrchestratorOutputSchema.parse(rawJson);
};