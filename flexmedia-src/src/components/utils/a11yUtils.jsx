// Accessibility utilities
export const A11Y_ROLES = {
  BUTTON: 'button',
  LINK: 'link',
  NAVIGATION: 'navigation',
  MAIN: 'main',
  SEARCH: 'search',
};

// Focus management utilities
export function focusFirstElement(selector) {
  const element = document.querySelector(selector);
  if (element) {
    element.focus();
  }
}

export function createFocusTrap(containerSelector) {
  const container = document.querySelector(containerSelector);
  if (!container) return null;

  const focusableElements = container.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );
  const firstElement = focusableElements[0];
  const lastElement = focusableElements[focusableElements.length - 1];

  const handleKeyDown = (e) => {
    if (e.key === 'Tab') {
      if (e.shiftKey) {
        if (document.activeElement === firstElement) {
          e.preventDefault();
          lastElement?.focus();
        }
      } else {
        if (document.activeElement === lastElement) {
          e.preventDefault();
          firstElement?.focus();
        }
      }
    }
  };

  return {
    activate: () => container.addEventListener('keydown', handleKeyDown),
    deactivate: () => container.removeEventListener('keydown', handleKeyDown),
  };
}

// Keyboard shortcut hint format
export const KEYBOARD_SHORTCUTS = {
  SAVE: 'Ctrl+S',
  NEW: 'Ctrl+N',
  ESCAPE: 'Esc',
  ENTER: 'Enter',
  TAB: 'Tab',
};

// Screen reader friendly announcements
export function announceToScreenReader(message) {
  const announcement = document.createElement('div');
  announcement.setAttribute('role', 'status');
  announcement.setAttribute('aria-live', 'polite');
  announcement.setAttribute('aria-atomic', 'true');
  announcement.style.position = 'absolute';
  announcement.style.left = '-9999px';
  announcement.textContent = message;
  document.body.appendChild(announcement);
  setTimeout(() => announcement.remove(), 1000);
}