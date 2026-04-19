//
// pulseShell — small support primitives for IndustryPulse
// =======================================================
// Housekeeping utilities that don't each warrant a separate module:
//
//   * useKeyboardShortcuts  — global hotkey layer (⌘K, g-prefix, ?, n/p, Esc)
//   * useDensity            — persisted Comfortable/Compact/Dense class
//   * DensityToggle         — tiny 3-way toggle button
//   * usePulseUrl           — typed getter/setter over the query string
//   * LoadingSkeleton       — whole-page skeleton for initial mount
//   * TabBodySkeleton       — per-tab skeleton (table / grid / strip shapes)
//

import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger,
  DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { LayoutPanelTop } from "lucide-react";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────
// Density
// ─────────────────────────────────────────────────────────────────────────
// The shell reads the active density value and applies a corresponding
// class to the root container; Tailwind utilities in tab components can
// opt into tighter spacing via `group-[.density-compact]:py-1` patterns.
// To keep this broad-reaching without touching every tab, we also toggle
// a couple of data-attributes and CSS custom properties on the root.

const DENSITY_STORAGE_KEY = "industryPulse.density";
const DENSITY_VALUES = ["comfortable", "compact", "dense"];

function readStoredDensity() {
  try {
    const v = localStorage.getItem(DENSITY_STORAGE_KEY);
    if (DENSITY_VALUES.includes(v)) return v;
  } catch { /* noop */ }
  return "comfortable";
}

export function useDensity() {
  const [density, setDensityState] = useState(readStoredDensity);
  const setDensity = useCallback((next) => {
    if (!DENSITY_VALUES.includes(next)) return;
    setDensityState(next);
    try { localStorage.setItem(DENSITY_STORAGE_KEY, next); } catch { /* noop */ }
  }, []);
  const className = useMemo(() => `density-${density}`, [density]);
  return { density, setDensity, className };
}

