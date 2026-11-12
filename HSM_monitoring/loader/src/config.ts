/**
 * Konfiguracja mapowania komunikatow ARC* -> InfluxDB / SQLite.
 *
 *   config/hsm-map.json         ustawienia ogolne + odnosniki do ponizszych plikow
 *   config/messages/<MEMBER>.json  mapowanie komunikatow jednej grupy (member PDS z ../members)
 *   config/influx-select.json   include / exclude: ktore komunikaty trafiaja do InfluxDB
 *
 * Dla kazdego komunikatu osobno: wzorzec (regex z nazwanymi grupami), co z ktorej grupy wyciagnac
 * i jako co (tag, pole danego typu, tylko SQLite), stale tagi, measurement i zrodlo czasu.
 * Opis wszystkich opcji: README.md, sekcja "Konfiguracja".
 */
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { CompiledDurations, compileDurations } from './durations';
import { assertTimeZone } from './time';

export const COMMON_TAGS = ['sysname', 'host_id', 'log_type', 'msg_id', 'severity'] as const;
export type CommonTag = (typeof COMMON_TAGS)[number];

/** tag = tag InfluxDB; int/float/string/bool/duration = pole InfluxDB; sqlite = tylko do SQLite */
export const TARGETS = ['tag', 'int', 'float', 'string', 'bool', 'duration', 'sqlite'] as const;
export type Target = (typeof TARGETS)[number];

/** Typ pola w InfluxDB (duration zapisujemy jako int sekund) */
export type FieldType = 'int' | 'float' | 'string' | 'bool';
export const fieldTypeOf = (t: Target): FieldType | null =>
    t === 'tag' || t === 'sqlite' ? null : t === 'duration' ? 'int' : t;

