import { useEffect, useRef, useState } from "react";
import { AlertCircle, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { useNotifications } from "./NotificationContext";

export default function NotificationToast() {
  const { notifications, markRead } = useNotifications();
  const [toasts, setToasts] = useState([]);
  const seenRef = useRef(new Set());
  const navigate = useNavigate();

  useEffect(() => {
    const critical = notifications.filter(
      n => n.severity === "critical" && !n.is_read && !n.is_dismissed
    );
    const newOnes = critical.filter(n => !seenRef.current.has(n.id));

    if (newOnes.length > 0) {
      newOnes.forEach(n => seenRef.current.add(n.id));
      setToasts(prev => [...newOnes.slice(0, 3), ...prev].slice(0, 5));

      // Auto-dismiss each after 7 seconds
      newOnes.forEach(n => {
        setTimeout(() => {
          setToasts(prev => prev.filter(t => t.id !== n.id));
        }, 7000);
      });
    }
  }, [notifications]);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-6 right-6 z-[100] flex flex-col gap-2 max-w-sm">
      {toasts.map(toast => (
        <div
          key={toast.id}
          className="bg-red-600 text-white rounded-xl shadow-2xl p-4 flex items-start gap-3
            animate-in slide-in-from-bottom-4 fade-in"
        >
          <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-sm leading-snug">{toast.title}</p>
            {toast.message && (
              <p className="text-red-100 text-xs mt-0.5 line-clamp-2">{toast.message}</p>
            )}
            {toast.cta_url && (
              <button
                className="text-red-200 hover:text-white text-xs underline mt-1"
                onClick={() => {
                  try {
                    const params = toast.cta_params ? JSON.parse(toast.cta_params) : {};
                    navigate(createPageUrl(toast.cta_url) + (params.id ? `?id=${params.id}` : ""));
                  } catch { /* ignore */ }
                  markRead(toast.id);
                  setToasts(prev => prev.filter(t => t.id !== toast.id));
                }}
              >
                {toast.cta_label || "View"} →
              </button>
            )}
          </div>
          <button
            className="text-red-200 hover:text-white shrink-0"
            onClick={() => {
              markRead(toast.id);
              setToasts(prev => prev.filter(t => t.id !== toast.id));
            }}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}