"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.COMMON_TIMEZONES = void 0;
exports.getLocalDateParts = getLocalDateParts;
exports.getUserYesterday = getUserYesterday;
exports.getUserLastCompletedWeek = getUserLastCompletedWeek;
exports.getUserLastCompletedMonth = getUserLastCompletedMonth;
exports.hasPeriodCompletedForUser = hasPeriodCompletedForUser;
exports.getTimezonesAtMidnight = getTimezonesAtMidnight;
exports.getTimezoneScheduleInfo = getTimezoneScheduleInfo;
exports.getPeriodKey = getPeriodKey;
exports.getISOWeekNumber = getISOWeekNumber;
exports.getPeriodBounds = getPeriodBounds;
exports.getDayBounds = getDayBounds;
exports.getWeekBounds = getWeekBounds;
exports.getMonthBounds = getMonthBounds;
exports.formatDateForReview = formatDateForReview;
exports.formatDateRange = formatDateRange;
exports.getDayName = getDayName;
exports.getPreviousPeriodDate = getPreviousPeriodDate;
exports.getDatesInPeriod = getDatesInPeriod;
exports.canGenerateReview = canGenerateReview;
exports.isDateInPeriod = isDateInPeriod;
exports.parsePeriodKey = parsePeriodKey;
const schema_1 = require("./schema");
// ============================================================================
// Common IANA Timezones
// ============================================================================
/**
 * List of common IANA timezones covering major population centers.
 * This list covers most users and all UTC offsets from -12 to +14.
 */
exports.COMMON_TIMEZONES = [
    // UTC and GMT
    'UTC',
    'GMT',
    // Americas
    'America/New_York', // UTC-5/-4 (EST/EDT)
    'America/Chicago', // UTC-6/-5 (CST/CDT)
    'America/Denver', // UTC-7/-6 (MST/MDT)
    'America/Los_Angeles', // UTC-8/-7 (PST/PDT)
    'America/Anchorage', // UTC-9/-8 (AKST/AKDT)
    'America/Phoenix', // UTC-7 (no DST)
    'America/Toronto', // UTC-5/-4 (EST/EDT)
    'America/Vancouver', // UTC-8/-7 (PST/PDT)
    'America/Mexico_City', // UTC-6/-5 (CST/CDT)
    'America/Sao_Paulo', // UTC-3 (BRT)
    'America/Buenos_Aires', // UTC-3 (ART)
    'America/Santiago', // UTC-4/-3 (CLT/CLST)
    'America/Bogota', // UTC-5 (COT)
    'America/Lima', // UTC-5 (PET)
    // Europe
    'Europe/London', // UTC+0/+1 (GMT/BST)
    'Europe/Paris', // UTC+1/+2 (CET/CEST)
    'Europe/Berlin', // UTC+1/+2 (CET/CEST)
    'Europe/Madrid', // UTC+1/+2 (CET/CEST)
    'Europe/Rome', // UTC+1/+2 (CET/CEST)
    'Europe/Amsterdam', // UTC+1/+2 (CET/CEST)
    'Europe/Brussels', // UTC+1/+2 (CET/CEST)
    'Europe/Vienna', // UTC+1/+2 (CET/CEST)
    'Europe/Warsaw', // UTC+1/+2 (CET/CEST)
    'Europe/Stockholm', // UTC+1/+2 (CET/CEST)
    'Europe/Oslo', // UTC+1/+2 (CET/CEST)
    'Europe/Copenhagen', // UTC+1/+2 (CET/CEST)
    'Europe/Helsinki', // UTC+2/+3 (EET/EEST)
    'Europe/Athens', // UTC+2/+3 (EET/EEST)
    'Europe/Moscow', // UTC+3 (MSK)
    'Europe/Istanbul', // UTC+3 (TRT)
    // Asia
    'Asia/Dubai', // UTC+4 (GST)
    'Asia/Karachi', // UTC+5 (PKT)
    'Asia/Kolkata', // UTC+5:30 (IST)
    'Asia/Dhaka', // UTC+6 (BST)
    'Asia/Bangkok', // UTC+7 (ICT)
    'Asia/Jakarta', // UTC+7 (WIB)
    'Asia/Singapore', // UTC+8 (SGT)
    'Asia/Hong_Kong', // UTC+8 (HKT)
    'Asia/Shanghai', // UTC+8 (CST)
    'Asia/Taipei', // UTC+8 (CST)
    'Asia/Seoul', // UTC+9 (KST)
    'Asia/Tokyo', // UTC+9 (JST)
    // Oceania
    'Australia/Perth', // UTC+8 (AWST)
    'Australia/Adelaide', // UTC+9:30/+10:30 (ACST/ACDT)
    'Australia/Sydney', // UTC+10/+11 (AEST/AEDT)
    'Australia/Melbourne', // UTC+10/+11 (AEST/AEDT)
    'Australia/Brisbane', // UTC+10 (AEST, no DST)
    'Pacific/Auckland', // UTC+12/+13 (NZST/NZDT)
    'Pacific/Fiji', // UTC+12/+13 (FJT/FJST)
    'Pacific/Honolulu', // UTC-10 (HST)
    // Africa
    'Africa/Cairo', // UTC+2 (EET)
    'Africa/Johannesburg', // UTC+2 (SAST)
    'Africa/Lagos', // UTC+1 (WAT)
    'Africa/Nairobi', // UTC+3 (EAT)
    // Middle East
    'Asia/Jerusalem', // UTC+2/+3 (IST/IDT)
    'Asia/Tehran', // UTC+3:30/+4:30 (IRST/IRDT)
    'Asia/Riyadh', // UTC+3 (AST)
];
// ============================================================================
// Timezone-Aware Period Functions
// ============================================================================
/**
 * Gets the current date/time in a user's timezone.
 * Returns the local date parts (year, month, day, hour, etc.).
 */
