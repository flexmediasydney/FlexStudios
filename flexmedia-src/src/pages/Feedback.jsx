import React from 'react';

// 2026-04-21 diagnostic stub — the full page kept blanking the React tree
// on Vercel even after multiple defensive rewrites. This stub isolates the
// problem: if it renders, something in the submodule graph was at fault
// (we'll bisect from here). If even this blanks, the issue is upstream
// (router / Suspense / lazy-loading / auth guard) and deserves different
// investigation.

export default function Feedback() {
  return (
    <div style={{ padding: 32 }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>Feedback</h1>
      <p style={{ fontSize: 14, color: '#64748b' }}>
        Diagnostic stub — if you can read this, the page route + lazy chunk load are fine.
      </p>
      <p style={{ fontSize: 12, color: '#94a3b8', marginTop: 16 }}>
        Build: {new Date().toISOString()}
      </p>
    </div>
  );
}
