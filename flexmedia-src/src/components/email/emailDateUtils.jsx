import { format, isToday } from "date-fns";
import { fixTimestamp } from "@/components/utils/dateUtils";
import { formatBytes } from "@/components/utils/formatters";

/**
 * Consistent date formatting for email timestamps
 * Returns time for today, date for other days
 */
export const formatEmailDate = (timestamp) => {
  try {
    const date = new Date(fixTimestamp(timestamp));
    if (!date.getTime()) return '';
    return isToday(date) 
      ? format(date, 'h:mm a')
      : format(date, 'd MMM');
  } catch {
    return '';
  }
};

/**
 * Full date-time format for detailed view
 */
export const formatEmailDateTime = (timestamp) => {
  try {
    const date = new Date(fixTimestamp(timestamp));
    if (!date.getTime()) return '';
    return format(date, "MMM d, h:mm a");
  } catch {
    return '';
  }
};

/**
 * Format file size with proper units.
 * Delegates to the shared formatBytes util; returns '' instead of '—' for
 * null/negative to match the email-specific convention (empty string = hide).
 */
export const formatFileSize = (bytes) => {
  const result = formatBytes(bytes);
  return result === '—' ? '' : result;
};