function getLocalDateParts(timezone, date = new Date()) {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        hour12: false,
        weekday: 'short',
    });
    const parts = formatter.formatToParts(date);
    const getPart = (type) => parts.find(p => p.type === type)?.value || '';
    const weekdayMap = {
        'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6
    };
    return {
        year: parseInt(getPart('year')),
        month: parseInt(getPart('month')),
        day: parseInt(getPart('day')),
        hour: parseInt(getPart('hour')),
        minute: parseInt(getPart('minute')),
        dayOfWeek: weekdayMap[getPart('weekday')] ?? 0,
    };
}
/**
 * Gets the user's "yesterday" based on their timezone.
 * Returns a UTC Date representing midnight UTC of the user's yesterday.
 *
 * @param timezone - IANA timezone string (e.g., "America/New_York")
 * @returns Date object representing user's yesterday (at midnight UTC for that date)
 */
function getUserYesterday(timezone) {
    const now = new Date();
    const local = getLocalDateParts(timezone, now);
    // Create a date for today in user's timezone, then subtract 1 day
    const userTodayUTC = new Date(Date.UTC(local.year, local.month - 1, local.day));
    const userYesterdayUTC = new Date(userTodayUTC);
    userYesterdayUTC.setUTCDate(userTodayUTC.getUTCDate() - 1);
    return userYesterdayUTC;
}
/**
 * Gets the user's last completed ISO week (Mon-Sun) based on their timezone.
 * Returns null if the current week hasn't ended yet.
 *
 * @param timezone - IANA timezone string
 * @returns { start, end } representing the last completed week, or null
 */
