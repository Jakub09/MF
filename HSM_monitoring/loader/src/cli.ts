#!/usr/bin/env node
/**
 * hsm-load - komunikaty DFSMShsm ARC* (Activity Log po ekstrakcji DFSORT) -> InfluxDB 1.x (+ SQLite).
 *
 * Uzycie:
 *   node --env-file=.env dist/src/cli.js [opcje] [<plik...>]
 *   Bez plikow: nowe pliki z katalogu input.dir (hsm-map.json) albo --input-dir.
 *
 * Opcje:
 *   -c, --config <plik>   konfiguracja mapowania (domyslnie config/hsm-map.json w katalogu pakietu)
 *       --input-dir <kat> katalog z ekstraktami (zamiast input.dir z konfiguracji); przetwarzane tylko nowe pliki
 *       --archive-dir <k> po udanym zapisie przenies przetworzone pliki do tego katalogu (zamiast input.archiveDir)
 *       --all             w trybie katalogu przetworz tez pliki juz przetworzone
 *       --host-id <id>    nadpisuje host_id z nazwy pliku
 *       --log-type <typ>  nadpisuje log_type z nazwy pliku (MIGLOG, BAKLOG, DMPLOG, CMDLOG, ABRLOG)
 *       --select <plik>   include / exclude dla InfluxDB zamiast influxSelect z konfiguracji
 *       --db <nazwa>      baza InfluxDB (domyslnie INFLUXDB_DATABASE albo "metrics")
 *       --rp <nazwa>      retention policy InfluxDB (domyslnie domyslna dla bazy)
 *       --out <plik>      zapis line protocol do pliku zamiast do InfluxDB
 *       --sqlite <plik>   SQLite: zdarzenia, zadania i stan kontroli terminow - trwaly stan loadera (ten sam plik
 *                         przy kazdym uruchomieniu); potrzebny do parowania zadan miedzy ekstraktami i do kontroli expectedEnd
 *       --as-of <czas>    chwila ekstraktu dla kontroli terminow (ISO, np. 2026-11-12T07:00:00+01:00; domyslnie teraz)
 *       --task-times      o ktorej srednio / najpozniej koncza sie zadania (pliki + historia z --sqlite); nic nie zapisuje
 *       --print           wypisz line protocol na stdout
 *       --dry-run         nic nie zapisuj (podsumowanie na stderr, z --print - punkty na stdout)
 *       --check           tylko walidacja konfiguracji
 *       --estimate        szacunek przyrostu InfluxDB (7 / 30 / 365 dni) z probki; nic nie zapisuje
 *       --sample-days <n> ile dni obejmuje probka (domyslnie: liczba dat w nazwach plikow)
 *       --periods <lista> okresy szacunku w dniach (domyslnie 7,30,365)
 *       --shard-days <n>  dlugosc shardu InfluxDB (domyslnie 7 - RP bez limitu)
 *       --top <n>         ile komunikatow w rankingu szacunku (domyslnie 15)
 *       --strict          kod 4, gdy sa problemy z danymi (niedopasowane, bledne wartosci, brak czasu)
 *       --max-issues <n>  ile problemow wypisac (domyslnie 20)
 *   -h, --help
 *
 * Zmienne srodowiskowe (jak w grafana_automation_js): INFLUXDB_URL (domyslnie http://localhost:8086),
 *   INFLUXDB_DATABASE, INFLUXDB_USERNAME, INFLUXDB_PASSWORD.
 *
 * Kody wyjscia:
 *   0 - OK
 *   1 - bledne argumenty albo konfiguracja
 *   2 - nie mozna odczytac pliku wejsciowego (pozostale pliki sa przetwarzane)
 *   3 - blad zapisu (InfluxDB, SQLite, plik --out)
 *   4 - (tylko --strict) dane z problemami
 *   5 - kontrola terminow: WARNING (zadanie bez konca po expectedEnd - pierwszy ekstrakt)
 *   6 - kontrola terminow: ERROR (nadal bez konca w kolejnym ekstrakcie)
 *   Kody 5 / 6 tylko, gdy nie wystapil blad 1-4. Powiadomienia: linie HSM-W / HSM-E / HSM-I na stderr.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CompiledConfig, ConfigError, loadConfig } from './config';
import { writeLines, WriteError } from './influx-writer';
import { toLine } from './line-protocol';
import { CHECK_MEASUREMENT, CompletedTask, evaluateChecks } from './checks';
import { OpenStart, pairTasks, TaskRecord } from './durations';
import { collectSample, formatEstimate, sampleDaysOf } from './estimate';
import { mapEvents, MapResult, MappedEvent, MessageStats } from './mapper';
import { Issue, parseEvents, SourceMeta, sourceMeta } from './parse';
import { SqliteStore } from './sqlite-store';
import { formatTaskTimes } from './task-times';

export const EXIT = { OK: 0, USAGE: 1, INPUT: 2, WRITE: 3, DATA: 4, TASK_WARNING: 5, TASK_ERROR: 6 } as const;

const USAGE = 'Uzycie: hsm-load [-c config.json] [--dry-run] [--print] [--out plik.lp] [--sqlite plik.db] '
    + '[--host-id X] [--log-type BAKLOG] [--db metrics] [--strict] <plik...>\n'
    + '        hsm-load --check [-c config.json]\n'
    + '        hsm-load --estimate [--sample-days 1] [--periods 7,30,365] [--select inny.json] <plik...>\n'
    + '        hsm-load --task-times [--sqlite stan.db] [<plik...>]';

/** Katalog pakietu (z package.json) - dziala dla src/ (tsx) i dist/src/ (node) */
function packageRoot(): string {
    let dir = __dirname;
    while (!fs.existsSync(path.join(dir, 'package.json')) && path.dirname(dir) !== dir) dir = path.dirname(dir);
    return dir;
}

