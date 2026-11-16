/**
 * Konfiguracja (JSON): reguly = kryterium na danych z DCOLLECT + przypisanie w rutynie ACS.
 * Przyklad i opis pol: config/przyklad.json, README.md.
 */
import fs from 'node:fs';
import { z } from 'zod';
import type { DataSet } from './dataset';
import { MaskError, matches, Mask, parseMask } from './mask';

export const NUM_FIELDS = [
    'nqual', 'vols', 'lrecl', 'blksize', 'extents', 'allocKb', 'usedKb', 'allocTrk', 'usedTrk', 'freeTrk',
    'ageDays', 'unrefDays',
] as const;
export const STR_FIELDS = [
    'dsn', 'hlq', 'llq', 'vol', 'dsorg', 'recfm', 'sc', 'mc', 'dc', 'sg', 'createJob', 'created', 'lastRef', 'expdt',
] as const;
export const BOOL_FIELDS = ['sms', 'temp', 'pdse', 'gds', 'ef', 'vsam'] as const;

type NumField = (typeof NUM_FIELDS)[number];
type StrField = (typeof STR_FIELDS)[number];
type BoolField = (typeof BOOL_FIELDS)[number];

const scalar = z.union([z.number(), z.string(), z.boolean()]);

const leaf = z.object({
    field: z.enum([...NUM_FIELDS, ...STR_FIELDS, ...BOOL_FIELDS]),
    op: z.enum(['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'in', 'notIn', 'mask', 'notMask', 'empty', 'notEmpty']),
    value: z.union([scalar, z.array(scalar)]).optional(),
}).strict();

export type Cond =
    | z.infer<typeof leaf>
    | { all: Cond[] }
    | { any: Cond[] }
    | { not: Cond };

export const condSchema: z.ZodType<Cond> = z.lazy(() => z.union([
    leaf,
    z.object({ all: z.array(condSchema).min(1) }).strict(),
    z.object({ any: z.array(condSchema).min(1) }).strict(),
    z.object({ not: condSchema }).strict(),
]));

export const ROUTINES = ['DATACLAS', 'STORCLAS', 'MGMTCLAS', 'STORGRP'] as const;
export type Routine = (typeof ROUTINES)[number];

const ACS_NAME = /^[A-Z][A-Z0-9_]{0,30}$/;
const CLASS_NAME = /^[A-Z#@$][A-Z0-9#@$]{0,7}$/;

const tuning = {
    /** minimalna czystosc maski: udzial zbiorow spelniajacych kryterium wsrod objetych maska (0-1) */
    minPurity: z.number().min(0).max(1).optional(),
    /** minimalna liczba zbiorow spelniajacych kryterium, ktore maska musi objac */
    minCount: z.number().int().min(1).optional(),
    /** maksymalna liczba masek na regule */
    maxMasks: z.number().int().min(1).optional(),
    /** kandydaci z '%' w miejsce cyfr (np. D%%%%%%) */
    digitMasks: z.boolean().optional(),
    /** zbiory niepokryte maskami dopisac jako pelne nazwy */
    literals: z.boolean().optional(),
    /** zbiory objete maskami, a niespelniajace kryterium -> lista EXCLUDE (pelne nazwy) */
    excludeFalsePositives: z.boolean().optional(),
};

export const ruleSchema = z.object({
    name: z.string().regex(ACS_NAME, 'nazwa: A-Z, 0-9, _ (do 31 znakow, od litery)'),
    description: z.string().optional(),
    when: condSchema,
    routine: z.enum(ROUTINES),
    value: z.union([z.string().regex(CLASS_NAME), z.array(z.string().regex(CLASS_NAME)).min(1).max(15)]),
    /** maski zawsze wylaczone z reguly (trafiaja do FILTLIST ..._X) */
    exclude: z.array(z.string()).optional(),
    /** dodatkowy warunek ACS dopisany przez AND (np. "&DSORG = 'PS'"), bez sprawdzania skladni */
    acsCondition: z.string().optional(),
    ...tuning,
}).strict();

export const configSchema = z.object({
    /** zbiory brane pod uwage w ogole (np. tylko SMS); domyslnie wszystkie */
    scope: condSchema.optional(),
    ...tuning,
    /** wartosc OTHERWISE w rutynie (np. { "STORGRP": "SGDEFLT" }); brak = bez OTHERWISE */
    otherwise: z.partialRecord(z.enum(ROUTINES), z.union([z.string().regex(CLASS_NAME), z.array(z.string())]))
        .optional(),
    rules: z.array(ruleSchema).min(1),
}).strict();

export type Rule = z.infer<typeof ruleSchema>;
export type Config = z.infer<typeof configSchema>;

export interface Tuning {
    minPurity: number;
    minCount: number;
    maxMasks: number;
    digitMasks: boolean;
    literals: boolean;
    excludeFalsePositives: boolean;
}

export const DEFAULT_TUNING: Tuning = {
    minPurity: 1,
    minCount: 3,
    maxMasks: 255,
    digitMasks: true,
    literals: false,
    excludeFalsePositives: false,
};

/** Kolejnosc: domyslne < konfiguracja < regula < parametry wywolania (override). */
export function tuningFor(cfg: Config, rule: Rule, override: Partial<Tuning> = {}): Tuning {
    const pick = (o: Partial<Record<keyof Tuning, unknown>>) =>
        Object.fromEntries(Object.entries(o).filter(([k, v]) => k in DEFAULT_TUNING && v !== undefined));
    return { ...DEFAULT_TUNING, ...pick(cfg), ...pick(rule), ...pick(override) } as Tuning;
}

export class ConfigError extends Error {}

export function loadConfig(file: string): Config {
    let raw: unknown;
    try {
        raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (err) {
        throw new ConfigError(`${file}: ${(err as Error).message}`);
    }
    return validateConfig(raw, file);
}

export function validateConfig(raw: unknown, source = 'konfiguracja'): Config {
    const r = configSchema.safeParse(raw);
    if (!r.success) {
        const msg = r.error.issues.map(i => `  ${i.path.join('.') || '(korzen)'}: ${i.message}`).join('\n');
        throw new ConfigError(`${source}: bledna konfiguracja\n${msg}`);
    }
    const names = new Set<string>();
    for (const rule of r.data.rules) {
        if (names.has(rule.name)) throw new ConfigError(`${source}: powtorzona nazwa reguly ${rule.name}`);
        names.add(rule.name);
        // nazwy FILTLIST: <nazwa>_<nr> / <nazwa>_X<nr> - do 31 znakow
        if (rule.name.length > 26) throw new ConfigError(`${source}: nazwa reguly ${rule.name} dluzsza niz 26 znakow`);
        for (const m of rule.exclude ?? []) checkMask(m, `${source}: regula ${rule.name}, exclude`);
    }
    checkCondMasks(r.data.scope, `${source}: scope`);
    for (const rule of r.data.rules) checkCondMasks(rule.when, `${source}: regula ${rule.name}, when`);
    return r.data;
}

function checkMask(m: string, where: string): Mask {
    try {
        return parseMask(m);
    } catch (err) {
        if (err instanceof MaskError) throw new ConfigError(`${where}: ${err.message}`);
        throw err;
    }
}

function checkCondMasks(c: Cond | undefined, where: string): void {
    if (!c) return;
    if ('all' in c) return c.all.forEach(x => checkCondMasks(x, where));
    if ('any' in c) return c.any.forEach(x => checkCondMasks(x, where));
    if ('not' in c) return checkCondMasks(c.not, where);
    if (c.op === 'mask' || c.op === 'notMask') {
        const vals = Array.isArray(c.value) ? c.value : [c.value];
        for (const v of vals) {
            if (typeof v !== 'string') throw new ConfigError(`${where}: ${c.op} wymaga masek (tekst)`);
            checkMask(v, where);
        }
    }
}

const maskCache = new Map<string, Mask>();
const cachedMask = (t: string) => {
    let m = maskCache.get(t);
    if (!m) maskCache.set(t, m = parseMask(t));
    return m;
};

function fieldValue(ds: DataSet, field: string): number | string | boolean | null {
    return (ds as unknown as Record<string, number | string | boolean | null>)[field];
}

function cmp(a: number | string, b: number | string): number {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    const x = String(a);
    const y = String(b);
    return x < y ? -1 : x > y ? 1 : 0;
}

/** Ocena warunku dla zbioru. Pole bez wartosci (null, np. brak daty) - porownania falszywe poza ne/empty. */
export function evalCond(c: Cond, ds: DataSet): boolean {
    if ('all' in c) return c.all.every(x => evalCond(x, ds));
    if ('any' in c) return c.any.some(x => evalCond(x, ds));
    if ('not' in c) return !evalCond(c.not, ds);
    const v = fieldValue(ds, c.field);
    const vals = Array.isArray(c.value) ? c.value : c.value === undefined ? [] : [c.value];
    const norm = (x: number | string | boolean) => (typeof x === 'string' ? x.toUpperCase() : x);
    switch (c.op) {
        case 'empty': return v === null || v === '';
        case 'notEmpty': return !(v === null || v === '');
        case 'mask': return typeof v === 'string' && vals.some(m => matches(cachedMask(String(m)), v));
        case 'notMask': return typeof v === 'string' && !vals.some(m => matches(cachedMask(String(m)), v));
        case 'in': return v !== null && vals.some(x => norm(x) === norm(v));
        case 'notIn': return v !== null && !vals.some(x => norm(x) === norm(v));
        default: break;
    }
    if (vals.length !== 1) throw new ConfigError(`warunek ${c.field} ${c.op}: wymagana jedna wartosc`);
    const want = vals[0];
    if (v === null) return c.op === 'ne';
    if (typeof v === 'boolean' || typeof want === 'boolean') {
        if (c.op === 'eq') return v === want;
        if (c.op === 'ne') return v !== want;
        throw new ConfigError(`warunek ${c.field} ${c.op}: pole logiczne - tylko eq / ne`);
    }
    const d = cmp(norm(v) as number | string, norm(want) as number | string);
    switch (c.op) {
        case 'eq': return d === 0;
        case 'ne': return d !== 0;
        case 'lt': return d < 0;
        case 'le': return d <= 0;
        case 'gt': return d > 0;
        case 'ge': return d >= 0;
    }
    return false;
}

/** Typy pol do opisu w pomocy. */
export const FIELD_HELP: Record<NumField | StrField | BoolField, string> = {
    nqual: 'liczba kwalifikatorow', vols: 'liczba wolumenow', lrecl: 'LRECL', blksize: 'BLKSIZE',
    extents: 'liczba ekstentow (suma)', allocKb: 'alokacja KB', usedKb: 'uzycie KB',
    allocTrk: 'alokacja w sciezkach 3390 (ROUND)', usedTrk: 'uzycie w sciezkach (w gore)',
    freeTrk: 'allocTrk - usedTrk', ageDays: 'dni od utworzenia', unrefDays: 'dni od ostatniego uzycia',
    dsn: 'nazwa', hlq: 'HLQ', llq: 'LLQ', vol: 'pierwszy wolumen', dsorg: 'PS/PO/DA/IS/VS',
    recfm: 'np. FB, VB, U', sc: 'storage class', mc: 'management class', dc: 'data class', sg: 'storage group',
    createJob: 'job tworzacy', created: 'data utworzenia RRRRDDD', lastRef: 'ostatnie uzycie RRRRDDD',
    expdt: 'data wygasniecia RRRRDDD', sms: 'zbior SMS', temp: 'tymczasowy', pdse: 'PDSE', gds: 'generacja GDG',
    ef: 'extended format', vsam: 'VSAM',
};
