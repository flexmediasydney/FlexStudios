import React, { useState, useEffect, useCallback } from 'react';
import { Download, X, RefreshCw, Share } from 'lucide-react';
import { Button } from '@/components/ui/button';

const DISMISS_EXPIRY_DAYS = 14;

function isStandalone() {
  // Check both standard and iOS-specific standalone detection
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  );
}

function isDismissed() {
  const dismissed = localStorage.getItem('pwa-install-dismissed');
  if (!dismissed) return false;
  const dismissedAt = parseInt(dismissed, 10);
  if (isNaN(dismissedAt)) return false;
  const daysSince = (Date.now() - dismissedAt) / (1000 * 60 * 60 * 24);
  return daysSince < DISMISS_EXPIRY_DAYS;
}

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}

export default function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [showIOSPrompt, setShowIOSPrompt] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [swRegistration, setSwRegistration] = useState(null);

  // Listen for beforeinstallprompt (Chrome/Edge/Android)
  useEffect(() => {
    if (isStandalone() || isDismissed()) return;

    const handler = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
      setShowPrompt(true);
    };

    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  // Show iOS-specific install instructions
  useEffect(() => {
    if (isStandalone() || isDismissed()) return;
    if (isIOS()) {
      // Small delay so it doesn't flash on load
      const timer = setTimeout(() => setShowIOSPrompt(true), 3000);
      return () => clearTimeout(timer);
    }
  }, []);

  // Listen for service worker update events
  useEffect(() => {
    const handleUpdate = (e) => {
      setUpdateAvailable(true);
      setSwRegistration(e.detail?.registration || null);
    };

    window.addEventListener('sw-update-available', handleUpdate);
    return () => window.removeEventListener('sw-update-available', handleUpdate);
  }, []);

  const handleInstall = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      setShowPrompt(false);
    }
    setDeferredPrompt(null);
  };

  const handleDismiss = () => {
    setShowPrompt(false);
    setShowIOSPrompt(false);
    setDeferredPrompt(null);
    // Store timestamp so dismiss expires after DISMISS_EXPIRY_DAYS
    localStorage.setItem('pwa-install-dismissed', String(Date.now()));
  };

  const handleUpdate = useCallback(() => {
    if (swRegistration?.waiting) {
      swRegistration.waiting.postMessage({ type: 'SKIP_WAITING' });
    }
    // Reload to activate the new service worker
    window.location.reload();
  }, [swRegistration]);

  // Update notification banner
  if (updateAvailable) {
    return (
      <div className="fixed bottom-4 left-4 right-4 z-50 mx-auto max-w-md animate-in slide-in-from-bottom-4 duration-300">
        <div className="flex items-center gap-3 rounded-xl border border-blue-200 bg-blue-50 p-4 shadow-lg dark:border-blue-800 dark:bg-blue-950">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white">
            <RefreshCw className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-blue-900 dark:text-blue-100">
              Update available
            </p>
            <p className="text-xs text-blue-700 dark:text-blue-300">
              A new version of FlexStudios is ready
            </p>
          </div>
          <Button size="sm" onClick={handleUpdate}>
            Refresh
          </Button>
        </div>
      </div>
    );
  }

  // iOS install instructions
  if (showIOSPrompt && !showPrompt) {
    return (
      <div className="fixed bottom-4 left-4 right-4 z-50 mx-auto max-w-md animate-in slide-in-from-bottom-4 duration-300">
        <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-card p-4 shadow-lg dark:border-slate-700 dark:bg-slate-900">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900">
            <Share className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
              Add to Home Screen
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Tap <Share className="inline h-3 w-3" /> then &quot;Add to Home Screen&quot;
            </p>
          </div>
          <button
            onClick={handleDismiss}
            className="rounded-md p-1.5 text-slate-400 hover:bg-muted hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
            aria-label="Dismiss install prompt"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    );
  }

  // Standard install prompt (Chrome/Edge/Android)
  if (!showPrompt) return null;

  return (
    <div className="fixed bottom-4 left-4 right-4 z-50 mx-auto max-w-md animate-in slide-in-from-bottom-4 duration-300">
      <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-card p-4 shadow-lg dark:border-slate-700 dark:bg-slate-900">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900">
          <Download className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
            Add FlexStudios to Home Screen
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Quick access &amp; offline support
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Button size="sm" onClick={handleInstall}>
            Install
          </Button>
          <button
            onClick={handleDismiss}
            className="rounded-md p-1.5 text-slate-400 hover:bg-muted hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
            aria-label="Dismiss install prompt"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
