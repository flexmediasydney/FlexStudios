import React, { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

/**
 * Copy Button with Toast Feedback
 * Shows success toast when text is copied to clipboard
 */
export default function CopyButton({
  text = '',
  label = 'Copy',
  variant = 'ghost',
  size = 'sm',
  className = '',
  showIcon = true,
  successMessage = 'Copied to clipboard!'
}) {
  const [isCopied, setIsCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setIsCopied(true);
      
      // Show toast feedback
      toast.success(successMessage, {
        duration: 2000,
        description: text.length > 30 ? `${text.substring(0, 30)}...` : text
      });

      // Reset icon after 2 seconds
      setTimeout(() => setIsCopied(false), 2000);
    } catch (err) {
      toast.error('Failed to copy');
      console.error('Copy failed:', err);
    }
  };

  return (
    <Button
      variant={variant}
      size={size}
      onClick={handleCopy}
      disabled={!text}
      title={isCopied ? 'Copied!' : 'Copy to clipboard'}
      aria-label={!label ? (isCopied ? 'Copied' : 'Copy to clipboard') : undefined}
      className={className}
    >
      {showIcon && (
        <span className="inline-flex transition-transform duration-200" style={{ transform: isCopied ? 'scale(1.15)' : 'scale(1)' }}>
          {isCopied ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
        </span>
      )}
      {label && <span className="ml-1">{isCopied ? 'Copied!' : label}</span>}
      <span className="sr-only" aria-live="polite">{isCopied ? 'Copied to clipboard' : ''}</span>
    </Button>
  );
}