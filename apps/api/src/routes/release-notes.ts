import { FastifyInstance } from "fastify";
import { loadReleaseNotes, type ReleaseNote } from "../utils/release-notes";

// Phase 110 (D-04 revised / N-02): the German release notes are baked into THIS image at build
// time (apps/api/Dockerfile copies docs/release-notes/) and read exactly once here, at module
// init — the same doctrine as the version bake in app.ts:60-67. There is deliberately NO runtime
// fetch of the upstream release-hosting API: int egress is unreliable and prod runs behind
// dmz-proxy, so a display feature must not be able to fail on a network fault (AK-04/AK-05).
const BAKED_RELEASES: ReleaseNote[] = loadReleaseNotes();

export async function releaseNotesRoutes(app: FastifyInstance) {
  // Public, no auth guard — same posture as GET /api/v1/version (app.ts:372). The content is
  // PII-free by template rule and D-08 wants it visible to every role; gating it would force the
  // web client to hold a token before it can even decide whether to show the unread marker.
  app.get("/release-notes", {
    schema: {
      tags: ["System"],
      description: "Release notes baked into this image at build time",
    },
    handler: async () => ({ releases: BAKED_RELEASES }),
  });
}