export interface FileResult {
    meta: SourceMeta;
    result: MapResult;
    lines: string[];
    issues: Issue[];
}

export function processFile(file: string, content: string, cfg: CompiledConfig,
    overrides: { hostId?: string; logType?: string } = {}): FileResult {
    const meta = sourceMeta(file, cfg.fileNamePattern);
    if (overrides.hostId) meta.hostId = overrides.hostId.toUpperCase();
    if (overrides.logType) meta.logType = overrides.logType.toUpperCase();
    const parsed = parseEvents(content);
    const result = mapEvents(parsed.events, meta, cfg);
    const lines = result.events.filter(e => e.influx).map(e => toLine(e, cfg.uniqueTimestamps));
    return { meta, result, lines, issues: [...parsed.issues, ...result.issues].sort((a, b) => a.line - b.line) };
}

function printSummary(r: FileResult, maxIssues: number, io: Io): void {
    const { meta, result } = r;
    const total = (k: keyof MessageStats) => [...result.stats.values()].reduce((sum, s) => sum + s[k], 0);
    io.err(`${meta.source}: host_id=${meta.hostId ?? '?'} log_type=${meta.logType ?? '?'} - `
        + `zdarzen ${total('events')}, zmapowanych ${total('mapped')}, do InfluxDB ${r.lines.length}, niedopasowanych ${total('noMatch')}, `
        + `pominietych ${total('skipped')}, bez czasu ${total('noTime')}, problemow ${r.issues.length}\n`);
    io.err('  MSG_ID     zdarz.  zmap.  influx niedop.  pomin. bez_cz.\n');
    for (const [msgId, s] of [...result.stats].sort(([a], [b]) => a.localeCompare(b))) {
        const col = (n: number) => String(n).padStart(7);
        io.err(`  ${msgId.padEnd(9)}${col(s.events)} ${col(s.mapped)} ${col(s.influx)} ${col(s.noMatch)} ${col(s.skipped)} ${col(s.noTime)}\n`);
    }
    for (const i of r.issues.slice(0, maxIssues)) {
        io.err(`  ! linia ${i.line}${i.msgId ? ` ${i.msgId}` : ''} [${i.kind}] ${i.detail}\n`);
    }
    if (r.issues.length > maxIssues) io.err(`  ! ... i ${r.issues.length - maxIssues} kolejnych\n`);
}

