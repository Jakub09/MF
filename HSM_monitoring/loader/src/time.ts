/**
 * Daty i czasy z komunikatow ARC* oraz z nazwy zbioru logu.
 *
 * Czas w logu HSM to czas lokalny LPAR-a, bez strefy - przeliczamy go na UTC wg `timezone`
 * z konfiguracji (Intl, bez dodatkowych bibliotek).
 */

export interface CalendarDate {
    y: number;
    m: number; // 1-12
    d: number;
}

const DAY_MS = 86_400_000;

/** Rok dwucyfrowy z logow HSM (yy/mm/dd, Dyyddd) - zawsze 20yy */
const fullYear = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));

function fromJulian(year: number, dayOfYear: number): CalendarDate | null {
    const daysInYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365;
    if (dayOfYear < 1 || dayOfYear > daysInYear) return null;
    const dt = new Date(Date.UTC(year, 0, dayOfYear));
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function valid(date: CalendarDate): CalendarDate | null {
    const dt = new Date(Date.UTC(date.y, date.m - 1, date.d));
    return dt.getUTCFullYear() === date.y && dt.getUTCMonth() === date.m - 1 && dt.getUTCDate() === date.d ? date : null;
}

/**
 * Obslugiwane formaty:
 *   yy/mm/dd, yyyy/mm/dd  (ARC07xx, ARC0522I ...)
 *   yyyy-mm-dd
 *   yyyy.ddd, yy.ddd      (data julianska, np. DFSMSdss w ARC0640I)
 *   yyddd, yyyyddd        (np. z nazwy zbioru Dyyddd)
 */
export function parseDate(text: string): CalendarDate | null {
    const s = text.trim();
    let m = /^(\d{2}|\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(s);
    if (m) return valid({ y: fullYear(m[1]), m: Number(m[2]), d: Number(m[3]) });
    m = /^(\d{2}|\d{4})\.?(\d{3})$/.exec(s);
    if (m) return fromJulian(fullYear(m[1]), Number(m[2]));
    return null;
}

/** hh:mm[:ss[.fff]] albo hhmmss -> milisekundy od polnocy */
export function parseTimeOfDay(text: string): number | null {
    const s = text.trim();
    let h: number, mi: number, sec = 0, ms = 0;
    let m = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,6}))?)?$/.exec(s);
    if (m) {
        [h, mi] = [Number(m[1]), Number(m[2])];
        if (m[3]) sec = Number(m[3]);
        if (m[4]) ms = Math.round(Number(`0.${m[4]}`) * 1000);
    } else if ((m = /^(\d{2})(\d{2})(\d{2})$/.exec(s))) {
        [h, mi, sec] = [Number(m[1]), Number(m[2]), Number(m[3])];
    } else {
        return null;
    }
    if (h > 23 || mi > 59 || sec > 60) return null;
    return ((h * 60 + mi) * 60 + sec) * 1000 + ms;
}

/** Czas trwania: hh:mm:ss (godziny moga byc > 24), mm:ss albo liczba sekund -> sekundy */
export function parseDuration(text: string): number | null {
    const s = text.trim();
    if (/^\d+$/.test(s)) return Number(s);
    const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(s);
    if (!m) return null;
    return (Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3]);
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
    let f = formatters.get(timeZone);
    if (!f) {
        f = new Intl.DateTimeFormat('en-US', {
            timeZone, hourCycle: 'h23',
            year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
        });
        formatters.set(timeZone, f);
    }
    return f;
}

/** Rzuca RangeError dla nieznanej strefy */
export function assertTimeZone(timeZone: string): void {
    formatter(timeZone);
}

/** Przesuniecie strefy (ms) w danej chwili UTC */
function offsetMs(utcMs: number, timeZone: string): number {
    const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(utcMs)).map(p => [p.type, p.value]));
    const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
        Number(parts.hour), Number(parts.minute), Number(parts.second));
    return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Czas lokalny (data + ms od polnocy w strefie timeZone) -> epoch ms UTC */
export function zonedToEpochMs(date: CalendarDate, msOfDay: number, timeZone: string): number {
    const wall = Date.UTC(date.y, date.m - 1, date.d) + msOfDay;
    const first = offsetMs(wall, timeZone);
    let ts = wall - first;
    // Na granicy zmiany czasu przesuniecie po korekcie moze byc inne
    const second = offsetMs(ts, timeZone);
    if (second !== first) ts = wall - second;
    return ts;
}

export function addDays(date: CalendarDate, days: number): CalendarDate {
    const dt = new Date(Date.UTC(date.y, date.m - 1, date.d) + days * DAY_MS);
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

export const HALF_DAY_MS = DAY_MS / 2;

const weekdayFormatters = new Map<string, Intl.DateTimeFormat>();

/** Data, minuta dnia i dzien tygodnia (0 = niedziela) w strefie timeZone */
export function localParts(utcMs: number, timeZone: string): { date: CalendarDate; minutes: number; weekday: number } {
    let f = weekdayFormatters.get(timeZone);
    if (!f) {
        f = new Intl.DateTimeFormat('en-US', {
            timeZone, hourCycle: 'h23', weekday: 'short',
            year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        });
        weekdayFormatters.set(timeZone, f);
    }
    const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map(x => [x.type, x.value]));
    return {
        date: { y: Number(p.year), m: Number(p.month), d: Number(p.day) },
        minutes: Number(p.hour) * 60 + Number(p.minute),
        weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday),
    };
}

export const pad2 = (n: number) => String(n).padStart(2, '0');
export const hhmm = (minutes: number) => {
    const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
    return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
};
