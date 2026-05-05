import { useSyncExternalStore, useCallback } from "react";

export const ALL_CARD_FIELDS = [
  // ID stays `agency_agent` so users' existing v4 storage keeps this field
  // enabled — the rename is purely the user-facing label.
  { id: "agency_agent",   label: "Person and Organisation", group: "Client" },
  { id: "products_packages", label: "Products & Packages", group: "Details" },
  { id: "price",          label: "Price",                group: "Finance", requiresPricing: true },
  { id: "product_category_tasks", label: "Task Progress", group: "Details" },
  { id: "payment_status", label: "Payment",              group: "Finance" },
  { id: "pricing_tier",   label: "Pricing Tier",         group: "Finance" },
  { id: "partially_delivered", label: "Partially Delivered", group: "Details" },
  { id: "effort",         label: "Effort (Actual / Est.)", group: "Details" },
  { id: "shoot",          label: "Shoot Date & Time",    group: "Schedule" },
];

// Default: enabled field IDs in display order. The card renderer collapses
// adjacent same-row groups (payment_status / pricing_tier / price into a
// "money strip", and effort / shoot into a date+effort row), so the order
// here is what users see by default. shoot stays last to anchor the card.
const DEFAULT_ENABLED = [
  "agency_agent", "products_packages", "payment_status", "pricing_tier", "price", "product_category_tasks", "effort", "shoot"
];

// v6: payment_status, pricing_tier, price now render as a single horizontal
// "money strip" row, and effort + shoot share a row. Default order updated
// to put each group's members adjacent. Storage key bumped so users pick
// up the new layout instead of inheriting the old single-line-per-field
// ordering.
const STORAGE_KEY = "project_card_fields_v6";

// ─── Module-level shared store ─────────────────────────────────────────────
// Why not plain useState: every consumer (CardFieldsCustomizer, KanbanBoard,
// dashboard ProjectCard, AgencyProjectsTab, Projects list) used to get its
// own useState copy. Toggling a field in the customizer only flipped the
// customizer's state; the kanban kept its stale copy and didn't re-render
// until a full page reload. Hoisting the state into a module-level store
// with useSyncExternalStore lets every hook instance subscribe to a single
// source of truth, so a toggle anywhere fans out to every card on screen.

function readInitial() {
  if (typeof window === "undefined") return DEFAULT_ENABLED;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {}
  return DEFAULT_ENABLED;
}

let _state = readInitial();
const _listeners = new Set();

function emit() {
  for (const l of _listeners) l();
}

function setState(next) {
  if (next === _state) return;
  _state = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {}
  emit();
}

// Cross-tab sync: a write in another tab fires the `storage` event with the
// raw new value. Pull it into our in-memory store so the second tab's cards
// re-render without waiting for a manual reload. localStorage writes from
// THIS tab don't fire `storage` here, so there's no echo loop.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY || e.newValue == null) return;
    try {
      const parsed = JSON.parse(e.newValue);
      if (Array.isArray(parsed) && parsed.length > 0) {
        _state = parsed;
        emit();
      }
    } catch {}
  });
}

function subscribe(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

function getSnapshot() {
  return _state;
}

export function useCardFields() {
  const enabledFields = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const toggleField = useCallback((id) => {
    const prev = _state;
    setState(prev.includes(id) ? prev.filter(f => f !== id) : [...prev, id]);
  }, []);

  // Accept a fully-reordered list of enabled IDs
  const reorderFields = useCallback((newOrder) => {
    setState(newOrder);
  }, []);

  const isEnabled = useCallback((id) => enabledFields.includes(id), [enabledFields]);

  // enabledFields is already in user-defined display order — return as-is
  return { enabledFields, toggleField, reorderFields, isEnabled };
}
