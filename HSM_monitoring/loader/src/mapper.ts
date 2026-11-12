/**
 * Zdarzenie ARC* -> punkt (tagi, pola, czas) + wartosci tylko do SQLite, wg skompilowanej konfiguracji.
 *
 * Czas zdarzenia:
 *  1. z tresci (grupy time/date); brak daty -> ostatnia data z pliku albo data z nazwy zbioru;
 *     jesli tak zlozony czas jest > 12 h wczesniejszy od poprzedniego -> przejscie przez polnoc (+1 dzien),
 *  2. komunikaty bez czasu -> wg timeFallback: previous / next / file (czas z nazwy zbioru).
 */
import { CompiledConfig, CompiledMessage, CompiledValue, FieldType, fieldTypeOf } from './config';
import { fullText, Issue, RawEvent, SourceMeta } from './parse';
import { addDays, CalendarDate, HALF_DAY_MS, parseDate, parseDuration, parseTimeOfDay, zonedToEpochMs } from './time';

export interface FieldValue {
    type: FieldType;
    value: number | string | boolean;
}

export type TimeSource = 'message' | 'previous' | 'next' | 'file';

export interface MappedEvent {
    raw: RawEvent;
    /** Nazwa pliku wejsciowego */
    source: string;
    /** host_id z nazwy pliku / --host-id (niezaleznie od commonTags) */
    hostId?: string;
    measurement: string;
    timeMs: number;
    timeSource: TimeSource;
    tags: Record<string, string>;
    fields: Record<string, FieldValue>;
    /** Wartosci "sqlite" (wysoka kardynalnosc, np. DSN) */
    extra: Record<string, string>;
    /** false = punkt zapisany mimo niedopasowania (onNoMatch / unknownMessages = count) */
    matched: boolean;
    /** Czy punkt trafia do InfluxDB (influx-select include / exclude); SQLite dostaje wszystkie */
    influx: boolean;
}

export interface MessageStats {
    events: number;
    mapped: number;
    noMatch: number;
    skipped: number;
    noTime: number;
    /** Punkty wybrane do InfluxDB */
    influx: number;
}

export interface MapResult {
    events: MappedEvent[];
    issues: Issue[];
    stats: Map<string, MessageStats>;
}

interface Pending {
    raw: RawEvent;
    spec?: CompiledMessage;
    groups: Record<string, string | undefined>;
    matched: boolean;
    explicitMs?: number;
}

const FALSE_VALUES = /^(NO|N|FALSE|0|OFF)$/i;

type Converted = { kind: 'tag'; value: string } | { kind: 'field'; value: FieldValue } | { kind: 'sqlite'; value: string };

/** Wartosc grupy -> tag / pole / sqlite; null = brak wartosci, string = blad */
function convert(v: CompiledValue, raw: string | undefined): Converted | null | string {
    let text = raw?.trim();
    if (!text) text = v.default;
    if (text === undefined || text === '') {
        return v.to === 'bool' ? { kind: 'field', value: { type: 'bool', value: false } } : null;
    }
    if (v.map && Object.hasOwn(v.map, text)) text = v.map[text];

    switch (v.to) {
        case 'tag':
            return { kind: 'tag', value: text };
        case 'sqlite':
            return { kind: 'sqlite', value: text };
        case 'string':
            return { kind: 'field', value: { type: 'string', value: text } };
        case 'bool':
            return { kind: 'field', value: { type: 'bool', value: !FALSE_VALUES.test(text) } };
        case 'int': {
            const s = text.replace(/^\+/, '');
            if (!/^-?\d+$/.test(s)) return `"${text}" nie jest liczba calkowita`;
            return { kind: 'field', value: { type: 'int', value: Math.round(Number(s) * (v.multiply ?? 1)) } };
        }
        case 'float': {
            const n = Number(text.replace(',', '.'));
            if (!Number.isFinite(n)) return `"${text}" nie jest liczba`;
            return { kind: 'field', value: { type: 'float', value: n * (v.multiply ?? 1) } };
        }
        case 'duration': {
            const sec = parseDuration(text);
            if (sec === null) return `"${text}" nie jest czasem trwania (hh:mm:ss)`;
            return { kind: 'field', value: { type: fieldTypeOf('duration')!, value: sec } };
        }
    }
}

