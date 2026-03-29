export const handler = async (event: any) => {
  const { webhookUrl, report } = event;

  console.log(`Invio report al webhook: ${webhookUrl}`);

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(report),
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
