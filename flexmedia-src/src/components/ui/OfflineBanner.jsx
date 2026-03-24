import { useOnlineStatus } from '@/lib/networkResilience';
import { WifiOff } from 'lucide-react';

/**
 * Thin banner rendered at the top of the viewport when the browser goes offline.
 * Automatically hides when connectivity returns.
 */
export default function OfflineBanner() {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div
      role="alert"
      className="fixed top-0 inset-x-0 z-[9999] bg-amber-600 text-white text-center text-sm py-2 px-4 flex items-center justify-center gap-2 shadow-md"
    >
      <WifiOff className="h-4 w-4 flex-shrink-0" />
      You are offline. Changes will not be saved until your connection is restored.
    </div>
  );
}
