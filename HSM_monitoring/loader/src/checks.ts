/**
 * Kontrola terminu konca zadan (durations.json: expectedEnd, days) przy kazdym uruchomieniu loadera.
 *
 * Termin D = dzien + expectedEnd (czas lokalny). Przebieg nalezy do terminu D, jesli zaczal sie po poprzednim
 * terminie (D - 1 dzien, przy "days" - poprzedni dzien z listy), a przed D; koniec moze byc pozniej (po terminie).
 * Dla terminow, ktore minely (D <= as-of) w ostatnich 36 h:
 *   - koniec jest                  -> COMPLETED (OK) albo COMPLETED_LATE (po terminie, INFO; po wczesniejszym
 *                                     WARNING / ERROR - "aktualizujemy czas")
 *   - konca brak, pierwszy raz     -> WARNING (RUNNING - start bez konca, albo NOT_STARTED)
 *   - konca brak, kolejny ekstrakt -> ERROR (drugie i ostatnie powiadomienie)
 * Stan miedzy uruchomieniami: SQLite, tabela hsm_task_check. Kontrolowane sa tylko pary zadanie / host, dla
 * ktorych zadanie juz kiedys sie wykonalo (brak falszywych alarmow, gdy zadania na danym hoscie nie ma).
 */
import type { CompiledDurations, OpenStart } from './durations';
import type { FieldValue, MappedEvent } from './mapper';
import type { TaskCheck } from './sqlite-store';
import { addDays, hhmm, localParts, pad2, zonedToEpochMs } from './time';

const HOUR = 3_600_000;
const LOOKBACK_MS = 36 * HOUR;
/** Ponowne uruchomienie na tym samym ekstrakcie (as-of blizej niz 1 h) nie eskaluje WARNING -> ERROR */
export const MIN_RECHECK_MS = HOUR;
export const CHECK_MEASUREMENT = 'MF.HSM.TASK_CHECK';

export interface CompletedTask {
    task: string;
    sysname: string;
    hostId?: string;
    startMs: number;
    endMs: number;
    status: string;
}

export interface Notification {
    level: 'INFO' | 'WARNING' | 'ERROR';
    task: string;
    sysname: string;
    hostId?: string;
    deadlineMs: number;
    text: string;
}

export interface CheckInput {
    durations: CompiledDurations;
    timezone: string;
    countField: string;
    asOfMs: number;
    /** zakonczone zadania: historia (SQLite) + biezace uruchomienie */
    completed: CompletedTask[];
    /** starty bez konca (po parowaniu z historia) */
    open: OpenStart[];
    /** hosty aktywne: pierwsze zdarzenie */
    hosts: { sysname: string; hostId?: string; firstMs: number }[];
    previous: (task: string, sysname: string, hostId: string | undefined, deadlineMs: number) => TaskCheck | undefined;
}

const hostKey = (sysname: string, hostId?: string) => `${sysname}/${hostId ?? '-'}`;