function getUserLastCompletedWeek(timezone) {
    const now = new Date();
    const local = getLocalDateParts(timezone, now);
    // Get user's "today" in UTC representation
    const userTodayUTC = new Date(Date.UTC(local.year, local.month - 1, local.day));
    // Calculate days since Monday (Monday = 0 in our calculation)
    // If Sunday (0), days since Monday = 6
    // If Monday (1), days since Monday = 0
    const daysSinceMonday = local.dayOfWeek === 0 ? 6 : local.dayOfWeek - 1;
    // Get this week's Monday
    const thisMonday = new Date(userTodayUTC);
    thisMonday.setUTCDate(userTodayUTC.getUTCDate() - daysSinceMonday);
    // Last week's Monday (7 days before this Monday)
    const lastMonday = new Date(thisMonday);
    lastMonday.setUTCDate(thisMonday.getUTCDate() - 7);
    // Last week's Sunday (end of last week, exclusive boundary is this Monday)
    const lastSunday = new Date(thisMonday);
    return {
        start: lastMonday,
        end: lastSunday, // Exclusive end (this is this week's Monday 00:00)
    };
}
/**
 * Gets the user's last completed month based on their timezone.
 * Returns null if the current month hasn't ended yet.
 *
 * @param timezone - IANA timezone string
 * @returns { start, end } representing the last completed month, or null
 */
function getUserLastCompletedMonth(timezone) {
    const now = new Date();
    const local = getLocalDateParts(timezone, now);
    // Last month
    let lastMonthYear = local.year;
    let lastMonth = local.month - 1; // Convert to 0-based for Date constructor
    if (lastMonth === 0) {
        lastMonth = 12;
        lastMonthYear -= 1;
    }
    // Start of last month
    const start = new Date(Date.UTC(lastMonthYear, lastMonth - 1, 1));
    // End of last month (start of current month, exclusive)
    const end = new Date(Date.UTC(local.year, local.month - 1, 1));
    return { start, end };
}
/**
 * Checks if a period has completed for a user's timezone.
 * This determines whether we should generate a review for the given period.
 *
 * @param reviewType - DAILY, WEEKLY, or MONTHLY
 * @param targetDate - The date representing the period to check
 * @param timezone - IANA timezone string
 * @returns true if the period has completed in the user's local time
 */
function hasPeriodCompletedForUser(reviewType, targetDate, timezone) {
    const now = new Date();
    const local = getLocalDateParts(timezone, now);
    const userTodayUTC = new Date(Date.UTC(local.year, local.month - 1, local.day));
    switch (reviewType) {
        case schema_1.ReviewType.DAILY: {
            // Daily is complete if targetDate < user's today
            const targetMidnight = new Date(Date.UTC(targetDate.getUTCFullYear(), targetDate.getUTCMonth(), targetDate.getUTCDate()));
            return targetMidnight < userTodayUTC;
        }
        case schema_1.ReviewType.WEEKLY: {
            // Get end of target week (next Monday 00:00)
            const targetWeekBounds = getWeekBounds(targetDate);
            return targetWeekBounds.end <= userTodayUTC;
        }
        case schema_1.ReviewType.MONTHLY: {
            // Get end of target month (1st of next month 00:00)
            const targetMonthBounds = getMonthBounds(targetDate);
            return targetMonthBounds.end <= userTodayUTC;
        }
    }
}
/**
 * Gets all timezones from COMMON_TIMEZONES where the local hour is currently 0 (midnight).
 * Used to efficiently query only users whose day just started.
 *
 * @param date - The current UTC time (defaults to now)
 * @returns Array of IANA timezone strings where it's currently midnight hour (00:00-00:59)
 */
function getTimezonesAtMidnight(date = new Date()) {
    const midnightTimezones = [];
    for (const tz of exports.COMMON_TIMEZONES) {
        try {
            const local = getLocalDateParts(tz, date);
            if (local.hour === 0) {
                midnightTimezones.push(tz);
            }
        }
        catch {
            // Invalid timezone, skip
        }
    }
    return midnightTimezones;
}
/**
 * Gets timezone info for cron scheduling.
 * Returns which timezones are at midnight, and additional context for weekly/monthly.
 *
 * @param date - The current UTC time (defaults to now)
 * @returns Object with timezones at midnight and their day/date info
 */
