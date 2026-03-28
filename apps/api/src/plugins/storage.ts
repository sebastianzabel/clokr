import fp from "fastify-plugin";
import { Client } from "minio";

declare module "fastify" {
  interface FastifyInstance {
    storage: {
      upload(path: string, buffer: Buffer, contentType: string): Promise<void>;
      getBuffer(path: string): Promise<Buffer>;
      delete(path: string): Promise<void>;
    };
  }
}

export const storagePlugin = fp(async (app) => {
  const endpoint = process.env.MINIO_ENDPOINT ?? "minio";
  const port = parseInt(process.env.MINIO_PORT ?? "9000");
  const accessKey = process.env.MINIO_ACCESS_KEY ?? "minioadmin";
  const secretKey = process.env.MINIO_SECRET_KEY ?? "minioadmin";
  const bucket = process.env.MINIO_BUCKET ?? "clokr";
  const useSSL = process.env.MINIO_USE_SSL === "true";

  const client = new Client({ endPoint: endpoint, port, useSSL, accessKey, secretKey });

  // Ensure bucket exists on startup
  try {
    const exists = await client.bucketExists(bucket);
    if (!exists) {
      await client.makeBucket(bucket);
      app.log.info(`MinIO: Bucket '${bucket}' created`);
    }
  } catch (err) {
    app.log.warn({ err }, "MinIO: Could not verify/create bucket (will retry on first use)");
  }

  async function upload(path: string, buffer: Buffer, contentType: string): Promise<void> {
    await client.putObject(bucket, path, buffer, buffer.length, { "Content-Type": contentType });
  }

  async function getBuffer(path: string): Promise<Buffer> {
    const stream = await client.getObject(bucket, path);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async function deletePath(path: string): Promise<void> {
    await client.removeObject(bucket, path);
  }

  app.decorate("storage", { upload, getBuffer, delete: deletePath });
});
