import { z } from 'zod';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { BedrockAgentRuntimeClient, InvokeAgentCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import { randomUUID } from 'crypto';
import { unzipRepoToTemp } from './tools/decompressione-zip.tool';
import { listRepositoryFiles } from './tools/find-all-files.tool';
import { readFileContent } from './tools/read-file-content.tool';

const s3Client = new S3Client({});
const bedrockClient = new BedrockAgentRuntimeClient({ region: 'eu-central-1' });

const TestAgentEventSchema = z.object({
  s3Bucket: z.string(),
  s3Key: z.string(),
  s3Prefix: z.string(),
});

const AGENT_ID = process.env.TEST_AGENT_ID || 'L3EB5WS1ZU';
const AGENT_ALIAS_ID = process.env.TEST_AGENT_ALIAS_ID || 'TSTALIASID';

export const testAgentHandler = async (event: unknown) => {
  console.log('TEST: START');
  try {
    const { s3Bucket: bucket, s3Key: key, s3Prefix } = TestAgentEventSchema.parse(event);

    console.log('TEST: downloading and extracting repo...');
    const extractPath = await unzipRepoToTemp(bucket, key);
    console.log(`TEST: repo extracted to ${extractPath}`);

    const sessionId = randomUUID();
    const initialPrompt = `Please analyze the test coverage of the codebase extracted in this local directory: ${extractPath}\nUse your available tools to list all files, identify test files (*.spec.ts, *.test.ts), read them, and cross-reference with the source files to produce your report.`;

    let command = new InvokeAgentCommand({
      agentId: AGENT_ID,
      agentAliasId: AGENT_ALIAS_ID,
      sessionId,
      inputText: initialPrompt,
    });

    let finalMarkdownReport = '';

    while (true) {
      console.log('TEST: Invoking AWS Bedrock Agent...');
      const response = await bedrockClient.send(command);

      if (!response.completion) {
        console.error('TEST: response.completion is undefined.');
        break;
      }

      let returnControlInvocationResults: any[] = [];
      let returnControlInvocationId: string | undefined;
      let streamedText = '';

      for await (const chunk of response.completion) {
        if (chunk.chunk) {
          streamedText += new TextDecoder().decode(chunk.chunk.bytes);
        } else if (chunk.returnControl) {
          console.log('TEST: Intercepted Return of Control from AWS!');
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
              actionGroup = invocation.functionInvocationInput.actionGroup || '';
              functionName = invocation.functionInvocationInput.function || '';
              parameters = invocation.functionInvocationInput.parameters || [];
            } else if (invocation.apiInvocationInput) {
              isApi = true;
              actionGroup = invocation.apiInvocationInput.actionGroup || '';
              apiPath = invocation.apiInvocationInput.apiPath || '';
              httpMethod = invocation.apiInvocationInput.httpMethod || 'POST';
              functionName = apiPath.replace(/^\//, '');
              const apiParams = invocation.apiInvocationInput.parameters || [];
              const bodyParams = invocation.apiInvocationInput.requestBody?.content?.['application/json']?.properties || [];
              parameters = [...apiParams, ...bodyParams];
            } else {
              continue;
            }

            console.log(`TEST: Executing local tool -> ${functionName} with params:`, JSON.stringify(parameters));

            let toolResponse = '';
            try {
              if (functionName === 'list_repository_files') {
                const rawContent = await listRepositoryFiles.callback({ basePath: extractPath });
                const lines = rawContent.split('\n');
                const filtered = lines.filter(f => 
                  (f.endsWith('.ts') || f.endsWith('.js') || f.endsWith('.php') || f.endsWith('.py') || f.endsWith('.java') || f.endsWith('.go') || f.endsWith('.rb') || f.endsWith('.c') || f.endsWith('.cpp') || f.endsWith('.cs') || f.endsWith('.html') || f.endsWith('.css') || f.endsWith('.md') || f.endsWith('.json') || f.endsWith('.yaml') || f.endsWith('.yml') || f.endsWith('.sql')) && 
                  !f.includes('node_modules') && 
                  !f.includes('.git') &&
                  !f.includes('/vendor/') &&
                  !f.includes('/dist/')
                );
                toolResponse = filtered.slice(0, 1000).join('\n');
              } else if (functionName === 'read_file_content') {
                let filePath = parameters?.find((p: any) => p.name === 'filePath')?.value || '';
                if (!filePath || filePath === '') {
                  toolResponse = 'Error: Missing filePath parameter.';
                } else {
                  if (!filePath.startsWith('/tmp/')) {
                    const path = require('path');
                    filePath = path.join(extractPath, filePath.replace(/^[/\\]+/, ''));
                    console.log(`TEST: Coerced relative filePath to absolute: ${filePath}`);
                  }
                  const content = await readFileContent.callback({ filePath });
                  toolResponse = content.substring(0, 24000);
                }
              } else {
                toolResponse = `Error: Unsupported function ${functionName}`;
              }
            } catch (err: any) {
              console.error(`TEST Tool Error (${functionName}):`, err.message);
              toolResponse = `Error executing tool: ${err.message}`;
            }

            console.log(`TEST: Tool execution finished. Response length: ${toolResponse.length}`);

            if (isApi) {
              returnControlInvocationResults.push({
                apiResult: {
                  actionGroup,
                  apiPath,
                  httpMethod,
                  httpStatusCode: 200,
                  responseBody: {
                    'application/json': {
                      body: JSON.stringify({ result: toolResponse })
                    }
                  }
                }
              });
            } else {
              returnControlInvocationResults.push({
                functionResult: {
                  actionGroup,
                  function: functionName,
                  responseBody: {
                    TEXT: { body: toolResponse }
                  }
                }
              });
            }
          }
        }
      }

      if (returnControlInvocationResults.length > 0 && returnControlInvocationId) {
        command = new InvokeAgentCommand({
          agentId: AGENT_ID,
          agentAliasId: AGENT_ALIAS_ID,
          sessionId,
          sessionState: {
            invocationId: returnControlInvocationId,
            returnControlInvocationResults
          }
        });
      } else {
        finalMarkdownReport = streamedText;
        break;
      }
    }

    console.log('TEST Agent invocation complete.');

    let cleanMarkdown = finalMarkdownReport.replace(/<thinking>.*?<\/thinking>/gs, '').trim();
    const startIndex = cleanMarkdown.indexOf('## Riepilogo');
    if (startIndex !== -1) cleanMarkdown = cleanMarkdown.substring(startIndex);

    const reportKey = `${s3Prefix}/test-report.md`;
    await s3Client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: reportKey,
      Body: cleanMarkdown,
      ContentType: 'text/markdown',
    }));

    return { agent: 'test', status: 'success', reportKey };

  } catch (err: any) {
    console.error('TEST CRASH:', err?.message, err?.stack);
    return { agent: 'test', status: 'error', error: err?.message ?? 'crash silenzioso' };
  }
};