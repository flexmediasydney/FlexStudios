/**
 * Shared form validation utilities for all forms in the app.
 */

export const LIMITS = {
  name: 120,
  address: 255,
  phone: 30,
  email: 100,
  url: 500,
  title: 255,
  notes: 2000,
  description: 1000,
  code: 50,
  short: 80,
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[+\d\s\-().]{5,30}$/;
const URL_RE = /^https?:\/\/.+/;

/** Strip leading/trailing whitespace from all string values in an object */
export function trimFormData(data) {
  return Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, typeof v === "string" ? v.trim() : v])
  );
}

/** Returns an error string or "" */
export function validateField(name, value) {
  if (value === null || value === undefined) return "";
  const v = typeof value === "string" ? value.trim() : value;

  // Required fields
  if (["name", "agent_name", "agency_name", "title", "property_address"].includes(name)) {
    if (!v) return "This field is required";
  }

  // Length limits
  const limit = LIMITS[name] || LIMITS[fieldToCategory(name)];
  if (limit && typeof v === "string" && v.length > limit) {
    return `Maximum ${limit} characters`;
  }

  // Format validation
  if ((name === "email" || name === "agent_email") && v) {
    if (!EMAIL_RE.test(v)) return "Enter a valid email address";
  }
  if ((name === "phone" || name === "agent_phone") && v) {
    if (!PHONE_RE.test(v)) return "Enter a valid phone number";
  }
  if ((name === "delivery_link" || name === "dropbox_link") && v) {
    if (!URL_RE.test(v)) return "Enter a valid URL (must start with https://)";
  }
  if (name === "price" && v !== "" && v !== null && v !== undefined) {
    const num = Number(v);
    if (isNaN(num) || num < 0) return "Enter a valid positive number";
    if (num > 999999) return "Price seems too large";
  }

  return "";
}

function fieldToCategory(name) {
  if (name.includes("email")) return "email";
  if (name.includes("phone")) return "phone";
  if (name.includes("address")) return "address";
  if (name.includes("note")) return "notes";
  if (name.includes("description")) return "description";
  if (name.includes("url") || name.includes("link")) return "url";
  if (name.includes("name")) return "name";
  return "short";
}

/** Validate all fields in a form object. Returns { field: errorString } */
export function validateForm(data) {
  const errors = {};
  Object.entries(data).forEach(([key, val]) => {
    const err = validateField(key, val);
    if (err) errors[key] = err;
  });
  return errors;
}

/** Returns true if there are no errors */
export function isFormValid(errors) {
  return Object.values(errors).every(e => !e);
}