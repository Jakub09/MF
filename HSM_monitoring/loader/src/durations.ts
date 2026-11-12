/**
 * Czas trwania zadan HSM z par komunikatow start / koniec (config/durations.json).
 *
 * Kazde zadanie (np. AUTOBACKUP: ARC0720I -> ARC0721I) jest parowane w obrebie sysname + host_id + klucza
 * (np. copy_pool). Wynik: punkt w measurement MF.HSM.DURATION (pole duration w sekundach, czas = koniec zadania)
 * i rekord w SQLite (tabela hsm_task). "aggregate" dodaje do punktu liczniki z komunikatow w oknie zadania
 * (np. volumes = liczba ARC0723I, datasets = suma DATA SETS BACKED UP). Parowanie obejmuje zdarzenia z jednego uruchomienia loadera
 * (wszystkie podane pliki, posortowane po czasie) - zadania przechodzace przez przelaczenie logu (SWAPLOG)
 * miedzy uruchomieniami nie sa jeszcze domykane.
 */
import { z } from 'zod';
import type { CompiledMessage } from './config';
import type { FieldValue, MappedEvent } from './mapper';

const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const Name = z.string().regex(NAME, 'nazwa: litera, potem litery, cyfry, _');
const MSG = z.string().regex(/^ARC\d{4}[A-Z]$/, 'ID komunikatu, np. ARC0723I');

const EndSpec = z.union([
    z.string().min(1).describe('Staly status zadania, np. "OK", "TERMINATED"'),
    z.object({
        status: z.string().min(1).optional().describe('Staly status'),
        statusFrom: Name.optional().describe('Status z wartosci komunikatu konca (tag / pole / sqlite), np. "status"'),
        durationFrom: Name.optional()
            .describe('Czas trwania z wartosci komunikatu konca (sekundy, np. pole duration "elapsed" z ARC0523I) zamiast roznicy czasow'),
        when: z.record(Name, z.string()).optional()
            .describe('Komunikat konczy zadanie tylko, gdy wartosci pasuja do regexow, np. {"function": "^AUTOMATIC BACKUP"}'),
    }).strict(),
]);

