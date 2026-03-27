import { execSync } from 'child_process';
import { readFileSync, rmSync, existsSync } from 'fs';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const s3Client = new S3Client({});

//restituisce url con token se presente
function buildCloneUrl(repoUrl: string, userToken?: string): string {
  if (!userToken) {
    return repoUrl;
  }
  const urlObj = new URL(repoUrl);
  urlObj.username = userToken;
  return urlObj.toString();
}

function processRepository(cloneUrl: string, commitSha: string, tmpDir: string, tarPath: string): { hasChangelog: boolean; tags: string[]; branches: string[] } {
  // Esegue git clone e checkout
  execSync(`git clone ${cloneUrl} ${tmpDir}`, { stdio: 'ignore' });
  execSync(`git checkout ${commitSha}`, { cwd: tmpDir, stdio: 'ignore' });

  // Estrae i metadati necessari all'orchestratore
  const tagsOutput = execSync('git tag', { cwd: tmpDir }).toString().trim();
  const branchesOutput = execSync('git branch -r', { cwd: tmpDir }).toString().trim();

  const repoMetadata = {
    hasChangelog: existsSync(`${tmpDir}/CHANGELOG.md`) || existsSync(`${tmpDir}/CHANGELOG`),
    tags: tagsOutput ? tagsOutput.split('\n') : [],
    branches: branchesOutput ? branchesOutput.split('\n').map(b => b.trim()) : [],
  };

  // Comprime la cartella scaricata
  execSync(`tar -czf ${tarPath} -C ${tmpDir} .`);
  
  return repoMetadata;
}

//funzione chiamata dalla lambda
export const handler = async (event: any) => {
  const { jobId, repoUrl, commitSha, userToken, s3Prefix } = event;
  const bucketName = process.env.S3_BUCKET_NAME;

  if (!bucketName) {
    throw new Error('Configurazione mancante: S3_BUCKET_NAME');
  }

  const tmpDir = `/tmp/repo-${jobId}`;
  const tarPath = `/tmp/archive-${jobId}.tar.gz`;

  try {
    const cloneUrl = buildCloneUrl(repoUrl, userToken);
    
    // Processa la repo e recupera i metadati
    const repoMetadata = processRepository(cloneUrl, commitSha, tmpDir, tarPath);

    // Legge il file compresso creato e lo carica su S3
    const fileBuffer = readFileSync(tarPath);
    const s3Key = `${s3Prefix}/source.tar.gz`;

    await s3Client.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: s3Key,
      Body: fileBuffer,
    }));

    return {
      s3Bucket: bucketName,
      s3Key: s3Key,
      repoMetadata: repoMetadata
    };

  } catch (error: any) {
    console.error('Errore esecuzione Lambda:', error);
    throw new Error(`Impossibile scaricare la repository: ${error.message}`);
  } finally {
    // Svuota /tmp
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(tarPath, { force: true });
  }
};