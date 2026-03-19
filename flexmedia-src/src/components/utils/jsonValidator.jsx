export function validateJSON(str) {
  try {
    JSON.parse(str);
    return { valid: true, error: null };
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

export function prettifyJSON(str, indent = 2) {
  try {
    return JSON.stringify(JSON.parse(str), null, indent);
  } catch {
    return str;
  }
}

export function minifyJSON(str) {
  try {
    return JSON.stringify(JSON.parse(str));
  } catch {
    return str;
  }
}

export function getJSONSize(obj) {
  return new Blob([JSON.stringify(obj)]).size;
}