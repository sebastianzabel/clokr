/**
 * Issue #608 (D-03, P-608-05) - the display label of a push device, derived from the User-Agent.
 *
 * The result is one value of a closed vocabulary ("<browser> auf <system>" or the fallback), never
 * client free text, so the label can be shown and audited without a DSGVO free-text concern.
 */

const BROWSERS: Array<{ label: string; test: RegExp }> = [
  // Order matters: several engines also carry the "Chrome" or "Safari" token.
  { label: "Edge", test: /\b(Edg|EdgA|EdgiOS|Edge)\//i },
  { label: "Samsung Internet", test: /SamsungBrowser\//i },
  { label: "Opera", test: /\b(OPR|OPT|Opera)\//i },
  { label: "Firefox", test: /\b(Firefox|FxiOS)\//i },
  { label: "Chrome", test: /\b(Chrome|CriOS)\//i },
  { label: "Safari", test: /\bSafari\//i },
];

const SYSTEMS: Array<{ label: string; test: RegExp }> = [
  // iPad/iPhone before macOS (their UA says "like Mac OS X"); Android before Linux.
  { label: "iPhone", test: /\biPhone\b/i },
  { label: "iPad", test: /\biPad\b/i },
  { label: "Android", test: /\bAndroid\b/i },
  { label: "ChromeOS", test: /\bCrOS\b/i },
  { label: "Windows", test: /\bWindows\b/i },
  { label: "macOS", test: /\bMacintosh\b|\bMac OS X\b/i },
  { label: "Linux", test: /\bLinux\b|\bX11\b/i },
];

export const UNKNOWN_DEVICE_LABEL = "Unbekanntes Gerät";

export function deviceLabelFromUserAgent(ua: string | undefined): string {
  if (!ua) return UNKNOWN_DEVICE_LABEL;
  const browser = BROWSERS.find((b) => b.test.test(ua));
  const system = SYSTEMS.find((s) => s.test.test(ua));
  if (!browser || !system) return UNKNOWN_DEVICE_LABEL;
  return `${browser.label} auf ${system.label}`;
}