const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const MSG_ID = /^ARC\d{4}[A-Z]$/;
const MEMBER = /^[A-Z@#$][A-Z0-9@#$]{0,7}$/;
const Name = z.string().regex(NAME, 'nazwa: litera, potem litery, cyfry, _');

const TimeFallback = z.enum(['previous', 'next', 'file'])
    .describe('Czas dla komunikatu bez czasu w tresci: previous = ostatni czas z wczesniejszego komunikatu w pliku, '
        + 'next = czas najblizszego pozniejszego komunikatu, file = czas z nazwy zbioru logu (Dyyddd.Thhmmss)');

const OnNoMatch = z.enum(['skip', 'warn', 'count'])
    .describe('Gdy zaden wzorzec nie pasuje: skip = pomin po cichu, warn = pomin i zglos, count = zapisz punkt tylko z tagami wspolnymi');

const ExtractObject = z.object({
    to: z.enum(TARGETS).describe('Jako co zapisac wartosc grupy'),
    name: Name.optional().describe('Nazwa tagu / pola (domyslnie nazwa grupy)'),
    map: z.record(z.string(), z.string()).optional()
        .describe('Zamiana wartosci przed konwersja, np. {"MCDS CONTROL": "MCDS"}; wartosci spoza mapy bez zmian'),
    default: z.string().optional().describe('Wartosc, gdy grupa nie wystapila lub jest pusta'),
    multiply: z.number().positive().optional()
        .describe('Mnoznik dla int / float, np. 56664 = sciezki 3390 -> bajty (wynik int zaokraglany)'),
}).strict();

const ExtractSpec = z.union([z.enum(TARGETS), ExtractObject]);

const TimeSpec = z.object({
    time: Name.optional().describe('Grupa z godzina (hh:mm:ss); domyslnie grupa "time"'),
    date: Name.optional().describe('Grupa z data (yy/mm/dd, yyyy/mm/dd, yyyy.ddd); domyslnie grupa "date"'),
    fallback: TimeFallback.optional(),
}).strict();

const MessageSpec = z.object({
    description: z.string().optional(),
    enabled: z.boolean().default(true).describe('false = komunikat w ogole nie jest przetwarzany (ani InfluxDB, ani SQLite)'),
    measurement: z.string().min(1).optional().describe('Nadpisuje influx.measurement'),
    pattern: z.union([z.string(), z.array(z.string()).min(1)]).optional()
        .describe('Regex (lub lista - pierwszy pasujacy) dopasowywany do tresci bez ID komunikatu; '
            + 'linie (CONT.) sa doklejane spacja. Brak = kazde wystapienie pasuje, bez wartosci'),
    ignoreCase: z.boolean().default(false),
    extract: z.record(Name, ExtractSpec).default({}).describe('Grupa regexu -> jak zapisac'),
    constTags: z.record(Name, z.string().min(1)).default({}).describe('Stale tagi dla tego komunikatu'),
    time: TimeSpec.optional(),
    onNoMatch: OnNoMatch.optional(),
}).strict();

const Messages = z.record(z.string(), MessageSpec).describe('ID komunikatu (np. ARC0723I) -> mapowanie');

/** Plik config/messages/<MEMBER>.json */
export const MessageFileSchema = z.object({
    $schema: z.string().optional(),
    member: z.string().regex(MEMBER, 'nazwa membra: do 8 znakow A-Z0-9@#$').optional()
        .describe('Nazwa grupy (do odwolan @MEMBER w influx-select); domyslnie nazwa pliku'),
    description: z.string().optional(),
    messages: Messages,
}).strict();

/** Plik config/influx-select.json (albo obiekt w hsm-map.json) */
export const InfluxSelectSchema = z.object({
    $schema: z.string().optional(),
    description: z.string().optional(),
    include: z.array(z.string()).optional()
        .describe('Co trafia do InfluxDB: ID (ARC0723I), wzorzec z * i ? (ARC18*), grupa (@BACKUP). Brak = wszystkie'),
    exclude: z.array(z.string()).default([]).describe('Wyjatki od include (maja pierwszenstwo); te same formy'),
}).strict();

export const ConfigSchema = z.object({
    $schema: z.string().optional(),
    description: z.string().optional(),
    timezone: z.string().default('UTC').describe('Strefa czasu LPAR (IANA), np. Europe/Warsaw'),
    influx: z.object({
        measurement: z.string().min(1).default('MF.HSM.EVENT'),
        commonTags: z.array(z.enum(COMMON_TAGS)).default(['sysname', 'host_id', 'log_type', 'msg_id']),
        countField: Name.default('events').describe('Pole int = 1 w kazdym punkcie (zliczanie zdarzen sum())'),
        uniqueTimestamps: z.boolean().default(true)
            .describe('Dodaje GROUP ID jako nanosekundy do czasu, zeby zdarzenia z tym samym czasem sie nie nadpisywaly'),
    }).strict().prefault({}),
    input: z.object({
        fileNamePattern: z.string()
            .default('\\.H(?<host_id>[A-Z0-9@#$]+)\\.(?<log_type>[A-Z]+)\\.D(?<date>\\d{5})\\.T(?<time>\\d{6})')
            .describe('Regex dla nazwy pliku (bez rozroznienia wielkosci liter); grupy host_id, log_type, date (yyddd), time (hhmmss)'),
        dir: z.string().min(1).optional()
            .describe('Katalog z ekstraktami (bezwzglednie albo wzgledem katalogu tego pliku); uzywany, gdy w wierszu polecen nie podano plikow'),
        include: z.string().min(1).default('*.txt').describe('Ktore pliki z katalogu (* i ?), np. "HSM*.txt"'),
        archiveDir: z.string().min(1).optional()
            .describe('Katalog, do ktorego przenosic pliki po udanym zapisie (bezwzglednie albo wzgledem katalogu tego pliku)'),
        minAgeSeconds: z.number().int().min(0).default(60)
            .describe('Pomijaj pliki zmienione w ostatnich N sekundach (transfer w toku)'),
    }).strict().prefault({}),
    defaults: z.object({
        timeFallback: TimeFallback.default('previous'),
        onNoMatch: OnNoMatch.default('warn'),
        unknownMessages: z.enum(['skip', 'count']).default('skip')
            .describe('Komunikaty spoza "messages" (lub enabled=false): skip = pomin, count = punkt tylko z tagami wspolnymi'),
    }).strict().prefault({}),
    messageFiles: z.array(z.string()).default([])
        .describe('Pliki z mapowaniem (wzgledem katalogu tego pliku); * i ? tylko w nazwie pliku, np. "messages/*.json"'),
    influxSelect: z.union([z.string(), InfluxSelectSchema]).optional()
        .describe('Plik include/exclude (wzgledem katalogu tego pliku) albo obiekt; brak = wszystkie zmapowane do InfluxDB'),
    messages: Messages.default({}).describe('Mapowanie wpisane bezposrednio (oprocz messageFiles)'),
    durations: z.union([z.string(), z.looseObject({})]).optional()
        .describe('Zadania start / koniec do liczenia czasu trwania: plik (wzgledem katalogu tego pliku) albo obiekt'),
}).strict();

export type ConfigInput = z.input<typeof ConfigSchema>;
export type Config = z.output<typeof ConfigSchema>;
type MessageSpecOut = z.output<typeof MessageSpec>;

// --- Postac skompilowana ---

export interface CompiledValue {
    group: string;
    name: string;
    to: Target;
    map?: Record<string, string>;
    default?: string;
    multiply?: number;
}

export interface CompiledMessage {
    msgId: string;
    /** Skad pochodzi definicja (plik / "messages") */
    origin: string;
    measurement: string;
    patterns: RegExp[];
    values: CompiledValue[];
    constTags: Record<string, string>;
    timeGroup?: string;
    dateGroup?: string;
    timeFallback: z.infer<typeof TimeFallback>;
    onNoMatch: z.infer<typeof OnNoMatch>;
}

export interface CompiledConfig {
    timezone: string;
    commonTags: CommonTag[];
    countField: string;
    uniqueTimestamps: boolean;
    defaultMeasurement: string;
    fileNamePattern: RegExp;
    unknownMessages: 'skip' | 'count';
    messages: Map<string, CompiledMessage>;
    /** Komunikaty z enabled=false */
    disabled: Set<string>;
    /** Grupy z plikow messages/<MEMBER>.json -> ID komunikatow */
    groups: Map<string, Set<string>>;
    /** Czy punkt z tym komunikatem trafia do InfluxDB (include / exclude) */
    toInflux: (msgId: string) => boolean;
    /** Ostrzezenia, ktore nie blokuja pracy (np. include z ID bez mapowania) */
    warnings: string[];
    /** Zadania start / koniec (czas trwania) */
    durations?: CompiledDurations;
    /** Katalog ekstraktow */
    input: { dir?: string; include: RegExp; archiveDir?: string; minAgeMs: number };
}

export class ConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ConfigError';
    }
}

