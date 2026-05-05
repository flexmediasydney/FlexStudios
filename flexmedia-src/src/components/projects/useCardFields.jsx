import { useState, useEffect } from "react";
// useEffect is needed to persist card field selections to localStorage

export const ALL_CARD_FIELDS = [
  { id: "agency_agent",   label: "Agency / Agent",       group: "Client" },
  { id: "products_packages", label: "Products & Packages", group: "Details" },
  { id: "price",          label: "Price",                group: "Finance", requiresPricing: true },
  { id: "product_category_tasks", label: "Task Progress", group: "Details" },
  { id: "payment_status", label: "Payment",              group: "Finance" },
  { id: "partially_delivered", label: "Partially Delivered", group: "Details" },
  { id: "effort",         label: "Effort (Actual / Est.)", group: "Details" },
  { id: "shoot",          label: "Shoot Date & Time",    group: "Schedule" },
];

// Default: enabled field IDs in display order. `shoot` is intentionally last
// so the combined date+time row sits at the bottom of the card.
const DEFAULT_ENABLED = [
  "agency_agent", "products_packages", "price", "product_category_tasks", "payment_status", "effort", "shoot"
];

// v4: dropped Priority / Requests / Active Tasks / Property Type / Status
// Timer from card field options. Bumped so users get the new defaults
// instead of stale field IDs that no longer render anything.
const STORAGE_KEY = "project_card_fields_v4";

export function useCardFields() {
  // Store ONLY the ordered list of enabled IDs.
  // The order is exactly as the user arranged it.
  // Bug fix: persist to localStorage so customizations survive navigation.
  const [enabledFields, setEnabledFields] = useState(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {}
    return DEFAULT_ENABLED;
  });

  // Sync to localStorage whenever enabledFields changes
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(enabledFields));
    } catch {}
  }, [enabledFields]);

  const toggleField = (id) => {
    setEnabledFields(prev => {
      if (prev.includes(id)) {
        return prev.filter(f => f !== id);
      } else {
        // Append to end when enabling
        return [...prev, id];
      }
    });
  };

  // Accept a fully-reordered list of enabled IDs
  const reorderFields = (newOrder) => setEnabledFields(newOrder);

  const isEnabled = (id) => enabledFields.includes(id);

  // enabledFields is already in user-defined display order — return as-is
  return { enabledFields, toggleField, reorderFields, isEnabled };
}