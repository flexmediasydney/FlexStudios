import { useState, useCallback } from "react";

export function useFormErrors() {
  const [errors, setErrors] = useState({});

  const setError = useCallback((field, message) => {
    setErrors(prev => ({ ...prev, [field]: message }));
  }, []);

  const clearError = useCallback((field) => {
    setErrors(prev => {
      const newErrors = { ...prev };
      delete newErrors[field];
      return newErrors;
    });
  }, []);

  const clearAllErrors = useCallback(() => {
    setErrors({});
  }, []);

  const hasError = useCallback((field) => {
    return !!errors[field];
  }, [errors]);

  return { errors, setError, clearError, clearAllErrors, hasError };
}