import { Input } from "@/components/ui/input";

export default function CurrencyInput({ value, onChange, currency = "USD", label }) {
  const formatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });

  const handleChange = (e) => {
    const numericValue = parseFloat(e.target.value.replace(/\D/g, "")) || 0;
    onChange(numericValue / 100);
  };

  return (
    <div className="space-y-2">
      {label && <label className="text-sm font-medium">{label}</label>}
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
          {currency === "USD" ? "$" : "€"}
        </span>
        <Input
          type="text"
          value={formatter.format(value || 0)}
          onChange={handleChange}
          placeholder="0.00"
          className="pl-8"
        />
      </div>
    </div>
  );
}