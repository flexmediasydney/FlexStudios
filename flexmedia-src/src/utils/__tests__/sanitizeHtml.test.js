import { describe, it, expect, vi } from 'vitest';
import {
  sanitizeEmailHtml,
  sanitizeDisplayHtml,
  sanitizeEditorHtml,
  validateUrl,
  safeWindowOpen,
  sanitizeCssValue,
} from '../sanitizeHtml';

// ─── sanitizeEmailHtml ───────────────────────────────────────────────────────

describe('sanitizeEmailHtml', () => {
  it('returns empty string for null/undefined/empty', () => {
    expect(sanitizeEmailHtml(null)).toBe('');
    expect(sanitizeEmailHtml(undefined)).toBe('');
    expect(sanitizeEmailHtml('')).toBe('');
  });

  it('passes through safe HTML unchanged', () => {
    const safe = '<p>Hello <strong>world</strong></p>';
    expect(sanitizeEmailHtml(safe)).toBe(safe);
  });

  // Script removal
  it('strips <script> tags and their content', () => {
    const input = '<p>Hello</p><script>alert("xss")</script><p>World</p>';
    const result = sanitizeEmailHtml(input);
    expect(result).not.toContain('script');
    expect(result).not.toContain('alert');
    expect(result).toContain('<p>Hello</p>');
    expect(result).toContain('<p>World</p>');
  });

  it('strips multiline script tags', () => {
    const input = '<script\ntype="text/javascript">\nvar x = 1;\n</script>';
    expect(sanitizeEmailHtml(input)).not.toContain('script');
  });

  // Style removal
  it('strips <style> tags and their content', () => {
    const input = '<style>body { display: none; }</style><p>Content</p>';
    const result = sanitizeEmailHtml(input);
    expect(result).not.toContain('style');
    expect(result).toContain('<p>Content</p>');
  });

  // Iframe removal
  it('strips <iframe> tags', () => {
    const input = '<iframe src="https://evil.com"></iframe>';
    expect(sanitizeEmailHtml(input)).not.toContain('iframe');
  });

  it('strips self-closing iframes', () => {
    const input = '<iframe src="https://evil.com" />';
    expect(sanitizeEmailHtml(input)).not.toContain('iframe');
  });

  // Object/Embed/Applet removal
  it('strips <object> tags', () => {
    const input = '<object data="malware.swf"></object>';
    expect(sanitizeEmailHtml(input)).not.toContain('object');
  });

  it('strips <embed> tags', () => {
    const input = '<embed src="malware.swf" />';
    expect(sanitizeEmailHtml(input)).not.toContain('embed');
  });

  it('strips <applet> tags', () => {
    const input = '<applet code="Evil.class"></applet>';
    expect(sanitizeEmailHtml(input)).not.toContain('applet');
  });

  // Head removal
  it('strips <head> blocks', () => {
    const input = '<head><title>Phishing</title></head><body>Content</body>';
    const result = sanitizeEmailHtml(input);
    expect(result).not.toContain('head');
    expect(result).not.toContain('Phishing');
  });

  // HTML comment removal
  it('strips HTML comments', () => {
    const input = '<!-- hidden payload --><p>Visible</p>';
    const result = sanitizeEmailHtml(input);
    expect(result).not.toContain('<!--');
    expect(result).not.toContain('hidden payload');
    expect(result).toContain('<p>Visible</p>');
  });

  // Event handler removal
  it('strips onclick event handlers', () => {
    const input = '<a href="#" onclick="steal()">Click</a>';
    const result = sanitizeEmailHtml(input);
    expect(result).not.toContain('onclick');
    expect(result).not.toContain('steal');
    expect(result).toContain('Click');
  });

  it('strips onerror event handlers', () => {
    const input = '<img src="x" onerror="alert(1)">';
    const result = sanitizeEmailHtml(input);
    expect(result).not.toContain('onerror');
    expect(result).not.toContain('alert');
  });

  it('strips onload event handlers', () => {
    const input = '<body onload="malicious()">';
    const result = sanitizeEmailHtml(input);
    expect(result).not.toContain('onload');
    expect(result).not.toContain('malicious');
  });

  it('strips onmouseover event handlers', () => {
    const input = '<div onmouseover="attack()">Hover</div>';
    const result = sanitizeEmailHtml(input);
    expect(result).not.toContain('onmouseover');
    expect(result).not.toContain('attack');
  });

  // JavaScript URI removal
  it('strips javascript: URIs in href', () => {
    const input = '<a href="javascript:alert(1)">Link</a>';
    const result = sanitizeEmailHtml(input);
    expect(result).not.toContain('javascript:');
  });

  it('strips data: URIs in href', () => {
    const input = '<a href="data:text/html,<script>alert(1)</script>">Link</a>';
    const result = sanitizeEmailHtml(input);
    expect(result).not.toContain('data:text');
  });

  it('strips vbscript: URIs', () => {
    const input = '<a href="vbscript:MsgBox">Link</a>';
    const result = sanitizeEmailHtml(input);
    expect(result).not.toContain('vbscript:');
  });

  it('strips javascript: URIs in src attributes', () => {
    const input = '<img src="javascript:alert(1)">';
    const result = sanitizeEmailHtml(input);
    expect(result).not.toContain('javascript:');
  });

  // Base tag removal
  it('strips <base> tags', () => {
    const input = '<base href="https://evil.com">';
    expect(sanitizeEmailHtml(input)).not.toContain('base');
  });

  // Form tag removal
  it('strips <form> tags', () => {
    const input = '<form action="https://phishing.com"><input></form>';
    const result = sanitizeEmailHtml(input);
    expect(result).not.toContain('form');
    expect(result).toContain('<input>');
  });

  // Meta tag removal
  it('strips <meta> tags', () => {
    const input = '<meta http-equiv="refresh" content="0;url=evil.com">';
    expect(sanitizeEmailHtml(input)).not.toContain('meta');
  });

  // Combined attack vectors
  it('handles multiple attack vectors in one input', () => {
    const input = [
      '<script>alert(1)</script>',
      '<p onclick="steal()">Hello</p>',
      '<a href="javascript:void(0)">Link</a>',
      '<!-- secret -->',
      '<iframe src="evil.com"></iframe>',
      '<style>* { display: none }</style>',
    ].join('');
    const result = sanitizeEmailHtml(input);
    expect(result).not.toContain('script');
    expect(result).not.toContain('onclick');
    expect(result).not.toContain('javascript:');
    expect(result).not.toContain('<!--');
    expect(result).not.toContain('iframe');
    expect(result).not.toContain('style');
    expect(result).toContain('Hello');
    expect(result).toContain('Link');
  });
});

