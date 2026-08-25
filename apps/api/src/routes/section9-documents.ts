/**
 * section9-documents.ts — Papier-AU-Upload für § 9-BUrlG-Vorgänge (Phase 104, D-26).
 *
 * Warum überhaupt ein Upload, wenn R6 den Manager-Schritt "AU liegt vor" nennt und nicht
 * "Datei hochladen"? Weil Privatversicherte keine eAU haben: ohne Papierweg wäre der
 * § 9-Anspruch für sie schlicht nicht einlösbar. Der Upload ist die Ausnahme, nicht der
 * Regelweg — die Bestätigung selbst (POST /leave/section9/:id/confirm) funktioniert auch
 * mit attestSource "EAU" ganz ohne Datei.
 *
 * Art. 9 DSGVO: die Datei IST ein Gesundheitsdatum. Deshalb:
 *   - kein öffentlicher Abruf, jede Leseanfrage authentifiziert und tenant-geprüft
 *   - keine serverseitige Verarbeitung des Inhalts (kein Re-Encoding, kein PDF-Parsing) — eine
 *     ärztliche Bescheinigung wird nicht re-encodiert und nicht ausgewertet, das wäre
 *     zusätzliche Angriffsfläche ohne fachlichen Nutzen
 *   - der Löschpfad (utils/anonymize.ts + routes/employees.ts) deckt diesen Ablageort mit ab
 */
import { FastifyInstance } from "fastify";
import { requireAuth } from "../middleware/auth";

/** Art. 9 DSGVO / V12: enge Allowlist. Kein SVG (aktive Inhalte), kein Office-Format. */
const ALLOWED_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
};

/**
 * Umkehrung für GET — welcher Content-Type gehört zur gespeicherten Endung. Aus ALLOWED_TYPES
 * abgeleitet statt ein zweites Mal literal ausgeschrieben (eine Quelle der Wahrheit für die
 * Allowlist statt zweier Kopien, die auseinanderlaufen könnten).
 */
const EXT_TO_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(ALLOWED_TYPES).map(([mime, ext]) => [ext, mime]),
);

/**
 * 10 MB. Ein gescanntes A4-Attest liegt typischerweise bei 0,5–3 MB; Handyfotos in voller
 * Auflösung erreichen 8 MB. Das globale 2-MB-Limit aus app.ts:260 bleibt für Avatare
 * unverändert — @fastify/multipart erlaubt den Override pro req.file()-Aufruf.
 */
const MAX_AU_SIZE = 10 * 1024 * 1024;

