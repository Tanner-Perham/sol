import React, { useState, useMemo } from "react";
import { AppSettings, FileNode } from "../types";
import { formatDate, getISOWeek } from "../utils/dateUtils";
import { getAllFilePaths } from "../utils/treeUtils";

export interface CalendarWidgetProps {
  settings: AppSettings;
  fileTree: FileNode[];
  openPeriodicNote: (relativePath: string) => Promise<void>;
  activeFile: string | null;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

const WEEKDAY_HEADERS = ["W", "Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

export const CalendarWidget: React.FC<CalendarWidgetProps> = ({
  settings,
  fileTree,
  openPeriodicNote,
  activeFile
}) => {
  const [currentDate, setCurrentDate] = useState(() => new Date());

  // Recursively collect all paths in workspace
  const allFilePaths = useMemo(() => getAllFilePaths(fileTree), [fileTree]);

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();

  // Navigation handlers
  const handlePrevMonth = () => {
    setCurrentDate(new Date(year, month - 1, 1));
  };

  const handleNextMonth = () => {
    setCurrentDate(new Date(year, month + 1, 1));
  };

  const handleGoToToday = () => {
    setCurrentDate(new Date());
  };

  // Helper to generate paths
  const getDailyNotePath = (date: Date) => {
    const folder = (settings.dailyNotesFolder ?? "daily").trim().replace(/\/$/, "");
    const format = settings.dailyNotesFormat ?? "YYYY-MM-DD";
    const formatted = formatDate(date, format);
    return folder ? `${folder}/${formatted}.md` : `${formatted}.md`;
  };

  const getWeeklyNotePath = (date: Date) => {
    const folder = (settings.weeklyNotesFolder ?? "weekly").trim().replace(/\/$/, "");
    const format = settings.weeklyNotesFormat ?? "YYYY-[W]WW";
    const formatted = formatDate(date, format);
    return folder ? `${folder}/${formatted}.md` : `${formatted}.md`;
  };

  // Generate calendar grid cells
  const gridCells = useMemo(() => {
    const cells: { date: Date; isCurrentMonth: boolean; isToday: boolean }[] = [];
    const today = new Date();
    const isSameDay = (d1: Date, d2: Date) =>
      d1.getFullYear() === d2.getFullYear() &&
      d1.getMonth() === d2.getMonth() &&
      d1.getDate() === d2.getDate();

    // Trailing days of previous month
    const firstDayOfMonth = new Date(year, month, 1);
    const firstDayOfWeek = firstDayOfMonth.getDay();
    const startOffset = (firstDayOfWeek + 6) % 7; // Monday is 0

    const daysInPrevMonth = new Date(year, month, 0).getDate();
    for (let i = startOffset - 1; i >= 0; i--) {
      const d = new Date(year, month - 1, daysInPrevMonth - i);
      cells.push({
        date: d,
        isCurrentMonth: false,
        isToday: isSameDay(d, today)
      });
    }

    // Days of current month
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    for (let i = 1; i <= daysInMonth; i++) {
      const d = new Date(year, month, i);
      cells.push({
        date: d,
        isCurrentMonth: true,
        isToday: isSameDay(d, today)
      });
    }

    // Leading days of next month to complete the grid (multiple of 7)
    const totalCells = Math.ceil(cells.length / 7) * 7;
    const remaining = totalCells - cells.length;
    for (let i = 1; i <= remaining; i++) {
      const d = new Date(year, month + 1, i);
      cells.push({
        date: d,
        isCurrentMonth: false,
        isToday: isSameDay(d, today)
      });
    }

    // Group into weeks
    const weeks: { date: Date; isCurrentMonth: boolean; isToday: boolean }[][] = [];
    for (let i = 0; i < cells.length; i += 7) {
      weeks.push(cells.slice(i, i + 7));
    }

    return weeks;
  }, [year, month]);

  return (
    <div className="sidebar-calendar-widget">
      <div className="calendar-header">
        <div className="calendar-title-container">
          <span
            className="calendar-title"
            onClick={handleGoToToday}
            title="Click to jump to today"
          >
            {MONTH_NAMES[month]} {year}
          </span>
        </div>
        <div className="calendar-nav-buttons">
          <button
            className="btn-calendar-nav"
            onClick={handlePrevMonth}
            title="Previous Month"
          >
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <button
            className="btn-calendar-nav"
            onClick={handleGoToToday}
            title="Today"
            style={{ fontSize: "9px", padding: "2px 4px", fontWeight: 600 }}
          >
            TODAY
          </button>
          <button
            className="btn-calendar-nav"
            onClick={handleNextMonth}
            title="Next Month"
          >
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </div>
      </div>

      <div className="calendar-grid">
        {/* Headers */}
        {WEEKDAY_HEADERS.map((h, i) => (
          <div key={i} className="calendar-grid-header">
            {h}
          </div>
        ))}

        {/* Rows */}
        {gridCells.map((week, wIdx) => {
          // Thursday (index 3) determines the ISO week number
          const thursdayDate = week[3].date;
          const { week: weekNo } = getISOWeek(thursdayDate);
          const weeklyPath = getWeeklyNotePath(thursdayDate);
          const hasWeeklyNote = allFilePaths.has(weeklyPath);
          const isWeeklyActive = activeFile === weeklyPath;

          return (
            <React.Fragment key={wIdx}>
              {/* Week Number Cell */}
              <div
                className={`calendar-cell week-cell ${isWeeklyActive ? "active-note" : ""}`}
                onClick={() => openPeriodicNote(weeklyPath)}
                title={`Open weekly note: ${weeklyPath}`}
              >
                {weekNo}
                {hasWeeklyNote && <span className="week-note-dot" />}
              </div>

              {/* Days cells */}
              {week.map((cell, dIdx) => {
                const dailyPath = getDailyNotePath(cell.date);
                const hasDailyNote = allFilePaths.has(dailyPath);
                const isDailyActive = activeFile === dailyPath;

                return (
                  <div
                    key={dIdx}
                    className={`calendar-cell day-cell ${cell.isCurrentMonth ? "" : "other-month"} ${cell.isToday ? "today" : ""} ${isDailyActive ? "active-note" : ""}`}
                    onClick={() => openPeriodicNote(dailyPath)}
                    title={`Open daily note: ${dailyPath}`}
                  >
                    <span>{cell.date.getDate()}</span>
                    {hasDailyNote && <span className="note-dot" />}
                  </div>
                );
              })}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
};
