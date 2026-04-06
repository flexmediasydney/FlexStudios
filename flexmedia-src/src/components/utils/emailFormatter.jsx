export function maskEmail(email) {
  if (!email || !email.includes("@")) return email || '';
  const [local, domain] = email.split("@");
  const masked = local.slice(0, 2) + "*".repeat(Math.max(0, local.length - 2)) + "@" + domain;
  return masked;
}

export function getEmailDomain(email) {
  if (!email || !email.includes("@")) return '';
  return email.split("@")[1];
}

export function isValidEmail(email) {
  if (!email) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function extractEmails(text) {
  if (!text) return [];
  const emailRegex = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
  return text.match(emailRegex) || [];
}