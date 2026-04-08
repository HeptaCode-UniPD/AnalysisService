jest.mock('./adapters/aws-step-functions', () => ({
  startStepFunctionExecution: jest.fn(),
}));

import { AppService } from './app.service';
import { startStepFunctionExecution } from './adapters/aws-step-functions';

describe('AppService', () => {
  let appService: AppService;

  beforeEach(() => {
    appService = new AppService();
    jest.clearAllMocks();
  });

  const mockPayload = { repoUrl: 'https://github.com/test', s3Bucket: 'b', s3Key: 'k', jobId: 'job-unique-id', commitSha: 'abc123sha' };

  it('dovrebbe innescare l\'analisi corretta e restituire arn e jobId', async () => {
    const mockArn = 'arn:aws:states:us-east-1:12345:execution:AnalysisWorkflow:job-unique-id';
    (startStepFunctionExecution as jest.Mock).mockResolvedValue(mockArn);

    const result = await appService.triggerAnalysis(mockPayload);

    expect(startStepFunctionExecution).toHaveBeenCalledWith(mockPayload);
    
    expect(result.executionArn).toBe(mockArn);
    expect(result.jobId).toBe('job-unique-id');
  });

  it('dovrebbe gestire fallimenti dell\'adattatore SFN', async () => {
    (startStepFunctionExecution as jest.Mock).mockRejectedValue(new Error('SFN Start Failure'));

    await expect(appService.triggerAnalysis(mockPayload)).rejects.toThrow('SFN Start Failure');
  });
});
