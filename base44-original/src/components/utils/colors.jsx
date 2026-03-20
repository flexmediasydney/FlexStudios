export const colorPalette = {
  primary: "#3b82f6",
  secondary: "#8b5cf6",
  success: "#10b981",
  error: "#ef4444",
  warning: "#f59e0b",
  info: "#0ea5e9",
};

export function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}` : null;
}

export function rgbToHex(r, g, b) {
  return "#" + [r, g, b].map(x => {
    const hex = x.toString(16);
    return hex.length === 1 ? "0" + hex : hex;
  }).join("");
}

export function getContrastColor(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return "#000000";
  const [r, g, b] = rgb.split(", ").map(Number);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? "#000000" : "#ffffff";
}