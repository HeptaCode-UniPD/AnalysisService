export const handler = async (event: any) => {
  console.log('Payload ricevuto:', JSON.stringify(event));

  const { jobId, errorInfo, repoUrl } = event;

  // Cerchiamo sia la versione maiuscola che minuscola per compatibilità totale
  const errorType = errorInfo?.Error || errorInfo?.error || 'UnknownError';
  const errorCause =
    errorInfo?.Cause || errorInfo?.cause || 'No specific cause';

  const webhookUrl = process.env.DESTINATION_URL;
  const apiKey = process.env.DESTINATION_API_KEY;

  console.error(`[FAILURE] Job ${jobId} fallito. Errore: ${errorType}`);

  if (!webhookUrl || !apiKey) {
    console.error(
      'Configurazione mancante in failureHandler. Impossibile inviare il webhook.',
    );
    return;
  }

  const payload = {
    jobId,
    repoUrl,
    status: 'failed',
    errorType: errorType,
    // Proviamo a estrarre un messaggio leggibile dalla 'cause' (che spesso è una stringa JSON)
    message: errorCause
      ? typeof errorCause === 'string'
        ? errorCause
        : JSON.stringify(errorCause)
      : 'Errore imprevisto nella pipeline.',
  };

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify(payload),
    });

    console.log(`Notifica di fallimento inviata. Status: ${response.status}`);
  } catch (e) {
    console.error("Errore durante l'invio del webhook di fallimento:", e);
  }
};
