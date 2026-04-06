export const handler = async (event: any) => {
  const { report, repoUrl, jobId, commitSha } = event;
  const apiKey = process.env.DESTINATION_API_KEY;
  const webhookUrl = process.env.DESTINATION_URL;

  if (!apiKey || !webhookUrl) {
    throw new Error(
      'Configurazione mancante: DESTINATION_API_KEY non definita.',
    );
  }

  const payload = report?.Payload ?? report;

  const finalPayload = {
    analysisDetails:payload.analysisDetails || [],
    repoUrl: repoUrl,
    commitId: commitSha,
    jobId: jobId,
    status: 'done'
  };

  const headers = {
    'Content-Type': 'application/json',
    'x-ms1-key': apiKey,
  }

  console.log('Headers in invio:', headers);

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: headers,
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
