import { format, isToday, isYesterday, differenceInCalendarDays, isThisYear } from "date-fns";
import { fixTimestamp } from "@/components/utils/dateUtils";
import { formatBytes } from "@/components/utils/formatters";

/**
 * Smart date formatting for email timestamps:
 * - Today: "2:34 PM"
 * - Yesterday: "Yesterday"
 * - This week (within 6 days): "Mon", "Tue", etc.
 * - This year: "12 Mar"
 * - Older: "12 Mar 2024"
 */
export const formatEmailDate = (timestamp) => {
  try {
    const date = new Date(fixTimestamp(timestamp));
    if (!date.getTime()) return '';
    const now = new Date();
    if (isToday(date)) return format(date, 'h:mm a');
    if (isYesterday(date)) return 'Yesterday';
    const daysDiff = differenceInCalendarDays(now, date);
    if (daysDiff <= 6) return format(date, 'EEE');
    if (isThisYear(date)) return format(date, 'd MMM');
    return format(date, 'd MMM yyyy');
  } catch {
    return '';
  }
};

/**
 * Pipedrive-style compact inbox timestamp:
 * - Today: "9:58 am"    (lowercase meridian, no leading zero hour)
 * - Yesterday: "Yesterday"
 * - This year: "16 Apr"
 * - Older: "16 Apr 25"
 */
export const formatInboxTime = (timestamp) => {
  try {
    const date = new Date(fixTimestamp(timestamp));
    if (!date.getTime()) return '';
    if (isToday(date)) {
      // date-fns 'a' = 'AM'/'PM'; lowercase to match Pipedrive
      return format(date, 'h:mm a').toLowerCase();
    }
    if (isYesterday(date)) return 'Yesterday';
    if (isThisYear(date)) return format(date, 'd MMM');
    return format(date, 'd MMM yy');
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