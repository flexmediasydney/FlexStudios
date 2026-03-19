export function round(num, decimals = 2) {
  return Math.round(num * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

export function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

export function percentOf(num, total) {
  return round((num / total) * 100, 1);
}

export function isEven(num) {
  return num % 2 === 0;
}

export function isOdd(num) {
  return num % 2 !== 0;
}

export function isPrime(num) {
  if (num <= 1) return false;
  if (num <= 3) return true;
  if (num % 2 === 0 || num % 3 === 0) return false;
  for (let i = 5; i * i <= num; i += 6) {
    if (num % i === 0 || num % (i + 2) === 0) return false;
  }
  return true;
}

export function factorial(num) {
  if (num === 0 || num === 1) return 1;
  return num * factorial(num - 1);
}

export function sumArray(arr) {
  return arr.reduce((sum, n) => sum + n, 0);
}

export function averageArray(arr) {
  return arr.length ? round(sumArray(arr) / arr.length) : 0;
}

export function minArray(arr) {
  return Math.min(...arr);
}

export function maxArray(arr) {
  return Math.max(...arr);
}