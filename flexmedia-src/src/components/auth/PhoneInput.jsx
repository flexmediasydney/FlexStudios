import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const COUNTRY_CODES = [
  { code: '+61', label: 'AU', flag: '🇦🇺' },
  { code: '+64', label: 'NZ', flag: '🇳🇿' },
  { code: '+1', label: 'US', flag: '🇺🇸' },
  { code: '+44', label: 'UK', flag: '🇬🇧' },
  { code: '+91', label: 'IN', flag: '🇮🇳' },
  { code: '+63', label: 'PH', flag: '🇵🇭' },
];

export default function PhoneInput({ value, onChange, disabled }) {
  const [countryCode, setCountryCode] = useState('+61');
  const [number, setNumber] = useState('');

  const handleNumberChange = (e) => {
    const raw = e.target.value.replace(/[^\d]/g, '');
    setNumber(raw);
    onChange?.(countryCode + raw);
  };

  const handleCodeChange = (code) => {
    setCountryCode(code);
    onChange?.(code + number);
  };

  return (
    <div className="flex gap-2">
      <Select value={countryCode} onValueChange={handleCodeChange} disabled={disabled}>
        <SelectTrigger className="w-[100px] h-11">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {COUNTRY_CODES.map(c => (
            <SelectItem key={c.code} value={c.code}>
              {c.flag} {c.code}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        type="tel"
        inputMode="numeric"
        placeholder="412 345 678"
        value={number}
        onChange={handleNumberChange}
        disabled={disabled}
        className="h-11 flex-1"
        autoComplete="tel"
      />
    </div>
  );
}
