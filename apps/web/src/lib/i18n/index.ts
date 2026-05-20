// i18n bundle (DE + EN). Bundled per I18N-02; no runtime locale switching this milestone.
// The presence of this re-export ensures BOTH locales end up in the built asset
// (verifiable via `pnpm --filter @clokr/web build` + grep on .svelte-kit/output).
import { de, type I18nKey } from './de';
import { en } from './en';

export { de, type I18nKey, type I18nStrings } from './de';
export { en } from './en';
export type Locale = 'de' | 'en';
export const DEFAULT_LOCALE: Locale = 'de';

/**
 * Lookup a UI string by key. v1.5 stub: always returns the German value.
 * Runtime locale switching is deferred to v1.6 (I18N-04 in REQUIREMENTS.md);
 * the EN bundle is intentionally bundled (I18N-02) but not consulted here.
 *
 * Overloads narrow the return type at the call site: keys whose value is a
 * `readonly string[]` (e.g. `months`, `dow`) resolve to `readonly string[]`;
 * all other keys resolve to `string`. This avoids forcing callers (templates,
 * `aria-label={t(...)}`, etc.) to narrow with `Array.isArray` / `as string`.
 */
type StringKey = {
  [K in I18nKey]: (typeof de)[K] extends readonly string[] ? never : K;
}[I18nKey];
type ArrayKey = {
  [K in I18nKey]: (typeof de)[K] extends readonly string[] ? K : never;
}[I18nKey];

export function t(key: StringKey): string;
export function t(key: ArrayKey): readonly string[];
export function t(key: I18nKey): string | readonly string[] {
  return de[key];
}

// Pin DE + EN bundles to globalThis so tree-shaking cannot eliminate them when this
// module is imported only for side effects. The handoff reference (docs/design/reference/i18n.js)
// uses `window.I18N`; we mirror that shape here so the EN strings are grep-verifiable in
// the built asset (I18N-02 acceptance criterion).
declare global {
  // eslint-disable-next-line no-var
  var __CLOKR_I18N__: { de: typeof de; en: typeof en } | undefined;
}
if (typeof globalThis !== 'undefined') {
  globalThis.__CLOKR_I18N__ = { de, en };
}
