/**
 * Odczyt pliku po ekstrakcji DFSORT:
 *
 *   SYS1    ;00000042;ARC1802I FAST REPLICATION BACKUP HAS COMPLETED ...
 *   1-8 SYSNAME ; 10-17 GROUP ID (wspolny dla linii (CONT.)) ; 19+ oryginalna linia logu
 *
 * Kolejne linie z tym samym SYSNAME + GROUP ID tworza jedno zdarzenie; tresc linii kontynuacji
 * (bez ID komunikatu i znacznika "(CONT.)") trafia do `cont`.
 */
import path from 'node:path';
import { CalendarDate, parseDate, parseTimeOfDay } from './time';

export interface RawEvent {
    line: number;
    sysname: string;
    groupId: string;
    msgId: string;
    /** Tresc pierwszej linii bez ID komunikatu */
    text: string;
    /** Tresc linii kontynuacji */
    cont: string[];
}

export interface Issue {
    line: number;
    msgId?: string;
    kind: 'format' | 'no-match' | 'value' | 'time';
    detail: string;
}

export interface SourceMeta {
    /** Nazwa pliku (bez katalogu) - identyfikuje zrodlo w SQLite */
    source: string;
    hostId?: string;
    logType?: string;
    fileDate?: CalendarDate;
    fileMsOfDay?: number;
}

const MSG_ID = /^(ARC\d{4}[A-Z])(?:\s+|$)/;
const CONT = /^\(CONT\.?\)\s*/i;

/** Tresc do dopasowania wzorcem: pierwsza linia + linie (CONT.) sklejone spacja */
export const fullText = (e: RawEvent) => (e.cont.length ? `${e.text} ${e.cont.join(' ')}` : e.text);

export function parseEvents(content: string): { events: RawEvent[]; issues: Issue[] } {
    const events: RawEvent[] = [];
    const issues: Issue[] = [];
    let current: RawEvent | undefined;
    const seen = new Map<string, number>(); // SYSNAME;GROUP ID -> linia pierwszego wystapienia

    content.split(/\r?\n/).forEach((rawLine, index) => {
        const line = index + 1;
        if (rawLine.trim() === '') return;
        const first = rawLine.indexOf(';');
        const second = first < 0 ? -1 : rawLine.indexOf(';', first + 1);
        if (second < 0) {
            issues.push({ line, kind: 'format', detail: 'brak separatorow ";" (oczekiwano SYSNAME;GROUPID;tekst)' });
            return;
        }
        const sysname = rawLine.slice(0, first).trim();
        const groupId = rawLine.slice(first + 1, second).trim();
        const body = rawLine.slice(second + 1).trim();
        const id = MSG_ID.exec(body);
        if (!/^\d+$/.test(groupId) || !id) {
            issues.push({ line, kind: 'format', detail: `niepoprawny rekord: ${rawLine.slice(0, 60)}` });
            return;
        }
        const rest = body.slice(id[0].length).trim();

        if (current && current.groupId === groupId && current.sysname === sysname) {
            current.cont.push(rest.replace(CONT, '').trim());
            return;
        }
        const key = `${sysname};${groupId}`;
        const firstLine = seen.get(key);
        if (firstLine !== undefined) {
            issues.push({ line, msgId: id[1], kind: 'format', detail: `GROUP ID ${groupId} powtorzony (pierwszy raz w linii ${firstLine}) - `
                + 'punkty z tym samym czasem i tagami nadpisza sie w InfluxDB' });
        } else {
            seen.set(key, line);
        }
        current = { line, sysname, groupId, msgId: id[1], text: rest, cont: [] };
        events.push(current);
    });
    return { events, issues };
}

/** host_id, log_type i czas logu z nazwy zbioru, np. HSMACT.HA.BAKLOG.D26307.T010000 */
export function sourceMeta(file: string, pattern: RegExp): SourceMeta {
    const source = path.basename(file);
    const m = pattern.exec(source);
    const g = m?.groups ?? {};
    return {
        source,
        hostId: g.host_id?.toUpperCase(),
        logType: g.log_type?.toUpperCase(),
        fileDate: g.date ? parseDate(g.date) ?? undefined : undefined,
        fileMsOfDay: g.time ? parseTimeOfDay(g.time) ?? undefined : undefined,
    };
}
