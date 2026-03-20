export function maskEmail(email) {
  const [local, domain] = email.split("@");
  const masked = local.slice(0, 2) + "*".repeat(local.length - 2) + "@" + domain;
  return masked;
}

export function getEmailDomain(email) {
  return email.split("@")[1];
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function extractEmails(text) {
  const emailRegex = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
  return text.match(emailRegex) || [];
}