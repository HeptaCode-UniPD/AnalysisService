import { z } from 'zod';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { unzipRepoToTemp } from './tools/decompressione-zip.tool';
import { createSourceChunks } from './utils/smart-bundler';
import { invokeSubAgent, extractFirstMeaningfulLine } from './utils/agent-invoker';

const s3Client = new S3Client({});

const TestAgentEventSchema = z.object({
  s3Bucket: z.string(),
  s3Key: z.string(),
  s3Prefix: z.string(),
});

const AGENT_QA_ID    = process.env.TEST_QA_AGENT_ID    || 'EXDHLR6GUP';
const AGENT_GEN_ID   = process.env.TEST_GEN_AGENT_ID   || '3IIAWFA9BC';
const AGENT_AUDIT_ID = process.env.TEST_AUDIT_AGENT_ID || 'BNBKYAFDME';
const AGENT_LEAD_ID  = process.env.TEST_AGENT_ID        || 'L3EB5WS1ZU';
const ALIAS          = process.env.TEST_AGENT_ALIAS_ID  || 'TSTALIASID';

const NO_TOOLS = `⚠️ REGOLA FERREA: NON USARE TOOL. Hai già tutto il contesto nel testo sotto. Produci solo il report Markdown richiesto.`;

const invokeSpec = (id: string, prompt: string, name: string) =>
  invokeSubAgent(id, ALIAS, prompt, name, false);

const invokeLead = (id: string, prompt: string, name: string) =>
  invokeSubAgent(id, ALIAS, prompt, name, true);

