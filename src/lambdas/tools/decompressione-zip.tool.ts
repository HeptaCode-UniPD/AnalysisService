import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
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

export const executeUnzipRepo = async ({
  bucket,
  zipKey,
}: z.infer<typeof UnzipRepoInput>): Promise<string> => {
  try {
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

    return `Decompressione completata con successo. Il repository si trova nel percorso locale: ${extractDirPath}`;
  } catch (error: any) {
    return `Errore durante il download o la decompressione: ${error.message}`;
  }
};

export const unzipRepo = tool({
  name: 'unzip_repo',
  description:
    'Scarica un repository .zip da S3 e lo decompone nel file system temporaneo locale.',

  inputSchema: zodToJsonSchema(UnzipRepoInput as any) as any,
  callback: executeUnzipRepo,
});
