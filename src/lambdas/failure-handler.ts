export const handler = async (event: any) => {
  console.log('Payload ricevuto:', JSON.stringify(event));

  const { repoUrl, jobId, commitSha, errorInfo } = event;

  const errorType = errorInfo?.Error || errorInfo?.error || 'UnknownError';
  const errorCause = errorInfo?.Cause || errorInfo?.cause || 'No specific cause';
  
  let errorMessage = 'Errore imprevisto nella pipeline.';

  try {
    // Spesso AWS Step Functions passa "Cause" come stringa JSON. Proviamo a farne il parse.
    const parsedCause = typeof errorCause === 'string' ? JSON.parse(errorCause) : errorCause;
    // Estraiamo solo il messaggio pulito
    errorMessage = parsedCause.errorMessage || parsedCause.message || errorCause;
  } catch (e) {
    // Se non è un JSON valido, usiamo la stringa originale
    errorMessage = typeof errorCause === 'string' ? errorCause : JSON.stringify(errorCause);
  }
  const webhookUrl = process.env.DESTINATION_URL;
  const apiKey = process.env.DESTINATION_API_KEY;

  console.error(`[FAILURE] Job ${jobId} fallito. Errore: ${errorType}`);

  if (!webhookUrl || !apiKey) {
    console.error(
      'Configurazione mancante in failureHandler. Impossibile inviare il webhook.',
    );
    return;
  }

  const payloadError = [
    { agentName: 'OWASP', summary: '', report: '' },
    { agentName: 'TEST', summary: '', report: '' },
    { agentName: 'DOCS', summary: '', report: '' },
  ];

  const payload = {
    analysisDetails: payloadError,
    repoUrl: repoUrl,
    commitId: commitSha,
    jobId: jobId,
    status: 'error',
    error: errorMessage
  };

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ms1-key': apiKey,
      },
      body: JSON.stringify(payload),
    });

    console.log(`Notifica di fallimento inviata. Status: ${response.status}`);
  } catch (e) {
    console.error("Errore durante l'invio del webhook di fallimento:", e);
  }
};
