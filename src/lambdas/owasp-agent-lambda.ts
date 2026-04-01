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

CONTESTO FILE (chunk ${i + 1}/${fullChunks.length}):
${fullChunks[i]}

COMPITO:
1. Scansiona chiavi API, password, token, segreti riga per riga in questo chunk.
2. Riporta esclusivamente i segreti trovati con file e riga.
3. Se non trovi nulla, scrivi 'Nessun segreto rilevato in questo chunk'.
4. Fornisci un Maturity Score (0-100) basato solo su questo chunk.
PRODUCI: Report tecnico in Markdown con titolo "## 🔑 Scansione Credenziali (chunk ${i + 1}/${fullChunks.length})".`,
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
1. Analizza Injection, XSS, Broken Auth, IDOR, Misconfiguration, etc. in questo chunk.
2. Riporta le vulnerabilità trovate con file e contesto riga.
3. Se non trovi nulla, scrivi 'Nessuna vulnerabilità OWASP rilevata in questo chunk'.
4. Fornisci un Maturity Score (0-100) basato solo su questo chunk.
PRODUCI: Report tecnico in Markdown con titolo "## 🛡️ Vulnerabilità OWASP Top 10 (chunk ${i + 1}/${sourceChunks.length})".`,
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

RUOLO: OWASP Audit Lead (Giudice Globale).

ANALISI RICEVUTE:
---
${depRes}

---

${credsRes}

---

${coreRes}
---

COMPITO:
1. Esegui una SINTESI DI SICUREZZA GLOBALE.
2. Riorganizza le criticità in "## ⚠️ Analisi Dettagliata dei Rischi".
3. ELIMINA I DUPLICATI: è possibile che la stessa vulnerabilità sia stata vista in chunk diversi se il bundler ha sovrapposizioni.
4. Ordina per Gravità: 🔴 CRITICAL → 🟠 HIGH → 🟡 MEDIUM.
5. Per OGNI rischio unificato:
   - **Rischio**: [Titolo]
   - **Dettaglio Rischio**: [Tecnico + File + Riga]
   - **Azione Correttiva**: [Fix concreto con esempio]
6. Fornisci "Global Maturity Score" (0-100) basandoti sulla visione d'insieme.
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