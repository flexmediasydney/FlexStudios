# Avoiding "Cannot access X before initialization" in production builds

ESM bindings (`const`, `let`, `class`) are in the **temporal dead zone**
(TDZ) between the start of their lexical scope and the line that
initialises them. Reading the binding inside that window throws
`ReferenceError: Cannot access 'X' before initialization` — and under
minification `X` is some 1-3-letter symbol like `te`, `om`, `Bs` that
tells you nothing about which source binding is at fault.

We hit three flavours of this error in a single day on Project Details
Shortlisting. All three minified to the same `te`. The root causes were
disjoint. This document captures each pattern, how to detect it, and the
fix.

If you are reading this because production just threw `Cannot access 'te'
before initialization`: **the symbol does not narrow you down**. You are
looking for one of the three patterns below.

---

## Pattern 1: ESM circular imports in `src/`

Two (or more) modules import named bindings from each other. If module A
is being evaluated, hits `import { foo } from './B'`, B begins evaluating,
hits `import { bar } from './A'` — A's exports object exists but `bar`'s
declaration line has not yet executed. B captures the binding in its TDZ
slot. Once B finishes evaluating, control returns to A and A's
declarations run. **But if B's body invoked `bar` during evaluation**
(e.g. as a top-level call, or as part of a class field with a default,
or — most commonly for us — as a JSX child rendered during module load
of a singleton-style component), V8 throws.

Under minification the binding name becomes a short symbol. The stack
frame points into the consumer module, not the source.

### Symptom

- Production minified bundle throws `Cannot access 'X' before
  initialization`, where `X` is 2-3 letters
- Same code runs fine in dev (Vite's ESM loader doesn't minify and
  evaluates differently)
- The error fires on first navigation to a route that touches one of the
  modules in the cycle, not necessarily on cold load

### Detection

Add `onwarn` to `vite.config.js` for one debug build:

```js
build: {
  rollupOptions: {
    onwarn(warning, defaultHandler) {
      if (warning.code === 'CIRCULAR_DEPENDENCY') {
        console.warn('CIRCULAR:', warning.message);
        // optional: throw to fail the build
      }
      defaultHandler(warning);
    }
  }
}
```

Then `pnpm build`. Every cycle in the source graph prints. Most are
benign (e.g. a barrel file re-exporting through itself), but the ones
that matter are cycles where one of the imported names is **used during
module evaluation**, not lazily on render.

### Fix

Extract the shared bindings into a **leaf module** — a file with no
imports from anywhere in the cycle. The two consumers now both import
from the leaf, breaking the cycle.

```jsx
// before:
//   TaskManagement.jsx exports CountdownTimer / CompletionTimer
//   TaskListView.jsx imports CountdownTimer from TaskManagement
//   TaskDetailPanel.jsx imports CountdownTimer from TaskManagement
//   TaskManagement.jsx imports TaskListView, TaskDetailPanel
//   -> three-cornered cycle, minifies into a TDZ

// after — taskTimers.jsx is a leaf:
//   src/components/projects/taskTimers.jsx
//     export function CountdownTimer(...) { ... }
//     export function CompletionTimer(...) { ... }
//     export function getCountdownState(...) { ... }
//   TaskListView.jsx     imports from './taskTimers'
//   TaskDetailPanel.jsx  imports from './taskTimers'
//   TaskManagement.jsx   re-exports from './taskTimers' (back-compat)
```

Reference: commit `32f389c` (TaskManagement / TaskListView /
TaskDetailPanel split, leaf module at
`flexmedia-src/src/components/projects/taskTimers.jsx`).

### Habits to keep cycles out

- Do not import a sibling component just to render it — pass it as a
  prop or use a leaf module
- Barrel files (`index.js` re-exporting from siblings) are fine **if**
  every consumer imports the same barrel; mixed direct + barrel imports
  produce phantom cycles
- Presentational helpers (`<CountdownTimer/>`, `<Pill/>`,
  `formatBytes`, etc.) belong in leaf modules, not co-located with
  their first consumer

---

## Pattern 2: `manualChunks` misses transitive sub-packages

Rollup splits vendored dependencies into named chunks via
`build.rollupOptions.output.manualChunks`. The static array form
declares which top-level packages go into a chunk:

```js
// fragile shape — array form
manualChunks: {
  'vendor-radix': [
    '@radix-ui/react-dialog',
    '@radix-ui/react-dropdown-menu',
    '@radix-ui/react-popover',
    // ... explicitly listed top-level packages
  ]
}
```

