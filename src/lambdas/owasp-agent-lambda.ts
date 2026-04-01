import { z } from 'zod';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { unzipRepoToTemp } from './tools/decompressione-zip.tool';
import {
  createManifestBundle,
  createSourceChunks,
  createFullChunks,
  extractImportedLibraries,
} from './utils/smart-bundler';
import { invokeSubAgent, extractFirstMeaningfulLine } from './utils/agent-invoker';

const s3Client = new S3Client({});

const OwaspAgentEventSchema = z.object({
  s3Bucket: z.string(),
  s3Key: z.string(),
  s3Prefix: z.string(),
});

const AGENT_DEP_ID   = process.env.OWASP_DEP_AGENT_ID   || 'KUE8YYMLKK';
const AGENT_CREDS_ID = process.env.OWASP_CREDS_AGENT_ID  || 'QDRECNXUGR';
const AGENT_CORE_ID  = process.env.OWASP_CORE_AGENT_ID   || 'FJPDLGYFQM';
const AGENT_LEAD_ID  = process.env.OWASP_LEAD_AGENT_ID   || 'PILT1S5IL6';
const ALIAS          = process.env.OWASP_AGENT_ALIAS_ID  || 'TSTALIASID';

const NO_TOOLS = `⚠️ REGOLA FERREA: NON USARE TOOL. Hai già tutto il contesto nel testo sotto. Produci solo il report Markdown richiesto.`;

// Sotto-agenti: isLead=false → output grezzo (no sanitize, no taglio)
const invokeSpec = (id: string, prompt: string, name: string) =>
  invokeSubAgent(id, ALIAS, prompt, name, false);

// Domain Lead: isLead=true → sanitize completo sul report finale
const invokeLead = (id: string, prompt: string, name: string) =>
  invokeSubAgent(id, ALIAS, prompt, name, true);

