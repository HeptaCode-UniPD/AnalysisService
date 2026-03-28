import { execSync } from 'child_process';
import { readFileSync, rmSync, existsSync } from 'fs';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import AdmZip from 'adm-zip';

const s3Client = new S3Client({});

function processRepository(
  cloneUrl: string,
  commitSha: string,
  tmpDir: string,
  zipPath: string,
): { hasChangelog: boolean; tags: string[]; branches: string[] } {
  execSync(`git clone ${cloneUrl} ${tmpDir}`, { stdio: 'ignore' });
  execSync(`git checkout ${commitSha}`, { cwd: tmpDir, stdio: 'ignore' });

  const tagsOutput = execSync('git tag', { cwd: tmpDir }).toString().trim();
  const branchesOutput = execSync('git branch -r', { cwd: tmpDir }).toString().trim();

  const repoMetadata = {
    hasChangelog: existsSync(`${tmpDir}/CHANGELOG.md`) || existsSync(`${tmpDir}/CHANGELOG`),
    tags: tagsOutput ? tagsOutput.split('\n') : [],
    branches: branchesOutput ? branchesOutput.split('\n').map((b) => b.trim()) : [],
  };

  const zip = new AdmZip();
  zip.addLocalFolder(tmpDir);
  zip.writeZip(zipPath);

  return repoMetadata;
}

export const handler = async (event: any) => {
  const { jobId, repoUrl, commitSha, s3Prefix } = event;
  const bucketName = process.env.S3_BUCKET_NAME;

  if (!bucketName) {
    throw new Error('Configurazione mancante: S3_BUCKET_NAME');
  }

  const tmpDir = `/tmp/repo-${jobId}`;
  // Estensione corretta in .zip
  const zipPath = `/tmp/archive-${jobId}.zip`; 

  try {
    const repoMetadata = processRepository(repoUrl, commitSha, tmpDir, zipPath);

    const fileBuffer = readFileSync(zipPath);
    // Cambiato s3Key per usare .zip invece di .tar.gz
    const s3Key = `${s3Prefix}/source.zip`; 

    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: s3Key,
        Body: fileBuffer,
      }),
    );

    return {
      s3Bucket: bucketName,
      s3Key: s3Key,
      repoMetadata: repoMetadata,
    };
  } catch (error: any) {
    console.error('Errore esecuzione Lambda:', error);
    throw new Error(`Impossibile scaricare la repository: ${error.message}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(zipPath, { force: true });
  }
};