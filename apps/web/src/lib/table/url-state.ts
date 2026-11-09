// Issue #843 (D-843-01 block 6, ASVS V5, T-843-18) - the ONE helper that maps table state
// (search text, sort, filters, page) to the URL and back.
//
// The URL is attacker-controlled input (anyone can craft a link), so reading is an allow-list:
//   - only the keys of the page's schema are looked at, every other key is ignored,
//   - each key goes through its own parser (bounded text, enum, pattern, bounded integer) and a
//     value that fails falls back to the schema default,
//   - a raw URL string is never handed on; the page only ever sees the parsed state.
// Writing emits only non-default values, keeps the keys that are not in the schema (such as the
// salon filter `salonId`) untouched and navigates with replaceState, so a keystroke in the search
// field does not fill the browser history.
//
// The parse and serialise functions are pure. Only the default reader and navigator of `urlState()`
// touch SvelteKit (`page.url`, `goto`); a test injects its own.
import { page } from "$app/state";
import { goto } from "$app/navigation";

/** Maps one raw query value to a typed value and back; `serialise` returns null for a default. */
export interface StateParser<T> {
  readonly fallback: T;
  parse(raw: string | null): T;
  serialise(value: T): string | null;
}

/** The schema of one table: query key -> parser. Keys not named here never pass. */
export type StateSchema = Record<string, StateParser<unknown>>;

export type StateOf<S extends StateSchema> = {
  [K in keyof S]: S[K] extends StateParser<infer T> ? T : never;
};

/** Anything with `get(name)`: `URLSearchParams` and `URL["searchParams"]` both fit. */
export interface SearchParamsLike {
  get(name: string): string | null;
}

/** Upper bound for a pattern-checked value, so a huge string never reaches the regular expression. */
const PATTERN_MAX_LENGTH = 200;

/** Control characters (C0, DEL, C1) never belong in a search text. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

// ── Parser builders ──────────────────────────────────────────────────────────

/** Free text: control characters removed, trimmed, cut to `max` characters. Default "". */
export function text(options: { max: number }): StateParser<string> {
  const { max } = options;
  const clean = (raw: string): string => raw.replace(CONTROL_CHARS, "").trim().slice(0, max);
  return {
    fallback: "",
    parse: (raw) => (raw === null ? "" : clean(raw)),
    serialise: (value) => {
      const cleaned = typeof value === "string" ? clean(value) : "";
      return cleaned === "" ? null : cleaned;
    },
  };
}

/** One of a fixed set of values; anything else is the fallback. */
export function oneOf<const V extends string>(values: readonly V[], fallback: V): StateParser<V> {
  if (!values.includes(fallback)) {
    throw new Error("oneOf: the fallback must be one of the values");
  }
  const known = (raw: unknown): raw is V => values.includes(raw as V);
  return {
    fallback,
    parse: (raw) => (known(raw) ? raw : fallback),
    serialise: (value) => (known(value) && value !== fallback ? value : null),
  };
}

/** A string that matches `re` (and is at most 200 characters); anything else is the fallback. */
export function pattern(re: RegExp, fallback: string): StateParser<string> {
  // A global or sticky expression keeps `lastIndex` between calls; a fresh copy never does.
  const matcher = new RegExp(re.source, re.flags.replace(/[gy]/g, ""));
  const valid = (raw: unknown): raw is string =>
    typeof raw === "string" && raw.length <= PATTERN_MAX_LENGTH && matcher.test(raw);
  return {
    fallback,
    parse: (raw) => (valid(raw) ? raw : fallback),
    serialise: (value) => (valid(value) && value !== fallback ? value : null),
  };
}

/** A whole number within [min, max]; anything else is the fallback. */
export function int(range: { min: number; max: number }, fallback: number): StateParser<number> {
  const valid = (n: unknown): n is number =>
    typeof n === "number" && Number.isInteger(n) && n >= range.min && n <= range.max;
  return {
    fallback,
    parse: (raw) => {
      if (raw === null || !/^-?\d{1,9}$/.test(raw)) return fallback;
      const n = Number(raw);
      return valid(n) ? n : fallback;
    },
    serialise: (value) => (valid(value) && value !== fallback ? String(value) : null),
  };
}

// ── Pure parse / serialise ───────────────────────────────────────────────────

/** Parses the state of a schema from query parameters. Never throws; unknown keys are ignored. */
export function parseUrlState<S extends StateSchema>(
  schema: S,
  params: SearchParamsLike,
): StateOf<S> {
  const state: Record<string, unknown> = {};
  for (const key of Object.keys(schema)) {
    state[key] = schema[key].parse(params.get(key));
  }
  return state as StateOf<S>;
}

/**
 * The query string (no leading "?") for `state`: the keys of `current` that are not in the schema
 * stay as they are, the schema keys are rewritten from `state` and only non-default values appear.
 */
export function serialiseUrlState<S extends StateSchema>(
  schema: S,
  state: Partial<StateOf<S>>,
  current: URLSearchParams | string = "",
): string {
  const params = new URLSearchParams(current);
  for (const key of Object.keys(schema)) params.delete(key);
  for (const key of Object.keys(schema)) {
    const value = key in state ? state[key] : schema[key].fallback;
    const serialised = schema[key].serialise(value);
    if (serialised !== null) params.set(key, serialised);
  }
  return params.toString();
}

// ── Reactive helper ──────────────────────────────────────────────────────────

export interface NavigateOptions {
  replaceState: boolean;
  keepFocus: boolean;
  noScroll: boolean;
}

/** Where the helper reads the current URL and how it navigates; both are injectable for tests. */
export interface UrlStateIo {
  url(): URL;
  navigate(href: string, options: NavigateOptions): unknown;
}

const defaultIo: UrlStateIo = {
  url: () => page.url,
  // The href is built from the current `page.url.pathname`, which already carries any base path;
  // `resolve()` would prefix it a second time.
  // eslint-disable-next-line svelte/no-navigation-without-resolve
  navigate: (href, options) => goto(href, options),
};

export interface UrlState<S extends StateSchema> {
  /** The parsed state of the current URL (reactive when called in a rune context). */
  read(): StateOf<S>;
  /** Merges `patch` into the current state and navigates once, replacing the history entry. */
  write(patch: Partial<StateOf<S>>): void;
}

/** Binds a schema to the page URL (or an injected reader and navigator). */
export function urlState<S extends StateSchema>(
  schema: S,
  io: UrlStateIo = defaultIo,
): UrlState<S> {
  return {
    read: () => parseUrlState(schema, io.url().searchParams),
    write: (patch) => {
      const url = io.url();
      const next = { ...parseUrlState(schema, url.searchParams), ...patch };
      const query = serialiseUrlState(schema, next, url.searchParams);
      // Built from the current path only: the helper never forwards a string it was given.
      const href = `${url.pathname}${query === "" ? "" : `?${query}`}${url.hash}`;
      if (href === `${url.pathname}${url.search}${url.hash}`) return;
      io.navigate(href, { replaceState: true, keepFocus: true, noScroll: true });
    },
  };
}
