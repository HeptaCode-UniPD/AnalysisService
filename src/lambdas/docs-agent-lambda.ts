import { z } from 'zod';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { unzipRepoToTemp } from './tools/decompressione-zip.tool';
import { createFullChunks } from './utils/smart-bundler';
import { invokeSubAgent, extractFirstMeaningfulLine } from './utils/agent-invoker';

const s3Client = new S3Client({});

const DocAgentEventSchema = z.object({
  s3Bucket: z.string(),
  s3Key: z.string(),
  s3Prefix: z.string(),
});

const AGENT_TECH_ID  = process.env.DOCS_TECH_AGENT_ID  || 'ZPFNNQK2FO';
const AGENT_GOV_ID   = process.env.DOCS_GOV_AGENT_ID   || 'UVFEQBJS1T';
const AGENT_LEAD_ID  = process.env.DOCS_AGENT_ID        || 'DB16ZAYK3A';
const ALIAS          = process.env.DOCS_AGENT_ALIAS_ID  || 'TSTALIASID';

const NO_TOOLS = `⚠️ REGOLA FERREA: NON USARE TOOL. Hai già tutto il contesto nel testo sotto. Produci solo il report Markdown richiesto.`;

const invokeSpec = (id: string, prompt: string, name: string) =>
  invokeSubAgent(id, ALIAS, prompt, name, false);

const invokeLead = (id: string, prompt: string, name: string) =>
  invokeSubAgent(id, ALIAS, prompt, name, true);

export const docAgentHandler = async (event: unknown) => {
  console.log('DOCS MULTI-AGENT (v2): START');
  try {
    const { s3Bucket: bucket, s3Key: key, s3Prefix } = DocAgentEventSchema.parse(event);

    console.log('DOCS: extraction and bundling...');
    const extractPath = await unzipRepoToTemp(bucket, key);
    const fullChunks = await createFullChunks(extractPath);
    console.log(`DOCS: ${fullChunks.length} full chunk(s).`);

    console.log('DOCS: launching parallel sub-analyses...');

    // ── 1. Tech Review — tutti i chunk in sequenza ──
    const techResPromise = (async () => {
      const parts: string[] = [];
      for (let i = 0; i < fullChunks.length; i++) {
        console.log(`DOCS: Tech review chunk ${i + 1}/${fullChunks.length}...`);
        parts.push(await invokeSpec(
          AGENT_TECH_ID,
          `${NO_TOOLS}

RUOLO: Senior Technical Writer. Analizza la documentazione tecnica in questo chunk.
Chunk ${i + 1} di ${fullChunks.length}.

COMPITO:
1. Identifica: README, guide, API docs e commenti tecnici (JSDoc/PHPDoc).
2. Se non trovi nulla, scrivi 'Nessuna documentazione tecnica rilevata in questo chunk'.
3. NON segnalare mancanze globali. Riporta solo ciò che vedi qui.
PRODUCI: Report tecnico in Markdown con titolo "## 📘 Revisione Tecnica (chunk ${i + 1}/${fullChunks.length})".`,
          `TECH_WRITER_${i + 1}`,
        ));
      }
      return parts.join('\n\n---\n\n');
    })();

    // ── 2. Compliance & Standards — tutti i chunk in sequenza ──
    const govResPromise = (async () => {
      const parts: string[] = [];
      for (let i = 0; i < fullChunks.length; i++) {
        console.log(`DOCS: Service scan chunk ${i + 1}/${fullChunks.length}...`);
        parts.push(await invokeSpec(
          AGENT_GOV_ID,
          `${NO_TOOLS}

RUOLO: Project Standard Officer. Analizza file informativi e legali in questo chunk.
Chunk ${i + 1} di ${fullChunks.length}.

COMPITO:
1. Identifica: LICENSE, informative security, CONTRIBUTING o file legali.
2. Se non trovi nulla, scrivi 'Nessun file informativo rilevato in questo chunk'.
3. NON segnalare mancanze globali. Riporta solo ciò che vedi qui.
PRODUCI: Report tecnico in Markdown con titolo "## ⚖️ Standard di Progetto (chunk ${i + 1}/${fullChunks.length})".`,
          `COMPLIANCE_OFFICER_${i + 1}`,
        ));
      }
      return parts.join('\n\n---\n\n');
    })();

    const [techRes, govRes] = await Promise.all([techResPromise, govResPromise]);

    console.log('DOCS: specialized analysis complete. Starting Domain Lead aggregation...');

    const finalReport = await invokeLead(
      AGENT_LEAD_ID,
      `${NO_TOOLS}

RUOLO: Project Documentation Lead (Giudice Globale).

ANALISI RICEVUTE:
---
${techRes}

---
${govRes}
---

COMPITO:
1. Esegui una SINTESI GLOBALE. Un file (es. README, LICENSE) è PRESENTE se appare in ALMENO uno dei report.
2. SEGNALA COME MANCANTE solo ciò che non appare in NESSUNO dei report ricevuti.
3. Riorganizza in "## ⚖️ Analisi Standard e UX".
4. Per ogni deficit globale:
   - **Punto Critico**: [Descrizione]
   - **Dettaglio**: [Perché è un problema]
   - **Suggerimento**: [Azione correttiva]
5. Fornisci "Global Maturity Score" (0-100) basandoti sulla visione d'insieme.
PRODUCI: Report Finale in Markdown con header "# 📘 Documentation & UX Strategy".`,
      'DOCS_LEAD',
    );

    const dynamicSummary =
      extractFirstMeaningfulLine(finalReport, /[📘⚖️⚠️🔴🟠🟡🎨]/g) ||
      'Analisi DOCS completata.';

    const reportKey = `${s3Prefix}/docs-report.json`;
    await s3Client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: reportKey,
      Body: JSON.stringify({ area: 'DOCS', summary: dynamicSummary, report: finalReport }),
      ContentType: 'application/json',
    }));

    return { agent: 'docs', status: 'success', reportKey };
  } catch (err: any) {
    console.error('DOCS MULTI-AGENT CRASH:', err?.message);
    return { agent: 'docs', status: 'error', error: err?.message };
  }
};