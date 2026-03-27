import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { z } from 'zod';
import { Agent, tool, BedrockModel } from '@strands-agents/sdk';

const s3Client = new S3Client({});

const bedrockModel = new BedrockModel({
  modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  region: process.env.AWS_REGION,
});

const runOwaspAnalysis = tool({
  name: 'run_owasp_analysis',
  description:
    "Avvia l'analisi di sicurezza OWASP. Usalo sempre per ogni repository.",
  handler: async (
    bucket: string,
    key: string,
    context: string,
  ): Promise<string> => {
    return await invokeAgentLambda(process.env.LAMBDA_OWASP_NAME!, {
      s3Bucket: bucket,
      s3Key: key,
      orchestratorRaw: context,
    });
  },
});

const runTestAnalysis = tool({
  name: 'run_test_analysis',
  description:
    "Avvia l'analisi della test coverage e QA. Usalo sempre per ogni repository.",
  handler: async (
    bucket: string,
    key: string,
    context: string,
  ): Promise<string> => {
    return await invokeAgentLambda(process.env.LAMBDA_TEST_NAME!, {
      s3Bucket: bucket,
      s3Key: key,
      orchestratorRaw: context,
    });
  },
});

const runDocumentationAnalysis = tool({
  name: 'run_documentation_analysis',
  description:
    "Avvia l'analisi della documentazione. Usalo SOLO se il repository è contrassegnato come 'release'.",
  handler: async (
    bucket: string,
    key: string,
    context: string,
  ): Promise<string> => {
    return await invokeAgentLambda(process.env.LAMBDA_DOCS_NAME!, {
      s3Bucket: bucket,
      s3Key: key,
      orchestratorRaw: context,
    });
  },
});

interface OrchestratorEvent {
  s3Bucket: string;
  s3Key: string;
  isRelease: boolean; // Flag per determinare se è una release
  orchestratorRaw: string;
}

// Handler dell'Orchestratore
export const orchestratorHandler = async (
  event: OrchestratorEvent,
  context: any,
) => {
  const { s3Bucket: bucket, s3Key: key, isRelease, orchestratorRaw } = event;

  // Il System Prompt istruisce l'agente su quando usare determinati tool
  const systemInstruction = `You are a Lead Repository Auditor and Orchestrator.
  Your job is to coordinate specific sub-agents to analyze a repository stored in S3.
  
  RULES:
  1. ALWAYS run the OWASP security analysis.
  2. ALWAYS run the Test & QA analysis.
  3. ONLY run the Documentation analysis IF the provided context explicitly states this is a "RELEASE".
  
  Once you have gathered the results from the necessary tools, synthesize them into a final comprehensive executive summary.
  Respond ONLY with valid JSON matching the requested schema, containing the aggregated reports.`;

  const orchestratorAgent = new Agent({
    name: 'Main_Orchestrator',
    model: bedrockModel,
    systemPrompt: systemInstruction,
    tools: [runOwaspAnalysis, runTestAnalysis, runDocumentationAnalysis],
  });

  // Passiamo lo status della release nel prompt utente per far decidere l'agente
  const releaseStatus = isRelease
    ? 'This IS a RELEASE.'
    : 'This IS NOT a release.';
  const userPrompt = `Analyze the repo in bucket '${bucket}' under prefix '${key}'. 
  Status: ${releaseStatus}
  Context: ${orchestratorRaw}`;

  const finalResponse = await orchestratorAgent.run(userPrompt);

  return JSON.parse(finalResponse.text);
};
