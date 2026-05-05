import { useState, useEffect } from "react";
// useEffect is needed to persist card field selections to localStorage

export const ALL_CARD_FIELDS = [
  { id: "agency_name",    label: "Agency",        group: "Client" },
  { id: "agent_name",     label: "Agent",         group: "Client" },
  { id: "shoot_date",     label: "Shoot Date",    group: "Schedule" },
  { id: "shoot_time",     label: "Shoot Time",    group: "Schedule" },
  { id: "delivery_date",  label: "Delivery Date", group: "Schedule" },
  { id: "price",          label: "Price",         group: "Finance",  requiresPricing: true },
  { id: "priority",       label: "Priority",      group: "Details" },
  { id: "property_type",  label: "Property Type", group: "Details" },
  { id: "products",       label: "Products",      group: "Details" },
  { id: "packages",       label: "Packages",      group: "Details" },
  { id: "status_timer",   label: "Status Timer",  group: "Details" },
  { id: "tasks",          label: "Active Tasks",  group: "Details" },
  { id: "product_category_tasks", label: "Task Progress", group: "Details" },
  { id: "requests",       label: "Requests",      group: "Details" },
  { id: "outcome",        label: "Outcome",       group: "Details" },
  { id: "payment_status", label: "Payment",       group: "Finance" },
  { id: "partially_delivered", label: "Partially Delivered", group: "Details" },
  { id: "notes",          label: "Notes",         group: "Details" },
  { id: "delivery_link",  label: "Delivery Link", group: "Details" },
  { id: "effort",         label: "Effort (Actual / Est.)", group: "Details" },
];

// Default: enabled field IDs in display order
const DEFAULT_ENABLED = [
  "agency_name", "agent_name", "shoot_date", "price", "priority", "status_timer", "tasks", "requests"
];

const STORAGE_KEY = "project_card_fields_v2";

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