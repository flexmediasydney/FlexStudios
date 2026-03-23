/**
 * Centralized HTML sanitization for dangerouslySetInnerHTML usage.
 *
 * All sanitizers use regex-based stripping (no DOM dependency).
 * This is NOT a substitute for a library like DOMPurify, but provides
 * defense-in-depth against common XSS vectors in email bodies,
 * note content, and signature HTML rendered by this application.
 */

/**
 * Full sanitizer for untrusted HTML (email bodies, external content).
 * Strips: script, style, iframe, object, embed, applet, head, base, form,
 *         HTML comments, on* event handlers, javascript:/data:/vbscript: URIs.
 */
export function sanitizeEmailHtml(html) {
  if (!html) return '';
  let clean = html
    // Remove dangerous element blocks entirely (multiline-safe)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<iframe[\s\S]*?\/?>/gi, '')      // self-closing iframes
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[\s\S]*?\/?>/gi, '')
    .replace(/<applet[\s\S]*?<\/applet>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    // Remove HTML comments (can hide payloads from regex)
    .replace(/<!--[\s\S]*?-->/g, '')
    // Strip all on* event handler attributes (onclick, onload, onerror, etc.)
    .replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '')
    // Strip javascript:, data:, and vbscript: URI schemes from href, src, action
    .replace(/(href|src|action)\s*=\s*(?:"(?:javascript|data|vbscript):[^"]*"|'(?:javascript|data|vbscript):[^']*')/gi, 'href="#"')
    // Also catch unquoted URI schemes
    .replace(/(href|src|action)\s*=\s*(?:javascript|data|vbscript):[^\s>]*/gi, 'href="#"')
    // Strip <base> tags (can redirect all relative links)
    .replace(/<base\b[^>]*>/gi, '')
    // Strip <form> tags and their closing tags (phishing risk)
    .replace(/<\/?form\b[^>]*>/gi, '')
    // Strip <meta> tags (can trigger redirects via http-equiv)
    .replace(/<meta\b[^>]*>/gi, '');
  return clean;
}

/**
 * Sanitizer for semi-trusted HTML (internal notes, signatures).
 * Same protections as sanitizeEmailHtml.
 */
export function sanitizeDisplayHtml(html) {
  if (!html) return '';
  return sanitizeEmailHtml(html);
}

/**
 * Sanitizer for rich-text editor initialization.
 * Used when populating contentEditable elements with stored HTML.
 */
export function sanitizeEditorHtml(html) {
  if (!html) return '';
  return sanitizeEmailHtml(html);
}

/**
 * Validate a URL is safe to open (http/https only).
 * Returns the URL if valid, or null if suspicious.
 */
export function validateUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Safely open a URL in a new tab with noopener protection.
 * Only allows http/https URLs.
 */
export function safeWindowOpen(url) {
  const safe = validateUrl(url);
  if (safe) {
    window.open(safe, '_blank', 'noopener,noreferrer');
  }
}

/**
 * Sanitize a value for safe injection into a CSS property.
 * Strips characters that could break out of a CSS value context.
 */
export function sanitizeCssValue(value) {
  if (!value || typeof value !== 'string') return '';
  // Only allow typical CSS color/property characters
  return value.replace(/[^a-zA-Z0-9#(),.\-_%\s]/g, '');
}