export function evaluateChecks(i: CheckInput): { notifications: Notification[]; checks: TaskCheck[]; points: MappedEvent[] } {
    const notifications: Notification[] = [];
    const checks: TaskCheck[] = [];
    const points: MappedEvent[] = [];
    const local = (ms: number) => localParts(ms, i.timezone);
    const fmt = (ms: number) => localStamp(ms, i.timezone);
    const dur = (ms: number) => `${Math.floor(ms / HOUR)} h ${pad2(Math.floor((ms % HOUR) / 60000))} min`;

    for (const task of i.durations.tasks) {
        if (task.expectedEndMin === undefined) continue;
        const ran = new Set([...i.completed.filter(c => c.task === task.name).map(c => hostKey(c.sysname, c.hostId)),
            ...i.open.filter(o => o.task === task.name).map(o => hostKey(o.sysname, o.hostId))]);

        for (const host of i.hosts) {
            if (!ran.has(hostKey(host.sysname, host.hostId))) continue;
            const done = i.completed.filter(c => c.task === task.name && c.sysname === host.sysname && c.hostId === host.hostId);
            const running = i.open.filter(o => o.task === task.name && o.sysname === host.sysname && o.hostId === host.hostId);

            /** Poprzedni termin (dzien wczesniej, a przy "days" - poprzedni dzien z listy) */
            const prevDeadline = (deadline: number): number => {
                let date = local(deadline).date;
                for (let k = 0; k < 7; k++) {
                    date = addDays(date, -1);
                    const p = zonedToEpochMs(date, task.expectedEndMin! * 60_000, i.timezone);
                    if (!task.days || task.days.has(local(p).weekday)) return p;
                }
                return deadline - 7 * 24 * HOUR;
            };

            // terminy z ostatnich 36 h
            const deadlines: number[] = [];
            for (let date = local(i.asOfMs - LOOKBACK_MS - 24 * HOUR).date; ; date = addDays(date, 1)) {
                const d = zonedToEpochMs(date, task.expectedEndMin * 60_000, i.timezone);
                if (d > i.asOfMs) break;
                const wd = local(d).weekday;
                if (d > i.asOfMs - LOOKBACK_MS && d >= host.firstMs && (!task.days || task.days.has(wd))) deadlines.push(d);
            }

            for (const deadline of deadlines) {
                const prev = i.previous(task.name, host.sysname, host.hostId, deadline);
                if (prev && (prev.state === 'COMPLETED' || prev.state === 'COMPLETED_LATE')) continue;
                const label = `${task.name} ${host.sysname}/${host.hostId ?? '-'} (termin ${fmt(deadline)})`;
                const since = prevDeadline(deadline);
                const end = done.filter(c => c.startMs >= since && c.startMs < deadline && c.endMs <= i.asOfMs)
                    .sort((a, b) => b.endMs - a.endMs)[0];
                let next: TaskCheck | undefined;
                let note: Notification | undefined;

                if (end) {
                    const late = end.endMs > deadline;
                    next = {
                        task: task.name, sysname: host.sysname, hostId: host.hostId, deadlineMs: deadline,
                        state: late ? 'COMPLETED_LATE' : 'COMPLETED', level: 'OK', startMs: end.startMs, endMs: end.endMs,
                        warnedMs: prev?.warnedMs, erroredMs: prev?.erroredMs, updatedMs: i.asOfMs,
                    };
                    if (late) {
                        note = { level: 'INFO', task: task.name, sysname: host.sysname, hostId: host.hostId, deadlineMs: deadline,
                            text: `${label}: zakonczone po terminie o ${fmt(end.endMs)} (+${dur(end.endMs - deadline)}), status ${end.status}` };
                    } else if (prev) {
                        // wczesniej WARNING / ERROR, a koniec (przed terminem) dotarl dopiero w kolejnym ekstrakcie
                        note = { level: 'INFO', task: task.name, sysname: host.sysname, hostId: host.hostId, deadlineMs: deadline,
                            text: `${label}: koniec w kolejnym ekstrakcie - zakonczone o ${fmt(end.endMs)} (przed terminem), status ${end.status}` };
                    }
                } else {
                    if (prev?.level === 'ERROR') continue; // drugie powiadomienie juz bylo
                    if (prev?.level === 'WARNING' && i.asOfMs - (prev.warnedMs ?? 0) < MIN_RECHECK_MS) continue;
                    const start = running.filter(o => o.start.timeMs >= since && o.start.timeMs <= i.asOfMs)
                        .sort((a, b) => b.start.timeMs - a.start.timeMs)[0];
                    const level = prev?.level === 'WARNING' ? 'ERROR' : 'WARNING';
                    next = {
                        task: task.name, sysname: host.sysname, hostId: host.hostId, deadlineMs: deadline,
                        state: start ? 'RUNNING' : 'NOT_STARTED', level, startMs: start?.start.timeMs,
                        warnedMs: level === 'WARNING' ? i.asOfMs : prev?.warnedMs, erroredMs: level === 'ERROR' ? i.asOfMs : undefined, updatedMs: i.asOfMs,
                    };
                    const what = start ? `w toku od ${fmt(start.start.timeMs)} (${dur(i.asOfMs - start.start.timeMs)})` : 'nie wystartowalo (brak komunikatu startu)';
                    note = { level, task: task.name, sysname: host.sysname, hostId: host.hostId, deadlineMs: deadline,
                        text: `${label}: brak konca${level === 'ERROR' ? ' w kolejnym ekstrakcie' : ''} - ${what}` };
                }

                checks.push(next);
                if (note) notifications.push(note);
                points.push(checkPoint(next, i, deadline));
            }
        }
    }
    return { notifications, checks, points };
}

/** "2026-11-12 06:45" w strefie z konfiguracji */
const localStamp = (ms: number, tz: string) => {
    const p = localParts(ms, tz);
    return `${p.date.y}-${pad2(p.date.m)}-${pad2(p.date.d)} ${hhmm(p.minutes)}`;
};

function checkPoint(c: TaskCheck, i: CheckInput, deadline: number): MappedEvent {
    const tags: Record<string, string> = { sysname: c.sysname, task: c.task, state: c.state, level: c.level };
    if (c.hostId) tags.host_id = c.hostId;
    const fields: Record<string, FieldValue> = {
        [i.countField]: { type: 'int', value: 1 },
        level_num: { type: 'int', value: c.level === 'ERROR' ? 2 : c.level === 'WARNING' ? 1 : 0 },
        deadline: { type: 'string', value: localStamp(deadline, i.timezone) },
    };
    if (c.endMs !== undefined) fields.late_s = { type: 'int', value: Math.round((c.endMs - deadline) / 1000) };
    if (c.state === 'RUNNING' && c.startMs !== undefined) fields.running_s = { type: 'int', value: Math.round((i.asOfMs - c.startMs) / 1000) };
    return {
        // numer dnia terminu jako "GROUP ID" -> rozne nanosekundy dla kilku terminow w jednym uruchomieniu
        raw: { line: 0, sysname: c.sysname, groupId: String(Math.floor(deadline / 86_400_000)), msgId: 'CHECK', text: '', cont: [] },
        source: 'check',
        hostId: c.hostId,
        measurement: CHECK_MEASUREMENT,
        timeMs: i.asOfMs,
        timeSource: 'file',
        tags,
        fields,
        extra: {},
        matched: true,
        influx: true,
    };
}
