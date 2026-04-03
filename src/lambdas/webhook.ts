// Modifica suggerita per src/lambdas/webhook.ts
export const handler = async (event: any) => {
  const { report, repoUrl, jobId, commitSha } = event;
  const apiKey = process.env.DESTINATION_API_KEY;
  const webhookUrl = process.env.DESTINATION_URL;

  if (!apiKey || !webhookUrl) {
    throw new Error(
      'Configurazione mancante: DESTINATION_API_KEY non definita.',
    );
  }

  // 2. Unisci il report originale con il repoUrl
  const finalPayload = {
    ...report,
    repoUrl: repoUrl,
    jobId: jobId,
    commitSha: commitSha
  };

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify(finalPayload),
    });

    if (!response.ok) {
      throw new Error(`Errore HTTP: ${response.status} ${response.statusText}`);
    }

    console.log('Webhook inviato con successo!');
    return { success: true };
  } catch (error: any) {
    console.error('Errore invio webhook:', error);
    throw new Error(`Impossibile inviare il webhook: ${error.message}`);
  }
};