export interface CompileOptions {
    /** Katalog, wzgledem ktorego sa messageFiles i influxSelect (domyslnie biezacy) */
    baseDir?: string;
    /** Plik include/exclude zamiast influxSelect z konfiguracji (sciezka bezwzgledna lub wzgledem cwd) */
    selectFile?: string;
}

/** Nazwy grup (?<nazwa>...) wystepujace we wzorcu */
export function groupNames(pattern: string): Set<string> {
    return new Set([...pattern.matchAll(/\(\?<([A-Za-z_][A-Za-z0-9_]*)>/g)].map(m => m[1]));
}

export const wildcard = (s: string, flags = '') =>
    new RegExp(`^${s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, flags);

function compileRegex(source: string, flags: string, where: string): RegExp {
    try {
        return new RegExp(source, flags);
    } catch (err) {
        throw new ConfigError(`${where}: niepoprawny regex: ${(err as Error).message}`);
    }
}

function issuesText<T>(result: z.ZodSafeParseResult<T>, prefix: string): string[] {
    return result.success ? [] : result.error.issues.map(i => `${prefix}${i.path.join('.') || '(root)'}: ${i.message}`);
}

function readJson(file: string): unknown {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        throw new ConfigError(`Nie mozna wczytac ${file}: ${(err as Error).message}`);
    }
}

/** "messages/*.json" -> lista plikow; wzorzec tylko w ostatnim elemencie sciezki */
function expandFiles(baseDir: string, pattern: string): string[] {
    const full = path.resolve(baseDir, pattern);
    const base = path.basename(full);
    if (!/[*?]/.test(base)) return fs.existsSync(full) ? [full] : [];
    let names: string[];
    try {
        names = fs.readdirSync(path.dirname(full));
    } catch {
        return [];
    }
    const re = wildcard(base);
    return names.filter(n => re.test(n)).sort().map(n => path.join(path.dirname(full), n));
}

interface Entry {
    spec: MessageSpecOut;
    origin: string;
}

export function compileConfig(input: unknown, options: CompileOptions = {}): CompiledConfig {
    const baseDir = options.baseDir ?? process.cwd();
    const parsed = ConfigSchema.safeParse(input);
    if (!parsed.success) {
        throw new ConfigError(`Niepoprawna konfiguracja:\n${issuesText(parsed, '  ').join('\n')}`);
    }
    const cfg = parsed.data;
    const errors: string[] = [];
    const warnings: string[] = [];
    const rel = (file: string) => path.relative(baseDir, file) || file;

    try {
        assertTimeZone(cfg.timezone);
    } catch {
        errors.push(`timezone: nieznana strefa "${cfg.timezone}"`);
    }

    // --- Zebranie definicji: messages + messageFiles ---
    const entries = new Map<string, Entry>();
    const groups = new Map<string, Set<string>>();
    const add = (msgId: string, spec: MessageSpecOut, origin: string) => {
        const prev = entries.get(msgId);
        if (!prev) {
            entries.set(msgId, { spec, origin });
        } else if (!isDeepStrictEqual(prev.spec, spec)) {
            errors.push(`${msgId}: rozne definicje w ${prev.origin} i ${origin} - komunikat moze byc w kilku plikach, `
                + 'ale z identyczna definicja');
        }
    };
    for (const [msgId, spec] of Object.entries(cfg.messages)) add(msgId, spec, 'messages');

    for (const pattern of cfg.messageFiles) {
        const files = expandFiles(baseDir, pattern);
        if (!files.length) errors.push(`messageFiles: "${pattern}" nie wskazuje zadnego pliku`);
        for (const file of files) {
            let json: unknown;
            try {
                json = readJson(file);
            } catch (err) {
                errors.push((err as Error).message);
                continue;
            }
            const res = MessageFileSchema.safeParse(json);
            if (!res.success) {
                errors.push(...issuesText(res, `${rel(file)}: `));
                continue;
            }
            const member = res.data.member ?? path.basename(file, path.extname(file)).toUpperCase();
            if (groups.has(member)) errors.push(`${rel(file)}: grupa ${member} zdefiniowana w kilku plikach`);
            groups.set(member, new Set(Object.keys(res.data.messages)));
            for (const [msgId, spec] of Object.entries(res.data.messages)) add(msgId, spec, rel(file));
        }
    }

    // --- Kompilacja komunikatow ---
    const reserved = new Set<string>([...cfg.influx.commonTags, cfg.influx.countField]);
    // measurement -> nazwa -> rodzaj (tag / typ pola) i kto go zdefiniowal - InfluxDB odrzuci
    // zapis, gdy to samo pole ma rozne typy albo ta sama nazwa jest raz tagiem, raz polem
    const kinds = new Map<string, Map<string, { kind: string; msgId: string }>>();
    const messages = new Map<string, CompiledMessage>();
    const disabled = new Set<string>();

    for (const [msgId, { spec, origin }] of entries) {
        const where = `${origin}: messages.${msgId}`;
        if (!MSG_ID.test(msgId)) {
            errors.push(`${where}: niepoprawne ID komunikatu (oczekiwano np. ARC0723I)`);
            continue;
        }
        if (!spec.enabled) {
            disabled.add(msgId);
            continue;
        }
        const sources = spec.pattern === undefined ? [] : Array.isArray(spec.pattern) ? spec.pattern : [spec.pattern];
        let patterns: RegExp[];
        try {
            patterns = sources.map((p, i) => compileRegex(p, spec.ignoreCase ? 'i' : '', `${where}.pattern[${i}]`));
        } catch (err) {
            errors.push((err as Error).message);
            continue;
        }
        const groupsInPattern = new Set(sources.flatMap(p => [...groupNames(p)]));

        const values: CompiledValue[] = [];
        const outNames = new Set<string>();
        for (const [group, raw] of Object.entries(spec.extract)) {
            const v: CompiledValue = typeof raw === 'string'
                ? { group, name: group, to: raw }
                : { group, name: raw.name ?? group, to: raw.to, map: raw.map, default: raw.default, multiply: raw.multiply };
            if (v.multiply !== undefined && v.to !== 'int' && v.to !== 'float') {
                errors.push(`${where}.extract.${group}: multiply tylko dla int / float`);
            }
            if (!groupsInPattern.has(group)) errors.push(`${where}.extract.${group}: brak grupy (?<${group}>...) we wzorcu`);
            if (outNames.has(v.name)) errors.push(`${where}.extract.${group}: nazwa "${v.name}" uzyta wiecej niz raz`);
            if (reserved.has(v.name) && v.to !== 'sqlite') {
                errors.push(`${where}.extract.${group}: nazwa "${v.name}" jest zarezerwowana (tag wspolny lub countField)`);
            }
            outNames.add(v.name);
            values.push(v);
        }
        for (const tag of Object.keys(spec.constTags)) {
            if (outNames.has(tag) || reserved.has(tag)) errors.push(`${where}.constTags.${tag}: kolizja nazwy z extract / tagami wspolnymi`);
        }

        const timeGroup = spec.time?.time ?? (groupsInPattern.has('time') ? 'time' : undefined);
        const dateGroup = spec.time?.date ?? (groupsInPattern.has('date') ? 'date' : undefined);
        if (spec.time?.time && !groupsInPattern.has(spec.time.time)) errors.push(`${where}.time.time: brak grupy (?<${spec.time.time}>...) we wzorcu`);
        if (spec.time?.date && !groupsInPattern.has(spec.time.date)) errors.push(`${where}.time.date: brak grupy (?<${spec.time.date}>...) we wzorcu`);
        if (dateGroup && !timeGroup) errors.push(`${where}.time: jest grupa z data, brak grupy z godzina`);

        const measurement = spec.measurement ?? cfg.influx.measurement;
        const seen = kinds.get(measurement) ?? new Map<string, { kind: string; msgId: string }>();
        kinds.set(measurement, seen);
        const declare = (name: string, kind: string) => {
            const prev = seen.get(name);
            if (prev && prev.kind !== kind) {
                errors.push(`${where}: "${name}" w measurement ${measurement} jest "${kind}", a w ${prev.msgId} "${prev.kind}" - InfluxDB odrzuci zapis`);
            } else if (!prev) {
                seen.set(name, { kind, msgId });
            }
        };
        for (const v of values) {
            if (v.to === 'sqlite') continue;
            declare(v.name, fieldTypeOf(v.to) ?? 'tag');
        }
        for (const tag of Object.keys(spec.constTags)) declare(tag, 'tag');

        messages.set(msgId, {
            msgId,
            origin,
            measurement,
            patterns,
            values,
            constTags: spec.constTags,
            timeGroup,
            dateGroup,
            timeFallback: spec.time?.fallback ?? cfg.defaults.timeFallback,
            onNoMatch: spec.onNoMatch ?? cfg.defaults.onNoMatch,
        });
    }

    for (const [measurement, seen] of kinds) {
        for (const tag of cfg.influx.commonTags) {
            if (seen.has(tag)) errors.push(`${seen.get(tag)!.msgId}: "${tag}" koliduje z tagiem wspolnym (${measurement})`);
        }
    }

    // --- include / exclude dla InfluxDB ---
    let select: z.output<typeof InfluxSelectSchema> | undefined;
    let selectWhere = 'influxSelect';
    const selectSource = options.selectFile ?? cfg.influxSelect;
    if (typeof selectSource === 'string') {
        const file = options.selectFile ? path.resolve(options.selectFile) : path.resolve(baseDir, selectSource);
        selectWhere = rel(file);
        try {
            const res = InfluxSelectSchema.safeParse(readJson(file));
            if (res.success) select = res.data;
            else errors.push(...issuesText(res, `${selectWhere}: `));
        } catch (err) {
            errors.push((err as Error).message);
        }
    } else if (selectSource) {
        const res = InfluxSelectSchema.safeParse(selectSource);
        if (res.success) select = res.data;
        else errors.push(...issuesText(res, 'influxSelect: '));
    }

    const compileList = (items: string[] | undefined, key: string): RegExp[] | undefined => {
        if (!items) return undefined;
        const out: RegExp[] = [];
        for (const item of items) {
            const where = `${selectWhere}: ${key} "${item}"`;
            if (item.startsWith('@')) {
                const ids = groups.get(item.slice(1).toUpperCase());
                if (!ids) {
                    errors.push(`${where}: nieznana grupa (znane: ${[...groups.keys()].sort().join(', ') || 'brak'})`);
                    continue;
                }
                out.push(...[...ids].map(id => wildcard(id)));
            } else if ((/[*?]/.test(item) && /^[A-Z0-9*?]+$/i.test(item)) || MSG_ID.test(item.toUpperCase())) {
                out.push(wildcard(item.toUpperCase()));
                if (!/[*?]/.test(item) && !entries.has(item.toUpperCase()) && cfg.defaults.unknownMessages === 'skip') {
                    warnings.push(`${where}: komunikat bez mapowania - nie bedzie punktow`);
                }
            } else {
                errors.push(`${where}: oczekiwano ID (ARC0723I), wzorca (ARC18*) albo grupy (@BACKUP)`);
            }
        }
        return out;
    };
    const include = compileList(select?.include, 'include');
    const exclude = compileList(select?.exclude, 'exclude') ?? [];
    const toInflux = (msgId: string) =>
        (!include || include.some(re => re.test(msgId))) && !exclude.some(re => re.test(msgId));

    let durations: CompiledDurations | undefined;
    if (typeof cfg.durations === 'string') {
        const file = path.resolve(baseDir, cfg.durations);
        try {
            durations = compileDurations(readJson(file), messages, rel(file), cfg.influx.countField, errors);
        } catch (err) {
            errors.push((err as Error).message);
        }
    } else if (cfg.durations) {
        durations = compileDurations(cfg.durations, messages, 'durations', cfg.influx.countField, errors);
    }

    let fileNamePattern: RegExp | undefined;
    try {
        fileNamePattern = compileRegex(cfg.input.fileNamePattern, 'i', 'input.fileNamePattern');
    } catch (err) {
        errors.push((err as Error).message);
    }

    if (errors.length) throw new ConfigError(`Niepoprawna konfiguracja:\n${errors.map(e => `  ${e}`).join('\n')}`);

    return {
        timezone: cfg.timezone,
        commonTags: cfg.influx.commonTags,
        countField: cfg.influx.countField,
        uniqueTimestamps: cfg.influx.uniqueTimestamps,
        defaultMeasurement: cfg.influx.measurement,
        fileNamePattern: fileNamePattern!,
        unknownMessages: cfg.defaults.unknownMessages,
        messages,
        disabled,
        groups,
        toInflux,
        warnings,
        durations,
        input: {
            dir: cfg.input.dir ? path.resolve(baseDir, cfg.input.dir) : undefined,
            include: wildcard(cfg.input.include),
            archiveDir: cfg.input.archiveDir ? path.resolve(baseDir, cfg.input.archiveDir) : undefined,
            minAgeMs: cfg.input.minAgeSeconds * 1000,
        },
    };
}

export function loadConfig(file: string, options: Omit<CompileOptions, 'baseDir'> = {}): CompiledConfig {
    return compileConfig(readJson(file), { ...options, baseDir: path.dirname(path.resolve(file)) });
}
