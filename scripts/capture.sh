#!/usr/bin/env bash
#
# Capture a raw thought as a GitHub issue.
#
#   ./scripts/capture.sh "die urlaubsübersicht lädt ewig wenn viele mitarbeiter"
#   pbpaste | ./scripts/capture.sh
#   ./scripts/capture.sh                    # falls back to the clipboard
#   ./scripts/capture.sh --dry-run "..."    # print what would be created
#
# Input is taken from, in order: $1, stdin (when piped), the clipboard.
# Claude turns it into a title and a structured body; gh files it.
#
# Capture is capture: no milestone, no iteration, no estimate. The issue
# lands in Inbox and waits for the sprint change. Deciding at capture time
# is what makes people stop capturing.
#
# Pairs with macOS dictation — see docs/PROCESS.md.

set -euo pipefail

DRY_RUN=0
RAW=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run | -n)
      DRY_RUN=1
      shift
      ;;
    -h | --help)
      sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    --)
      shift
      RAW="$*"
      break
      ;;
    *)
      RAW="${RAW:+$RAW }$1"
      shift
      ;;
  esac
done

die() {
  echo "capture: $1" >&2
  exit 1
}

# ── Input ─────────────────────────────────────────────────────────────

if [ -z "$RAW" ] && [ ! -t 0 ]; then
  RAW="$(cat)"
fi

if [ -z "${RAW//[[:space:]]/}" ] && command -v pbpaste >/dev/null 2>&1; then
  RAW="$(pbpaste 2>/dev/null || true)"
  [ -n "${RAW//[[:space:]]/}" ] && echo "capture: using clipboard contents" >&2
fi

[ -z "${RAW//[[:space:]]/}" ] && die "no input — pass text as an argument, pipe it in, or copy it to the clipboard"

# Dictation produces long single paragraphs, but a stray keystroke produces
# "a". Refuse the latter rather than filing a useless issue.
if [ "${#RAW}" -lt 12 ]; then
  die "input is only ${#RAW} characters — too short to be a real note: ${RAW}"
fi

command -v claude >/dev/null 2>&1 || die "claude CLI not found in PATH"
command -v gh >/dev/null 2>&1 || die "gh CLI not found in PATH"

if [ "$DRY_RUN" -eq 0 ]; then
  gh auth status >/dev/null 2>&1 || die "gh is not authenticated — run: gh auth login"
fi

# ── Shape it ──────────────────────────────────────────────────────────

PROMPT=$(
  cat <<'PROMPT'
Du bekommst eine roh diktierte oder getippte Notiz zu Clokr, einer
deutschsprachigen Zeiterfassungs-Software. Mach daraus einen GitHub-Issue.

Antworte AUSSCHLIESSLICH mit einem JSON-Objekt, ohne Markdown-Codefence,
ohne Vor- oder Nachtext:

{"title": "...", "body": "...", "type": "bug|feature|chore"}

title  Maximal 70 Zeichen. Beschreibt das Problem, nicht die Lösung.
       Kein abschliessender Punkt. Deutsch.
body   Markdown. Deutsch. Gib die Notiz strukturiert wieder — erfinde
       nichts dazu. Was unklar bleibt, kommt unter "Offen" als Frage.
       Struktur je nach type:
         bug     -> "## Was passiert" / "## Erwartet" / "## Offen"
         feature -> "## Bedarf" / "## Idee" / "## Offen"
         chore   -> "## Was und warum" / "## Offen"
       Am Ende IMMER:
         "## Akzeptanzkriterien\n\n_Noch offen — beim Triage ergänzen._"
       Außer die Notiz nennt bereits prüfbare Kriterien; dann diese
       als Liste aufführen.
type   bug wenn etwas nicht funktioniert, feature wenn etwas fehlt,
       chore bei Wartung, Doku, Abhängigkeiten, Infrastruktur.

Die Notiz:
PROMPT
)

echo "capture: asking claude to shape the note ..." >&2

JSON="$(printf '%s\n\n%s\n' "$PROMPT" "$RAW" | claude -p 2>/dev/null || true)"
[ -z "${JSON//[[:space:]]/}" ] && die "claude returned nothing — is it authenticated? try: claude -p 'hi'"

# Be forgiving about a stray code fence, strict about everything else.
#
# The parsed fields go to files rather than through a shell variable: a body
# is multi-line markdown, and there is no delimiter that is both safe inside
# markdown and portable across GNU and BSD userland (`cut -z` is GNU-only).
WORK="$(mktemp -d -t clokr-capture)"
trap 'rm -rf "$WORK"' EXIT

if ! printf '%s' "$JSON" | WORK="$WORK" python3 -c '
import json, os, re, sys

work = os.environ["WORK"]
raw = sys.stdin.read().strip()
raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.MULTILINE).strip()

# A model that prepends a sentence still usually emits one clean object.
if not raw.startswith("{"):
    start, end = raw.find("{"), raw.rfind("}")
    if start == -1 or end == -1:
        sys.exit("no JSON object found in the response")
    raw = raw[start:end + 1]

try:
    d = json.loads(raw)
except json.JSONDecodeError as exc:
    sys.exit("response was not valid JSON: %s" % exc)

missing = [k for k in ("title", "body", "type") if not str(d.get(k, "")).strip()]
if missing:
    sys.exit("response is missing: " + ", ".join(missing))

kind = str(d["type"]).strip().lower()
if kind not in ("bug", "feature", "chore"):
    sys.exit("type must be bug, feature or chore - got %r" % kind)

title = " ".join(str(d["title"]).split())
if len(title) > 70:
    title = title[:69].rstrip() + "…"

for name, value in (("title", title), ("body", str(d["body"])), ("type", kind)):
    with open(os.path.join(work, name), "w", encoding="utf-8") as fh:
        fh.write(value)
' 2>"$WORK/err"; then
  die "could not read claude'\''s response: $(cat "$WORK/err")

--- raw response ---
${JSON}"
fi

TITLE="$(cat "$WORK/title")"
BODY="$(cat "$WORK/body")"
TYPE="$(cat "$WORK/type")"

# ── File it ───────────────────────────────────────────────────────────

# The raw note is kept verbatim under the shaped version. Dictation garbles
# words, and the original is often the only way to tell what was meant.
BODY_FILE="$WORK/issue.md"
{
  printf '%s\n\n---\n\n' "$BODY"
  printf '<sub>Erfasst via `scripts/capture.sh`. Rohnotiz unverändert:</sub>\n\n'
  printf '%s\n' "$RAW" | sed 's/^/> /'
} >"$BODY_FILE"

if [ "$DRY_RUN" -eq 1 ]; then
  echo
  echo "── DRY RUN — nothing was created ──────────────────────────────"
  echo "label: ${TYPE}"
  echo "title: ${TITLE}"
  echo
  cat "$BODY_FILE"
  echo "───────────────────────────────────────────────────────────────"
  exit 0
fi

URL="$(gh issue create --title "$TITLE" --label "$TYPE" --body-file "$BODY_FILE")" ||
  die "gh issue create failed — the shaped note was:

${TITLE}

${BODY}"

echo "$URL"
if command -v pbcopy >/dev/null 2>&1; then
  printf '%s' "$URL" | pbcopy && echo "capture: url copied to clipboard" >&2
fi
