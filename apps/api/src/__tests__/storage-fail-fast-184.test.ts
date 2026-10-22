/**
 * Issue #184 — object store fail-fast.
 *  - config: production without MINIO_* stops the start; dev/test get the compose defaults
 *  - unavailable store: upload answers 503 STORAGE_UNAVAILABLE (not a 500), /health reports it
 *    in the body while its status code stays DB-only (liveness)
 */
import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { envSchema } from "../config";
import {
  isStorageUnavailableError,
  StorageUnavailableError,
} from "../contexts/platform/plugins/storage";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";

// A genuine, decodable 2x2 JPEG — the avatar route runs its input through sharp().
const JPEG_BYTES = Buffer.from(
  "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABykX//Z",
  "base64",
);

const base = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  ENCRYPTION_KEY: "x".repeat(32),
  JWT_SECRET: "y".repeat(32),
  JWT_REFRESH_SECRET: "z".repeat(32),
};

describe("config: MINIO_* (Issue #184)", () => {
  it("production without MINIO_* still parses, with no defaults and the missing names listed", () => {
    const r = envSchema.safeParse({ ...base, NODE_ENV: "production" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.MINIO_ENDPOINT).toBeUndefined();
      expect(r.data.MINIO_ACCESS_KEY).toBeUndefined();
      expect(r.data.MINIO_SECRET_KEY).toBeUndefined();
      expect(r.data.MINIO_MISSING).toEqual([
        "MINIO_ENDPOINT",
        "MINIO_ACCESS_KEY",
        "MINIO_SECRET_KEY",
      ]);
    }
  });

  it("production treats blank values as missing", () => {
    const r = envSchema.safeParse({
      ...base,
      NODE_ENV: "production",
      MINIO_ENDPOINT: "",
      MINIO_ACCESS_KEY: "  ",
      MINIO_SECRET_KEY: "s",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.MINIO_MISSING).toEqual(["MINIO_ENDPOINT", "MINIO_ACCESS_KEY"]);
  });

  it("production with all three passes and keeps its values", () => {
    const r = envSchema.safeParse({
      ...base,
      NODE_ENV: "production",
      MINIO_ENDPOINT: "minio.internal",
      MINIO_ACCESS_KEY: "ak",
      MINIO_SECRET_KEY: "sk",
      MINIO_PORT: "9100",
      MINIO_USE_SSL: "true",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.MINIO_MISSING).toEqual([]);
      expect(r.data).toMatchObject({
        MINIO_ENDPOINT: "minio.internal",
        MINIO_PORT: 9100,
        MINIO_BUCKET: "clokr",
        MINIO_USE_SSL: true,
      });
    }
  });

  it("development and test fall back to the compose defaults", () => {
    for (const NODE_ENV of ["development", "test"]) {
      const r = envSchema.safeParse({ ...base, NODE_ENV });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data).toMatchObject({
          MINIO_ENDPOINT: "minio",
          MINIO_PORT: 9000,
          MINIO_ACCESS_KEY: "minioadmin",
          MINIO_SECRET_KEY: "minioadmin",
          MINIO_BUCKET: "clokr",
          MINIO_USE_SSL: false,
        });
      }
    }
  });
});

describe("isStorageUnavailableError", () => {
  it("recognises network and credential failures, not a missing object", () => {
    expect(isStorageUnavailableError(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe(
      true,
    );
    expect(
      isStorageUnavailableError(Object.assign(new Error("x"), { code: "InvalidAccessKeyId" })),
    ).toBe(true);
    expect(isStorageUnavailableError(Object.assign(new Error("x"), { code: "NoSuchBucket" }))).toBe(
      true,
    );
    expect(
      isStorageUnavailableError(
        Object.assign(new AggregateError([]), { errors: [{ code: "ECONNREFUSED" }] }),
      ),
    ).toBe(true);
    expect(isStorageUnavailableError(Object.assign(new Error("x"), { code: "NoSuchKey" }))).toBe(
      false,
    );
    expect(isStorageUnavailableError(new Error("boom"))).toBe(false);
  });
});

describe("unavailable object store (Issue #184)", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await getTestApp();
  });
  afterAll(async () => {
    await closeTestApp();
  });
  afterEach(() => vi.restoreAllMocks());

  it("/health reports the store but stays 200 (liveness is DB-only)", async () => {
    vi.spyOn(app.storage, "refresh").mockImplementation(() => {});
    vi.spyOn(app.storage, "status").mockReturnValue({
      available: false,
      unconfigured: false,
      checkedAt: null,
    });
    const down = await app.inject({ method: "GET", url: "/health" });
    expect(down.statusCode).toBe(200);
    expect(JSON.parse(down.body)).toMatchObject({ status: "ok", storage: "unavailable" });

    vi.spyOn(app.storage, "status").mockReturnValue({
      available: true,
      unconfigured: false,
      checkedAt: null,
    });
    const up = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(JSON.parse(up.body)).toMatchObject({ status: "ok", storage: "ok" });
  });

  it("unconfigured store: operations throw StorageUnavailableError and /health says unconfigured", async () => {
    vi.spyOn(app.storage, "status").mockReturnValue({
      available: false,
      unconfigured: true,
      checkedAt: null,
    });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ status: "ok", storage: "unconfigured" });
  });

  it("an avatar upload with the store down answers 503 STORAGE_UNAVAILABLE, not a 500", async () => {
    const seed = await seedTestData(app, "storage184");
    try {
      vi.spyOn(app.storage, "upload").mockRejectedValueOnce(
        new StorageUnavailableError(Object.assign(new Error("connect"), { code: "ECONNREFUSED" })),
      );
      const boundary = "----clokr184";
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
        ),
        JPEG_BYTES,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/avatars/${seed.employee.id}`,
        headers: {
          authorization: `Bearer ${seed.adminToken}`,
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload: body,
      });
      expect(res.statusCode).toBe(503);
      const json = JSON.parse(res.body);
      expect(json.code).toBe("STORAGE_UNAVAILABLE");
      expect(json.error).toMatch(/Dokumentenspeicher/);
      const emp = await app.prisma.employee.findUniqueOrThrow({ where: { id: seed.employee.id } });
      expect(emp.avatarPath).toBeNull();
    } finally {
      await cleanupTestData(app, seed.tenant.id);
    }
  });
});

describe("storage plugin without configuration (production, Issue #184)", () => {
  it("builds no client: status is unconfigured and every operation throws StorageUnavailableError", async () => {
    vi.resetModules();
    vi.doMock("../config", () => ({
      config: {
        MINIO_ENDPOINT: undefined,
        MINIO_ACCESS_KEY: undefined,
        MINIO_SECRET_KEY: undefined,
        MINIO_MISSING: ["MINIO_ENDPOINT", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY"],
        MINIO_BUCKET: "clokr",
        MINIO_PORT: 9000,
        MINIO_USE_SSL: false,
      },
    }));
    try {
      const { default: Fastify } = await import("fastify");
      const mod = await import("../contexts/platform/plugins/storage");
      const f = Fastify({ logger: false });
      await f.register(mod.storagePlugin);
      await f.ready();
      expect(f.storage.status()).toMatchObject({ available: false, unconfigured: true });
      expect(await f.storage.check()).toBe(false);
      await expect(f.storage.upload("a", Buffer.from("x"), "text/plain")).rejects.toBeInstanceOf(
        mod.StorageUnavailableError,
      );
      await f.close();
    } finally {
      vi.doUnmock("../config");
      vi.resetModules();
    }
  });
});
