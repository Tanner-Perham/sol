/**
 * Returns the ISO 8601 week number and corresponding week-year for a given date.
 */
export function getISOWeek(date: Date): { year: number; week: number } {
  // Create a copy of the date to avoid mutating the original
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  // Set to nearest Thursday: current date + 4 - current day number
  // Make Sunday's day number 7
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  // Get first day of year
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  // Calculate full weeks to nearest Thursday
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: d.getUTCFullYear(), week: weekNo };
}

/**
 * Formats a date string using template tokens.
 * Supported tokens:
 * - YYYY: 4-digit year (or week-year if formatting week)
 * - YY: 2-digit year (or week-year if formatting week)
 * - MM: 2-digit month (01-12)
 * - M: 1 or 2-digit month (1-12)
 * - DD: 2-digit day of month (01-31)
 * - D: 1 or 2-digit day of month (1-31)
 * - WW: 2-digit ISO week number (01-53)
 * - W: 1 or 2-digit ISO week number (1-53)
 * - [text]: literal text inside brackets
 */
export function formatDate(date: Date, format: string): string {
  const pad = (n: number) => n.toString().padStart(2, "0");

  let formatted = format;

  // Check if week tokens are present
  const hasWeekToken = format.includes("WW") || format.includes("W");
  const { year: wYear, week } = getISOWeek(date);

  // Replace year. If week token is present, we use the ISO week-year.
  const targetYear = hasWeekToken ? wYear : date.getFullYear();
  formatted = formatted.replace(/YYYY/g, targetYear.toString());
  formatted = formatted.replace(/YY/g, targetYear.toString().slice(-2));

  // Replace month
  const month = date.getMonth() + 1;
  formatted = formatted.replace(/MM/g, pad(month));
  formatted = formatted.replace(/M/g, month.toString());

  // Replace day
  const day = date.getDate();
  formatted = formatted.replace(/DD/g, pad(day));
  formatted = formatted.replace(/D/g, day.toString());

  // Replace week if applicable
  if (hasWeekToken) {
    formatted = formatted.replace(/WW/g, pad(week));
    formatted = formatted.replace(/W/g, week.toString());
  }

  // Remove brackets for literals
  formatted = formatted.replace(/\[([^\]]+)\]/g, "$1");

  return formatted;
}
