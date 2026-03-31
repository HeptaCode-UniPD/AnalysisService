import { z } from 'zod';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  BedrockAgentRuntimeClient,
  InvokeAgentCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { randomUUID } from 'crypto';
import { unzipRepoToTemp } from './tools/decompressione-zip.tool';
import { listRepositoryFiles } from './tools/find-all-files.tool';
import { readFileContent } from './tools/read-file-content.tool';

const s3Client = new S3Client({});
const bedrockClient = new BedrockAgentRuntimeClient({ region: 'eu-central-1' });

const DocAgentEventSchema = z.object({
  s3Bucket: z.string(),
  s3Key: z.string(),
  s3Prefix: z.string(),
});

const AGENT_ID = process.env.DOCS_AGENT_ID || 'DB16ZAYK3A';
const AGENT_ALIAS_ID = process.env.DOCS_AGENT_ALIAS_ID || 'TSTALIASID';

export const docAgentHandler = async (event: unknown) => {
  console.log('DOCS: START');
  try {
    const {
      s3Bucket: bucket,
      s3Key: key,
      s3Prefix,
    } = DocAgentEventSchema.parse(event);

    console.log('DOCS: downloading and extracting repo...');
    const extractPath = await unzipRepoToTemp(bucket, key);
    console.log(`DOCS: repo extracted to ${extractPath}`);

    const sessionId = randomUUID();
    const initialPrompt = `Please analyze the documentation of the codebase extracted in this local directory: ${extractPath}\nUse your available tools to list all files, read the key source files (controllers, services, modules, README), and produce your documentation report.`;

    let command = new InvokeAgentCommand({
      agentId: AGENT_ID,
      agentAliasId: AGENT_ALIAS_ID,
      sessionId,
      inputText: initialPrompt,
    });

    let finalMarkdownReport = '';

    while (true) {
      console.log('DOCS: Invoking AWS Bedrock Agent...');
      const response = await bedrockClient.send(command);

      if (!response.completion) {
        console.error('DOCS: response.completion is undefined.');
        break;
      }

      let returnControlInvocationResults: any[] = [];
      let returnControlInvocationId: string | undefined;
      let streamedText = '';

      for await (const chunk of response.completion) {
        if (chunk.chunk) {
          streamedText += new TextDecoder().decode(chunk.chunk.bytes);
        } else if (chunk.returnControl) {
          console.log('DOCS: Intercepted Return of Control from AWS!');
          returnControlInvocationId = chunk.returnControl.invocationId;
          const invocationInputs = chunk.returnControl.invocationInputs || [];

          for (const invocation of invocationInputs) {
            let actionGroup = '';
            let functionName = '';
            let parameters: any[] = [];
            let isApi = false;
            let apiPath = '';
            let httpMethod = '';

            if (invocation.functionInvocationInput) {
              actionGroup =
                invocation.functionInvocationInput.actionGroup || '';
              functionName = invocation.functionInvocationInput.function || '';
              parameters = invocation.functionInvocationInput.parameters || [];
            } else if (invocation.apiInvocationInput) {
              isApi = true;
              actionGroup = invocation.apiInvocationInput.actionGroup || '';
              apiPath = invocation.apiInvocationInput.apiPath || '';
              httpMethod = invocation.apiInvocationInput.httpMethod || 'POST';
              functionName = apiPath.replace(/^\//, '');
              const apiParams = invocation.apiInvocationInput.parameters || [];
              const bodyParams =
                invocation.apiInvocationInput.requestBody?.content?.[
                  'application/json'
                ]?.properties || [];
              parameters = [...apiParams, ...bodyParams];
            } else {
              continue;
            }

            console.log(
              `DOCS: Executing local tool -> ${functionName} with params:`,
              JSON.stringify(parameters),
            );

            let toolResponse = '';
            try {
              if (functionName === 'list_repository_files') {
                const rawContent = await listRepositoryFiles.callback({
                  basePath: extractPath,
                });
                const lines = rawContent.split('\n');
                const filtered = lines.filter(
                  (f) =>
                    (f.endsWith('.md') ||
                      f.endsWith('.txt') ||
                      f.endsWith('.json') ||
                      f.endsWith('.yaml') ||
                      f.endsWith('.yml') ||
                      f.includes('/docs/') ||
                      f.includes('/doc/')) &&
                    !f.includes('node_modules') &&
                    !f.includes('.git') &&
                    !f.includes('/vendor/') &&
                    !f.includes('/dist/'),
                );
                toolResponse = filtered.slice(0, 1000).join('\n');
              } else if (functionName === 'read_file_content') {
                let filePath =
                  parameters?.find((p: any) => p.name === 'filePath')?.value ||
                  '';
                if (!filePath || filePath === '') {
                  toolResponse = 'Error: Missing filePath parameter.';
                } else {
                  if (!filePath.startsWith('/tmp/')) {
                    const path = require('path');
                    filePath = path.join(
                      extractPath,
                      filePath.replace(/^[/\\]+/, ''),
                    );
                    console.log(
                      `DOCS: Coerced relative filePath to absolute: ${filePath}`,
                    );
                  }
                  const content = await readFileContent.callback({ filePath });
                  toolResponse = content.substring(0, 24000);
                }
              } else {
                toolResponse = `Error: Unsupported function ${functionName}`;
              }
            } catch (err: any) {
              console.error(`DOCS Tool Error (${functionName}):`, err.message);
              toolResponse = `Error executing tool: ${err.message}`;
            }

            console.log(
              `DOCS: Tool execution finished. Response length: ${toolResponse.length}`,
            );

            if (isApi) {
              returnControlInvocationResults.push({
                apiResult: {
                  actionGroup,
                  apiPath,
                  httpMethod,
                  httpStatusCode: 200,
                  responseBody: {
                    'application/json': {
                      body: JSON.stringify({ result: toolResponse }),
                    },
                  },
                },
              });
            } else {
              returnControlInvocationResults.push({
                functionResult: {
                  actionGroup,
                  function: functionName,
                  responseBody: {
                    TEXT: { body: toolResponse },
                  },
                },
              });
            }
          }
        }
      }

      if (
        returnControlInvocationResults.length > 0 &&
        returnControlInvocationId
      ) {
        command = new InvokeAgentCommand({
          agentId: AGENT_ID,
          agentAliasId: AGENT_ALIAS_ID,
          sessionId,
          sessionState: {
            invocationId: returnControlInvocationId,
            returnControlInvocationResults,
          },
        });
      } else {
        finalMarkdownReport = streamedText;
        break;
      }
    }

    console.log('DOCS Agent invocation complete.');

    let cleanMarkdown = finalMarkdownReport
      .replace(/<thinking>.*?<\/thinking>/gs, '')
      .trim();
    const startIndex = cleanMarkdown.indexOf('## Riepilogo');
    if (startIndex !== -1) cleanMarkdown = cleanMarkdown.substring(startIndex);

    const reportKey = `${s3Prefix}/docs-report.json`;
    const reportPayload = JSON.stringify({ area: 'DOCS', report: cleanMarkdown });
    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: reportKey,
        Body: reportPayload,
        ContentType: 'application/json',
      }),
    );

    return { agent: 'docs', status: 'success', reportKey };
  } catch (err: any) {
    console.error('DOCS CRASH:', err?.message, err?.stack);
    return {
      agent: 'docs',
      status: 'error',
      error: err?.message ?? 'crash silenzioso',
    };
  }
};
