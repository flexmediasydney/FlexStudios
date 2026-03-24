import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'

// Register service worker for PWA support
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((registration) => {
        console.log('SW registered:', registration.scope);

        // Listen for new service worker updates
        registration.addEventListener('updatefound', () => {
          const newWorker = registration.installing;
          if (!newWorker) return;

          newWorker.addEventListener('statechange', () => {
            // New SW is installed and waiting to activate
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              // Dispatch custom event so UI can show update notification
              window.dispatchEvent(new CustomEvent('sw-update-available', {
                detail: { registration },
              }));
            }
          });
        });
      })
      .catch((error) => {
        console.log('SW registration failed:', error);
      });
  });

  // Listen for SW_UPDATED messages from the newly activated service worker
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'SW_UPDATED') {
      window.dispatchEvent(new CustomEvent('sw-activated'));
    }
  });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <App />
)
