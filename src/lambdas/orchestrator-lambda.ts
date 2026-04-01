import {
  S3Client,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import {
  invokeSubAgent,
  extractFirstMeaningfulLine,
} from './utils/agent-invoker';

const s3Client = new S3Client({ region: process.env.AWS_REGION });
const MASTER_LEAD_ID = process.env.MASTER_LEAD_AGENT_ID || 'UNSET';
const ALIAS = process.env.OWASP_AGENT_ALIAS_ID || 'TSTALIASID';

const streamToString = (stream: any): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: any[] = [];
    stream.on('data', (chunk: any) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });

export const orchestratorHandler = async (event: any) => {
  const action = event.action;

  // ==========================================
  // FASE 1: PIANIFICAZIONE (PLAN)
  // ==========================================
  if (action === 'PLAN') {
    console.log('Orchestratore in fase di PLANNING...');

    // Recuperiamo i metadati generati dallo step precedente (pull-repo)
    const metadata = event.payload?.repoMetadata;

    // Attiviamo DOCS solo se c'è almeno un tag di release o un changelog
    let shouldRunDocs = true;
    if (metadata) {
      const hasTags = metadata.tags && metadata.tags.length > 0;
      shouldRunDocs = hasTags || metadata.hasChangelog;
    }

    return {
      runOwasp: true,
      runTest: true,
      runDocs: shouldRunDocs,
    };
  }

  // ==========================================
  // FASE 2: AGGREGAZIONE (AGGREGATE) - Nuova v2 (Clean Aggregation)
  // ==========================================
  if (action === 'AGGREGATE') {
    console.log('Orchestratore in fase di AGGREGAZIONE (v2)...');
    try {
      const { jobId, s3Bucket, reports } = event.payload;

      // Mappa per aggregare i risultati per Area (OWASP, TEST, DOCS)
      const areaMap: Record<string, { summary: string; report: string }> = {
        OWASP: { summary: '', report: '' },
        TEST: { summary: '', report: '' },
        DOCS: { summary: '', report: '' },
      };

      for (const report of reports) {
        if (report.status === 'success' && report.reportKey) {
          let content = '';
          try {
            const response = await s3Client.send(
              new GetObjectCommand({ Bucket: s3Bucket, Key: report.reportKey }),
            );
            content = await streamToString(response.Body);

            // Cleanup S3
            await s3Client.send(
              new DeleteObjectCommand({
                Bucket: s3Bucket,
                Key: report.reportKey,
              }),
            );
          } catch (err) {
            console.error(`Errore recupero report ${report.agent} da S3:`, err);
            continue;
          }

          try {
            const parsed = JSON.parse(content);
            const area = (
              parsed.area ||
              report.agent ||
              'UNKNOWN'
            ).toUpperCase();

            // Supporto raggruppamento per aree principali
            let targetArea = 'UNKNOWN';
            if (area.includes('OWASP')) targetArea = 'OWASP';
            else if (area.includes('TEST')) targetArea = 'TEST';
            else if (area.includes('DOCS')) targetArea = 'DOCS';
            else targetArea = area;

            if (!areaMap[targetArea]) {
              areaMap[targetArea] = { summary: '', report: '' };
            }

            // Aggregazione: concatena summary (se diversi) e report markdown
            if (
              parsed.summary &&
              !areaMap[targetArea].summary.includes(parsed.summary)
            ) {
              areaMap[targetArea].summary +=
                (areaMap[targetArea].summary ? '\n' : '') + parsed.summary;
            }
            if (parsed.report) {
              areaMap[targetArea].report +=
                (areaMap[targetArea].report ? '\n\n' : '') + parsed.report;
            }
          } catch (e) {
            console.warn(
              `[Orchestratore] Report ${report.agent} non è un JSON valido o manca di struttura v2.`,
            );
          }
        }
      }

      // ==========================================
      // FASE 3: MASTER POLISHING (Refining Area by Area)
      // ==========================================
      console.log('Orchestratore: avvio fase di Master Polishing...');

      const analysisDetails: {
        agentName: string;
        summary: string;
        report: string;
      }[] = [];

      for (const [area, data] of Object.entries(areaMap)) {
        if (!data.report || data.report.trim() === '') continue;

        console.log(`Orchestratore: polishing area ${area}...`);

        let polishedReport = data.report;
        if (MASTER_LEAD_ID !== 'UNSET') {
          try {
            polishedReport = await invokeSubAgent(
              MASTER_LEAD_ID,
              ALIAS,
              `RAFFINAMENTO AREA ${area}.
              SINTESI STRATEGICA: Accorcia le spiegazioni se il testo è troppo lungo. 
              Il report finale deve essere completo e chiuso correttamente (niente frasi a metà).
              MANTENIMENTO DATI: Non rimuovere mai file o vulnerabilità trovate.
              REPORT DA PULIRE:
              ${data.report}`,
              `POLISHER_${area}`,
              true,
            );
          } catch (e) {
            console.error(`Errore nel polishing di ${area}:`, e);
            // Mantieni il report originale in caso di errore
          }
        }

        const dynamicSummary =
          extractFirstMeaningfulLine(
            polishedReport,
            /[📊🏆📘⚖️⚠️🔍🧪🛠️🔴🟠🟡]/g,
          ) ||
          data.summary ||
          'Analisi completata.';

        analysisDetails.push({
          agentName: area,
          summary: dynamicSummary,
          report: polishedReport,
        });
      }

      return {
        jobId,
        analysisDetails,
      };
    } catch (error: any) {
      console.error('Errore in AGGREGAZIONE v2:', error?.message);
      return {
        jobId: event.payload?.jobId ?? 'unknown',
        analysisDetails: [],
      };
    }
  }

  console.error('Azione non riconosciuta:', event.action);
  return {
    jobId: event.payload?.jobId ?? 'unknown',
    analysisDetails: [],
  };
};
