import { Input } from "@/components/ui/input";
import { useState } from "react";
import { cn } from "@/lib/utils";

export default function PasswordStrength({ value, onChange, label }) {
  const [showPassword, setShowPassword] = useState(false);

  const getStrength = (pwd) => {
    let strength = 0;
    if (pwd.length >= 8) strength++;
    if (/[a-z]/.test(pwd) && /[A-Z]/.test(pwd)) strength++;
    if (/\d/.test(pwd)) strength++;
    if (/[@$!%*?&]/.test(pwd)) strength++;
    return strength;
  };

  const strength = getStrength(value);
  const strengthText = ["Weak", "Fair", "Good", "Strong", "Very Strong"];
  const strengthColor = ["bg-red-500", "bg-amber-500", "bg-yellow-500", "bg-green-500", "bg-green-600"];

  return (
    <div className="space-y-2">
      {label && <label className="text-sm font-medium">{label}</label>}
      <Input
        type={showPassword ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Enter password"
      />
      {value && (
        <div className="space-y-1">
          <div className="flex gap-1">
            {[...Array(4)].map((_, i) => (
              <div
                key={i}
                className={cn("h-2 flex-1 rounded", i < strength ? strengthColor[strength - 1] : "bg-gray-200")}
              />
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{strengthText[strength]}</p>
        </div>
      )}
    </div>
  );
}