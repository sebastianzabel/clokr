import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = () => {
  // 301 redirect: this route was renamed to /admin/integrations in Phase 52
  // (v1.6.1 Admin Area Restructure). Old bookmarks continue to work.
  redirect(301, "/admin/integrations");
};
