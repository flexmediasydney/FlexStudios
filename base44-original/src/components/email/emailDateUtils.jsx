import { format, isToday } from "date-fns";
import { fixTimestamp } from "@/components/utils/dateUtils";

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
 * Format file size with proper units
 */
export const formatFileSize = (bytes) => {
  if (!bytes || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};