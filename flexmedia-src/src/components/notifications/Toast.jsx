import { toast } from "sonner";
import { AlertCircle, CheckCircle, AlertTriangle, Info } from "lucide-react";

const icons = {
  success: CheckCircle,
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info,
};

export function showToast(type = "info", message, duration = 4000) {
  const Icon = icons[type];

  return toast[type](message, {
    duration,
    icon: Icon ? <Icon className="h-4 w-4" /> : undefined,
  });
}

export function showSuccess(message, duration = 4000) {
  return showToast("success", message, duration);
}

export function showError(message, duration = 4000) {
  return showToast("error", message, duration);
}

export function showWarning(message, duration = 4000) {
  return showToast("warning", message, duration);
}

export function showInfo(message, duration = 4000) {
  return showToast("info", message, duration);
}