export function DensityToggle({ density, onChange }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 px-2 text-xs gap-1.5"
          aria-label="Change density"
          title="Density"
        >
          <LayoutPanelTop className="h-3.5 w-3.5" />
          <span className="hidden md:inline capitalize">{density}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wider">
          Density
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={density} onValueChange={onChange}>
          <DropdownMenuRadioItem value="comfortable" className="text-xs">
            Comfortable
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="compact" className="text-xs">
            Compact
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dense" className="text-xs">
            Dense
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Keyboard shortcut layer
// ─────────────────────────────────────────────────────────────────────────
// Handles every shortcut in the IndustryPulse brief:
//
//   ⌘K / Ctrl+K     → openPalette()
//   /               → focusSearch() (falls through to openPalette if no search)
//   ?               → showHelp()
//   g <x>           → goto tab (chord — first g, then letter within 1.2s)
//   n / p           → next / prev tab
//   Esc             → closeOverlays() — slideout / dialog / palette
//
// Tab-letter map is passed in so the shell owns the mapping and can
// customise it per environment (e.g. future labels).

function isEditable(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return false;
}

export function useKeyboardShortcuts({
  tabs,
  tabLetterMap,
  currentTab,
  onChangeTab,
  onOpenPalette,
  onFocusSearch,
  onShowHelp,
  onCloseOverlays,
}) {
  // Track pending g-chord state. Timer clears automatically after 1.2s
  // so users don't end up stuck in chord mode.
  const gPendingRef = useRef(false);
  const gTimerRef = useRef(null);

  useEffect(() => {
    const clearG = () => {
      gPendingRef.current = false;
      if (gTimerRef.current) { clearTimeout(gTimerRef.current); gTimerRef.current = null; }
    };

    const onKey = (e) => {
      // ── Always-on (even inside inputs) ──
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpenPalette?.();
        return;
      }
      if (e.key === "Escape") {
        // Don't preventDefault — native Radix dismiss handling still wants
        // the bubble — but invoke our own close chain too. Many overlays
        // listen to this themselves (Sheet, Dialog), so this is a belt-
        // and-braces path for custom slideouts.
        onCloseOverlays?.();
        return;
      }

      // ── Suppress the rest while typing in an input ──
      if (isEditable(document.activeElement)) return;
      // Don't hijack OS-level modifier combinations (Cmd+1 etc).
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // ── `/` — focus quick search (or fall back to palette) ──
      if (e.key === "/") {
        e.preventDefault();
        if (onFocusSearch && onFocusSearch()) return;
        onOpenPalette?.();
        return;
      }

      // ── `?` — help sheet. Note: requires shift on most keyboards, hence
      // we match on the logical key value rather than a keycode.
      if (e.key === "?") {
        e.preventDefault();
        onShowHelp?.();
        return;
      }

      // ── g-chord — first `g`, then letter ──
      if (e.key === "g" || e.key === "G") {
        e.preventDefault();
        gPendingRef.current = true;
        if (gTimerRef.current) clearTimeout(gTimerRef.current);
        gTimerRef.current = setTimeout(clearG, 1200);
        return;
      }
      if (gPendingRef.current) {
        const target = tabLetterMap?.[e.key.toLowerCase()];
        clearG();
        if (target) {
          e.preventDefault();
          onChangeTab?.(target);
          return;
        }
      }

      // ── n / p — next / prev tab ──
      if (e.key === "n" || e.key === "p") {
        const values = tabs.map((t) => t.value);
        const idx = values.indexOf(currentTab);
        if (idx < 0) return;
        const delta = e.key === "n" ? 1 : -1;
        const next = values[(idx + delta + values.length) % values.length];
        e.preventDefault();
        onChangeTab?.(next);
        return;
      }

      // ── 1-9, 0, - (legacy) ──
      let idx = -1;
      if (e.key >= "1" && e.key <= "9") idx = parseInt(e.key, 10) - 1;
      else if (e.key === "0") idx = 9;
      else if (e.key === "-") idx = 10;
      if (idx >= 0 && idx < tabs.length) {
        e.preventDefault();
        onChangeTab?.(tabs[idx].value);
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (gTimerRef.current) clearTimeout(gTimerRef.current);
    };
  }, [tabs, tabLetterMap, currentTab, onChangeTab, onOpenPalette, onFocusSearch, onShowHelp, onCloseOverlays]);
}

// ─────────────────────────────────────────────────────────────────────────
// usePulseUrl — typed query-param getter/setter
// ─────────────────────────────────────────────────────────────────────────
// One source of truth for every ?param= the IndustryPulse shell + tabs read.
// Keys added here coexist cleanly with the existing ones — setting one
// never blows away the others. String values only; consumers parse to number
// / bool as needed.

const PULSE_PARAM_KEYS = [
  // legacy shell params
  "tab", "pulse_id", "entity_type", "drill_log", "drill_tab", "sync_log_id",
  "q", "suburb", "agency", "page", "sort", "slideout_tab", "type",
  // new per-tab view params (owned by individual tabs — the shell just
  // guarantees they round-trip unchanged)
  "listings_view", "agents_view", "agencies_view", "events_view",
  "market_window", "range",
];

export function usePulseUrl() {
  const [searchParams, setSearchParams] = useSearchParams();

  const get = useCallback((key) => {
    return searchParams.get(key);
  }, [searchParams]);

  const set = useCallback((patch, opts = {}) => {
    setSearchParams((prev) => {
      const np = new URLSearchParams(prev);
      Object.entries(patch).forEach(([k, v]) => {
        if (v === null || v === undefined || v === "") np.delete(k);
        else np.set(k, String(v));
      });
      return np;
    }, { replace: opts.replace !== false });
  }, [setSearchParams]);

  const clear = useCallback((keys) => {
    setSearchParams((prev) => {
      const np = new URLSearchParams(prev);
      (keys || []).forEach((k) => np.delete(k));
      return np;
    }, { replace: true });
  }, [setSearchParams]);

  return { get, set, clear, searchParams };
}

// Exported for tests / docs
usePulseUrl.KNOWN_KEYS = PULSE_PARAM_KEYS;

// ─────────────────────────────────────────────────────────────────────────
// Loading skeletons
// ─────────────────────────────────────────────────────────────────────────

export function LoadingSkeleton() {
  return (
    <div className="px-4 pt-3 pb-4 lg:px-6 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Skeleton className="h-5 w-5 rounded" />
          <Skeleton className="h-6 w-36" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-8 w-24" />
        </div>
      </div>
      {/* Stats strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-[62px] rounded-xl" />
        ))}
      </div>
      {/* Tab bar */}
      <Skeleton className="h-9 w-full rounded-lg" />
      {/* Content area */}
      <Skeleton className="h-64 rounded-xl" />
    </div>
  );
}

// Per-tab skeleton — renders a shape appropriate to the tab's primary
// layout. Shell passes `shape` = "table" | "grid" | "strip" | "timeline".
export function TabBodySkeleton({ shape = "table" }) {
  if (shape === "grid") {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {Array.from({ length: 9 }).map((_, i) => (
          <Skeleton key={i} className="h-36 rounded-xl" />
        ))}
      </div>
    );
  }
  if (shape === "strip") {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-16 rounded-xl" />
        ))}
      </div>
    );
  }
  if (shape === "timeline") {
    return (
      <div className="space-y-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-start gap-3">
            <Skeleton className="h-6 w-6 rounded-full shrink-0 mt-0.5" />
            <div className="flex-1 space-y-1">
              <Skeleton className="h-3 w-2/3" />
              <Skeleton className="h-2.5 w-1/3" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  // default: table rows
  return (
    <div className="rounded-xl border overflow-hidden">
      <Skeleton className="h-9 rounded-none" />
      <div className="divide-y">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="px-3 py-2 flex items-center gap-3">
            <Skeleton className="h-3 w-1/4" />
            <Skeleton className="h-3 w-1/5" />
            <Skeleton className="h-3 w-1/6" />
            <Skeleton className="h-3 w-1/5 ml-auto" />
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Shell context — exposes useful bits to tabs without prop-drilling
// ─────────────────────────────────────────────────────────────────────────
// Lightweight: just the shell's density + palette-open dispatcher so tab
// components (when they want) can trigger "open palette" from a toolbar
// button without passing another prop. Optional consumer — any tab that
// doesn't import this continues to behave as before.

const PulseShellContext = createContext(null);

export function PulseShellProvider({ value, children }) {
  return (
    <PulseShellContext.Provider value={value}>
      {children}
    </PulseShellContext.Provider>
  );
}

export function usePulseShell() {
  return useContext(PulseShellContext);
}

// Small helper used by the shell to decide whether to scope the density
// class to a wrapping <div>. The density CSS lives in index.css (under
// `.density-compact` / `.density-dense` rules) so Tailwind JIT doesn't have
// to parse arbitrary-selector variants with escaped decimals. The wrapper
// just reports the class without further variant gymnastics — retained as
// a no-op for a stable API while a richer density strategy rolls in.
export function densityWrapperCls(_density) {
  return "";
}