export const testAgentHandler = async (event: unknown) => {
  console.log('TEST MULTI-AGENT (v2): START');
  try {
    const { s3Bucket: bucket, s3Key: key, s3Prefix } = TestAgentEventSchema.parse(event);

    console.log('TEST: extraction and bundling...');
    const extractPath = await unzipRepoToTemp(bucket, key);
    const sourceChunks = await createSourceChunks(extractPath);
    console.log(`TEST: ${sourceChunks.length} source chunk(s).`);

    const firstChunk = sourceChunks[0];

    console.log('TEST: launching parallel sub-analyses...');

    // ── 1. QA & Copertura — tutti i chunk in sequenza ──
    // Necessario per dichiarare con certezza l'assenza totale di test
    const qaResPromise = (async () => {
      const parts: string[] = [];
      for (let i = 0; i < sourceChunks.length; i++) {
        console.log(`TEST: QA scan chunk ${i + 1}/${sourceChunks.length}...`);
        parts.push(await invokeSpec(
          AGENT_QA_ID,
          `${NO_TOOLS}

RUOLO: QA Lead Engineer. Analizza la robustezza dei test esistenti.
Chunk ${i + 1} di ${sourceChunks.length} del codice sorgente.

CONTESTO CODICE (chunk ${i + 1}/${sourceChunks.length}):
${sourceChunks[i]}

COMPITO:
1. Cerca file di test (.spec, .test, __tests__, /tests/, /test/). Se non ne trovi in questo chunk, scrivi esplicitamente "Nessun file di test trovato in questo chunk."
2. Se trovi test, valuta qualità: asserzioni, casi limite, mocking.
3. Fornisci "Maturity Score" (0-100) solo se questo è l'ultimo chunk (${i + 1} di ${sourceChunks.length}).
   REGOLA: se nell'intero repo non esiste alcun file di test il Maturity Score DEVE essere 0.
PRODUCI: Report in Markdown con titolo "## 🧪 Analisi QA e Copertura (chunk ${i + 1}/${sourceChunks.length})".`,
          `QA_EXPERT_${i + 1}`,
        ));
      }
      return parts.join('\n\n---\n\n');
    })();

    // ── 2. Boilerplate — primo chunk (struttura del progetto sufficiente) ──
    const genResPromise = invokeSpec(
      AGENT_GEN_ID,
      `${NO_TOOLS}

RUOLO: Test Architect. Crea esempi di test.
CONTESTO CODICE (chunk 1/${sourceChunks.length}):
${firstChunk}

COMPITO:
1. Se mancano i test, genera un file di esempio completo (Jest, PHPUnit, pytest) basato sulla logica del progetto.
2. Se i test esistono, suggerisci 3 nuovi test case avanzati non coperti.
PRODUCI: Report in Markdown con titolo "## 🛠️ Generatore di Test e Boilerplate".`,
      'TEST_ARCHITECT',
    );

    // ── 3. Code Quality — tutti i chunk in sequenza ──
    const auditResPromise = (async () => {
      const parts: string[] = [];
      for (let i = 0; i < sourceChunks.length; i++) {
        console.log(`TEST: Code quality audit chunk ${i + 1}/${sourceChunks.length}...`);
        parts.push(await invokeSpec(
          AGENT_AUDIT_ID,
          `${NO_TOOLS}

RUOLO: Senior Software Auditor. Analizza la pulizia del codice.
Chunk ${i + 1} di ${sourceChunks.length} del codice sorgente.

CONTESTO CODICE (chunk ${i + 1}/${sourceChunks.length}):
${sourceChunks[i]}

COMPITO:
1. Analizza complessità ciclomatica, aderenza a SOLID/DRY.
2. Identifica "Code Smells" (funzioni troppo lunghe, duplicazioni, coupling eccessivo).
3. Se non trovi problemi scrivi "Nessun code smell rilevato in questo chunk."
4. Fornisci "Maturity Score" (0-100) solo se questo è l'ultimo chunk (${i + 1} di ${sourceChunks.length}).
PRODUCI: Report in Markdown con titolo "## 🔍 Audit Qualità del Codice (chunk ${i + 1}/${sourceChunks.length})".`,
          `CODE_AUDITOR_${i + 1}`,
        ));
      }
      return parts.join('\n\n---\n\n');
    })();

    const [qaRes, genRes, auditRes] = await Promise.all([
      qaResPromise,
      genResPromise,
      auditResPromise,
    ]);

    console.log('TEST: specialized analysis complete. Starting Domain Lead aggregation...');

    const finalReport = await invokeLead(
      AGENT_LEAD_ID,
      `${NO_TOOLS}

RUOLO: QA & Test Lead (Sintetizzatore Strategico).

ANALISI RICEVUTE:
---
${qaRes}

---

${genRes}

---

${auditRes}
---

COMPITO:
1. Riorganizza in "## 🔍 Rischi Qualità e Copertura".
2. Elimina duplicati (stessa issue in chunk diversi).
3. Per OGNI deficit:
   - **Rischio**: [Titolo]
   - **Dettaglio Tecnico**: [Perché è un problema e dove]
   - **Mitigazione**: [Come risolvere con esempio concreto]
4. IMPORTANTE: se tutti i chunk QA riportano "Nessun file di test trovato", il Maturity Score DEVE essere 0 e va dichiarato esplicitamente che il progetto non ha test.
5. Includi i test boilerplate in "## 🛠️ Test Suggeriti".
6. Fornisci "Global Maturity Score" (0-100) con motivazione.
7. NON USARE MAI TABELLE.
PRODUCI: Report Finale in Markdown con header "# 🏆 Quality & Testing Overview".`,
      'TEST_LEAD',
    );

    const dynamicSummary =
      extractFirstMeaningfulLine(finalReport, /[🏆🧪🛠️🔍⚠️]/g) ||
      'Analisi TEST completata.';

    const reportKey = `${s3Prefix}/test-report.json`;
    await s3Client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: reportKey,
      Body: JSON.stringify({ area: 'TEST', summary: dynamicSummary, report: finalReport }),
      ContentType: 'application/json',
    }));

    return { agent: 'test', status: 'success', reportKey };
  } catch (err: any) {
    console.error('TEST MULTI-AGENT CRASH:', err?.message);
    return { agent: 'test', status: 'error', error: err?.message };
  }
};