import { z } from 'zod';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { BedrockAgentRuntimeClient, InvokeAgentCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import { randomUUID } from 'crypto';
import { unzipRepoToTemp } from './tools/decompressione-zip.tool';
import { listRepositoryFiles } from './tools/find-all-files.tool';
import { readFileContent } from './tools/read-file-content.tool';

const s3Client = new S3Client({});
const bedrockClient = new BedrockAgentRuntimeClient({ region: 'eu-central-1' });

const OwaspAgentEventSchema = z.object({
  s3Bucket: z.string(),
  s3Key: z.string(),
  s3Prefix: z.string(),
});

const AGENT_ID = process.env.OWASP_AGENT_ID || 'PILT1S5IL6';
const AGENT_ALIAS_ID = process.env.OWASP_AGENT_ALIAS_ID || 'TSTALIASID';

export const owaspAgentHandler = async (event: unknown) => {
  console.log('OWASP: START');
  try {
    const { s3Bucket: bucket, s3Key: key, s3Prefix } = OwaspAgentEventSchema.parse(event);

    console.log('OWASP: downloading and extracting repo...');
    const extractPath = await unzipRepoToTemp(bucket, key);
    console.log(`OWASP: repo extracted to ${extractPath}`);

    const sessionId = randomUUID();
    const initialPrompt = `Please analyze the codebase extracted in this local directory: ${extractPath}\nUse your available tools to explore the directory and read the files to perform the OWASP security audit.`;

    let command = new InvokeAgentCommand({
      agentId: AGENT_ID,
      agentAliasId: AGENT_ALIAS_ID,
      sessionId,
      inputText: initialPrompt,
    });

    let finalMarkdownReport = '';

    while (true) {
      console.log('OWASP: Invoking AWS Bedrock Agent...');
      const response = await bedrockClient.send(command);
      
      let returnControlInvocationResults: any[] = [];
      let returnControlInvocationId: string | undefined;
      let streamedText = '';

      if (!response.completion) {
        console.error('OWASP: response.completion is undefined.');
        break;
      }

      for await (const chunk of response.completion) {
        if (chunk.chunk) {
          streamedText += new TextDecoder().decode(chunk.chunk.bytes);
        } else if (chunk.returnControl) {
          console.log('OWASP: Intercepted Return of Control from AWS!');
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
              
              // Estrae i parametri sia da 'parameters' che da 'requestBody'
              const apiParams = invocation.apiInvocationInput.parameters || [];
              const bodyParams = invocation.apiInvocationInput.requestBody?.content?.['application/json']?.properties || [];
              parameters = [...apiParams, ...bodyParams];
            } else {
              continue;
            }

            console.log(`OWASP: Executing local tool -> ${functionName} with params:`, JSON.stringify(parameters));
            
            let toolResponse = '';
            try {
              if (functionName === 'list_repository_files') {
                const rawContent = await listRepositoryFiles.callback({ basePath: extractPath });
                // Filtriamo i file per inviare solo quelli rilevanti (src, dist, config) e non superare i limiti di Bedrock
                const lines = rawContent.split('\n');
                const filtered = lines.filter(f => 
                  (f.endsWith('.ts') || f.endsWith('.js') || f.endsWith('.php') || f.endsWith('.py') || f.endsWith('.java') || f.endsWith('.go') || f.endsWith('.rb') || f.endsWith('.c') || f.endsWith('.cpp') || f.endsWith('.cs') || f.endsWith('.html') || f.endsWith('.css') || f.endsWith('.md') || f.endsWith('.json') || f.endsWith('.yaml') || f.endsWith('.yml') || f.endsWith('.sql')) && 
                  !f.includes('node_modules') && 
                  !f.includes('.git') &&
                  !f.includes('/vendor/') &&
                  !f.includes('/dist/')
                );
                toolResponse = filtered.slice(0, 1000).join('\n'); // Max 1000 file
              } else if (functionName === 'read_file_content') {
                let filePath = parameters?.find((p: any) => p.name === 'filePath')?.value || '';
                
                if (!filePath || filePath === '') {
                    toolResponse = 'Error: Missiong filePath parameter.';
                } else {
                    if (!filePath.startsWith('/tmp/')) {
                      const path = require('path');
                      filePath = path.join(extractPath, filePath.replace(/^[\\/\\\\]+/, ''));
                      console.log(`OWASP: Coerced relative filePath to absolute: ${filePath}`);
                    }
                    const content = await readFileContent.callback({ filePath });
                    toolResponse = content.substring(0, 24000); 
                }
              } else {
                toolResponse = `Error: Unsupported function ${functionName}`;
              }
            } catch (err: any) {
              console.error(`OWASP Tool Error (${functionName}):`, err.message);
              toolResponse = `Error executing tool: ${err.message}`;
            }

            console.log(`OWASP: Tool execution finished. Response length: ${toolResponse.length}`);
            if (toolResponse.length > 20000) {
              console.warn('OWASP: Warning, toolResponse is very large, Bedrock might truncate or reject it!');
            }

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
                    TEXT: {
                      body: toolResponse
                    }
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

    console.log('OWASP Agent invocation complete.');

    let cleanMarkdown = finalMarkdownReport.replace(/<thinking>.*?<\/thinking>/gs, '').trim();
    const startIndex = cleanMarkdown.indexOf('## Riepilogo');
    if (startIndex !== -1) cleanMarkdown = cleanMarkdown.substring(startIndex);

    const reportKey = `${s3Prefix}/owasp-report.md`;
    await s3Client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: reportKey,
      Body: cleanMarkdown,
      ContentType: 'text/markdown',
    }));

    return { agent: 'owasp', status: 'success', reportKey };

  } catch (err: any) {
    console.error('OWASP CRASH:', err?.message, err?.stack);
    return { agent: 'owasp', status: 'error', error: err?.message ?? 'crash silenzioso' };
  }
};