const TaskSpec = z.object({
    description: z.string().optional(),
    enabled: z.boolean().default(true),
    start: z.union([MSG, z.array(MSG).min(1)]).describe('Komunikat(y) startu'),
    end: z.record(MSG, EndSpec).describe('Komunikat konca -> status'),
    key: z.array(Name).default([]).describe('Wartosci parujace start z koncem (oprocz sysname + host_id), np. ["volser"]'),
    keyAlias: z.record(MSG, z.record(Name, Name)).default({})
        .describe('Inna nazwa klucza w danym komunikacie, np. {"ARC0570I": {"volser": "scope"}}'),
    tags: z.array(Name).optional().describe('Wartosci z komunikatu konca jako tagi punktu (domyslnie = key)'),
    maxHours: z.number().positive().default(48).describe('Start starszy niz tyle godzin nie jest parowany'),
    expectedEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM').optional()
        .describe('Do ktorej (czas lokalny, timezone z hsm-map.json) zadanie powinno sie skonczyc; brak = bez kontroli. '
            + 'Podpowiedz: hsm-load --task-times'),
    days: z.array(z.enum(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'])).min(1).optional()
        .describe('Dni tygodnia terminu expectedEnd (np. ["SUN"] dla zadan tygodniowych); domyslnie codziennie'),
    aggregate: z.record(Name, z.object({
        op: z.enum(['count', 'sum', 'max']).describe('count = liczba komunikatow, sum / max = z wartosci "value"'),
        msg: z.union([MSG, z.array(MSG).min(1)]).describe('Komunikaty w oknie zadania (od startu do konca wlacznie)'),
        value: Name.optional().describe('Wartosc do sum / max, np. "ds_backed_up"'),
        when: z.record(Name, z.string()).optional().describe('Tylko komunikaty z wartosciami pasujacymi do regexow'),
    }).strict()).default({}).describe('Pole punktu (int) -> agregacja komunikatow w oknie zadania, np. volumes, datasets'),
}).strict();

export const DurationsSchema = z.object({
    $schema: z.string().optional(),
    description: z.string().optional(),
    measurement: z.string().min(1).default('MF.HSM.DURATION'),
    tasks: z.record(z.string(), TaskSpec).describe('Nazwa zadania (wielkie litery, cyfry, _) -> definicja'),
}).strict();

export interface CompiledAggregate {
    name: string;
    op: 'count' | 'sum' | 'max';
    msgs: Set<string>;
    value?: string;
    when?: [string, RegExp][];
}

export interface CompiledTask {
    name: string;
    starts: Set<string>;
    ends: Map<string, { status?: string; statusFrom?: string; durationFrom?: string; when?: [string, RegExp][] }>;
    key: string[];
    keyAlias: Record<string, Record<string, string>>;
    tags: string[];
    maxMs: number;
    aggregates: CompiledAggregate[];
    /** expectedEnd w minutach od polnocy (czas lokalny) */
    expectedEndMin?: number;
    /** dni tygodnia terminu, 0 = niedziela; brak = codziennie */
    days?: Set<number>;
}

export interface CompiledDurations {
    measurement: string;
    tasks: CompiledTask[];
}

/** Nazwy, ktore komunikat moze dostarczyc (extract + constTags) */
const produces = (m: CompiledMessage) => new Set([...m.values.map(v => v.name), ...Object.keys(m.constTags)]);
const RESERVED = new Set(['task', 'status', 'duration', 'exact', 'sysname', 'host_id']);

export function compileDurations(input: unknown, messages: Map<string, CompiledMessage>, where: string,
    countField: string, errors: string[]): CompiledDurations | undefined {
    const res = DurationsSchema.safeParse(input);
    if (!res.success) {
        errors.push(...res.error.issues.map(i => `${where}: ${i.path.join('.') || '(root)'}: ${i.message}`));
        return undefined;
    }
    const tasks: CompiledTask[] = [];
    for (const [name, spec] of Object.entries(res.data.tasks)) {
        const w = `${where}: tasks.${name}`;
        if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
            errors.push(`${w}: nazwa zadania - wielkie litery, cyfry, _ (np. VOLBACKUP)`);
            continue;
        }
        if (!spec.enabled) continue;
        const starts = new Set(Array.isArray(spec.start) ? spec.start : [spec.start]);
        const ends = new Map<string, { status?: string; statusFrom?: string; durationFrom?: string; when?: [string, RegExp][] }>();
        for (const [id, e] of Object.entries(spec.end)) {
            if (typeof e === 'string') {
                ends.set(id, { status: e });
                continue;
            }
            const when: [string, RegExp][] = [];
            for (const [n, re] of Object.entries(e.when ?? {})) {
                try {
                    when.push([n, new RegExp(re)]);
                } catch (err) {
                    errors.push(`${w}: end.${id}.when.${n}: niepoprawny regex: ${(err as Error).message}`);
                }
            }
            if (!e.status && !e.statusFrom) errors.push(`${w}: end.${id}: podaj status albo statusFrom`);
            ends.set(id, { status: e.status, statusFrom: e.statusFrom, durationFrom: e.durationFrom, when: when.length ? when : undefined });
        }
        const tags = spec.tags ?? spec.key;
        const nameIn = (msgId: string, k: string) => spec.keyAlias[msgId]?.[k] ?? k;
        let ok = true;
        for (const msgId of [...starts, ...ends.keys()]) {
            const m = messages.get(msgId);
            if (!m) {
                errors.push(`${w}: ${msgId} nie ma mapowania albo jest wylaczony (enabled=false)`);
                ok = false;
                continue;
            }
            const has = produces(m);
            for (const k of spec.key) {
                if (!has.has(nameIn(msgId, k))) errors.push(`${w}: ${msgId} nie dostarcza "${nameIn(msgId, k)}" (klucz ${k}) - dodaj do extract albo keyAlias`);
            }
            const end = ends.get(msgId);
            if (end) {
                for (const t of tags) if (!has.has(nameIn(msgId, t))) errors.push(`${w}: ${msgId} nie dostarcza tagu "${nameIn(msgId, t)}"`);
                if (end.statusFrom && !has.has(end.statusFrom)) errors.push(`${w}: ${msgId} nie dostarcza "${end.statusFrom}" (statusFrom)`);
                for (const [n] of end.when ?? []) if (!has.has(n)) errors.push(`${w}: ${msgId} nie dostarcza "${n}" (when)`);
                if (end.durationFrom && !has.has(end.durationFrom)) errors.push(`${w}: ${msgId} nie dostarcza "${end.durationFrom}" (durationFrom)`);
            }
        }
        for (const t of tags) if (RESERVED.has(t) || t === countField) errors.push(`${w}: tag "${t}" jest zarezerwowany`);

        const aggregates: CompiledAggregate[] = [];
        for (const [field, a] of Object.entries(spec.aggregate)) {
            const aw = `${w}.aggregate.${field}`;
            if (RESERVED.has(field) || field === countField || tags.includes(field)) errors.push(`${aw}: nazwa pola zarezerwowana lub uzyta jako tag`);
            if (a.op !== 'count' && !a.value) errors.push(`${aw}: ${a.op} wymaga "value"`);
            const msgs = new Set(Array.isArray(a.msg) ? a.msg : [a.msg]);
            const when: [string, RegExp][] = [];
            for (const [n, re] of Object.entries(a.when ?? {})) {
                try {
                    when.push([n, new RegExp(re)]);
                } catch (err) {
                    errors.push(`${aw}.when.${n}: niepoprawny regex: ${(err as Error).message}`);
                }
            }
            for (const msgId of msgs) {
                const m = messages.get(msgId);
                if (!m) {
                    errors.push(`${aw}: ${msgId} nie ma mapowania albo jest wylaczony`);
                    continue;
                }
                const has = produces(m);
                if (a.value && !has.has(a.value)) errors.push(`${aw}: ${msgId} nie dostarcza "${a.value}"`);
                for (const [n] of when) if (!has.has(n)) errors.push(`${aw}: ${msgId} nie dostarcza "${n}" (when)`);
            }
            aggregates.push({ name: field, op: a.op, msgs, value: a.value, when: when.length ? when : undefined });
        }
        const expectedEndMin = spec.expectedEnd ? Number(spec.expectedEnd.slice(0, 2)) * 60 + Number(spec.expectedEnd.slice(3)) : undefined;
        const days = spec.days ? new Set(spec.days.map(x => ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'].indexOf(x))) : undefined;
        if (ok) tasks.push({ name, starts, ends, key: spec.key, keyAlias: spec.keyAlias, tags, maxMs: spec.maxHours * 3_600_000, aggregates, expectedEndMin, days });
    }
    return { measurement: res.data.measurement, tasks };
}

// --- Parowanie ---

export interface TaskRecord {
    task: string;
    sysname: string;
    hostId?: string;
    key: Record<string, string>;
    start: MappedEvent;
    end: MappedEvent;
    durationS: number;
    status: string;
    /** false = co najmniej jeden czas zastepczy (komunikat bez czasu w tresci, np. ARC0520I) */
    exact: boolean;
    /** Wyniki "aggregate", np. { volumes: 40, datasets: 5210 } */
    metrics: Record<string, number>;
}

export interface TaskStats {
    paired: number;
    /** koniec bez startu (start w poprzednim przebiegu albo brak klucza) */
    unmatchedEnd: number;
    /** start bez konca - zadanie trwa, zawieszone albo koniec w kolejnym logu */
    open: number;
    /** drugi start z tym samym kluczem przed koncem (poprzedni porzucony) */
    restarted: number;
    /** sparowane, ale czasu nie da sie ustalic (start i koniec bez czasu w tresci, roznica 0) - bez punktu */
    noTime: number;
}

const valueOf = (e: MappedEvent, name: string): string | undefined => {
    if (e.tags[name] !== undefined) return e.tags[name];
    if (e.extra[name] !== undefined) return e.extra[name];
    const f = e.fields[name];
    return f === undefined ? undefined : String(f.value);
};

export interface OpenStart {
    task: string;
    sysname: string;
    hostId?: string;
    key: Record<string, string>;
    start: MappedEvent;
}

/**
 * isNew - zdarzenia z biezacego uruchomienia; zdarzenia z historii (SQLite) sluza tylko do parowania:
 * punkt powstaje wylacznie dla zadan, ktorych koniec jest nowy (inaczej bylby zapisany drugi raz).
 */
export function pairTasks(events: MappedEvent[], d: CompiledDurations, countField: string, isNew: (e: MappedEvent) => boolean = () => true):
    { points: MappedEvent[]; records: TaskRecord[]; stats: Map<string, TaskStats>; open: OpenStart[] } {
    const openStarts: OpenStart[] = [];
    const sorted = events.map((e, i) => ({ e, i })).sort((a, b) => a.e.timeMs - b.e.timeMs || a.i - b.i).map(x => x.e);
    const records: TaskRecord[] = [];
    const stats = new Map<string, TaskStats>();

    for (const task of d.tasks) {
        const s: TaskStats = { paired: 0, unmatchedEnd: 0, open: 0, restarted: 0, noTime: 0 };
        stats.set(task.name, s);
        const open = new Map<string, MappedEvent>();
        const keyOf = (e: MappedEvent): { id: string; values: Record<string, string> } | undefined => {
            const values: Record<string, string> = {};
            for (const k of task.key) {
                const v = valueOf(e, task.keyAlias[e.raw.msgId]?.[k] ?? k);
                if (v === undefined) return undefined;
                values[k] = v;
            }
            return { id: [e.raw.sysname, e.hostId ?? '', ...task.key.map(k => values[k])].join('\u0000'), values };
        };
        for (const e of sorted) {
            const isStart = task.starts.has(e.raw.msgId);
            let end = task.ends.get(e.raw.msgId);
            if (end?.when && !end.when.every(([n, re]) => re.test(valueOf(e, n) ?? ''))) end = undefined;
            if (!isStart && !end) continue;
            const key = keyOf(e);
            if (!key) {
                if (end) s.unmatchedEnd++;
                continue;
            }
            if (isStart) {
                if (open.has(key.id)) s.restarted++;
                open.set(key.id, e);
                continue;
            }
            const start = open.get(key.id);
            if (!start || e.timeMs < start.timeMs || e.timeMs - start.timeMs > task.maxMs) {
                s.unmatchedEnd++;
                continue;
            }
            open.delete(key.id);
            const fromMsg = end!.durationFrom !== undefined ? Number(valueOf(e, end!.durationFrom)) : NaN;
            const exact = Number.isFinite(fromMsg) || (start.timeSource === 'message' && e.timeSource === 'message');
            const durationS = Number.isFinite(fromMsg) ? Math.round(fromMsg) : Math.round((e.timeMs - start.timeMs) / 1000);
            if (!exact && durationS === 0) {
                s.noTime++;
                continue;
            }
            s.paired++;
            records.push({
                task: task.name,
                sysname: e.raw.sysname,
                hostId: e.hostId,
                key: key.values,
                start,
                end: e,
                durationS,
                status: end!.status ?? valueOf(e, end!.statusFrom!) ?? 'UNKNOWN',
                exact,
                metrics: {},
            });
        }
        s.open = open.size;
        for (const st of open.values()) {
            const values: Record<string, string> = {};
            for (const k of task.key) values[k] = valueOf(st, task.keyAlias[st.raw.msgId]?.[k] ?? k) ?? '';
            openStarts.push({ task: task.name, sysname: st.raw.sysname, hostId: st.hostId, key: values, start: st });
        }
    }

    aggregate(records, sorted, d);
    const fresh = records.filter(r => isNew(r.end));
    for (const s of stats.values()) s.paired = 0;
    for (const r of fresh) stats.get(r.task)!.paired++;

    const points = fresh.map((r): MappedEvent => {
        const task = d.tasks.find(t => t.name === r.task)!;
        const tags: Record<string, string> = { sysname: r.sysname, task: r.task, status: r.status };
        if (r.hostId) tags.host_id = r.hostId;
        for (const t of task.tags) {
            const v = valueOf(r.end, task.keyAlias[r.end.raw.msgId]?.[t] ?? t);
            if (v !== undefined && v !== '') tags[t] = v;
        }
        const fields: Record<string, FieldValue> = {
            [countField]: { type: 'int', value: 1 },
            duration: { type: 'int', value: r.durationS },
            exact: { type: 'bool', value: r.exact },
        };
        for (const [k, v] of Object.entries(r.metrics)) fields[k] = { type: 'int', value: Math.round(v) };
        return {
            raw: r.end.raw,
            source: r.end.source,
            hostId: r.hostId,
            measurement: d.measurement,
            timeMs: r.end.timeMs,
            timeSource: r.end.timeSource,
            tags,
            fields,
            extra: { start: new Date(r.start.timeMs).toISOString(), start_msg: r.start.raw.msgId },
            matched: true,
            influx: true,
        };
    });
    return { points, records: fresh, stats, open: openStarts };
}

/**
 * Agregacje w oknie zadania: komunikaty z tego samego sysname + host_id, z czasem od startu do konca
 * (wlacznie - komunikaty bez czasu w tresci dostaja czas sasiada, np. ARC1805I = czas ARC1802I), a jesli
 * komunikat ma wartosc klucza zadania (np. copy_pool) - zgodna z kluczem.
 */
function aggregate(records: TaskRecord[], sorted: MappedEvent[], d: CompiledDurations): void {
    const byHost = new Map<string, MappedEvent[]>();
    for (const e of sorted) {
        const k = `${e.raw.sysname}\u0000${e.hostId ?? ''}`;
        let list = byHost.get(k);
        if (!list) byHost.set(k, (list = []));
        list.push(e);
    }
    const tasks = new Map(d.tasks.map(t => [t.name, t]));
    for (const r of records) {
        const task = tasks.get(r.task)!;
        if (!task.aggregates.length) continue;
        const list = byHost.get(`${r.sysname}\u0000${r.hostId ?? ''}`) ?? [];
        // pierwszy indeks z czasem >= start (lista posortowana po czasie)
        let lo = 0;
        let hi = list.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (list[mid].timeMs < r.start.timeMs) lo = mid + 1;
            else hi = mid;
        }
        for (const a of task.aggregates) {
            let acc: number | undefined = a.op === 'max' ? undefined : 0;
            for (let i = lo; i < list.length && list[i].timeMs <= r.end.timeMs; i++) {
                const e = list[i];
                if (!a.msgs.has(e.raw.msgId)) continue;
                if (a.when && !a.when.every(([n, re]) => re.test(valueOf(e, n) ?? ''))) continue;
                if (!task.key.every(k => {
                    const v = valueOf(e, task.keyAlias[e.raw.msgId]?.[k] ?? k);
                    return v === undefined || v === r.key[k];
                })) continue;
                if (a.op === 'count') {
                    acc = (acc ?? 0) + 1;
                    continue;
                }
                const v = Number(valueOf(e, a.value!));
                if (!Number.isFinite(v)) continue;
                acc = a.op === 'sum' ? (acc ?? 0) + v : Math.max(acc ?? -Infinity, v);
            }
            if (acc !== undefined) r.metrics[a.name] = acc;
        }
    }
}
