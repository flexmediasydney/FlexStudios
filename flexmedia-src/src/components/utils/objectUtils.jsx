export function pick(obj, keys) {
  return keys.reduce((result, key) => {
    if (key in obj) result[key] = obj[key];
    return result;
  }, {});
}

export function omit(obj, keys) {
  return Object.keys(obj).reduce((result, key) => {
    if (!keys.includes(key)) result[key] = obj[key];
    return result;
  }, {});
}

export function merge(target, ...sources) {
  if (!sources.length) return target;
  const source = sources.shift();
  
  if (typeof target === "object" && typeof source === "object") {
    for (const key in source) {
      if (typeof source[key] === "object") {
        target[key] = merge(target[key] || {}, source[key]);
      } else {
        target[key] = source[key];
      }
    }
  }
  
  return merge(target, ...sources);
}

export function deepClone(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  if (obj instanceof Date) return new Date(obj.getTime());
  if (obj instanceof Array) return obj.map(item => deepClone(item));
  if (obj instanceof Object) {
    const cloned = {};
    for (let key in obj) {
      cloned[key] = deepClone(obj[key]);
    }
    return cloned;
  }
}

export function isEmpty(obj) {
  return Object.keys(obj).length === 0;
}

export function hasKey(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export function getNestedValue(obj, path) {
  return path.split(".").reduce((current, key) => current?.[key], obj);
}

export function setNestedValue(obj, path, value) {
  const keys = path.split(".");
  const lastKey = keys.pop();
  const target = keys.reduce((current, key) => (current[key] = current[key] || {}), obj);
  target[lastKey] = value;
  return obj;
}