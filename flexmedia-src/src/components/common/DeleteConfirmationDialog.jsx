import React, { useState, useEffect } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

export default function DeleteConfirmationDialog({
  open,
  itemName,
  itemType = 'item',
  impact = null,
  isLoading = false,
  onConfirm,
  onCancel,
  destructive = true
}) {
  const [inputValue, setInputValue] = useState('');
  const [step, setStep] = useState('confirm');
  const isMatched = inputValue === itemName;

  // Reset step and input when dialog opens/closes or item changes
  useEffect(() => {
    if (open) {
      setStep('confirm');
      setInputValue('');
    }
  }, [open, itemName]);

  const getRiskLevel = (impact) => {
    if (!impact || impact.totalAffected === 0) return 'low';
    if (impact.totalAffected > 10) return 'high';
    return impact.totalAffected > 5 ? 'medium' : 'low';
  };

  const riskLevel = impact ? getRiskLevel(impact) : 'low';

  const handleConfirmStep = () => {
    setInputValue('');
    setStep('verify');
  };

  const handleDelete = () => {
    onConfirm();
  };

  const handleCancel = () => {
    setInputValue('');
    setStep('confirm');
    onCancel();
  };

  return (
    <AlertDialog open={open} onOpenChange={handleCancel}>
      <AlertDialogContent className="max-w-2xl">
        <AlertDialogHeader>
          <div className="flex items-center gap-3">
            <AlertTriangle className={`h-5 w-5 flex-shrink-0 ${
              riskLevel === 'high' ? 'text-red-600' : riskLevel === 'medium' ? 'text-amber-600' : 'text-blue-600'
            }`} />
            <AlertDialogTitle>Delete "{itemName}"?</AlertDialogTitle>
          </div>
        </AlertDialogHeader>

        <div className="space-y-4">
          {step === 'confirm' && (
            <>
              <p className="text-sm text-muted-foreground">
                This will permanently delete this {itemType} and cannot be undone.
              </p>

              {impact && impact.totalAffected > 0 && (
                <div className={`border rounded-lg p-3 space-y-2 ${
                  riskLevel === 'high' ? 'bg-red-50 border-red-200' : 
                  riskLevel === 'medium' ? 'bg-amber-50 border-amber-200' : 'bg-blue-50 border-blue-200'
                }`}>
                  <p className="text-sm font-semibold">
                    {riskLevel === 'high' ? '⚠️ High Impact - ' : riskLevel === 'medium' ? '⚠️ Medium Impact - ' : 'ℹ️ Low Impact - '}
                    {impact.totalAffected} item{impact.totalAffected !== 1 ? 's' : ''} affected
                  </p>

                  {impact.affectedEntities && Object.entries(impact.affectedEntities).map(([key, entity]) => (
                    entity.count > 0 && (
                      <div key={key}>
                        <p className="text-xs font-medium text-foreground capitalize">{key} ({entity.count})</p>
                        <ul className="text-xs text-muted-foreground mt-1 space-y-0.5">
                          {entity.items.slice(0, 2).map((item, i) => (
                            <li key={i}>• {item.name || item}</li>
                          ))}
                          {entity.items.length > 2 && (
                            <li>• +{entity.items.length - 2} more</li>
                          )}
                        </ul>
                      </div>
                    )
                  ))}
                </div>
              )}

              <div className="flex justify-end gap-2">
                <AlertDialogCancel disabled={isLoading}>Cancel</AlertDialogCancel>
                <button
                  onClick={handleConfirmStep}
                  disabled={isLoading}
                  className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 bg-amber-600 text-white hover:bg-amber-700 h-9 px-4"
                >
                  Continue to Verify
                </button>
              </div>
            </>
          )}

          {step === 'verify' && (
            <>
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 space-y-2">
                <p className="text-sm font-semibold text-red-900">Final Verification Required</p>
                <p className="text-sm text-red-800">
                  Type <span className="font-mono font-bold">{itemName}</span> below to confirm deletion:
                </p>
                <Input
                  placeholder={`Type "${itemName}"`}
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  className="h-9 text-sm"
                  disabled={isLoading}
                  autoFocus
                />
                {inputValue && !isMatched && (
                  <p className="text-xs text-red-600">❌ Text does not match</p>
                )}
                {isMatched && (
                  <p className="text-xs text-red-600">✓ Ready to delete</p>
                )}
              </div>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setStep('confirm')}
                  disabled={isLoading}
                  className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-9 px-4"
                >
                  Back
                </button>
                <button
                  onClick={handleDelete}
                  disabled={!isMatched || isLoading}
                  className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 bg-red-600 text-white hover:bg-red-700 h-9 px-4 gap-2"
                >
                  {isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Delete Permanently
                </button>
              </div>
            </>
          )}
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}