export function maskEmail(email) {
  if (!email) return "";
  const [local, domain] = email.split("@");
  if (!local || !domain) return email;
  const masked = local.slice(0, 2) + "*".repeat(Math.max(0, local.length - 2)) + "@" + domain;
  return masked;
}

export function getEmailDomain(email) {
  if (!email) return "";
  return email.split("@")[1] || "";
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function extractEmails(text) {
  const emailRegex = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
  return text.match(emailRegex) || [];
}