/** Wyjscie programu - parametr, zeby testy nie podmienialy process.stdout */
export interface Io {
    out: (text: string) => void;
    err: (text: string) => void;
}

const STDIO: Io = { out: t => process.stdout.write(t), err: t => process.stderr.write(t) };

export async function main(argv: string[], io: Io = STDIO): Promise<number> {
    let args;
    try {
        args = parseArgs({
            args: argv,
            allowPositionals: true,
            options: {
                config: { type: 'string', short: 'c' },
                select: { type: 'string' },
                'input-dir': { type: 'string' },
                'archive-dir': { type: 'string' },
                all: { type: 'boolean', default: false },
                'host-id': { type: 'string' },
                'log-type': { type: 'string' },
                db: { type: 'string' },
                rp: { type: 'string' },
                out: { type: 'string' },
                sqlite: { type: 'string' },
                print: { type: 'boolean', default: false },
                'dry-run': { type: 'boolean', default: false },
                check: { type: 'boolean', default: false },
                estimate: { type: 'boolean', default: false },
                'task-times': { type: 'boolean', default: false },
                'as-of': { type: 'string' },
                'sample-days': { type: 'string' },
                periods: { type: 'string', default: '7,30,365' },
                'shard-days': { type: 'string', default: '7' },
                top: { type: 'string', default: '15' },
                strict: { type: 'boolean', default: false },
                'max-issues': { type: 'string', default: '20' },
                help: { type: 'boolean', short: 'h', default: false },
            },
        });
    } catch (err) {
        io.err(`${(err as Error).message}\n${USAGE}\n`);
        return EXIT.USAGE;
    }
    const opt = args.values;
    if (opt.help) {
        io.out(`${USAGE}\nSzczegoly: README.md\n`);
        return EXIT.OK;
    }
    const maxIssues = Number(opt['max-issues']);
    if (!Number.isInteger(maxIssues) || maxIssues < 0) {
        io.err('--max-issues: oczekiwano liczby >= 0\n');
        return EXIT.USAGE;
    }

    const positive = (name: string, v: string | undefined) => {
        if (v === undefined) return undefined;
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name}: oczekiwano liczby > 0`);
        return n;
    };
    let estimate: { sampleDays?: number; periods: number[]; shardDays: number; top: number };
    try {
        const periods = opt.periods.split(',').map(p => positive('periods', p.trim())!);
        estimate = {
            sampleDays: positive('sample-days', opt['sample-days']),
            periods: periods.sort((a, b) => a - b),
            shardDays: positive('shard-days', opt['shard-days'])!,
            top: positive('top', opt.top)!,
        };
    } catch (err) {
        io.err(`${(err as Error).message}\n`);
        return EXIT.USAGE;
    }

    const asOfMs = opt['as-of'] ? Date.parse(opt['as-of']) : Date.now();
    if (!Number.isFinite(asOfMs)) {
        io.err(`--as-of: niepoprawny czas "${opt['as-of']}" (oczekiwano ISO, np. 2026-11-12T07:00:00+01:00)\n`);
        return EXIT.USAGE;
    }

    const configFile = opt.config ?? path.join(packageRoot(), 'config', 'hsm-map.json');
    let cfg: CompiledConfig;
    try {
        cfg = loadConfig(configFile, { selectFile: opt.select });
    } catch (err) {
        if (!(err instanceof ConfigError)) throw err;
        io.err(`${err.message}\n`);
        return EXIT.USAGE;
    }
    for (const w of cfg.warnings) io.err(`Uwaga: ${w}\n`);
    if (opt.check) {
        const ids = [...cfg.messages.keys()];
        const toInflux = ids.filter(id => cfg.toInflux(id));
        io.err(`${configFile}: OK - komunikatow ${ids.length} (grup ${cfg.groups.size}), do InfluxDB ${toInflux.length}, `
            + `wylaczonych ${cfg.disabled.size}, strefa ${cfg.timezone}\n`);
        const notInflux = ids.filter(id => !cfg.toInflux(id)).sort();
        if (notInflux.length) io.err(`  tylko SQLite (poza include / w exclude): ${notInflux.join(' ')}\n`);
        return EXIT.OK;
    }
    const inputDir = opt['input-dir'] ? path.resolve(opt['input-dir']) : cfg.input.dir;
    const archiveDir = opt['archive-dir'] ? path.resolve(opt['archive-dir']) : cfg.input.archiveDir;
    const dirMode = !args.positionals.length && !!inputDir;
    if (!args.positionals.length && !dirMode && !(opt['task-times'] && opt.sqlite)) {
        io.err(`Brak plikow wejsciowych - podaj pliki albo katalog (input.dir w konfiguracji / --input-dir)\n${USAGE}\n`);
        return EXIT.USAGE;
    }

    // SQLite = trwaly stan (historia do parowania zadan miedzy ekstraktami, kontrola terminow, przetworzone pliki).
    // W --dry-run / --estimate / --task-times tylko odczyt istniejacego pliku.
    const readOnly = opt['dry-run'] || opt.estimate || opt['task-times'];
    let store: SqliteStore | undefined;
    if (opt.sqlite && (!readOnly || fs.existsSync(opt.sqlite))) {
        try {
            store = new SqliteStore(opt.sqlite);
        } catch (err) {
            io.err(`SQLite ${opt.sqlite}: ${(err as Error).message}\n`);
            return EXIT.WRITE;
        }
    }

    let exit: number = EXIT.OK;
    let files = args.positionals;
    const fileInfo = new Map<string, fs.Stats>();
    if (dirMode) {
        let names: string[];
        try {
            names = fs.readdirSync(inputDir!).filter(n => cfg.input.include.test(n)).sort();
        } catch (err) {
            io.err(`Katalog ekstraktow ${inputDir}: ${(err as Error).message}\n`);
            store?.close();
            return EXIT.INPUT;
        }
        let young = 0;
        let done = 0;
        files = [];
        for (const n of names) {
            const f = path.join(inputDir!, n);
            const st = fs.statSync(f);
            if (!st.isFile()) continue;
            if (Date.now() - st.mtimeMs < cfg.input.minAgeMs) {
                young++;
                continue;
            }
            if (store && !opt.all && store.isProcessed(n, st.size, st.mtimeMs)) {
                done++;
                continue;
            }
            fileInfo.set(f, st);
            files.push(f);
        }
        io.err(`Katalog ${inputDir}: nowych plikow ${files.length}, juz przetworzonych ${done}, pominietych (zmienione < ${cfg.input.minAgeMs / 1000} s) ${young}`
            + `${store ? '' : ' (bez --sqlite: brak rejestru przetworzonych plikow - przetwarzane wszystkie)'}\n`);
    }

    const results: FileResult[] = [];
    for (const file of files) {
        let content: string;
        try {
            content = fs.readFileSync(file, 'utf8');
        } catch (err) {
            io.err(`${file}: nie mozna odczytac (${(err as Error).message})\n`);
            exit = EXIT.INPUT;
            continue;
        }
        const r = processFile(file, content, cfg, { hostId: opt['host-id'], logType: opt['log-type'] });
        printSummary(r, maxIssues, io);
        results.push(r);
    }

    try {
        return await run();
    } finally {
        store?.close();
    }

    async function run(): Promise<number> {
        const current = results.flatMap(r => r.result.events);

        // Czas trwania zadan: parowanie start / koniec - biezace pliki + historia z SQLite (zadanie zaczete
        // przed poprzednim ekstraktem); punkty tylko dla zadan zakonczonych w biezacych danych
        let durationPoints: MappedEvent[] = [];
        let tasks: TaskRecord[] = [];
        let open: OpenStart[] = [];
        if (cfg.durations) {
            let history: MappedEvent[] = [];
            if (store) {
                const msgs = new Set<string>();
                for (const t of cfg.durations.tasks) {
                    for (const m of [...t.starts, ...t.ends.keys(), ...t.aggregates.flatMap(a => [...a.msgs])]) msgs.add(m);
                }
                // bez nowych plikow: historia do chwili ekstraktu (starty w toku -> RUNNING w kontroli terminow)
                const minMs = current.length ? Math.min(...current.map(e => e.timeMs)) : asOfMs;
                const maxMs = current.length ? Math.max(...current.map(e => e.timeMs)) : asOfMs;
                const back = Math.max(...cfg.durations.tasks.map(t => t.maxMs));
                const key = (e: MappedEvent) => `${e.source}\u0000${e.raw.sysname}\u0000${e.raw.groupId}\u0000${e.raw.line}`;
                const seen = new Set(current.map(key));
                history = store.loadEvents(minMs - back, maxMs, [...msgs]).filter(e => !seen.has(key(e)));
            }
            const fresh = new Set(current);
            const paired = pairTasks([...history, ...current], cfg.durations, cfg.countField, e => fresh.has(e));
            durationPoints = paired.points;
            tasks = paired.records;
            open = paired.open;
            io.err(`Czas trwania (${cfg.durations.measurement}): nowych zadan ${tasks.length}`
                + `${store ? `, historia z SQLite: ${history.length} zdarzen` : ' (bez --sqlite: parowanie tylko w biezacych plikach)'}\n`);
            io.err('  ZADANIE        sparowane  koniec_bez_startu  otwarte  ponowny_start  bez_czasu\n');
            for (const [name, st] of paired.stats) {
                if (!st.paired && !st.unmatchedEnd && !st.open && !st.restarted && !st.noTime) continue;
                const col = (n: number, w: number) => String(n).padStart(w);
                io.err(`  ${name.padEnd(14)}${col(st.paired, 10)}${col(st.unmatchedEnd, 19)}${col(st.open, 9)}${col(st.restarted, 15)}${col(st.noTime, 11)}\n`);
            }
        }

        const completed: CompletedTask[] = [
            ...(store?.loadTasks() ?? []),
            ...tasks.map(t => ({ task: t.task, sysname: t.sysname, hostId: t.hostId, startMs: t.start.timeMs, endMs: t.end.timeMs, status: t.status })),
        ];

        if (opt['task-times']) {
            if (!cfg.durations) {
                io.err('Brak konfiguracji durations (zadan)\n');
                return EXIT.USAGE;
            }
            io.out(`${formatTaskTimes(completed, cfg.durations, cfg.timezone)}\n`);
            return exit;
        }

        if (opt.estimate) {
            const sample = collectSample([...current, ...durationPoints], cfg);
            const fileDates = results.map(r => r.meta.fileDate && `${r.meta.fileDate.y}-${r.meta.fileDate.m}-${r.meta.fileDate.d}`);
            const sd = sampleDaysOf(sample, fileDates, estimate.sampleDays);
            io.out(`${formatEstimate(sample, cfg, { ...estimate, sampleDays: sd.days, sampleSource: sd.source })}\n`);
            return exit;
        }

        // Kontrola terminow konca (expectedEnd) - wymaga historii i stanu w SQLite
        let checkPoints: MappedEvent[] = [];
        let taskLevel = 0;
        const checks = cfg.durations?.tasks.some(t => t.expectedEndMin !== undefined) ?? false;
        if (checks && !store) {
            io.err('Uwaga: kontrola expectedEnd pominieta - wymaga --sqlite (stan miedzy ekstraktami)\n');
        } else if (checks && store && cfg.durations) {
            const hostMap = new Map<string, { sysname: string; hostId?: string; firstMs: number }>();
            for (const h of [...store.hosts(), ...current.map(e => ({ sysname: e.raw.sysname, hostId: e.hostId, firstMs: e.timeMs }))]) {
                const k = `${h.sysname}/${h.hostId ?? ''}`;
                const prev = hostMap.get(k);
                if (!prev || h.firstMs < prev.firstMs) hostMap.set(k, { sysname: h.sysname, hostId: h.hostId, firstMs: h.firstMs });
            }
            const st = store;
            const res = evaluateChecks({
                durations: cfg.durations, timezone: cfg.timezone, countField: cfg.countField, asOfMs, completed, open,
                hosts: [...hostMap.values()], previous: (...a) => st.getCheck(...a),
            });
            checkPoints = res.points;
            for (const n of res.notifications) {
                io.err(`HSM-${n.level[0]} ${n.text}\n`);
                taskLevel = Math.max(taskLevel, n.level === 'ERROR' ? 2 : n.level === 'WARNING' ? 1 : 0);
            }
            const okCount = res.checks.filter(c => c.level === 'OK').length;
            io.err(`Kontrola terminow (${CHECK_MEASUREMENT}, as-of ${new Date(asOfMs).toISOString()}): zmian ${res.checks.length}, `
                + `OK ${okCount}, WARNING ${res.checks.filter(c => c.level === 'WARNING').length}, ERROR ${res.checks.filter(c => c.level === 'ERROR').length}\n`);
            if (!opt['dry-run']) for (const c of res.checks) store.putCheck(c);
        }

        const allLines = [...results.flatMap(r => r.lines), ...durationPoints.map(e => toLine(e, cfg.uniqueTimestamps)),
            ...checkPoints.map(e => toLine(e, true))];
        if (opt.print) io.out(allLines.length ? `${allLines.join('\n')}\n` : '');

        if (!opt['dry-run']) {
            try {
                if (opt.out) {
                    fs.writeFileSync(opt.out, allLines.length ? `${allLines.join('\n')}\n` : '');
                    io.err(`Zapisano ${allLines.length} punktow do ${opt.out}\n`);
                } else if (allLines.length) {
                    const target = {
                        url: process.env.INFLUXDB_URL || 'http://localhost:8086',
                        database: opt.db || process.env.INFLUXDB_DATABASE || 'metrics',
                        username: process.env.INFLUXDB_USERNAME || undefined,
                        password: process.env.INFLUXDB_PASSWORD || undefined,
                        retentionPolicy: opt.rp,
                    };
                    await writeLines(target, allLines);
                    io.err(`Zapisano ${allLines.length} punktow do InfluxDB ${target.url} (baza ${target.database})\n`);
                }
                if (store) {
                    for (const r of results) store.save(r.meta, r.result.events);
                    store.saveTasks(tasks);
                    for (const r of results) {
                        const f = files.find(x => path.basename(x) === r.meta.source);
                        const st = f ? fileInfo.get(f) ?? fs.statSync(f) : undefined;
                        if (st) store.markProcessed(r.meta.source, st.size, st.mtimeMs, r.result.events.length);
                    }
                    io.err(`Zapisano ${current.length} zdarzen i ${tasks.length} zadan do ${opt.sqlite}\n`);
                }
                if (dirMode && archiveDir && results.length) {
                    fs.mkdirSync(archiveDir, { recursive: true });
                    for (const r of results) {
                        const from = path.join(inputDir!, r.meta.source);
                        const to = path.join(archiveDir, r.meta.source);
                        try {
                            fs.renameSync(from, to);
                        } catch (err) {
                            if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
                            fs.copyFileSync(from, to); // inny system plikow
                            fs.unlinkSync(from);
                        }
                    }
                    io.err(`Przeniesiono ${results.length} plikow do ${archiveDir}\n`);
                }
            } catch (err) {
                io.err(`${err instanceof WriteError ? err.message : `Blad zapisu: ${(err as Error).message}`}\n`);
                return EXIT.WRITE;
            }
        }

        if (exit === EXIT.OK && opt.strict && results.some(r => r.issues.length)) exit = EXIT.DATA;
        if (exit === EXIT.OK && taskLevel) exit = taskLevel === 2 ? EXIT.TASK_ERROR : EXIT.TASK_WARNING;
        return exit;
    }
}

if (require.main === module) {
    main(process.argv.slice(2)).then(code => {
        process.exitCode = code;
    }, err => {
        process.stderr.write(`Nieoczekiwany blad: ${(err as Error).stack ?? err}\n`);
        process.exitCode = 1;
    });
}
