export function isEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function isUrl(url) {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

export function isPhoneNumber(phone) {
  return /^\d{10,15}$/.test(phone.replace(/\D/g, ""));
}

export function isStrongPassword(password) {
  return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/.test(password);
}

export function isEmpty(value) {
  return !value || (typeof value === "string" && value.trim() === "") || (Array.isArray(value) && value.length === 0);
}

export function isValidJSON(str) {
  try {
    JSON.parse(str);
    return true;
  } catch {
    return false;
  }
}