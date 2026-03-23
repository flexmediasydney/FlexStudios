export function formatCurrency(amount, currency = "USD") {
  // BUG FIX: guard against null, undefined, NaN — all produced "$NaN" or "$0.00"
  if (amount == null || typeof amount !== 'number' || isNaN(amount)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(amount);
}

export function formatPercent(value, decimals = 1) {
  // BUG FIX: parseFloat(null/undefined) → NaN → "NaN%"
  const num = parseFloat(value);
  if (isNaN(num)) return "—";
  return `${num.toFixed(decimals)}%`;
}

export function formatNumber(value) {
  // BUG FIX: null/undefined/NaN produced "NaN" string
  if (value == null || (typeof value === 'number' && isNaN(value))) return "—";
  const num = Number(value);
  if (isNaN(num)) return "—";
  return new Intl.NumberFormat("en-US").format(num);
}

export function formatBytes(bytes) {
  // BUG FIX: null/NaN/negative produced "NaN B" or infinite loop (negative)
  if (bytes == null || isNaN(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

export function formatDate(date) {
  // BUG FIX: null/undefined caused Invalid Date crash; no timezone
  if (!date) return "—";
  try {
    const d = new Date(date);
    if (isNaN(d.getTime())) return "—";
    return new Intl.DateTimeFormat("en-US").format(d);
  } catch { return "—"; }
}

export function formatTime(date) {
  // BUG FIX: null/undefined caused Invalid Date crash
  if (!date) return "—";
  try {
    const d = new Date(date);
    if (isNaN(d.getTime())) return "—";
    return new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(d);
  } catch { return "—"; }
}

export function formatDatetime(date) {
  // BUG FIX: null/undefined caused Invalid Date crash
  if (!date) return "—";
  try {
    const d = new Date(date);
    if (isNaN(d.getTime())) return "—";
    return new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
  } catch { return "—"; }
}

export function formatDuration(seconds) {
  // BUG FIX: null/undefined/NaN/negative all crashed or produced garbage
  if (seconds == null || isNaN(seconds) || seconds < 0) return "—";
  seconds = Math.floor(seconds);
  if (seconds === 0) return "0s";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`.replace(/\b0\w+\s?/g, "").trim() || "0s";
}

export function formatPhone(phone) {
  // BUG FIX: null/undefined caused TypeError on .replace()
  if (!phone || typeof phone !== 'string') return "—";
  const cleaned = phone.replace(/\D/g, "");
  if (cleaned.length === 10) return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6)}`;
  return phone;
}