The trap: `@radix-ui/react-dialog` internally imports
`@radix-ui/react-context`, `@radix-ui/react-primitive`,
`@radix-ui/react-portal`, etc. Those sub-packages are **not** listed in
the manualChunk, so Rollup auto-splits them into anonymous chunks. The
anonymous chunks then import from `vendor-radix` AND `vendor-radix`
imports back from them — a circular import across chunk boundaries.

Under minification one of the re-exported bindings becomes a short
symbol (`te`, `om`), and on first render the auto-split chunk reads it
before the `vendor-radix` chunk has finished initialising. TDZ.

The same trap hits any ecosystem with internal sub-packages:
`react-leaflet` (`hooks/`, `media-overlay/`, `grid-layer/`),
`recharts` + `d3-*`, `@tanstack/*`, `@supabase/*`.

### Symptom

- `Cannot access 'X' before initialization` where `X` lives in a vendor
  chunk
- Stack frame format is `at <minified-symbol> (vendor-radix-<hash>.js:LINE:COL)`
  with one or two of *our* component frames above and below
- Goes away when you disable manualChunks entirely (proves the chunk
  boundary is the problem, not the source)

### Detection

In a temporary diagnostic build, preserve `console.error` so
ErrorBoundary's `componentDidCatch` log surfaces the stack. See the
diagnostic section at the bottom of this doc. The stack trace will
have a frame inside a `vendor-X-<hash>.js` chunk — that names the
ecosystem.

### Fix

Replace the array form with the **function form**, which captures every
sub-package of an ecosystem by path-prefix match:

```js
// vite.config.js
build: {
  rollupOptions: {
    output: {
      manualChunks(id) {
        if (id.includes('node_modules/')) {
          if (id.includes('node_modules/@radix-ui/'))            return 'vendor-radix';
          if (id.includes('node_modules/lucide-react/'))         return 'vendor-icons';
          if (id.includes('node_modules/recharts/') ||
              id.includes('node_modules/d3-'))                   return 'vendor-recharts';
          if (id.includes('node_modules/date-fns/'))             return 'vendor-date';
          if (id.includes('node_modules/@tanstack/react-query')) return 'vendor-query';
          if (id.includes('node_modules/@supabase/'))            return 'vendor-supabase';
          if (id.includes('node_modules/react-leaflet') ||
              id.includes('node_modules/leaflet') ||
              id.includes('node_modules/leaflet.markercluster')) return 'vendor-leaflet';
          if (id.includes('node_modules/react-router') ||
              id.includes('node_modules/react-dom') ||
              id.includes('node_modules/react/') ||
              id.includes('node_modules/scheduler/'))            return 'vendor-react';
        }
        // everything else: let Rollup decide (per-route splits)
      }
    }
  }
}
```

Reference: `flexmedia-src/vite.config.js` (commit `daf4fda`). The
in-source comment on that file walks through why the array form fails.

### Habits

- Never use the array form for any package that has sub-packages
  (`@scope/*`, ecosystem internals like `d3-*`)
- When you add a new vendor chunk, grep `node_modules` for the package
  name and check whether it ships internal sub-packages; if yes, use
  path-prefix
- If you see two chunk hashes in a stack with arrows between them,
  suspect this pattern

---

## Pattern 3: Forward reference in component body

Inside a component function body, `const` bindings are in TDZ from the
start of the function until their declaration line. React executes the
function top-to-bottom on every render. If a hook earlier in the body
references a binding declared later in the same body — most often via
a `useMemo` / `useCallback` / `useEffect` deps array — V8 throws on
first render.

This is the trickiest of the three patterns because the ESLint rule
`no-use-before-define` doesn't catch references inside hook deps arrays
(they're "syntactically before-define" but semantically the deps array
evaluates at call time, after the binding *would* have been declared in
a sane ordering). And `react-hooks/exhaustive-deps` happily writes the
broken deps array for you when you autofix.

### Symptom

