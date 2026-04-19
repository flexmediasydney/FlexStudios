#!/usr/bin/env bash
# scripts/check-deploy-safety.sh
#
# Pre-push safety net for FlexStudios. Prevents the classes of bug that
# have silently broken Vercel deploys or edge-function runs in the past:
#
#   1. JSDoc comment containing "*/" as a non-terminator — esbuild reads it
#      as the end of the block comment and chokes (cost: 6+ failed deploys,
#      commit e435cdf had to fix this retroactively).
#   2. Source files imported but never "git add"-ed — Vercel clones from
#      the git tree, which doesn't include local-only files. Forced deploys
#      mask the issue because they upload the working tree (cost: 5+ failed
#      auto-deploys, commit d6de503 had to fix this retroactively).
#   3. A local Vite build smoke-test — catches everything the above two
#      don't, at the cost of ~30s per push.
#   4. Supabase null-destructuring: `const { data: rows = [] }` on a
#      supabase query result does NOT catch data:null (only undefined), so
#      downstream .forEach/.map crashes the whole edge function. Root cause
#      of pulseDataSync's 46% failure rate (a3554c6 had to fix 32 sites
#      retroactively). Ban the pattern outright — require .data ?? [].
#
# Wired in as a git hook via `.githooks/pre-push` — see that file for the
# invocation. Can be run manually: `./scripts/check-deploy-safety.sh`.
#
# Exit code 0 = safe to push. Non-zero = hard stop.

set -euo pipefail

cd "$(dirname "$0")/.."

FAILED=0

echo "┌─ FlexStudios pre-push safety check ─"

# ── 1. Untracked source files (imported but not committed) ────────────────
echo "├── 1. Scanning for untracked source files…"
UNTRACKED=$(git ls-files --others --exclude-standard | grep -E '\.(jsx?|tsx?|mjs|cjs)$' || true)
if [ -n "$UNTRACKED" ]; then
  echo "│     ❌ UNTRACKED source files found:"
  echo "$UNTRACKED" | sed 's/^/│         /'
  echo "│     → git add them before pushing, or add to .gitignore if intentional"
  FAILED=1
else
  echo "│     ✓ no untracked source files"
fi

# ── 2. JSDoc */ hazard (non-terminator "*/" inside a block comment) ───────
echo "├── 2. Scanning for JSDoc */ hazards in *.jsx…"
# Match lines that start with " * " (inside a JSDoc block) AND contain "*/"
# followed by a non-whitespace character that is NOT "}" or ")" — those
# terminate JSX comments {/* … */} or valid JS expressions, so they're safe.
# The true hazard is "*/" followed by alphanumeric / symbol inside a block
# comment — esbuild sees the "*/" as the end of the comment and the trailing
# text as stray tokens. Classic example: "runs */5min" (tried to mean a cron
# expression inside a JSDoc, got interpreted as end-of-comment + "5min").
HAZARDS=$(grep -rnE '^\s*\*.*\*/[^\s})]' \
  flexmedia-src/src \
  supabase/functions 2>/dev/null \
  --include='*.jsx' --include='*.js' --include='*.ts' --include='*.tsx' || true)
if [ -n "$HAZARDS" ]; then
  echo "│     ❌ JSDoc */ hazards found (esbuild will read these as comment terminators):"
  echo "$HAZARDS" | sed 's/^/│         /'
  echo "│     → rewrite the comment — e.g. 'every 5 min' instead of '*/5min'"
  FAILED=1
else
  echo "│     ✓ no JSDoc hazards"
fi

# ── 3. Supabase null-destructuring anti-pattern ──────────────────────────
# The pattern `const { data: X = [] } = await admin.from(...)...` is UNSAFE.
# The destructuring default fires only on `undefined` — when Supabase returns
# { data: null, error: someError } (common on RLS deny, network blip, CF
# challenge, column typo, timeout), X is null and the next .map/.forEach
# crashes the function. Require `.data ?? []` instead, which coalesces both
# null AND undefined.
#
# Safe:
#   const result = await admin.from('t').select('*');
#   const rows = result.data ?? [];
# Unsafe (banned):
#   const { data: rows = [] } = await admin.from('t').select('*');
echo "├── 3. Scanning edge functions for null-unsafe destructuring…"
UNSAFE=$(grep -rnE '\{\s*data:\s*\w+\s*=\s*\[\s*\]' supabase/functions 2>/dev/null \
  --include='*.ts' --include='*.tsx' --include='*.js' --include='*.mjs' \
  --include='*.jsx' --include='*.cjs' || true)
if [ -n "$UNSAFE" ]; then
  echo "│     ❌ Null-unsafe Supabase destructuring found (banned):"
  echo "$UNSAFE" | sed 's/^/│         /'
  echo "│     → rewrite as:"
  echo "│         const r = await admin.from(...).select(...);"
  echo "│         const rows = r.data ?? [];"
  echo "│       The \`= []\` default fires only on undefined, not null."
  FAILED=1
else
  echo "│     ✓ no null-unsafe destructuring"
fi

# ── 4. Local Vite build smoke-test ────────────────────────────────────────
echo "├── 4. Running local Vite build (≈30s)…"
if [ ! -d "flexmedia-src/node_modules" ]; then
  echo "│     ⚠ skipping — flexmedia-src/node_modules missing"
else
  BUILD_LOG=$(mktemp)
  if (cd flexmedia-src && npx vite build --logLevel error > "$BUILD_LOG" 2>&1); then
    echo "│     ✓ build succeeded"
  else
    echo "│     ❌ BUILD FAILED — tail of log:"
    tail -30 "$BUILD_LOG" | sed 's/^/│         /'
    FAILED=1
  fi
  rm -f "$BUILD_LOG"
fi

echo "└─"

if [ "$FAILED" -ne 0 ]; then
  echo ""
  echo "One or more safety checks failed. Push blocked."
  echo "Bypass (at your own risk): git push --no-verify"
  exit 1
fi

echo "All checks passed. Safe to push."
exit 0
