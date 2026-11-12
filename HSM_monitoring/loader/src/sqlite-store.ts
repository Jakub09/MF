/**
 * Zdarzenia w SQLite: pelna tresc + wszystkie wyciagniete wartosci (tagi, pola, "sqlite").
 * Tu trafiaja dane o wysokiej kardynalnosci (DSN, klucze BCDS ...) i stad beda liczone pary start/koniec.
 * Klucz (source, sysname, group_id, line) - ponowny import tego samego pliku nadpisuje rekordy.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { TaskRecord } from './durations';
import type { FieldValue, MappedEvent, TimeSource } from './mapper';
import { fullText, SourceMeta } from './parse';

/**
 * node:sqlite jest wbudowany w Node (22.13+), ale Node 22 oznacza go jako eksperymentalny i wypisuje
 * ostrzezenie przy pierwszym uzyciu - tylko to jedno ostrzezenie jest wyciszane.
 * (Skopiowane z grafana_automation_js/src/infrastructure/sqlite.ts)
 */
function loadSqlite(): typeof import('node:sqlite') {
    const original = process.emitWarning;
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
        if (String(typeof warning === 'string' ? warning : warning.message).includes('SQLite')) return;
        return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
    }) as typeof process.emitWarning;
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require('node:sqlite') as typeof import('node:sqlite');
    } finally {
        process.emitWarning = original;
    }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS hsm_event (
    source      TEXT    NOT NULL,          -- nazwa pliku wejsciowego
    sysname     TEXT    NOT NULL,
    group_id    TEXT    NOT NULL,
    line        INTEGER NOT NULL,
    host_id     TEXT,
    log_type    TEXT,
    msg_id      TEXT    NOT NULL,
    time_ms     INTEGER NOT NULL,          -- epoch ms UTC
    time_utc    TEXT    NOT NULL,
    time_source TEXT    NOT NULL,          -- message / previous / next / file
    measurement TEXT    NOT NULL,
    matched     INTEGER NOT NULL,
    influx      INTEGER NOT NULL,          -- 1 = punkt wyslany do InfluxDB (influx-select)
    tags        TEXT    NOT NULL,          -- JSON
    fields      TEXT    NOT NULL,          -- JSON
    extra       TEXT    NOT NULL,          -- JSON, wartosci "sqlite"
    text        TEXT    NOT NULL,          -- tresc z liniami (CONT.)
    loaded_at   TEXT    NOT NULL,
    PRIMARY KEY (source, sysname, group_id, line)
);
CREATE INDEX IF NOT EXISTS hsm_event_msg_time ON hsm_event (msg_id, time_ms);
CREATE INDEX IF NOT EXISTS hsm_event_host_time ON hsm_event (sysname, host_id, time_ms);

CREATE TABLE IF NOT EXISTS hsm_task (
    task        TEXT    NOT NULL,          -- nazwa z durations.json, np. VOLBACKUP
    sysname     TEXT    NOT NULL,
    host_id     TEXT    NOT NULL,
    task_key    TEXT    NOT NULL,          -- JSON wartosci klucza, np. {"volser":"PRD001"}
    start_ms    INTEGER NOT NULL,
    end_ms      INTEGER NOT NULL,
    duration_s  INTEGER NOT NULL,
    status      TEXT    NOT NULL,
    exact       INTEGER NOT NULL,          -- 0 = czas zastepczy (komunikat bez czasu w tresci)
    start_msg   TEXT    NOT NULL,
    end_msg     TEXT    NOT NULL,
    end_source  TEXT    NOT NULL,
    metrics     TEXT    NOT NULL,          -- JSON wynikow aggregate, np. {"volumes":40,"datasets":5210}
    loaded_at   TEXT    NOT NULL,
    PRIMARY KEY (task, sysname, host_id, task_key, end_ms)
);
CREATE INDEX IF NOT EXISTS hsm_task_time ON hsm_task (task, end_ms);

-- Przetworzone pliki ekstraktow (tryb katalogu: tylko nowe / zmienione pliki)
CREATE TABLE IF NOT EXISTS hsm_file (
    name         TEXT    NOT NULL PRIMARY KEY,   -- nazwa pliku (bez katalogu)
    size         INTEGER NOT NULL,
    mtime_ms     INTEGER NOT NULL,
    events       INTEGER NOT NULL,
    processed_at TEXT    NOT NULL
);

