/**
 * Issue #710 — Sichtbarkeits-Durchlauf for the role editor (retroactive proof for #692).
 *
 * "Ansehen" on a system role opens the editor. Before #692 it rendered below the table, outside
 * the viewport, with no scroll and no focus; the mounted tests only asserted existence and stayed
 * green. Since #854 the editor is a Dialog (a bottom sheet below 760 px) that scrolls inside itself, so
 * it is in view by construction; this spec still asserts that the editor form lies in the viewport
 * after the click, at 1280, 390 and 360 px, light and dark - it is the proof that the dialog is not
 * clipped or covered. Tenant fixture only, no seed, no date dependency.
 */
import { expect } from "../fixtures";
import { defineVisibilityWalkthrough } from "../helpers/visibility-walkthrough";

defineVisibilityWalkthrough({
  title: "Rollen-Editor Ansehen",
  path: "/admin/roles",
  ready: async (page) => {
    await expect(page.getByRole("button", { name: "Ansehen" }).first()).toBeVisible();
  },
  steps: [
    {
      name: "Ansehen",
      act: async (page) => {
        await page.getByRole("button", { name: "Ansehen" }).first().click();
      },
      // #role-editor-form exists before and after the #692 fix and the #854 dialog, so the same spec
      // runs on all of them; the "Ansehen" button of the roles table is unchanged by the DataTable.
      target: (page) => page.locator("#role-editor-form"),
    },
  ],
});
