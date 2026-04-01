import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { InternalServerErrorException } from '@nestjs/common';

// Inizializza il client fuori dalla funzione per sfruttare il riutilizzo (caching) nelle Lambda
const sfnClient = new SFNClient({
  region: process.env.AWS_REGION || 'eu-west-1',
});

export const startStepFunctionExecution = async (
  payload: any,
): Promise<string> => {
  const stateMachineArn = process.env.STATE_MACHINE_ARN;

  if (!stateMachineArn) {
    throw new InternalServerErrorException(
      'Configurazione mancante: STATE_MACHINE_ARN non definito.',
    );
  }

  try {
    const command = new StartExecutionCommand({
      stateMachineArn,
      input: JSON.stringify(payload),
    });

    const response = await sfnClient.send(command);

    if (!response.executionArn) {
      throw new Error('ARN non restituito da AWS.');
    }

    return response.executionArn;
  } catch (error) {
    console.error('Errore di comunicazione con AWS Step Functions:', error);
    // Lanciamo un'eccezione HTTP di NestJS per una risposta pulita al client
    throw new InternalServerErrorException(
      "Impossibile avviare l'analisi su AWS.",
    );
  }
};
