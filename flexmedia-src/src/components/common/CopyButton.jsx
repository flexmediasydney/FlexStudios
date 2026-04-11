import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Copy, Check } from "lucide-react";

export default function CopyButton({ text, className = "", size = "icon", variant = "ghost", label }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <Button
      variant={variant}
      size={size}
      onClick={handleCopy}
      className={`${className} transition-colors`}
      title={copied ? 'Copied!' : `Copy ${label || 'text'}`}
      aria-label={copied ? 'Copied to clipboard' : `Copy ${label || 'text'} to clipboard`}
    >
      {copied
        ? <Check className="h-3 w-3 text-green-600 animate-in zoom-in-50 duration-150" />
        : <Copy className="h-3 w-3" />
      }
      {label && <span className="ml-1">{copied ? 'Copied!' : label}</span>}
    </Button>
  );
}