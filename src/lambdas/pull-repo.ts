import { execSync } from 'child_process';
import { rmSync, existsSync } from 'fs';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import AdmZip from 'adm-zip';

const s3Client = new S3Client({});

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
  execSync(`git clone ${cloneUrl} ${tmpDir}`, { stdio: 'ignore' });
  
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

  // 5. Crea lo zip in memoria
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