function getTimezoneScheduleInfo(date = new Date()) {
    const timezonesAtMidnight = [];
    const weeklyDue = [];
    const monthlyDue = [];
    for (const tz of exports.COMMON_TIMEZONES) {
        try {
            const local = getLocalDateParts(tz, date);
            if (local.hour === 0) {
                timezonesAtMidnight.push(tz);
                // Monday = 1 in our dayOfWeek (0=Sun, 1=Mon, ...)
                if (local.dayOfWeek === 1) {
                    weeklyDue.push(tz);
                }
                // 1st of month
                if (local.day === 1) {
                    monthlyDue.push(tz);
                }
            }
        }
        catch {
            // Invalid timezone, skip
        }
    }
    return { timezonesAtMidnight, weeklyDue, monthlyDue };
}
// ============================================================================
// Period Key Generation
// ============================================================================
/**
 * Generates a period key based on review type and target date.
 *
 * @param reviewType - DAILY, WEEKLY, or MONTHLY
 * @param date - The target date
 * @returns Period key string (e.g., "2024-01-15", "2024-W03", "2024-01")
 */
function getPeriodKey(reviewType, date) {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    switch (reviewType) {
        case schema_1.ReviewType.DAILY:
            return `${year}-${month}-${day}`;
        case schema_1.ReviewType.WEEKLY:
            const weekNumber = getISOWeekNumber(date);
            return `${year}-W${String(weekNumber).padStart(2, '0')}`;
        case schema_1.ReviewType.MONTHLY:
            return `${year}-${month}`;
    }
}
/**
 * Gets the ISO week number for a date.
 * ISO weeks start on Monday and week 1 is the week containing January 4th.
 */
function getISOWeekNumber(date) {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    // Set to nearest Thursday: current date + 4 - current day number
    // Make Sunday day number 7
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    // Get first day of year
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    // Calculate full weeks to nearest Thursday
    const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
    return weekNo;
}
// ============================================================================
// Period Boundaries
// ============================================================================
/**
 * Gets the start and end of a period based on review type.
 *
 * @param reviewType - DAILY, WEEKLY, or MONTHLY
 * @param date - A date within the period
 * @returns { start, end } - UTC dates for period boundaries (end is exclusive)
 */
function getPeriodBounds(reviewType, date) {
    switch (reviewType) {
        case schema_1.ReviewType.DAILY:
            return getDayBounds(date);
        case schema_1.ReviewType.WEEKLY:
            return getWeekBounds(date);
        case schema_1.ReviewType.MONTHLY:
            return getMonthBounds(date);
    }
}
/**
 * Gets the start and end of a day (UTC).
 */
function getDayBounds(date) {
    const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));
    const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, 0, 0, 0, 0));
    return { start, end };
}
/**
 * Gets the start and end of an ISO week (Monday-Sunday, UTC).
 */
function getWeekBounds(date) {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    // Get day of week (0 = Sunday, 1 = Monday, ..., 6 = Saturday)
    const dayOfWeek = d.getUTCDay();
    // Calculate days to subtract to get to Monday
    // If Sunday (0), go back 6 days; otherwise go back (dayOfWeek - 1) days
    const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    // Start is Monday 00:00:00 UTC
    const start = new Date(d);
    start.setUTCDate(d.getUTCDate() - daysToMonday);
    start.setUTCHours(0, 0, 0, 0);
    // End is next Monday 00:00:00 UTC (exclusive)
    const end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 7);
    return { start, end };
}
/**
 * Gets the start and end of a month (UTC).
 */
function getMonthBounds(date) {
    const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0));
    const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1, 0, 0, 0, 0));
    return { start, end };
}
// ============================================================================
// Date Formatting
// ============================================================================
/**
 * Formats a date as a human-readable string for reviews.
 */
function formatDateForReview(date) {
    return date.toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: 'UTC',
    });
}
/**
 * Formats a date range as a human-readable string.
 */
