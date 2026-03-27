// aws-step-functions.ts
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';

const client = new SFNClient({
  region: process.env.AWS_REGION ?? 'eu-central-1',
});

export async function startStepFunctionExecution(input: {
  jobId: string;
  repoUrl: string;
  commitSha: string;
  webhookUrl: string;
}): Promise<string> {
  const command = new StartExecutionCommand({
    stateMachineArn: process.env.STATE_MACHINE_ARN,
    name: input.jobId,
    input: JSON.stringify(input),
  });

  const response = await client.send(command);
  return response.executionArn!;
}
