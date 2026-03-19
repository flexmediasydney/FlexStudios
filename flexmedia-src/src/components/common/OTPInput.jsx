import { Input } from "@/components/ui/input";
import { useRef, useState } from "react";

export default function OTPInput({ length = 6, onComplete }) {
  const [values, setValues] = useState(Array(length).fill(""));
  const inputRefs = useRef([]);

  const handleChange = (idx, val) => {
    if (!/^\d?$/.test(val)) return;
    const newValues = [...values];
    newValues[idx] = val;
    setValues(newValues);

    if (val && idx < length - 1) {
      inputRefs.current[idx + 1]?.focus();
    }

    if (newValues.every(v => v)) {
      onComplete?.(newValues.join(""));
    }
  };

  const handleKeyDown = (idx, e) => {
    if (e.key === "Backspace" && !values[idx] && idx > 0) {
      inputRefs.current[idx - 1]?.focus();
    }
  };

  return (
    <div className="flex gap-2 justify-center">
      {values.map((val, idx) => (
        <Input
          key={idx}
          ref={(el) => inputRefs.current[idx] = el}
          type="text"
          value={val}
          onChange={(e) => handleChange(idx, e.target.value)}
          onKeyDown={(e) => handleKeyDown(idx, e)}
          maxLength="1"
          className="h-12 w-12 text-center text-lg font-semibold"
        />
      ))}
    </div>
  );
}