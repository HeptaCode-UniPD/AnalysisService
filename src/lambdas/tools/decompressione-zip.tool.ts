import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { createWriteStream, rmSync } from 'fs';
import { pipeline } from 'stream/promises';
import path from 'path';
import AdmZip from 'adm-zip';

const s3Client = new S3Client({});

const UnzipRepoInput = z.object({
  bucket: z
    .string()
    .describe("L'identificativo del drive virtuale interno (workspace ID)"),
  zipKey: z
    .string()
    .describe('Il percorso locale del file compresso da estrarre'),
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

// import di 'tool' solo a runtime
export const createUnzipRepoTool = async () => {
  const { tool } = await import('@strands-agents/sdk');
  return tool({
    name: 'unzip_repo',
    description:
      'Extracts an internal archive to a local workspace directory for inspection. Requires the archive ID and path.',
    inputSchema: z.toJSONSchema(UnzipRepoInput as any) as any,
    callback: executeUnzipRepo,
  });
};