export function mapEvents(raw: RawEvent[], meta: SourceMeta, cfg: CompiledConfig): MapResult {
    const issues: Issue[] = [];
    const stats = new Map<string, MessageStats>();
    const stat = (msgId: string) => {
        let s = stats.get(msgId);
        if (!s) stats.set(msgId, (s = { events: 0, mapped: 0, noMatch: 0, skipped: 0, noTime: 0, influx: 0 }));
        return s;
    };

    // --- Przebieg 1: dopasowanie wzorcow i czas z tresci (kolejno, bo data jest dziedziczona) ---
    const pending: Pending[] = [];
    let lastDate: CalendarDate | undefined = meta.fileDate;
    let lastMs: number | undefined;

    for (const e of raw) {
        const s = stat(e.msgId);
        s.events++;
        const spec = cfg.messages.get(e.msgId);
        if (!spec) {
            if (cfg.unknownMessages === 'count') pending.push({ raw: e, groups: {}, matched: false });
            else s.skipped++;
            continue;
        }

        let groups: Record<string, string | undefined> | undefined = {};
        if (spec.patterns.length) {
            const text = fullText(e);
            groups = undefined;
            for (const re of spec.patterns) {
                const m = re.exec(text);
                if (m) {
                    groups = { ...m.groups };
                    break;
                }
            }
        }
        if (!groups) {
            s.noMatch++;
            if (spec.onNoMatch === 'warn') {
                issues.push({ line: e.line, msgId: e.msgId, kind: 'no-match', detail: fullText(e).slice(0, 120) });
            }
            if (spec.onNoMatch === 'count') pending.push({ raw: e, spec, groups: {}, matched: false });
            continue;
        }

        const item: Pending = { raw: e, spec, groups, matched: true };
        const timeText = spec.timeGroup ? groups[spec.timeGroup] : undefined;
        if (timeText !== undefined) {
            const msOfDay = parseTimeOfDay(timeText);
            const dateText = spec.dateGroup ? groups[spec.dateGroup] : undefined;
            const ownDate = dateText !== undefined ? parseDate(dateText) : null;
            if (msOfDay === null) {
                issues.push({ line: e.line, msgId: e.msgId, kind: 'time', detail: `niepoprawna godzina "${timeText}" - uzyto ${spec.timeFallback}` });
            } else if (dateText !== undefined && !ownDate) {
                issues.push({ line: e.line, msgId: e.msgId, kind: 'time', detail: `niepoprawna data "${dateText}" - uzyto ${spec.timeFallback}` });
            } else {
                let date = ownDate ?? lastDate;
                if (date) {
                    let ms = zonedToEpochMs(date, msOfDay, cfg.timezone);
                    if (!ownDate && lastMs !== undefined && lastMs - ms > HALF_DAY_MS) {
                        date = addDays(date, 1);
                        ms = zonedToEpochMs(date, msOfDay, cfg.timezone);
                    }
                    item.explicitMs = ms;
                    lastDate = date;
                    lastMs = ms;
                }
            }
        }
        pending.push(item);
    }

    // --- Przebieg 2: czas zastepczy i wartosci ---
    const fileMs = meta.fileDate && meta.fileMsOfDay !== undefined
        ? zonedToEpochMs(meta.fileDate, meta.fileMsOfDay, cfg.timezone)
        : undefined;
    const prev: (number | undefined)[] = [];
    let carry: number | undefined;
    for (const p of pending) {
        prev.push(carry);
        if (p.explicitMs !== undefined) carry = p.explicitMs;
    }
    const next: (number | undefined)[] = new Array(pending.length);
    carry = undefined;
    for (let i = pending.length - 1; i >= 0; i--) {
        next[i] = carry;
        if (pending[i].explicitMs !== undefined) carry = pending[i].explicitMs;
    }

    const events: MappedEvent[] = [];
    pending.forEach((p, i) => {
        const e = p.raw;
        const s = stat(e.msgId);
        let timeMs = p.explicitMs;
        let timeSource: TimeSource = 'message';
        if (timeMs === undefined) {
            const fallback = p.spec?.timeFallback ?? 'previous';
            const candidates: [TimeSource, number | undefined][] =
                fallback === 'next' ? [['next', next[i]], ['previous', prev[i]], ['file', fileMs]]
                    : fallback === 'file' ? [['file', fileMs], ['previous', prev[i]]]
                        : [['previous', prev[i]], ['file', fileMs]];
            const found = candidates.find(([, ms]) => ms !== undefined);
            if (!found) {
                s.noTime++;
                issues.push({ line: e.line, msgId: e.msgId, kind: 'time', detail: 'brak czasu (tresc, sasiednie komunikaty, nazwa pliku) - pominiety' });
                return;
            }
            [timeSource, timeMs] = found as [TimeSource, number];
        }

        const tags: Record<string, string> = {};
        const common: Record<string, string | undefined> = {
            sysname: e.sysname, host_id: meta.hostId, log_type: meta.logType, msg_id: e.msgId, severity: e.msgId.slice(-1),
        };
        for (const t of cfg.commonTags) if (common[t]) tags[t] = common[t]!;
        Object.assign(tags, p.spec?.constTags);

        const fields: Record<string, FieldValue> = { [cfg.countField]: { type: 'int', value: 1 } };
        const extra: Record<string, string> = {};
        if (p.matched && p.spec) {
            for (const v of p.spec.values) {
                const c = convert(v, p.groups[v.group]);
                if (c === null) continue;
                if (typeof c === 'string') {
                    issues.push({ line: e.line, msgId: e.msgId, kind: 'value', detail: `${v.group}: ${c}` });
                    continue;
                }
                if (c.kind === 'tag') tags[v.name] = c.value;
                else if (c.kind === 'field') fields[v.name] = c.value;
                else extra[v.name] = c.value;
            }
        }

        const influx = cfg.toInflux(e.msgId);
        s.mapped++;
        if (influx) s.influx++;
        events.push({
            raw: e,
            source: meta.source,
            hostId: meta.hostId,
            measurement: p.spec?.measurement ?? cfg.defaultMeasurement,
            timeMs,
            timeSource,
            tags,
            fields,
            extra,
            matched: p.matched,
            influx,
        });
    });

    return { events, issues, stats };
}
