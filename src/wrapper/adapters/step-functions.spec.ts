const mockSfnSend = jest.fn();

jest.mock('@aws-sdk/client-sfn', () => ({
  SFNClient: jest.fn().mockImplementation(() => ({
    send: mockSfnSend,
  })),
  StartExecutionCommand: jest.fn().mockImplementation((input: any) => ({ input })),
}));

// Corretto il nome del file e della funzione importata
import { startStepFunctionExecution } from './aws-step-functions';

describe('StepFunctionsAdapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STATE_MACHINE_ARN = 'arn:aws:states:us-east-1:123456789012:stateMachine:AnalysisWorkflow';
  });

  it('dovrebbe invocare startExecution con il payload corretto', async () => {
    mockSfnSend.mockResolvedValue({ executionArn: 'arn:aws:states:execution-123' });

    const mockPayload = { repoUrl: 'https://github.com/test', s3Bucket: 'b', s3Key: 'k' };
    const result = await startStepFunctionExecution(mockPayload);

    expect(result).toBe('arn:aws:states:execution-123');
    expect(mockSfnSend).toHaveBeenCalledTimes(1);
    
    const call = mockSfnSend.mock.calls[0][0];
    const input = JSON.parse(call.input.input);
    
    expect(input).toMatchObject(mockPayload);
  });

  it('dovrebbe lanciare InternalServerErrorException se l\'invocazione SDK fallisce', async () => {
    mockSfnSend.mockRejectedValue(new Error('AWS SFN Error'));
    // L'adattatore lancia InternalServerErrorException di NestJS
    await expect(startStepFunctionExecution({})).rejects.toThrow("Impossibile avviare l'analisi su AWS.");
  });

  it('dovrebbe lanciare errore se manca STATE_MACHINE_ARN', async () => {
    delete process.env.STATE_MACHINE_ARN;
    await expect(startStepFunctionExecution({})).rejects.toThrow('Configurazione mancante');
  });
});
