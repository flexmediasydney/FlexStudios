export function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

export function titleCase(str) {
  if (!str) return '';
  return str.replace(/\w\S*/g, txt => capitalize(txt));
}

export function camelCase(str) {
  if (!str) return '';
  return str.replace(/(?:^\w|[A-Z]|\b\w)/g, (word, idx) => {
    return idx === 0 ? word.toLowerCase() : word.toUpperCase();
  }).replace(/\s+/g, "");
}

export function snakeCase(str) {
  if (!str) return '';
  return str.toLowerCase().replace(/\s+/g, "_");
}

export function slugify(str) {
  if (!str) return '';
  return str.toLowerCase().replace(/\s+/g, "-").replace(/[^\w-]+/g, "");
}

export function truncate(str, length = 50, suffix = "...") {
  if (!str) return '';
  return str.length > length ? str.slice(0, length) + suffix : str;
}

export function reverse(str) {
  if (!str) return '';
  return str.split("").reverse().join("");
}

export function isPalindrome(str) {
  if (!str) return true;
  const clean = str.toLowerCase().replace(/[^\w]/g, "");
  return clean === reverse(clean);
}

export function countWords(str) {
  if (!str || !str.trim()) return 0;
  return str.trim().split(/\s+/).length;
}

export function removeDuplicateWords(str) {
  if (!str) return '';
  return [...new Set(str.split(/\s+/))].join(" ");
}