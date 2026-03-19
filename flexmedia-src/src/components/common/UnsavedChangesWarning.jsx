import React from 'react';
import { AlertCircle } from 'lucide-react';

export default function UnsavedChangesWarning() {
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200">
      <AlertCircle className="h-4 w-4 text-amber-600 flex-shrink-0" />
      <p className="text-xs text-amber-800 font-medium">Unsaved changes</p>
      <div className="w-2 h-2 rounded-full bg-amber-600 ml-auto flex-shrink-0" />
    </div>
  );
}