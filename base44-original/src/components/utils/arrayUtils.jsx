export function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

export function flatten(array) {
  return array.reduce((flat, item) => {
    return flat.concat(Array.isArray(item) ? flatten(item) : item);
  }, []);
}

export function unique(array, key) {
  return key
    ? Array.from(new Map(array.map(item => [item[key], item])).values())
    : [...new Set(array)];
}

export function groupBy(array, key) {
  return array.reduce((result, item) => {
    const group = item[key];
    if (!result[group]) result[group] = [];
    result[group].push(item);
    return result;
  }, {});
}

export function sortBy(array, key, ascending = true) {
  return [...array].sort((a, b) => {
    if (a[key] < b[key]) return ascending ? -1 : 1;
    if (a[key] > b[key]) return ascending ? 1 : -1;
    return 0;
  });
}

export function findDuplicates(array) {
  return array.filter((item, idx) => array.indexOf(item) !== idx);
}

export function difference(a, b) {
  return a.filter(item => !b.includes(item));
}

export function intersection(a, b) {
  return a.filter(item => b.includes(item));
}