export async function section9DocumentRoutes(app: FastifyInstance) {
  // POST /api/v1/section9-documents/:creditId — Papier-AU hochladen
  app.post("/:creditId", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { creditId } = req.params as { creditId: string };

      const credit = await app.prisma.section9Credit.findUnique({
        where: { id: creditId },
        include: { employee: { select: { id: true, tenantId: true, userId: true } } },
      });
      if (!credit) return reply.code(404).send({ error: "§-9-Vorgang nicht gefunden" });

      // Tenant isolation BEFORE any other check (leave.ts:1659 idiom) — a cross-tenant
      // probe must not be able to learn the row's existence from the response.
      if (credit.employee.tenantId !== req.user.tenantId) {
        await app.audit({
          userId: req.user.sub,
          action: "CROSS_TENANT_ACCESS_DENIED",
          entity: "Section9Credit",
          entityId: creditId,
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
        return reply.code(404).send({ error: "§-9-Vorgang nicht gefunden" });
      }

      // Authz: own case (a privately-insured employee handing in their own certificate)
      // or manager/admin.
      const isSelf = req.user.employeeId === credit.employeeId;
      const isManager = ["ADMIN", "MANAGER"].includes(req.user.role);
      if (!isSelf && !isManager) {
        return reply.code(403).send({ error: "Keine Berechtigung" });
      }

      // Phase 104 review (WR-06): once the Vorgang is DECIDED, the certificate it rests on
      // is finalized evidence. Without this guard the employee who BENEFITS from the credit
      // (isSelf) — or any manager — could upload a replacement afterwards, and a replacement
      // with a different extension additionally destroyed the previous object. CLAUDE.md's
      // "no silent overwrites" rule requires a correction entry rather than an in-place
      // replacement of finalized evidence; the correction path here is reopen (D-11), which
      // puts the Vorgang back into AU_PENDING and is itself audited (SECTION9_CREDIT_REOPENED).
      if (credit.status !== "AU_PENDING") {
        return reply.code(409).send({
          error:
            "Der Vorgang ist bereits entschieden — das Dokument kann nicht mehr ersetzt werden.",
        });
      }

      // throwFileSizeLimit: false — @fastify/multipart 10.x defaults to THROWING a 413
      // (RequestFileTooLargeError) out of toBuffer() once the fileSize limit is hit,
      // which would bypass our own German 400 message. Disabling it makes toBuffer()
      // return the (truncated) buffer instead, so we can check `data.file.truncated`
      // ourselves — a silently truncated medical certificate must not be stored as if
      // it were complete.
      const data = await req.file({
        limits: { fileSize: MAX_AU_SIZE },
        throwFileSizeLimit: false,
      });
      if (!data) return reply.code(400).send({ error: "Keine Datei hochgeladen" });

      const ext = ALLOWED_TYPES[data.mimetype];
      if (!ext) {
        return reply.code(400).send({ error: "Nur PDF, JPG oder PNG erlaubt" });
      }

      const buffer = await data.toBuffer();
      if (data.file.truncated || buffer.length > MAX_AU_SIZE) {
        return reply.code(400).send({ error: "Datei darf max. 10 MB groß sein" });
      }

      const path = `section9/${credit.employee.tenantId}/${credit.employeeId}/${credit.id}.${ext}`;

      // Re-upload with a different extension: delete the stale object so it does not
      // become orphaned (invisible to the Art. 17 deletion loop, which only knows the
      // CURRENT documentPath).
      //
      // WR-06 asked whether the displaced object should be KEPT (timestamp-suffixed)
      // instead. Deliberately not: there is no history column to store the extra path in,
      // so a retained object would be invisible to the Art. 17 deletion loop forever — an
      // undeletable Art. 9 health document is a worse compliance outcome than a replaced
      // draft. The Revisionssicherheit requirement is met differently: replacement is now
      // only possible while the Vorgang is undecided (guard above), and the displaced path
      // is recorded in the SECTION9_DOCUMENT_UPLOADED audit row's oldValue below, so the
      // displacement itself stays reconstructible.
      //
      // IN-02: never swallow the failure silently — an undeleted object here is exactly the
      // orphan the Art. 17 loop can no longer find, and it must leave a trace.
      if (credit.documentPath && credit.documentPath !== path) {
        await app.storage
          .delete(credit.documentPath)
          .catch((err: unknown) =>
            app.log.warn(
              { err, path: credit.documentPath },
              "§ 9: stale AU object delete failed — possible orphan in object storage",
            ),
          );
      }

      // No image-processing library involved — the certificate must be stored byte-for-byte
      // as handed in. Re-encoding it would both destroy evidential value and add an
      // image-parser to the attack surface for an Art. 9 datum.
      await app.storage.upload(path, buffer, data.mimetype);

      await app.prisma.section9Credit.update({
        where: { id: credit.id },
        data: { documentPath: path },
      });

      // Record path/mimetype/size only — never the client-supplied filename, which can
      // itself carry a patient name or a diagnosis.
      await app.audit({
        userId: req.user.sub,
        action: "SECTION9_DOCUMENT_UPLOADED",
        entity: "Section9Credit",
        entityId: credit.id,
        // WR-06: preserve the DISPLACED path — without it the audit row recorded that
        // *a* replacement happened but not what it replaced.
        oldValue: credit.documentPath ? { documentPath: credit.documentPath } : null,
        newValue: { documentPath: path, mimetype: data.mimetype, bytes: buffer.length },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return { success: true, documentPath: path };
    },
  });

  // GET /api/v1/section9-documents/:creditId — Papier-AU abrufen
  app.get("/:creditId", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { creditId } = req.params as { creditId: string };

      const credit = await app.prisma.section9Credit.findUnique({
        where: { id: creditId },
        include: { employee: { select: { id: true, tenantId: true, userId: true } } },
      });
      if (!credit) return reply.code(404).send({ error: "§-9-Vorgang nicht gefunden" });

      if (credit.employee.tenantId !== req.user.tenantId) {
        await app.audit({
          userId: req.user.sub,
          action: "CROSS_TENANT_ACCESS_DENIED",
          entity: "Section9Credit",
          entityId: creditId,
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
        return reply.code(404).send({ error: "§-9-Vorgang nicht gefunden" });
      }

      const isSelf = req.user.employeeId === credit.employeeId;
      const isManager = ["ADMIN", "MANAGER"].includes(req.user.role);
      if (!isSelf && !isManager) {
        return reply.code(403).send({ error: "Keine Berechtigung" });
      }

      if (!credit.documentPath) {
        return reply.code(404).send({ error: "Kein Dokument vorhanden" });
      }

      const ext = credit.documentPath.split(".").pop() ?? "";
      const contentType = EXT_TO_MIME[ext];
      // Structurally unreachable — documentPath is only ever written by the POST handler
      // above, which only ever writes one of ALLOWED_TYPES' extensions. Fail loudly rather
      // than guessing a generic content type for an Art. 9 datum if that invariant is ever
      // violated (e.g. by a future direct-DB edit).
      if (!contentType) {
        return reply.code(500).send({ error: "Unbekannter Dokumenttyp" });
      }

      try {
        const buffer = await app.storage.getBuffer(credit.documentPath);
        reply.header("Content-Type", contentType);
        // Stricter than the avatar route's max-age=3600 — an Art. 9 datum should not sit
        // in any shared or disk cache.
        reply.header("Cache-Control", "private, no-store");
        return reply.send(buffer);
      } catch {
        return reply.code(404).send({ error: "Dokument nicht gefunden" });
      }
    },
  });
}
