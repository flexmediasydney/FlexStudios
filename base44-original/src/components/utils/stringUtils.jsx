export function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

export function titleCase(str) {
  return str.replace(/\w\S*/g, txt => capitalize(txt));
}

export function camelCase(str) {
  return str.replace(/(?:^\w|[A-Z]|\b\w)/g, (word, idx) => {
    return idx === 0 ? word.toLowerCase() : word.toUpperCase();
  }).replace(/\s+/g, "");
}

export function snakeCase(str) {
  return str.toLowerCase().replace(/\s+/g, "_");
}

export function slugify(str) {
  return str.toLowerCase().replace(/\s+/g, "-").replace(/[^\w-]+/g, "");
}

export function truncate(str, length = 50, suffix = "...") {
  return str.length > length ? str.slice(0, length) + suffix : str;
}

export function reverse(str) {
  return str.split("").reverse().join("");
}

export function isPalindrome(str) {
  const clean = str.toLowerCase().replace(/[^\w]/g, "");
  return clean === reverse(clean);
}

export function countWords(str) {
  return str.trim().split(/\s+/).length;
}

export function removeDuplicateWords(str) {
  return [...new Set(str.split(/\s+/))].join(" ");
}