import { execSync } from 'child_process';
import { rmSync, existsSync } from 'fs';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import AdmZip from 'adm-zip';

const s3Client = new S3Client({});

async function checkGitHubRepoSize(repoUrl: string, commitSha: string, maxFiles: number = 65000): Promise<void> {
  // 1. Estraiamo owner e repo dall'URL (es. https://github.com/owner/repo.git)
  const match = repoUrl.match(/github\.com\/([^\/]+)\/([^\/.]+)/);
  if (!match) {
    console.warn('URL non di GitHub riconosciuto. Impossibile usare la Tree API per il conteggio preventivo.');
    return;
  }

  const owner = match[1];
  const repo = match[2];

  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${commitSha}?recursive=1`;

  console.log(`Verifica preventiva dimensione repository via API: ${apiUrl}`);

  // Preparazione headers. L'User-Agent è obbligatorio per le API GitHub.
  const headers: Record<string, string> = {
    'User-Agent': 'AWS-Lambda-Repo-Checker',
    'Accept': 'application/vnd.github.v3+json',
  };

  // FORTEMENTE CONSIGLIATO: Se hai un token, inseriscilo. 
  // Senza token, le API di GitHub hanno un limite di 60 richieste all'ora per IP.
  if (process.env.GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const response = await fetch(apiUrl, { headers });

  if (!response.ok) {
    // Se l'API fallisce (es. repo privato senza token o limite rate), logga l'errore 
    // ma non bloccare l'esecuzione, lascia che provi col git clone classico.
    console.warn(`Controllo API fallito (Status: ${response.status}). Procedo col clone standard.`);
    return;
  }

  const data = await response.json();

  // 2. Controllo truncation
  // Se l'albero è gigantesco (spesso > 100.000 file), GitHub taglia la risposta e imposta truncated: true
  if (data.truncated) {
    throw new Error(`Il repository è troppo grande (supera i limiti dell'API di GitHub). Analisi interrotta preventivamente.`);
  }

  // 3. Contiamo i file (type === 'blob', ignoriamo type === 'tree' che sono le cartelle)
  const fileCount = data.tree ? data.tree.filter((item: any) => item.type === 'blob').length : 0;
  console.log(`Conteggio preventivo: il repository contiene ${fileCount} file.`);

  // 4. Lanciamo l'errore se supera il limite
  if (fileCount > maxFiles) {
    throw new Error(`Il repository è troppo grande: contiene ${fileCount} file. Il limite massimo supportato per la compressione è di circa ${maxFiles} file. Analisi interrotta preventivamente.`);
  }
}

function processRepository(
  cloneUrl: string,
  commitSha: string,
  tmpDir: string,
): {
  metadata: { hasChangelog: boolean; tags: string[]; branches: string[] };
  zipBuffer: Buffer;
  actualCommitSha: string;
} {
  // 1. Clona il repository
  try {
    execSync(`git clone ${cloneUrl} ${tmpDir}`, { stdio: 'pipe' });
  } catch (e: any) {
    // Se fallisce, estraiamo il VERO messaggio di errore di Git
    const gitError = e.stderr ? e.stderr.toString() : e.message;
    throw new Error(`Git clone fallito: ${gitError}`);
  }

  console.error('Errore esecuzione Lambda');
  
  // 2. Checkout obbligatorio: se fallisce, blocchiamo l'esecuzione
  try {
    execSync(`git checkout ${commitSha}`, { cwd: tmpDir, stdio: 'ignore' });
  } catch (e) {
    throw new Error(`Checkout fallito: il commit ${commitSha} non esiste in questa repository.`);
  }

  // Estraiamo l'hash effettivo per conferma
  const actualCommitSha = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();
  
  // 3. Estrai i metadati necessari
  const tagsOutput = execSync('git tag', { cwd: tmpDir }).toString().trim();
  const branchesOutput = execSync('git branch -r', { cwd: tmpDir }).toString().trim();

  const repoMetadata = {
    hasChangelog:
      existsSync(`${tmpDir}/CHANGELOG.md`) || existsSync(`${tmpDir}/CHANGELOG`),
    tags: tagsOutput ? tagsOutput.split('\n') : [],
    branches: branchesOutput
      ? branchesOutput.split('\n').map((b) => b.trim())
      : [],
  };

  // 4. Rimuovi la cartella .git per evitare crash di adm-zip
  const gitDir = `${tmpDir}/.git`;
  if (existsSync(gitDir)) {
    rmSync(gitDir, { recursive: true, force: true });
  }

  // 5. Contiamo velocemente i file effettivi rimasti nella cartella
  const fileCountStr = execSync('find . -type f | wc -l', { cwd: tmpDir }).toString().trim();
  const fileCount = parseInt(fileCountStr, 10);

  if (fileCount > 65000) {
    throw new Error(`Il repository è troppo grande: contiene ${fileCount} file. Il limite massimo supportato per la compressione è di circa 65.000 file. Analisi interrotta preventivamente.`);
  }

  // 6. Crea lo zip in memoria
  const zip = new AdmZip();
  zip.addLocalFolder(tmpDir);
  const zipBuffer = zip.toBuffer();

  return { metadata: repoMetadata, zipBuffer, actualCommitSha };
}

export const handler = async (event: any) => {
  const { jobId, repoUrl, commitSha, s3Prefix } = event;
  const bucketName = process.env.S3_BUCKET_NAME;

  if (!bucketName) {
    throw new Error('Configurazione mancante: S3_BUCKET_NAME');
  }

  const tmpDir = `/tmp/repo-${jobId}`;

  try {

    await checkGitHubRepoSize(repoUrl, commitSha);
    const { metadata, zipBuffer, actualCommitSha } = processRepository(
      repoUrl,
      commitSha,
      tmpDir,
    );

    const s3Key = `${s3Prefix}/source.zip`;

    // FIX: Passa il buffer direttamente a S3 e aggiungi il ContentType
    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: s3Key,
        Body: zipBuffer,
        ContentType: 'application/zip',
      }),
    );

    return {
      s3Bucket: bucketName,
      s3Key: s3Key,
      repoMetadata: metadata,
      commitSha: actualCommitSha,
    };
  } catch (error: any) {
    console.error('Errore esecuzione Lambda:', error);
    throw new Error(
      `Impossibile scaricare o zippare la repository: ${error.message}`,
    );
  } finally {
    // Pulisci solo la cartella tmpDir, non serve più eliminare lo zip dal disco
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
};
