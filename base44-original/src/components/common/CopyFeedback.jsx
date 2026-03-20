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
      className={className}
    >
      {showIcon && (isCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />)}
      {label && <span className="ml-1">{isCopied ? 'Copied!' : label}</span>}
    </Button>
  );
}