// ─── sanitizeDisplayHtml ─────────────────────────────────────────────────────

describe('sanitizeDisplayHtml', () => {
  it('returns empty string for null', () => {
    expect(sanitizeDisplayHtml(null)).toBe('');
  });

  it('delegates to sanitizeEmailHtml (strips same vectors)', () => {
    const input = '<script>bad</script><p>Good</p>';
    expect(sanitizeDisplayHtml(input)).not.toContain('script');
    expect(sanitizeDisplayHtml(input)).toContain('<p>Good</p>');
  });
});

// ─── sanitizeEditorHtml ──────────────────────────────────────────────────────

describe('sanitizeEditorHtml', () => {
  it('returns empty string for null', () => {
    expect(sanitizeEditorHtml(null)).toBe('');
  });

  it('strips dangerous tags for editor initialization', () => {
    const input = '<p>Content</p><script>alert(1)</script>';
    const result = sanitizeEditorHtml(input);
    expect(result).toContain('<p>Content</p>');
    expect(result).not.toContain('script');
  });
});

// ─── validateUrl ─────────────────────────────────────────────────────────────

describe('validateUrl', () => {
  it('returns null for null/undefined/empty', () => {
    expect(validateUrl(null)).toBeNull();
    expect(validateUrl(undefined)).toBeNull();
    expect(validateUrl('')).toBeNull();
  });

  it('returns null for non-string inputs', () => {
    expect(validateUrl(123)).toBeNull();
  });

  it('returns the URL for valid http URLs', () => {
    const result = validateUrl('http://example.com');
    expect(result).toBe('http://example.com/');
  });

  it('returns the URL for valid https URLs', () => {
    const result = validateUrl('https://example.com/path?q=1');
    expect(result).toBe('https://example.com/path?q=1');
  });

  it('returns null for javascript: protocol', () => {
    expect(validateUrl('javascript:alert(1)')).toBeNull();
  });

  it('returns null for data: protocol', () => {
    expect(validateUrl('data:text/html,<h1>Hi</h1>')).toBeNull();
  });

  it('resolves relative URLs against window.location.origin', () => {
    const result = validateUrl('/path/to/page');
    // Should resolve to http://localhost/path/to/page in test env
    expect(result).toBeTruthy();
    expect(result).toContain('/path/to/page');
  });
});

