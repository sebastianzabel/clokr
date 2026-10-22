import fp from "fastify-plugin";
import { Client } from "minio";
import { config } from "../../../config";

/**
 * Issue #184 — the object store (documents, AU certificates, avatars) cannot be reached or
 * refuses our credentials/bucket. Mapped once in `app.ts` to 503 `STORAGE_UNAVAILABLE`, so an
 * upload answers a clear, retryable error instead of an opaque 500.
 */
export class StorageUnavailableError extends Error {
  readonly code = "STORAGE_UNAVAILABLE";
  constructor(cause?: unknown) {
    super("Object storage unavailable");
    this.name = "StorageUnavailableError";
    if (cause !== undefined) this.cause = cause;
  }
}

// Network-level failures (no answer from the store) and S3 errors that mean "this store is not
// usable for us" (wrong credentials, missing bucket). NoSuchKey and the like are NOT here: a
// missing object is a normal outcome the caller handles.
const UNAVAILABLE_NET_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
]);
const UNAVAILABLE_S3_CODES = new Set([
  "InvalidAccessKeyId",
  "SignatureDoesNotMatch",
  "AccessDenied",
  "NoSuchBucket",
  "ServiceUnavailable",
  "SlowDown",
  "InternalError",
]);

export function isStorageUnavailableError(err: unknown): boolean {
  if (err instanceof StorageUnavailableError) return true;
  const e = err as { code?: unknown; errors?: unknown } | null;
  if (!e || typeof e !== "object") return false;
  if (
    typeof e.code === "string" &&
    (UNAVAILABLE_NET_CODES.has(e.code) || UNAVAILABLE_S3_CODES.has(e.code))
  ) {
    return true;
  }
  // AggregateError (Node tries several addresses) carries the codes on its members.
  return Array.isArray(e.errors) && e.errors.some((x) => isStorageUnavailableError(x));
}

export type StorageStatus = {
  available: boolean;
  /** True when MINIO_* is missing (production without configuration): no client exists. */
  unconfigured: boolean;
  checkedAt: string | null;
};

declare module "fastify" {
  interface FastifyInstance {
    storage: {
      upload(path: string, buffer: Buffer, contentType: string): Promise<void>;
      getBuffer(path: string): Promise<Buffer>;
      delete(path: string): Promise<void>;
      /** Live probe (bucket reachable with our credentials); also refreshes `status()`. */
      check(): Promise<boolean>;
      /**
       * Background refresh for health polling: single-flight and at most once per
       * STORAGE_REFRESH_MIN_INTERVAL_MS, never throws. Probing on every poll piled up DNS lookups
       * on the libuv threadpool (e2e-ci, Issue #184) and starved every other threadpool user.
       */
      refresh(): void;
      /** Last known state, from startup, the last probe or the last operation. */
      status(): StorageStatus;
    };
  }
}

const CHECK_TIMEOUT_MS = 2_000;
const STORAGE_REFRESH_MIN_INTERVAL_MS = 30_000;

export const storagePlugin = fp(async (app) => {
  const { MINIO_ENDPOINT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY, MINIO_MISSING } = config;

  // Production without configuration (Issue #184): no client is built, so no call can ever go to a
  // guessed host. One clear error at start; every operation answers StorageUnavailableError.
  if (MINIO_MISSING.length > 0 || !MINIO_ENDPOINT || !MINIO_ACCESS_KEY || !MINIO_SECRET_KEY) {
    app.log.error(
      { missing: MINIO_MISSING },
      `MinIO: object store is NOT configured (missing ${MINIO_MISSING.join(", ")}) — uploads answer 503 STORAGE_UNAVAILABLE until it is set`,
    );
    const refuse = async (): Promise<never> => {
      throw new StorageUnavailableError();
    };
    app.decorate("storage", {
      upload: refuse,
      getBuffer: refuse,
      delete: refuse,
      check: async () => false,
      refresh: () => {},
      status: () => ({ available: false, unconfigured: true, checkedAt: null }),
    });
    return;
  }

  const bucket = config.MINIO_BUCKET;
  const client = new Client({
    endPoint: MINIO_ENDPOINT,
    port: config.MINIO_PORT,
    useSSL: config.MINIO_USE_SSL,
    accessKey: MINIO_ACCESS_KEY,
    secretKey: MINIO_SECRET_KEY,
  });

  let state: StorageStatus = { available: false, unconfigured: false, checkedAt: null };
  function mark(available: boolean) {
    state = { available, unconfigured: false, checkedAt: new Date().toISOString() };
  }

  // Probes the bucket; creates it when the store answers but the bucket is missing.
  async function probe(): Promise<boolean> {
    try {
      const exists = await Promise.race([
        client.bucketExists(bucket),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("storage check timed out")), CHECK_TIMEOUT_MS).unref(),
        ),
      ]);
      if (!exists) {
        await client.makeBucket(bucket);
        app.log.info(`MinIO: Bucket '${bucket}' created`);
      }
      mark(true);
      return true;
    } catch (err) {
      mark(false);
      app.log.error(
        { err, endpoint: config.MINIO_ENDPOINT, port: config.MINIO_PORT, bucket },
        "MinIO: object store not reachable or bucket unusable — uploads answer 503 STORAGE_UNAVAILABLE until it recovers",
      );
      return false;
    }
  }

  // Start-up probe. An unreachable store does not stop the API (an orphaned object store must not
  // take time tracking down with it); it is reported loudly here, in /api/v1/ready and on every
  // upload. A MISSING configuration is handled above (unconfigured, also no start abort).
  await probe();

  // Runs a store call; a store-level failure flips the state and surfaces as the typed error.
  async function guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      const result = await fn();
      if (!state.available) mark(true);
      return result;
    } catch (err) {
      if (isStorageUnavailableError(err)) {
        mark(false);
        throw new StorageUnavailableError(err);
      }
      throw err;
    }
  }

  async function upload(path: string, buffer: Buffer, contentType: string): Promise<void> {
    await guarded(() =>
      client.putObject(bucket, path, buffer, buffer.length, { "Content-Type": contentType }),
    );
  }

  async function getBuffer(path: string): Promise<Buffer> {
    return guarded(async () => {
      const stream = await client.getObject(bucket, path);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    });
  }

  async function deletePath(path: string): Promise<void> {
    await guarded(() => client.removeObject(bucket, path));
  }

  let inFlight: Promise<boolean> | null = null;
  let lastRefreshAt = Date.now(); // the start-up probe counts
  function refresh(): void {
    if (inFlight || Date.now() - lastRefreshAt < STORAGE_REFRESH_MIN_INTERVAL_MS) return;
    lastRefreshAt = Date.now();
    inFlight = probe().finally(() => {
      inFlight = null;
    });
  }

  app.decorate("storage", {
    upload,
    getBuffer,
    delete: deletePath,
    check: probe,
    refresh,
    status: () => state,
  });
});