-- Kontrola terminu konca zadan (expectedEnd): jeden wiersz na zadanie / host / termin
CREATE TABLE IF NOT EXISTS hsm_task_check (
    task        TEXT    NOT NULL,
    sysname     TEXT    NOT NULL,
    host_id     TEXT    NOT NULL,
    deadline_ms INTEGER NOT NULL,          -- termin (expectedEnd danego dnia), epoch ms UTC
    state       TEXT    NOT NULL,          -- RUNNING / NOT_STARTED / COMPLETED / COMPLETED_LATE
    level       TEXT    NOT NULL,          -- OK / WARNING / ERROR
    start_ms    INTEGER,
    end_ms      INTEGER,
    warned_ms   INTEGER,                   -- as-of uruchomienia, ktore dalo WARNING
    errored_ms  INTEGER,                   -- as-of uruchomienia, ktore dalo ERROR
    updated_ms  INTEGER NOT NULL,
    PRIMARY KEY (task, sysname, host_id, deadline_ms)
);
`;

export class SqliteStore {
    private readonly db: DatabaseSync;

    constructor(file: string) {
        const { DatabaseSync } = loadSqlite();
        this.db = new DatabaseSync(file);
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec(SCHEMA);
    }

    public save(meta: SourceMeta, events: MappedEvent[]): void {
        const insert = this.db.prepare(`INSERT OR REPLACE INTO hsm_event
            (source, sysname, group_id, line, host_id, log_type, msg_id, time_ms, time_utc, time_source,
             measurement, matched, influx, tags, fields, extra, text, loaded_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const loadedAt = new Date().toISOString();
        this.db.exec('BEGIN');
        try {
            for (const e of events) {
                const fields = Object.fromEntries(Object.entries(e.fields).map(([k, v]) => [k, v.value]));
                insert.run(meta.source, e.raw.sysname, e.raw.groupId, e.raw.line, meta.hostId ?? null, meta.logType ?? null,
                    e.raw.msgId, e.timeMs, new Date(e.timeMs).toISOString(), e.timeSource, e.measurement, e.matched ? 1 : 0, e.influx ? 1 : 0,
                    JSON.stringify(e.tags), JSON.stringify(fields), JSON.stringify(e.extra), fullText(e.raw), loadedAt);
            }
            this.db.exec('COMMIT');
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
    }

    public saveTasks(tasks: TaskRecord[]): void {
        const insert = this.db.prepare(`INSERT OR REPLACE INTO hsm_task
            (task, sysname, host_id, task_key, start_ms, end_ms, duration_s, status, exact, start_msg, end_msg, end_source, metrics, loaded_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const loadedAt = new Date().toISOString();
        this.db.exec('BEGIN');
        try {
            for (const t of tasks) {
                insert.run(t.task, t.sysname, t.hostId ?? '', JSON.stringify(t.key), t.start.timeMs, t.end.timeMs, t.durationS,
                    t.status, t.exact ? 1 : 0, t.start.raw.msgId, t.end.raw.msgId, t.end.source, JSON.stringify(t.metrics), loadedAt);
            }
            this.db.exec('COMMIT');
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
    }

    /** Zdarzenia z poprzednich uruchomien (do parowania start / koniec miedzy ekstraktami) */
    public loadEvents(fromMs: number, toMs: number, msgIds: string[]): MappedEvent[] {
        if (!msgIds.length) return [];
        const rows = this.db.prepare(`SELECT source, sysname, group_id, line, host_id, msg_id, time_ms, time_source, measurement,
                matched, influx, tags, fields, extra, text FROM hsm_event
            WHERE time_ms >= ? AND time_ms <= ? AND msg_id IN (${msgIds.map(() => '?').join(', ')}) ORDER BY time_ms`)
            .all(fromMs, toMs, ...msgIds) as Record<string, string | number | null>[];
        return rows.map(r => {
            const fields: Record<string, FieldValue> = {};
            for (const [k, v] of Object.entries(JSON.parse(String(r.fields)) as Record<string, unknown>)) {
                fields[k] = typeof v === 'boolean' ? { type: 'bool', value: v }
                    : typeof v === 'number' ? { type: Number.isInteger(v) ? 'int' : 'float', value: v } : { type: 'string', value: String(v) };
            }
            return {
                raw: { line: Number(r.line), sysname: String(r.sysname), groupId: String(r.group_id), msgId: String(r.msg_id), text: String(r.text), cont: [] },
                source: String(r.source),
                hostId: r.host_id === null ? undefined : String(r.host_id),
                measurement: String(r.measurement),
                timeMs: Number(r.time_ms),
                timeSource: String(r.time_source) as TimeSource,
                tags: JSON.parse(String(r.tags)),
                fields,
                extra: JSON.parse(String(r.extra)),
                matched: r.matched === 1,
                influx: r.influx === 1,
            };
        });
    }

    /** Zakonczone zadania z historii (statystyki --task-times, kontrola terminow) */
    public loadTasks(fromMs = 0): StoredTask[] {
        return (this.db.prepare(`SELECT task, sysname, host_id, start_ms, end_ms, duration_s, status, exact FROM hsm_task
            WHERE end_ms >= ? ORDER BY end_ms`).all(fromMs) as Record<string, string | number>[])
            .map(r => ({
                task: String(r.task), sysname: String(r.sysname), hostId: String(r.host_id) || undefined,
                startMs: Number(r.start_ms), endMs: Number(r.end_ms), durationS: Number(r.duration_s), status: String(r.status), exact: r.exact === 1,
            }));
    }

    /** Systemy / hosty widziane w danych: pierwsze i ostatnie zdarzenie */
    public hosts(): { sysname: string; hostId?: string; firstMs: number; lastMs: number }[] {
        return (this.db.prepare('SELECT sysname, host_id, min(time_ms) AS first_ms, max(time_ms) AS last_ms FROM hsm_event GROUP BY sysname, host_id')
            .all() as Record<string, string | number | null>[])
            .map(r => ({ sysname: String(r.sysname), hostId: r.host_id === null ? undefined : String(r.host_id), firstMs: Number(r.first_ms), lastMs: Number(r.last_ms) }));
    }

    /** Czy plik o tej nazwie, rozmiarze i czasie modyfikacji byl juz przetworzony */
    public isProcessed(name: string, size: number, mtimeMs: number): boolean {
        const r = this.db.prepare('SELECT size, mtime_ms FROM hsm_file WHERE name = ?').get(name) as { size: number; mtime_ms: number } | undefined;
        return !!r && Number(r.size) === size && Number(r.mtime_ms) === Math.round(mtimeMs);
    }

    public markProcessed(name: string, size: number, mtimeMs: number, events: number): void {
        this.db.prepare('INSERT OR REPLACE INTO hsm_file (name, size, mtime_ms, events, processed_at) VALUES (?, ?, ?, ?, ?)')
            .run(name, size, Math.round(mtimeMs), events, new Date().toISOString());
    }

    public getCheck(task: string, sysname: string, hostId: string | undefined, deadlineMs: number): TaskCheck | undefined {
        const r = this.db.prepare('SELECT * FROM hsm_task_check WHERE task = ? AND sysname = ? AND host_id = ? AND deadline_ms = ?')
            .get(task, sysname, hostId ?? '', deadlineMs) as Record<string, string | number | null> | undefined;
        if (!r) return undefined;
        const num = (v: string | number | null) => (v === null ? undefined : Number(v));
        return {
            task, sysname, hostId, deadlineMs, state: String(r.state) as TaskCheck['state'], level: String(r.level) as TaskCheck['level'],
            startMs: num(r.start_ms), endMs: num(r.end_ms), warnedMs: num(r.warned_ms), erroredMs: num(r.errored_ms), updatedMs: Number(r.updated_ms),
        };
    }

    public putCheck(c: TaskCheck): void {
        this.db.prepare(`INSERT OR REPLACE INTO hsm_task_check
            (task, sysname, host_id, deadline_ms, state, level, start_ms, end_ms, warned_ms, errored_ms, updated_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(c.task, c.sysname, c.hostId ?? '', c.deadlineMs, c.state, c.level, c.startMs ?? null, c.endMs ?? null,
                c.warnedMs ?? null, c.erroredMs ?? null, c.updatedMs);
    }

    public close(): void {
        this.db.close();
    }
}

export interface StoredTask {
    task: string;
    sysname: string;
    hostId?: string;
    startMs: number;
    endMs: number;
    durationS: number;
    status: string;
    exact: boolean;
}

export interface TaskCheck {
    task: string;
    sysname: string;
    hostId?: string;
    deadlineMs: number;
    state: 'RUNNING' | 'NOT_STARTED' | 'COMPLETED' | 'COMPLETED_LATE';
    level: 'OK' | 'WARNING' | 'ERROR';
    startMs?: number;
    endMs?: number;
    warnedMs?: number;
    erroredMs?: number;
    updatedMs: number;
}