// ─── safeWindowOpen ──────────────────────────────────────────────────────────

describe('safeWindowOpen', () => {
  it('calls window.open for valid https URLs with noopener', () => {
    const mockOpen = vi.fn();
    vi.stubGlobal('open', mockOpen);

    safeWindowOpen('https://example.com');
    expect(mockOpen).toHaveBeenCalledWith(
      'https://example.com/',
      '_blank',
      'noopener,noreferrer'
    );

    vi.unstubAllGlobals();
  });

  it('does not call window.open for javascript: URLs', () => {
    const mockOpen = vi.fn();
    vi.stubGlobal('open', mockOpen);

    safeWindowOpen('javascript:alert(1)');
    expect(mockOpen).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('does not call window.open for null/empty', () => {
    const mockOpen = vi.fn();
    vi.stubGlobal('open', mockOpen);

    safeWindowOpen(null);
    safeWindowOpen('');
    expect(mockOpen).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

// ─── sanitizeCssValue ────────────────────────────────────────────────────────

describe('sanitizeCssValue', () => {
  it('returns empty string for null/undefined/empty', () => {
    expect(sanitizeCssValue(null)).toBe('');
    expect(sanitizeCssValue(undefined)).toBe('');
    expect(sanitizeCssValue('')).toBe('');
  });

  it('returns empty string for non-string inputs', () => {
    expect(sanitizeCssValue(123)).toBe('');
  });

  it('passes through safe CSS color values', () => {
    expect(sanitizeCssValue('#ff0000')).toBe('#ff0000');
    expect(sanitizeCssValue('rgb(255, 0, 0)')).toBe('rgb(255, 0, 0)');
    expect(sanitizeCssValue('rgba(0, 0, 0, 0.5)')).toBe('rgba(0, 0, 0, 0.5)');
  });

  it('passes through safe CSS property values', () => {
    expect(sanitizeCssValue('10px')).toBe('10px');
    expect(sanitizeCssValue('100%')).toBe('100%');
    expect(sanitizeCssValue('solid')).toBe('solid');
  });

  it('strips dangerous characters that could escape CSS context', () => {
    expect(sanitizeCssValue('red; background: url(evil)')).not.toContain(';');
    expect(sanitizeCssValue('red">')).not.toContain('"');
    expect(sanitizeCssValue("red'>")).not.toContain("'");
    // Note: parentheses are allowed by the regex (needed for rgb(), calc(), etc.)
    // but semicolons, quotes, angle brackets, and curly braces are stripped
    expect(sanitizeCssValue('red; } .evil { color: blue')).not.toContain(';');
  });

  it('strips curly braces', () => {
    const result = sanitizeCssValue('red} .evil { background: black');
    expect(result).not.toContain('{');
    expect(result).not.toContain('}');
  });
});