export const owaspAgentHandler = async (event: unknown) => {
  console.log('OWASP ORCHESTRATOR (MARKDOWN v2): START');
  try {
    const { s3Bucket: bucket, s3Key: key, s3Prefix } = OwaspAgentEventSchema.parse(event);

    console.log('OWASP: downloading and extracting repo...');
    const extractPath = await unzipRepoToTemp(bucket, key);

    console.log('OWASP: creating thematic bundles...');
    const [manifestBundle, sourceChunks, fullChunks] = await Promise.all([
      createManifestBundle(extractPath),
      createSourceChunks(extractPath),
      createFullChunks(extractPath),
    ]);

    const rawImports = extractImportedLibraries(sourceChunks);
    console.log(`OWASP: ${sourceChunks.length} source chunk(s), ${fullChunks.length} full chunk(s), ${rawImports.length} imports.`);

    // ── 1. Dependency (manifest piccolo → chiamata singola) ──
    const depResPromise = invokeSpec(
      AGENT_DEP_ID,
      `${NO_TOOLS}

RUOLO: Esperto Sicurezza Supply Chain. Analizza vulnerabilità librerie.
MANIFESTS:
${manifestBundle}
IMPORTS RILEVATI: ${rawImports.join(', ')}

COMPITO:
1. Identifica librerie vulnerabili e suggerisci versioni sicure.
2. Usa Severity Badges: 🔴 CRITICAL, 🟠 HIGH, 🟡 MEDIUM.
3. Fornisci un "Maturity Score" (0-100) per la gestione dipendenze.
PRODUCI: Report in Markdown con titolo "## 📦 Verifica Dipendenze".`,
      'DEPENDENCY',
    );

    // ── 2. Credentials Scan — tutti i fullChunks in sequenza ──
    const credsResPromise = (async () => {
      const parts: string[] = [];
      for (let i = 0; i < fullChunks.length; i++) {
        console.log(`OWASP: Credentials scan chunk ${i + 1}/${fullChunks.length}...`);
        parts.push(await invokeSpec(
          AGENT_CREDS_ID,
          `${NO_TOOLS}

RUOLO: Specialista Cybersecurity. Cerca credenziali hardcoded.
Chunk ${i + 1} di ${fullChunks.length} del bundle completo.

FULL BUNDLE (chunk ${i + 1}/${fullChunks.length}):
${fullChunks[i]}

COMPITO:
1. Scansiona chiavi API, password, token, segreti riga per riga.
2. Usa Severity Badges: 🔴 CRITICAL, 🟠 HIGH, 🟡 MEDIUM.
3. Se non trovi nulla scrivi "Nessuna credenziale trovata in questo chunk."
4. Fornisci "Maturity Score" (0-100) solo se questo è l'ultimo chunk (${i + 1} di ${fullChunks.length}).
PRODUCI: Report in Markdown con titolo "## 🔑 Scansione Credenziali (chunk ${i + 1}/${fullChunks.length})".`,
          `CREDENTIALS_${i + 1}`,
        ));
      }
      return parts.join('\n\n---\n\n');
    })();

    // ── 3. OWASP Top 10 — tutti i sourceChunks in sequenza ──
    const coreResPromise = (async () => {
      const parts: string[] = [];
      for (let i = 0; i < sourceChunks.length; i++) {
        console.log(`OWASP: Top10 scan chunk ${i + 1}/${sourceChunks.length}...`);
        parts.push(await invokeSpec(
          AGENT_CORE_ID,
          `${NO_TOOLS}

RUOLO: Auditor OWASP. Analizza vulnerabilità logiche (Top 10).
Chunk ${i + 1} di ${sourceChunks.length} del codice sorgente.

SOURCE CODE (chunk ${i + 1}/${sourceChunks.length}):
${sourceChunks[i]}

COMPITO:
1. Analizza Injection, XSS, Broken Auth, IDOR, Misconfiguration, etc.
2. Usa Severity Badges: 🔴 CRITICAL, 🟠 HIGH, 🟡 MEDIUM.
3. Se non trovi vulnerabilità scrivi "Nessuna vulnerabilità OWASP trovata in questo chunk."
4. Fornisci "Maturity Score" (0-100) solo se questo è l'ultimo chunk (${i + 1} di ${sourceChunks.length}).
PRODUCI: Report in Markdown con titolo "## 🛡️ Vulnerabilità OWASP Top 10 (chunk ${i + 1}/${sourceChunks.length})".`,
          `OWASP_CORE_${i + 1}`,
        ));
      }
      return parts.join('\n\n---\n\n');
    })();

    const [depRes, credsRes, coreRes] = await Promise.all([
      depResPromise,
      credsResPromise,
      coreResPromise,
    ]);

    console.log('OWASP: specialized analysis complete. Starting Domain Lead aggregation...');

    const finalReport = await invokeLead(
      AGENT_LEAD_ID,
      `${NO_TOOLS}

RUOLO: OWASP Audit Lead (Sintetizzatore Strategico).

ANALISI RICEVUTE:
---
${depRes}

---

${credsRes}

---

${coreRes}
---

COMPITO:
1. Riorganizza le criticità in "⚠️ Analisi Dettagliata dei Rischi".
2. Elimina i duplicati (stesso file/riga rilevati in chunk diversi).
3. Ordina per Gravità: 🔴 CRITICAL → 🟠 HIGH → 🟡 MEDIUM.
4. Per OGNI rischio:
   - **Rischio**: [Titolo]
   - **Dettaglio Rischio**: [Tecnico + File + Riga]
   - **Azione Correttiva**: [Fix concreto]
5. Aggiungi "Global Maturity Score" (0-100) con motivazione.
6. NON USARE TABELLE.
PRODUCI: Report Finale in Markdown con header "# 📊 Executive Security Summary (OWASP)".`,
      'OWASP_LEAD',
    );

    const dynamicSummary =
      extractFirstMeaningfulLine(finalReport, /[📊⚠️🔴🟠🟡📦🔑🛡️]/g) ||
      'Analisi OWASP completata.';

    const reportKey = `${s3Prefix}/owasp-report.json`;
    await s3Client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: reportKey,
      Body: JSON.stringify({ area: 'OWASP', summary: dynamicSummary, report: finalReport }),
      ContentType: 'application/json',
    }));

    return { agent: 'owasp', status: 'success', reportKey };
  } catch (err: any) {
    console.error('OWASP v2 CRASH:', err?.message, err?.stack);
    return { agent: 'owasp', status: 'error', error: err?.message };
  }
};