function formatDateRange(start, end) {
    const startStr = start.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
    });
    // End is exclusive, so subtract 1 day for display
    const displayEnd = new Date(end);
    displayEnd.setUTCDate(displayEnd.getUTCDate() - 1);
    const endStr = displayEnd.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC',
    });
    return `${startStr} - ${endStr}`;
}
/**
 * Gets the day name (Monday, Tuesday, etc.) for a date.
 */
function getDayName(date) {
    return date.toLocaleDateString('en-US', {
        weekday: 'long',
        timeZone: 'UTC',
    });
}
// ============================================================================
// Period Navigation
// ============================================================================
/**
 * Gets the previous period's date.
 */
function getPreviousPeriodDate(reviewType, date) {
    const result = new Date(date);
    switch (reviewType) {
        case schema_1.ReviewType.DAILY:
            result.setUTCDate(result.getUTCDate() - 1);
            break;
        case schema_1.ReviewType.WEEKLY:
            result.setUTCDate(result.getUTCDate() - 7);
            break;
        case schema_1.ReviewType.MONTHLY:
            result.setUTCMonth(result.getUTCMonth() - 1);
            break;
    }
    return result;
}
/**
 * Gets all dates in a period (useful for daily reviews within a week/month).
 */
function getDatesInPeriod(reviewType, date) {
    const { start, end } = getPeriodBounds(reviewType, date);
    const dates = [];
    const current = new Date(start);
    while (current < end) {
        dates.push(new Date(current));
        current.setUTCDate(current.getUTCDate() + 1);
    }
    return dates;
}
// ============================================================================
// Validation
// ============================================================================
/**
 * Checks if a review can be generated for a given date.
 * Reviews should only be generated for completed periods (not future).
 */
function canGenerateReview(reviewType, targetDate) {
    const now = new Date();
    const { end } = getPeriodBounds(reviewType, targetDate);
    // Can only generate reviews for periods that have ended
    return end <= now;
}
/**
 * Checks if a date is within a given period.
 */
function isDateInPeriod(date, reviewType, periodDate) {
    const { start, end } = getPeriodBounds(reviewType, periodDate);
    return date >= start && date < end;
}
// ============================================================================
// Period Key Parsing
// ============================================================================
/**
 * Parses a period key back into review type and date.
 */
function parsePeriodKey(periodKey) {
    // Daily: "2024-01-15"
    const dailyMatch = periodKey.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dailyMatch) {
        const [, year, month, day] = dailyMatch;
        return {
            reviewType: schema_1.ReviewType.DAILY,
            date: new Date(Date.UTC(parseInt(year), parseInt(month) - 1, parseInt(day))),
        };
    }
    // Weekly: "2024-W03"
    const weeklyMatch = periodKey.match(/^(\d{4})-W(\d{2})$/);
    if (weeklyMatch) {
        const [, year, week] = weeklyMatch;
        // Get the Monday of the given ISO week
        const jan4 = new Date(Date.UTC(parseInt(year), 0, 4));
        const dayOfWeek = jan4.getUTCDay() || 7;
        const mondayOfWeek1 = new Date(jan4);
        mondayOfWeek1.setUTCDate(jan4.getUTCDate() - dayOfWeek + 1);
        const targetMonday = new Date(mondayOfWeek1);
        targetMonday.setUTCDate(mondayOfWeek1.getUTCDate() + (parseInt(week) - 1) * 7);
        return {
            reviewType: schema_1.ReviewType.WEEKLY,
            date: targetMonday,
        };
    }
    // Monthly: "2024-01"
    const monthlyMatch = periodKey.match(/^(\d{4})-(\d{2})$/);
    if (monthlyMatch) {
        const [, year, month] = monthlyMatch;
        return {
            reviewType: schema_1.ReviewType.MONTHLY,
            date: new Date(Date.UTC(parseInt(year), parseInt(month) - 1, 1)),
        };
    }
    return null;
}
