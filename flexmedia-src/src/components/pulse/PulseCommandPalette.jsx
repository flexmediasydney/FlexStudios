//
// PulseCommandPalette — global ⌘K search + action launcher for Industry Pulse
// =============================================================================
// Renders a centered top-mounted modal with a search input and a keyboard-
// navigable result list. Three categories feed the list:
//
//   1. Server-side typeahead (pulse_global_search RPC) across
//      pulse_listings, pulse_agents, pulse_agencies. Results carry a
//      `kind` of "listing" | "agent" | "agency"; selecting one opens the
//      entity slideout via onOpenEntity().
//
//   2. Navigation entries — one per Industry Pulse tab. Selecting one calls
//      onNavigateTab(value).
//
//   3. Local commands — actions provided by the parent (refresh, toggle
//      density, set homepage default, show shortcut help, etc.). Fuzzy-
//      matched client-side so the palette stays snappy even with no query.
//
// Scopes chip toggle filters the list: "All" shows everything, the other
// chips restrict to a single kind. Enter on a row fires its action and
// dismisses. Escape closes without firing.
//
// The palette is a controlled component: the parent owns `open`; this
// component manages its own query + scope + active-index state.
//

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/api/supabaseClient";
import {
  Search, Home, Users, Building2, ArrowRight, Command as CmdIcon,
  ChevronRight, Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Scope chips ─────────────────────────────────────────────────────────────
const SCOPES = [
  { value: "all",      label: "All" },
  { value: "listing",  label: "Listings" },
  { value: "agent",    label: "Agents" },
  { value: "agency",   label: "Agencies" },
  { value: "command",  label: "Commands" },
  { value: "nav",      label: "Navigation" },
];

// ── Icon picker per kind ────────────────────────────────────────────────────
function kindIcon(kind) {
  switch (kind) {
    case "listing": return Home;
    case "agent":   return Users;
    case "agency":  return Building2;
    case "nav":     return ChevronRight;
    case "command": return Zap;
    default:        return CmdIcon;
  }
}

// Simple substring fuzzy match — order-preserving, case-insensitive.
function fuzzyMatch(haystack, needle) {
  if (!needle) return true;
  const h = (haystack || "").toLowerCase();
  const n = needle.toLowerCase();
  if (h.includes(n)) return true;
  // Character-skip match for short queries like "mkt sh" → "market share"
  let hi = 0;
  for (let ni = 0; ni < n.length; ni++) {
    const ch = n[ni];
    if (ch === " ") continue;
    const found = h.indexOf(ch, hi);
    if (found === -1) return false;
    hi = found + 1;
  }
  return true;
}

export default function PulseCommandPalette({
  open,
  onClose,
  onOpenEntity,
  onNavigateTab,
  tabs = [],
  commands = [],
}) {
  const [q, setQ] = useState("");
  const [scope, setScope] = useState("all");
  const [active, setActive] = useState(0);
  const [serverHits, setServerHits] = useState([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef(null);
  const listRef  = useRef(null);

  // Reset state every time the palette is (re)opened. The user expects a
  // clean slate — not whatever query was typed last time.
  useEffect(() => {
    if (!open) return;
    setQ("");
    setScope("all");
    setActive(0);
    setServerHits([]);
    // Autofocus the input. The Dialog primitive already traps focus but
    // defers to the user to move it; we want the cursor in the input so
    // typing works straight away.
    const t = setTimeout(() => inputRef.current?.focus(), 20);
    return () => clearTimeout(t);
  }, [open]);

  // Debounced server search. 150ms is brisk enough to feel live but slow
  // enough that rapid typing doesn't spam the RPC.
  useEffect(() => {
    if (!open) return;
    const query = q.trim();
    if (query.length < 2) {
      setServerHits([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const { data, error } = await api._supabase.rpc("pulse_global_search", {
          q: query, lim: 20,
        });
        if (cancelled) return;
        if (error) {
          console.warn("[PulseCommandPalette] search error:", error);
          setServerHits([]);
        } else {
          setServerHits(Array.isArray(data) ? data : []);
        }
      } catch (err) {
        if (!cancelled) {
          console.warn("[PulseCommandPalette] search threw:", err);
          setServerHits([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 150);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q, open]);

  // ── Build the unified row list ─────────────────────────────────────────
  // Order:
  //   1) Server entity hits (when there's a query)
  //   2) Nav entries matching the query (always)
  //   3) Local commands matching the query (always)
  // Each row carries { kind, label, sub?, onSelect }.
  const rows = useMemo(() => {
    const out = [];
    const query = q.trim();

    // Entity hits (filtered by scope)
    if (query.length >= 2) {
      for (const h of serverHits) {
        if (scope !== "all" && scope !== h.kind) continue;
        out.push({
          kind: h.kind,
          id: h.id,
          label: h.label,
          sub: h.sub,
          groupLabel: h.kind === "listing" ? "Listings"
                    : h.kind === "agent"   ? "Agents"
                    : "Agencies",
          onSelect: () => {
            onOpenEntity?.({ type: h.kind, id: h.id });
            onClose?.();
          },
        });
      }
    }

    // Navigation entries
    if (scope === "all" || scope === "nav") {
      for (const t of tabs) {
        const hay = `${t.label} ${t.value}`;
        if (!fuzzyMatch(hay, query)) continue;
        out.push({
          kind: "nav",
          id: t.value,
          label: `Go to ${t.label}`,
          sub: "Navigation",
          groupLabel: "Navigation",
          onSelect: () => {
            onNavigateTab?.(t.value);
            onClose?.();
          },
        });
      }
    }

    // Local commands
    if (scope === "all" || scope === "command") {
      for (const c of commands) {
        const hay = `${c.label} ${c.keywords || ""}`;
        if (!fuzzyMatch(hay, query)) continue;
        out.push({
          kind: "command",
          id: c.id,
          label: c.label,
          sub: c.sub || "Command",
          groupLabel: "Commands",
          onSelect: () => {
            try { c.onRun?.(); } finally { onClose?.(); }
          },
        });
      }
    }

    return out;
  }, [q, scope, serverHits, tabs, commands, onOpenEntity, onNavigateTab, onClose]);

  // Clamp the active index so the highlight doesn't fall off the end
  useEffect(() => {
    if (active >= rows.length) setActive(0);
  }, [rows.length, active]);

  // Group rows by groupLabel for section headings (purely visual).
  const grouped = useMemo(() => {
    const groups = [];
    let currentKey = null;
    let current = null;
    rows.forEach((r, idx) => {
      if (r.groupLabel !== currentKey) {
        currentKey = r.groupLabel;
        current = { label: r.groupLabel, items: [] };
        groups.push(current);
      }
      current.items.push({ ...r, index: idx });
    });
    return groups;
  }, [rows]);

  const onKeyDown = useCallback((e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(rows.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[active];
      if (row) row.onSelect();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose?.();
    } else if (e.key === "Tab") {
      e.preventDefault();
      const order = SCOPES.map(s => s.value);
      const idx = order.indexOf(scope);
      const next = order[(idx + (e.shiftKey ? -1 : 1) + order.length) % order.length];
      setScope(next);
    }
  }, [rows, active, onClose, scope]);

  // Scroll the active row into view as the user arrow-keys through results.
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector(`[data-row-idx="${active}"]`);
    if (el && typeof el.scrollIntoView === "function") {
      try { el.scrollIntoView({ block: "nearest" }); } catch { /* noop */ }
    }
  }, [active]);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose?.(); }}>
      <DialogContent
        className="p-0 max-w-xl top-[15%] translate-y-0 gap-0 overflow-hidden"
        onKeyDown={onKeyDown}
      >
        <DialogTitle className="sr-only">Pulse command palette</DialogTitle>

        {/* Input row */}
        <div className="flex items-center gap-2 px-3 py-2.5 border-b">
          <Search className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <Input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search listings, agents, agencies, commands…"
            className="h-8 border-0 shadow-none focus-visible:ring-0 px-0 text-sm"
            aria-label="Palette search"
          />
          {loading && (
            <span className="text-[10px] text-muted-foreground animate-pulse">searching…</span>
          )}
          <kbd className="hidden sm:inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] rounded border bg-muted/60 text-muted-foreground">
            Esc
          </kbd>
        </div>

        {/* Scope chips */}
        <div className="flex items-center gap-1 px-3 py-2 border-b overflow-x-auto">
          {SCOPES.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => setScope(s.value)}
              className={cn(
                "text-[11px] px-2 py-0.5 rounded-full border whitespace-nowrap transition-colors",
                scope === s.value
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-muted/40 text-muted-foreground border-transparent hover:bg-muted"
              )}
            >
              {s.label}
            </button>
          ))}
          <span className="ml-auto text-[10px] text-muted-foreground whitespace-nowrap hidden sm:inline">
            Tab to cycle
          </span>
        </div>

        {/* Result list */}
        <div
          ref={listRef}
          className="max-h-[360px] overflow-y-auto py-1"
          role="listbox"
          aria-label="Palette results"
        >
          {rows.length === 0 && (
            <div className="px-3 py-8 text-center text-xs text-muted-foreground">
              {q.trim().length < 2
                ? "Start typing to search — or browse navigation and commands."
                : "No matches."}
            </div>
          )}
          {grouped.map((group) => (
            <div key={group.label} className="pt-1">
              <div className="px-3 py-1 text-[9px] uppercase tracking-wider text-muted-foreground/70">
                {group.label}
              </div>
              {group.items.map((r) => {
                const Icon = kindIcon(r.kind);
                const isActive = r.index === active;
                return (
                  <button
                    key={`${r.kind}-${r.id}-${r.index}`}
                    type="button"
                    data-row-idx={r.index}
                    role="option"
                    aria-selected={isActive}
                    onMouseEnter={() => setActive(r.index)}
                    onClick={() => r.onSelect()}
                    className={cn(
                      "w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs",
                      isActive ? "bg-accent text-accent-foreground" : "text-foreground hover:bg-muted/40"
                    )}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="font-medium truncate flex-1">{r.label}</span>
                    {r.sub && (
                      <Badge
                        variant="outline"
                        className="text-[9px] px-1 py-0 font-normal tracking-normal truncate max-w-[12rem]"
                      >
                        {r.sub}
                      </Badge>
                    )}
                    {isActive && (
                      <span className="text-[9px] text-muted-foreground whitespace-nowrap">
                        ⏎
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* Footer help */}
        <div className="px-3 py-1.5 border-t flex items-center gap-3 text-[10px] text-muted-foreground">
          <span><kbd className="px-1 py-0.5 rounded border bg-muted/60">↑↓</kbd> navigate</span>
          <span><kbd className="px-1 py-0.5 rounded border bg-muted/60">⏎</kbd> select</span>
          <span><kbd className="px-1 py-0.5 rounded border bg-muted/60">Tab</kbd> scope</span>
          <span className="ml-auto">{rows.length} result{rows.length === 1 ? "" : "s"}</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
