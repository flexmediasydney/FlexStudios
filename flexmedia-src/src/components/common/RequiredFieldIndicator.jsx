import React from 'react';

/**
 * Required Field Indicator
 * Shows asterisk (*) for required fields
 * Pure presentation component
 */
export default function RequiredFieldIndicator({ required = false, className = '' }) {
  if (!required) return null;
  
  return (
    <span 
      className={`text-destructive font-bold ml-1 ${className}`}
      aria-label="Required field"
      title="This field is required"
    >
      *
    </span>
  );
}