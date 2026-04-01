import { z } from 'zod';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { unzipRepoToTemp } from './tools/decompressione-zip.tool';
import { createFullChunks, getTopLevelFiles } from './utils/smart-bundler';
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
    const topLevelFiles = getTopLevelFiles(extractPath);
    const fullChunks = await createFullChunks(extractPath);
    console.log(`DOCS: ${fullChunks.length} full chunk(s). Files found: ${topLevelFiles.join(', ')}`);

    const fileMetadataInfo = `LISTA FILE REALI NELLA ROOT: [${topLevelFiles.join(', ')}]. 
    Se un file è in questa lista, ESISTE nel progetto. Ignora segnalazioni contrarie.`;

    console.log('DOCS: launching parallel sub-analyses...');

    // ── 1. Technical Review — tutti i chunk in sequenza ──
    const techResPromise = (async () => {
      const parts: string[] = [];
      for (let i = 0; i < fullChunks.length; i++) {
        console.log(`DOCS: Tech review chunk ${i + 1}/${fullChunks.length}...`);
        parts.push(await invokeSpec(
          AGENT_TECH_ID,
          `${NO_TOOLS}

RUOLO: Technical Writer. Analizza la documentazione tecnica.
${fileMetadataInfo}

Chunk ${i + 1} di ${fullChunks.length}.
CONTESTO FILE:
${fullChunks[i]}

COMPITO:
1. Esamina README, istruzioni, API docs. Se il README è nella LISTA FILE REALI sopra, consideralo PRESENTE.
2. Se non lo vedi nel testo di questo chunk, non dire che manca: dì solo che non è in questo frammento.
PRODUCI: Report in Markdown con titolo "## 📘 Revisione Tecnica (chunk ${i + 1}/${fullChunks.length})".`,
          `TECH_WRITER_${i + 1}`,
        ));
      }
      return parts.join('\n\n---\n\n');
    })();

    // ── 2. Standard & Review — tutti i chunk in sequenza ──
    const govResPromise = (async () => {
      const parts: string[] = [];
      for (let i = 0; i < fullChunks.length; i++) {
        console.log(`DOCS: Service scan chunk ${i + 1}/${fullChunks.length}...`);
        parts.push(await invokeSpec(
          AGENT_GOV_ID,
          `${NO_TOOLS}

RUOLO: Project Standard Officer. Verifica la presenza di file informativi.
${fileMetadataInfo}

Chunk ${i + 1} di ${fullChunks.length}.
CONTESTO FILE:
${fullChunks[i]}

COMPITO:
1. Cerca LICENSE, security e contributi. Se sono nella LISTA FILE REALI sopra, considerali PRESENTI.
PRODUCI: Report in Markdown con titolo "## ⚖️ Standard di Progetto (chunk ${i + 1}/${fullChunks.length})".`,
          `STANDARD_OFFICER_${i + 1}`,
        ));
      }
      return parts.join('\n\n---\n\n');
    })();

    const [techRes, govRes] = await Promise.all([techResPromise, govResPromise]);

    console.log('DOCS: specialized analysis complete. Starting Domain Lead aggregation...');

    const finalReport = await invokeLead(
      AGENT_LEAD_ID,
      `${NO_TOOLS}

RUOLO: Project Documentation Lead.
${fileMetadataInfo}

ANALISI RICEVUTE:
---
${techRes}
---
${govRes}
---

COMPITO:
1. **DETERMINISMO ASSOLUTO SULLE ESISTENZE**: Se un file (README, LICENSE, ecc.) è nella LISTA FILE REALI sopra, devi dichiarare che il file ESISTE. Ignora ogni dubbio degli esperti.
2. Riorganizza in "## ⚖️ Analisi Standard e UX".
3. Fornisci "Global Maturity Score" (0-100).
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