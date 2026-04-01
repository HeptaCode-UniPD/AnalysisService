import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { createWriteStream, rmSync } from 'fs';
import { pipeline } from 'stream/promises';
import path from 'path';
import AdmZip from 'adm-zip';

const s3Client = new S3Client({});

const UnzipRepoInput = z.object({
  bucket: z.string().describe('Il nome del bucket S3'),
  zipKey: z
    .string()
    .describe('La chiave (percorso) del file .zip nel bucket S3'),
});

export const unzipRepoToTemp = async (
  bucket: string,
  zipKey: string,
): Promise<string> => {
  const timestamp = Date.now();
  const extractDirPath = path.join(
    process.env.UNZIP_OUTPUT_DIR || '/tmp',
    `extracted_${timestamp}`,
  );
  const zipFilePath = path.join(
    process.env.UNZIP_OUTPUT_DIR || '/tmp',
    `repo_${timestamp}.zip`,
  );

  const command = new GetObjectCommand({ Bucket: bucket, Key: zipKey });
  const response = await s3Client.send(command);

  if (!response.Body)
    throw new Error('Il file scaricato è vuoto o inesistente.');

  const writeStream = createWriteStream(zipFilePath);
  await pipeline(response.Body as any, writeStream);

  const zip = new AdmZip(zipFilePath);
  zip.extractAllTo(extractDirPath, true);
  rmSync(zipFilePath, { force: true });

  return extractDirPath;
};

export const executeUnzipRepo = async ({
  bucket,
  zipKey,
}: z.infer<typeof UnzipRepoInput>): Promise<string> => {
  try {
    const extractDirPath = await unzipRepoToTemp(bucket, zipKey);
    return `Decompressione completata con successo. Il repository si trova nel percorso locale: ${extractDirPath}`;
  } catch (error: any) {
    return `Errore durante il download o la decompressione: ${error.message}`;
  }
};

export const createUnzipRepoTool = async () => {
  // @ts-ignore
  const { tool } = await import('@strands-agents/sdk');
  return tool({
    name: 'unzip_repo',
    description:
      'Scarica un repository .zip da S3 e lo decompone nel file system temporaneo locale. Restituisce il percorso locale della cartella estratta, es. /tmp/extracted_123456.',
    inputSchema: {
      type: 'object',
      properties: {
        bucket: {
          type: 'string',
          description: 'Il nome del bucket S3, es. my-bucket',
        },
        zipKey: {
          type: 'string',
          description:
            'La chiave del file .zip nel bucket S3, es. repos/job-123/source.zip',
        },
      },
      required: ['bucket', 'zipKey'],
    } as any,
    callback: executeUnzipRepo,
  });
};
