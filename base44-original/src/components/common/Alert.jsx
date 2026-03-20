import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle, AlertCircle, CheckCircle, Info } from "lucide-react";

const iconMap = {
  error: AlertTriangle,
  warning: AlertTriangle,
  success: CheckCircle,
  info: AlertCircle,
};

const classMap = {
  error: "border-red-200 bg-red-50",
  warning: "border-amber-200 bg-amber-50",
  success: "border-green-200 bg-green-50",
  info: "border-blue-200 bg-blue-50",
};

export default function AlertBox({ type = "info", title, description, action }) {
  const Icon = iconMap[type];

  return (
    <Alert className={classMap[type]}>
      {Icon && <Icon className="h-4 w-4" />}
      <div>
        {title && <AlertTitle>{title}</AlertTitle>}
        {description && <AlertDescription>{description}</AlertDescription>}
        {action && <div className="mt-2">{action}</div>}
      </div>
    </Alert>
  );
}