- `Cannot access 'X' before initialization` on a specific route, but
  only when certain data is present (in our case: only when rounds
  exist; the empty-state branch didn't mount the swimlane at all)
- Stack frame points into ONE of our component chunks, not a vendor
  chunk
- The minified column inside the offending function, when grepped for
  context, contains the binding name as part of a deps-array literal
  like `[P.bucket, te]`

### Detection

1. Preserve `console.error` in production (see diagnostic section
   below).
2. Reproduce on the affected route. ErrorBoundary's `componentDidCatch`
   logs the stack:
   ```
   Cannot access 'te' before initialization
       at om (ProjectDetails-<hash>.js:63:124026)
   ```
3. Open the deployed `ProjectDetails-<hash>.js`, jump to line 63 column
   124026, and read 200 chars of context. You will see something like
   `useMemo(()=>{...},[P.bucket,te])`. The `te` is the offending
   binding.
4. In dev, search the source file for every `useMemo` / `useCallback` /
   `useEffect` whose deps array includes a binding that isn't a hook
   parameter. For each one, confirm the binding's `const` declaration
   appears **before** the hook in the function body.

### Fix

Move the dependent hook AFTER the binding declaration. This is almost
always a one-liner re-order; it does not change behaviour because the
function still runs top-to-bottom, you're just letting the declaration
happen first:

```jsx
// before — TDZ at line 530 because columnItems is at line 1083
function ShortlistingSwimlane(...) {
  // ...
  const lightboxItemsMemo = useMemo(() => {
    // ...uses columnItems...
  }, [lightboxState.bucket, columnItems]);   // <-- TDZ on first render
  // ...500 lines of other hooks...
  const columnItems = useMemo(() => { /* ... */ }, [/* ... */]);
  // ...
}

// after — declare columnItems before the consumer
function ShortlistingSwimlane(...) {
  // ...500 lines of other hooks...
  const columnItems = useMemo(() => { /* ... */ }, [/* ... */]);
  const lightboxItemsMemo = useMemo(() => {
    // ...uses columnItems...
  }, [lightboxState.bucket, columnItems]);
  // ...
}
```

Reference: commit `ef407a0`
(`flexmedia-src/src/components/projects/shortlisting/ShortlistingSwimlane.jsx`).

### Belt-and-braces lint

Add to `.eslintrc`:

```json
{
  "rules": {
    "no-use-before-define": ["error", { "functions": false, "classes": true, "variables": true }],
    "react-hooks/exhaustive-deps": "warn"
  }
}
```

`no-use-before-define` will catch the direct read; it will NOT catch
deps-array reads, but pairing it with code review (and this doc) closes
the gap.

### Habits

- Declare every `useMemo`/`useCallback` immediately after the bindings
  it depends on, not at the top of the function
- If you're tempted to put a hook "near where it's used in JSX,"
  resist; co-locate with its dependencies instead
- Long component bodies (>500 lines) make this much easier to miss; if
  you find yourself in one, the answer is usually to extract a child
  component, not to ship the long body

---

## Diagnostic technique: surface the stack in production

Our default `vite.config.js` drops all `console.*` calls in production:

```js
esbuild: {
  drop: ['console', 'debugger'],
}
```

This silences `ErrorBoundary.componentDidCatch`'s `console.error(error,
errorInfo)`, which is exactly the log we need to find a TDZ source.
When you cannot reproduce locally and need the production stack, flip
to selective drops for one diagnostic deploy:

```js
// diagnostic — keep error/warn alive
esbuild: {
  pure: ['console.log', 'console.info', 'console.debug', 'console.trace'],
  drop: ['debugger'],
}
```

`pure` marks the call sites as side-effect-free so esbuild eliminates
them when their return value is unused (same effect as `drop` for
`console.log`-style call sites). `console.error` and `console.warn`
survive — so does `ErrorBoundary`'s log, with the full minified stack.

Workflow:

1. Commit the diagnostic config (e.g. commit `535e266`); deploy.
2. Reproduce the crash on production. ErrorBoundary logs the stack to
   the browser console, including the minified component / vendor frame
   coordinates.
3. Identify the root cause (Pattern 1, 2, or 3 above).
4. Ship the fix.
5. **Revert the diagnostic config** (e.g. commit `f5bcd79`) so prod
   bundles are quiet again. Both the diagnostic flip and the revert
   live as separate small commits; do not mix either with a feature
   change.

Bundle-size cost of keeping `console.error/warn` alive is negligible
(~30 call sites across the app), so if you find yourself needing it
twice in a quarter, consider keeping the selective form permanently.

---

## Triage checklist when prod throws "Cannot access X before initialization"

1. Is the stack frame inside a `vendor-X-<hash>.js` chunk? -> **Pattern 2**
2. Is the stack frame inside one of our component chunks (e.g.
   `ProjectDetails-<hash>.js`)? Open the deployed file at the column
   reported, grep for the offending symbol — does it appear inside a
   `useMemo`/`useCallback`/`useEffect` deps array? -> **Pattern 3**
3. Otherwise, run a debug build with `onwarn` capturing
   `CIRCULAR_DEPENDENCY` warnings. If a cycle includes a module whose
   exports are read during evaluation -> **Pattern 1**
4. If the symbol is in a vendor chunk for an ecosystem we explicitly
   chunk (Radix, leaflet, recharts), confirm `manualChunks` uses the
   path-prefix function form, not the array form. Same-day fixes
   shipped for Radix (`daf4fda`) and leaflet (`6b5e9a1`).
5. None of the above? Suspect a regression in a vendored package's own
   ESM ordering — check `package.json` for a recent bump, try pinning
   to the prior version to bisect.
