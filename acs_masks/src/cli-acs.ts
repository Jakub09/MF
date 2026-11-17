/**
 * acs-masks - polecenia pracujace na zrodlach rutyn ACS (uruchamiane na PC):
 *
 *   acs-masks check <rutyna>...
 *       kontrola skladni i semantyki rutyn (te same diagnostyki co w rozszerzeniu VS Code)
 *
 *   acs-masks repr <plik.csv> --acs <rutyna>... [--new <rutyna>...] [opcje]
 *       reprezentanci do testow NaviQuest: zbiory z CSV (job ACMCSV) pogrupowane wg warunkow z rutyn
 *       (domyslnie) albo wg sciezki wykonania (--trace); jeden reprezentant na grupe -> zos/ACMRLST
 *       (wejscie joba ACMRSEL). --new: nowa wersja rutyn - grupy uwzgledniaja warunki obu wersji.
 *
 *   acs-masks sim <plik.csv> --acs <rutyna>... [--new <rutyna>...] [opcje]
 *       emulacja rutyn na wszystkich zbiorach: wyliczone DC/SC/MC/SG a obecne klasy z DCOLLECT;
 *       z --new: zbiory, ktorym nowa wersja rutyn zmienia wynik (regresja).
 *
 * Opcje wspolne:
 *   --acs PLIK         rutyna ACS (mozna powtarzac: DC, SC, MC, SG - typ wg instrukcji PROC)
 *   --new PLIK         nowa wersja rutyny (jak --acs); typy niepodane w --new sa brane z --acs
 *   --env PLIK.json    srodowisko: { "size": "alloc|used", "volumes": "dcollect|none", "gdsStrip": true,
 *                      "initial": "null|dcollect", "vars": { "UNIT": "3390", "JOB": "@createJob" } }
 *   --var NAZWA=WART   stala wartosc zmiennej ACS (mozna powtarzac; "@pole" = pole zbioru)
 *   --out KATALOG      katalog wynikow (domyslnie nowy podkatalog przebiegu: out/repr|sim/RRRR-MM-DD_GGMMSS
 *                      w katalogu projektu; katalog bazowy zmienia ACS_MASKS_OUT)
 *   --today RRRR-MM-DD data odniesienia (&DATE, &RETPD)
 *   --vsam MODE        cluster (domyslnie, gdy sa rekordy A) albo component
 *   --encoding ENC     kodowanie CSV i rutyn (domyslnie utf-8)
 *   --top N            dlugosc list w raporcie (domyslnie 30)
 *   --dry-run          tylko raport na standardowe wyjscie
 * Opcje repr:
 *   --granularity G    list (domyslnie; jeden warunek na FILTLIST) albo entry (jeden na pozycje listy)
 *   --trace            grupy wg sciezki wykonania (emulator) zamiast wg wektora warunkow
 *   --per-group N      reprezentantow na grupe (domyslnie 1)
 *   --by-classes       osobny reprezentant dla kazdej kombinacji obecnych klas w grupie
 *   --tests            dodatkowo testy ISMF (DESCRIPTION1, DSN, ACSENVIR) z reprezentantow: zos/ACMTEST (wejscie
 *                      IEBUPDTE, job ACMTLOAD -> TESTBED) i zos/testy/<member>; zamiast testow z NaviQuest (ACBQBAG1)
 *   --test-prefix P    prefiks memberow testow, 1-4 litery (domyslnie ACM -> ACM00001)
 *
 * Wynik repr: REPREZENTANCI.txt, grupy.csv, zbiory.csv, zos/ACMRLST; z --tests: testy.csv, zos/ACMTEST, zos/testy/
 * Wynik sim:  SYMULACJA.txt, symulacja.csv, roznice.csv (z --new)
 * Kody wyjscia: 0 - OK, 1 - blad (argumenty, pliki, bledy w rutynach; check: znaleziono bledy).
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { CsvError, DataSet, readDataSets } from './dataset';
import { Atom, extractAtoms, nameMasks } from './lang/atoms';
import { DEFAULT_ENV, DERIVED, envBase, EnvBase, EnvOptions, makeEnv } from './lang/env';
import { simulate, SimOptions, SimResult } from './lang/interp';
import { allCmps } from './lang/ast';
import { normalize } from './lang/eval';
import { AcsError, formatDiag, Loaded, loadedList, loadRoutines, loadSource, ORDER, RoutineSet, SHORT } from './lang/load';
import { VARS } from './lang/vars';
import { buildGroups, Group, groupsCsv, listMember, membersCsv } from './repr';
import { buildTests, iebupdte, TEST_MAX_COL, TestCaseError } from './testcase';
import { runDir, RunKind, runInfo } from './outdir';
import { checkZosLines, ZosTextError } from './zos';

export interface Io {
    out: (t: string) => void;
    err: (t: string) => void;
}

export const ACS_COMMANDS = ['check', 'repr', 'sim'] as const;
export type AcsCommand = (typeof ACS_COMMANDS)[number];

const USAGE = 'Uzycie: acs-masks check <rutyna>...\n'
    + '        acs-masks repr <plik.csv> --acs <rutyna>... [--new <rutyna>...] [--granularity list|entry] [--trace]\n'
    + '                  [--per-group N] [--by-classes] [--tests] [--test-prefix ACM]\n'
    + '        acs-masks sim  <plik.csv> --acs <rutyna>... [--new <rutyna>...]\n'
    + '        wspolne: [--env plik.json] [--var NAZWA=WARTOSC]... [--out katalog] [--today RRRR-MM-DD]\n'
    + '                 [--vsam cluster|component] [--encoding utf-8] [--top N] [--dry-run]\n';

class ArgError extends Error {}

const envSchema = z.strictObject({
    size: z.enum(['alloc', 'used']).optional(),
    volumes: z.enum(['dcollect', 'none']).optional(),
    gdsStrip: z.boolean().optional(),
    initial: z.enum(['null', 'dcollect']).optional(),
    vars: z.record(z.string(), z.string()).optional(),
});

const n = (x: number) => x.toLocaleString('pl-PL');
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1).replace('.', ',')}%` : '-');

function loadEnv(file: string | undefined, vars: string[], today: Date): { env: EnvOptions; sim: SimOptions } {
    let cfg: z.infer<typeof envSchema> = {};
    if (file) {
        let raw: unknown;
        try {
            raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw e;
            throw new ArgError(`${file}: niepoprawny JSON (${(e as Error).message})`);
        }
        const r = envSchema.safeParse(raw);
        if (!r.success) {
            throw new ArgError(`${file}: bledna konfiguracja srodowiska\n`
                + r.error.issues.map(i => `  ${i.path.join('.') || '(korzen)'}: ${i.message}`).join('\n'));
        }
        cfg = r.data;
    }
    const v: Record<string, string> = { ...(cfg.vars ?? {}) };
    for (const item of vars) {
        const m = /^&?([A-Za-z_0-9]+)=(.*)$/.exec(item);
        if (!m) throw new ArgError(`--var: oczekiwano NAZWA=WARTOSC, jest "${item}"`);
        v[m[1]] = m[2];
    }
    for (const k of Object.keys(v)) {
        if (!VARS.has(k.replace(/^&/, '').toUpperCase())) throw new ArgError(`nieznana zmienna ACS &${k} (--var / vars)`);
    }
    return {
        env: {
            size: cfg.size ?? DEFAULT_ENV.size,
            volumes: cfg.volumes ?? DEFAULT_ENV.volumes,
            gdsStrip: cfg.gdsStrip ?? DEFAULT_ENV.gdsStrip,
            vars: v,
            today,
        },
        sim: { initial: cfg.initial ?? 'null' },
    };
}

/** Zmienne uzyte w porownaniach rutyn, ktorych nie da sie wyliczyc z DCOLLECT (maja wartosc stala). */
function assumedVars(routines: Loaded[], base: EnvBase): string[] {
    const names = new Set<string>();
    for (const r of routines) {
        for (const c of allCmps(r.program)) {
            const norm = normalize(c);
            if (!norm) continue;
            for (const o of [norm.subject, norm.other]) {
                if (o.kind === 'var' && VARS.has(o.name) && !DERIVED.has(o.name)) names.add(o.name);
            }
        }
    }
    const fields = new Map(base.fields);
    const consts = new Map(base.consts);
    return [...names].sort().map(x => {
        if (fields.has(x)) return `&${x} = pole ${String(fields.get(x))}`;
        const val = consts.get(x) ?? (x === 'ACSENVIR' ? 'ALLOC' : x === 'DATE' ? base.date : x === 'DAYOFWEEK' ? base.dayOfWeek : x === 'TIME' ? '00:00' : '');
        return `&${x} = '${val}'`;
    });
}

const simCols = (r: SimResult | undefined) => (r ? [r.dc, r.sc, r.mc, r.sg, r.fail] : ['', '', '', '', '']);

interface Loaded2 {
    old: RoutineSet;
    /** nowy zestaw: rutyny z --new, pozostale typy z --acs; null gdy brak --new */
    neu: RoutineSet | null;
    /** rutyny do raportu / atomow: stare + nowe (z etykieta z gwiazdka) */
    all: Loaded[];
}

function loadSets(acs: string[], neu: string[], encoding: BufferEncoding): Loaded2 {
    if (acs.length === 0) throw new ArgError('podaj co najmniej jedna rutyne: --acs PLIK');
    const old = loadRoutines(acs, encoding);
    if (neu.length === 0) return { old, neu: null, all: loadedList(old) };
    const fresh = loadRoutines(neu, encoding);
    const merged: RoutineSet = { ...old };
    const all = loadedList(old);
    for (const r of ORDER) {
        if (!fresh[r]) continue;
        fresh[r] = { ...fresh[r]!, label: `${SHORT[r]}*` };
        merged[r] = fresh[r];
        all.push(fresh[r]!);
    }
    return { old, neu: merged, all };
}

function header(title: string, csv: string, sets: Loaded2, dataSets: DataSet[], stamp: string, assumed: string[], env: EnvOptions): string[] {
    const out = [`acs-masks ${title} ${stamp}`, `CSV: ${csv}   zbiorow: ${n(dataSets.length)}`];
    for (const l of sets.all) out.push(`Rutyna ${l.label.padEnd(3)} ${l.routine}: ${l.file}`);
    if (sets.neu) out.push('(* = nowa wersja rutyny, --new)');
    out.push(`Srodowisko: &SIZE = ${env.size === 'alloc' ? 'alokacja' : 'uzycie'}, wolumeny: ${env.volumes}, `
        + `GDS bez GnnnnVnn: ${env.gdsStrip ? 'tak' : 'nie'}`);
    if (assumed.length) {
        out.push('Zmienne bez danych w DCOLLECT uzyte w rutynach - wartosc stala dla wszystkich zbiorow (--var / --env):');
        out.push('  ' + assumed.join(', '));
    }
    out.push('');
    return out;
}

function runCheck(files: string[], encoding: BufferEncoding, io: Io): number {
    if (files.length === 0) throw new ArgError('check: podaj pliki rutyn');
    let errors = 0;
    let warnings = 0;
    for (const file of files) {
        const l = loadSource(file, fs.readFileSync(file, encoding));
        for (const d of l.diagnostics) {
            if (d.severity === 'error') errors++;
            else if (d.severity === 'warning') warnings++;
            io.out(formatDiag(file, d) + '\n');
        }
        io.out(`${file}: ${l.routine ?? 'brak PROC'}, FILTLIST: ${l.program.filtlists.length}, porownan: ${l.program.cmpCount}\n`);
    }
    io.err(`Bledow: ${errors}, ostrzezen: ${warnings}\n`);
    return errors ? 1 : 0;
}

export async function mainAcs(cmd: AcsCommand, argv: string[], io: Io): Promise<number> {
    let a;
    try {
        a = parseArgs({
            args: argv,
            allowPositionals: true,
            options: {
                acs: { type: 'string', multiple: true, default: [] },
                new: { type: 'string', multiple: true, default: [] },
                env: { type: 'string' },
                var: { type: 'string', multiple: true, default: [] },
                out: { type: 'string', short: 'o' },
                granularity: { type: 'string', default: 'list' },
                trace: { type: 'boolean', default: false },
                'per-group': { type: 'string', default: '1' },
                'by-classes': { type: 'boolean', default: false },
                tests: { type: 'boolean', default: false },
                'test-prefix': { type: 'string', default: 'ACM' },
                vsam: { type: 'string' },
                today: { type: 'string' },
                top: { type: 'string', default: '30' },
                encoding: { type: 'string', default: 'utf-8' },
                'dry-run': { type: 'boolean', default: false },
                help: { type: 'boolean', short: 'h', default: false },
            },
        });
    } catch (err) {
        io.err(`${(err as Error).message}\n${USAGE}`);
        return 1;
    }
    const o = a.values;
    if (o.help) {
        io.out(USAGE);
        return 0;
    }
    try {
        const encoding = o.encoding as BufferEncoding;
        if (cmd === 'check') return runCheck(a.positionals, encoding, io);
        if (a.positionals.length !== 1) throw new ArgError(`${cmd}: podaj jeden plik CSV`);
        if (o.today && !/^\d{4}-\d{2}-\d{2}$/.test(o.today)) throw new ArgError('--today: RRRR-MM-DD');
        if (o.vsam && o.vsam !== 'cluster' && o.vsam !== 'component') throw new ArgError('--vsam: cluster albo component');
        if (o.granularity !== 'list' && o.granularity !== 'entry') throw new ArgError('--granularity: list albo entry');
        const top = Number(o.top);
        const perGroup = Number(o['per-group']);
        if (!Number.isInteger(top) || top < 0) throw new ArgError('--top: liczba calkowita >= 0');
        if (!Number.isInteger(perGroup) || perGroup < 1) throw new ArgError('--per-group: liczba calkowita >= 1');
        const today = o.today ? new Date(`${o.today}T00:00:00Z`) : new Date();
        const stamp = today.toISOString().slice(0, 10);
        const csvFile = a.positionals[0];
        const sets = loadSets(o.acs, o.new, encoding);
        const cfg = loadEnv(o.env, o.var, today);
        const base = envBase(cfg.env);
        const { dataSets, dRecords, assoc, warnings } = await readDataSets(csvFile, {
            encoding, vsamCluster: o.vsam ? o.vsam === 'cluster' : undefined, today,
            onProgress: (lines, part) => io.err(`CSV: ${lines.toLocaleString('pl-PL')} linii (${Math.round(part * 100)}%)\n`),
        });
        for (const w of warnings) io.err(`Uwaga: ${w}\n`);
        io.err(`CSV: ${dRecords} rekordow D, ${assoc} rekordow A -> ${dataSets.length} zbiorow\n`);
        const assumed = assumedVars(sets.all, base);
        const files: Record<string, string> = {};
        let report: string[];

        const sim = (set: RoutineSet, d: DataSet) => simulate(set, makeEnv(d, base), cfg.sim);

        if (cmd === 'sim') {
            report = header('sim - emulacja rutyn ACS', csvFile, sets, dataSets, stamp, assumed, cfg.env);
            const rows: string[] = [];
            const diffRows: string[] = [];
            const fields = ['dc', 'sc', 'mc', 'sg'] as const;
            const supplied = new Set(loadedList(sets.old).map(l => l.label.toLowerCase()));
            // zgodnosc z obecnymi klasami i przejscia obecna -> wyliczona
            const agree = { dc: 0, sc: 0, mc: 0, sg: 0 };
            const trans = new Map<string, { count: number; example: string }>();
            const changes = new Map<string, { count: number; example: string }>();
            const bump = (m: Map<string, { count: number; example: string }>, k: string, dsn: string) => {
                const e = m.get(k);
                if (e) e.count++;
                else m.set(k, { count: 1, example: dsn });
            };
            let fails = 0;
            let changed = 0;
            for (const d of dataSets) {
                const ro = sim(sets.old, d);
                const rn = sets.neu ? sim(sets.neu, d) : undefined;
                if (ro.fail) fails++;
                for (const f of fields) {
                    if (!supplied.has(f)) continue;
                    const now = d[f];
                    const ok = f === 'sg' ? ro.sg.split(',').includes(now) || ro.sg === now : ro[f] === now;
                    if (ok) agree[f]++;
                    else bump(trans, `${f.toUpperCase()}: '${now}' -> '${ro[f]}'`, d.dsn);
                }
                let diff = '';
                if (rn) {
                    for (const f of fields) {
                        if (ro[f] !== rn[f]) {
                            diff += f.toUpperCase() + ' ';
                            bump(changes, `${f.toUpperCase()}: '${ro[f]}' -> '${rn[f]}'`, d.dsn);
                        }
                    }
                    if (ro.fail !== rn.fail) {
                        diff += 'EXIT ';
                        bump(changes, `EXIT: '${ro.fail}' -> '${rn.fail}'`, d.dsn);
                    }
                    if (diff) changed++;
                }
                const row = [d.dsn, d.dc, d.sc, d.mc, d.sg, ...simCols(ro), ...(rn ? [...simCols(rn), diff.trim()] : [])].join(';');
                rows.push(row);
                if (diff) diffRows.push(row);
            }
            const head = ['dsn', 'dc_dcollect', 'sc_dcollect', 'mc_dcollect', 'sg_dcollect', 'dc', 'sc', 'mc', 'sg', 'exit',
                ...(sets.neu ? ['dc_nowa', 'sc_nowa', 'mc_nowa', 'sg_nowa', 'exit_nowa', 'zmiana'] : [])].join(';');
            files['symulacja.csv'] = [head, ...rows].join('\n') + '\n';
            if (sets.neu) files['roznice.csv'] = [head, ...diffRows].join('\n') + '\n';
            const sorted = (m: Map<string, { count: number; example: string }>) => [...m].sort((x, y) => y[1].count - x[1].count);
            report.push('--- Wynik rutyn (--acs) a obecne klasy z DCOLLECT');
            report.push('    (roznice: klasa nadana recznie, zmienna spoza DCOLLECT, stara wersja rutyny albo blad emulacji)');
            for (const f of fields) {
                if (supplied.has(f)) report.push(`  ${f.toUpperCase()}: zgodnych ${n(agree[f])} z ${n(dataSets.length)} (${pct(agree[f], dataSets.length)})`);
            }
            if (fails) report.push(`  Alokacja odrzucona (EXIT CODE > 0): ${n(fails)} zbiorow`);
            const tr = sorted(trans);
            if (tr.length) {
                report.push(`  Najczestsze roznice obecna -> wyliczona (${Math.min(top, tr.length)} z ${tr.length}):`);
                for (const [k, e] of tr.slice(0, top)) report.push(`    ${String(e.count).padStart(8)}  ${k.padEnd(34)} np. ${e.example}`);
            }
            if (sets.neu) {
                report.push('');
                report.push('--- Regresja: stare rutyny (--acs) a nowe (--new)');
                report.push(`  Zbiorow ze zmienionym wynikiem: ${n(changed)} z ${n(dataSets.length)} (lista: roznice.csv)`);
                for (const [k, e] of sorted(changes).slice(0, top)) {
                    report.push(`    ${String(e.count).padStart(8)}  ${k.padEnd(34)} np. ${e.example}`);
                }
            }
        } else {
            report = header('repr - reprezentanci do testow ACS', csvFile, sets, dataSets, stamp, assumed, cfg.env);
            let keys: string[];
            let describe: (g: Group) => string;
            let atoms: Atom[] = [];
            if (o.trace) {
                keys = dataSets.map(d => {
                    const ro = sim(sets.old, d).path;
                    return sets.neu ? `${ro} || ${sim(sets.neu, d).path}` : ro;
                });
                describe = g => g.key;
                report.push('Grupy wg sciezki wykonania rutyn (--trace): numer decyzji IF (T/F) i SELECT (numer WHEN od 0, O = OTHERWISE).');
            } else {
                atoms = extractAtoms(sets.all, o.granularity);
                const counts = new Array<number>(atoms.length).fill(0);
                const bits = dataSets.map(d => {
                    const env = makeEnv(d, base);
                    let s = '';
                    atoms.forEach((at, i) => {
                        const t = at.test(env);
                        if (t) counts[i]++;
                        s += t ? '1' : '0';
                    });
                    return s;
                });
                const live = atoms.map((_, i) => counts[i] > 0 && counts[i] < dataSets.length);
                const liveIdx = atoms.map((_, i) => i).filter(i => live[i]);
                keys = bits.map(b => liveIdx.map(i => b[i]).join(''));
                describe = g => liveIdx.filter((_, k) => g.key[k] === '1').map(i => i + 1).join(' ') || '(zaden)';
                const rw = atoms.filter(at => at.vars.some(x => VARS.get(x)?.rw));
                report.push(`Warunkow w rutynach: ${atoms.length} (ziarnistosc FILTLIST: ${o.granularity}); rozrozniajacych zbiory: ${liveIdx.length}`);
                if (rw.length) {
                    report.push('Uwaga: warunki na &DATACLAS / &STORCLAS / &MGMTCLAS / &STORGRP sa oceniane wg obecnych klas z DCOLLECT');
                    report.push('       (wynik wczesniejszej rutyny liczy tryb --trace).');
                }
                report.push('');
                report.push('--- Warunki (nr, dla ilu zbiorow prawdziwy, warunek, gdzie)');
                atoms.forEach((at, i) => {
                    const mark = counts[i] === 0 ? ' NIGDY' : counts[i] === dataSets.length ? ' ZAWSZE' : '';
                    report.push(`  ${String(i + 1).padStart(4)} ${String(counts[i]).padStart(9)}${mark.padEnd(7)} ${at.text.padEnd(36)} ${at.where.join(', ')}`);
                });
                const dead = atoms.filter((_, i) => counts[i] === 0).length;
                if (dead) report.push(`  NIGDY = warunek nie jest prawdziwy dla zadnego zbioru z CSV (${dead}) - martwa maska albo zmienna spoza DCOLLECT`);
            }
            const groups = buildGroups(dataSets, keys, { perGroup, byClasses: o['by-classes'] });
            const reps = groups.reduce((s, g) => s + g.reps.length, 0);
            report.push('');
            report.push(`--- Grupy: ${n(groups.length)}, reprezentantow: ${n(reps)} (zbiorow: ${n(dataSets.length)})`);
            report.push(`  ${'grupa'.padStart(6)} ${'zbiorow'.padStart(9)}  ${'reprezentant'.padEnd(44)} ${o.trace ? 'sciezka' : 'prawdziwe warunki (nr)'}`);
            for (const g of groups.slice(0, top)) {
                report.push(`  ${String(g.id).padStart(6)} ${String(g.count).padStart(9)}  ${g.reps[0].dsn.padEnd(44)} ${describe(g)}`);
            }
            if (groups.length > top) report.push(`  ... (${groups.length - top} dalszych grup w grupy.csv)`);
            const vsamOnly = groups.filter(g => g.vsamOnly);
            if (vsamOnly.length) {
                report.push('');
                report.push(`--- Grupy tylko ze zbiorami VSAM: ${vsamOnly.length}. Rekord D ma nazwe komponentu, wiec test z DCOLLECT dostanie`);
                report.push('    nazwe komponentu zamiast klastra - popraw DSN w tych testach recznie:');
                for (const g of vsamOnly.slice(0, top)) report.push(`  ${String(g.id).padStart(6)}  ${g.reps[0].dsn} (rekord D: ${g.reps[0].recDsn})`);
            }
            const mixed = groups.filter(g => g.classes.size > 1);
            report.push('');
            report.push(`--- Kontrola: grupy, w ktorych zbiory maja dzis rozne klasy DC/SC/MC/SG: ${mixed.length}`);
            if (mixed.length) {
                report.push('    (klasa nadana recznie, zmienna spoza DCOLLECT albo warunek, ktorego rutyna juz nie ma; --by-classes da');
                report.push('     osobnego reprezentanta dla kazdej kombinacji klas)');
                for (const g of mixed.slice(0, top)) {
                    const cl = [...g.classes].sort((x, y) => y[1] - x[1]).slice(0, 4).map(([k, c]) => `${k} x${c}`).join('  ');
                    report.push(`  ${String(g.id).padStart(6)} ${String(g.count).padStart(9)}  ${cl}${g.classes.size > 4 ? '  ...' : ''}`);
                }
            }
            const repRes = new Map<Group, [SimResult, SimResult | undefined]>();
            for (const g of groups) repRes.set(g, [sim(sets.old, g.reps[0]), sets.neu ? sim(sets.neu, g.reps[0]) : undefined]);
            files['grupy.csv'] = groupsCsv(groups, describe, {
                head: ['dc', 'sc', 'mc', 'sg', 'exit', ...(sets.neu ? ['dc_nowa', 'sc_nowa', 'mc_nowa', 'sg_nowa', 'exit_nowa'] : [])],
                row: g => {
                    const [ro, rn] = repRes.get(g)!;
                    return [...simCols(ro), ...(sets.neu ? simCols(rn) : [])];
                },
            });
            files['zbiory.csv'] = membersCsv(dataSets, groups);
            const member = listMember(groups);
            checkZosLines('ACMRLST', member, 80);
            files[path.join('zos', 'ACMRLST')] = member.join('\n') + '\n';

            if (o.tests) {
                // testy ISMF z samym DSN i ACSENVIR: nazwa taka, jaka widzi ACS (klaster VSAM, GDS bez GnnnnVnn)
                const seen = new Set<string>();
                const items: { dsn: string; description: string; group: Group }[] = [];
                for (const g of groups) {
                    for (const d of g.reps) {
                        const env = makeEnv(d, base);
                        const dsn = String(env.values.DSN);
                        if (seen.has(dsn)) continue;
                        seen.add(dsn);
                        // opis: tylko maski / kwalifikatory z testowanych rutyn, do ktorych pasuje nazwa
                        items.push({ dsn, description: nameMasks(sets.all, env).join(' ') || 'BEZ MASKI', group: g });
                    }
                }
                const tests = buildTests(o['test-prefix'], items);
                for (const t of tests) {
                    checkZosLines(t.member, t.lines, TEST_MAX_COL);
                    files[path.join('zos', 'testy', t.member)] = t.lines.join('\n') + '\n';
                }
                const upd = iebupdte(tests);
                checkZosLines('ACMTEST', upd, TEST_MAX_COL);
                files[path.join('zos', 'ACMTEST')] = upd.join('\n') + '\n';
                files['testy.csv'] = ['member;grupa;zbiorow;dsn', ...tests.map((t, i) => `${t.member};${items[i].group.id};${items[i].group.count};${t.dsn}`)].join('\n') + '\n';
                // zmienne, od ktorych zaleza rutyny, a ktorych test nie niesie (w tescie puste)
                const carried = new Set(['DSN', 'HLQ', 'LLQ', 'NQUAL', 'ACSENVIR']);
                const missing = new Set<string>();
                for (const l of sets.all) {
                    for (const c of allCmps(l.program)) {
                        const norm = normalize(c);
                        if (!norm) continue;
                        for (const x of [norm.subject, norm.other]) {
                            if (x.kind === 'var' && VARS.has(x.name) && !carried.has(x.name) && !VARS.get(x.name)!.rw) missing.add(x.name);
                        }
                    }
                }
                report.push('');
                report.push(`--- Testy ISMF (--tests): ${tests.length} (${tests[0]?.member ?? '-'} - ${tests[tests.length - 1]?.member ?? '-'}), pola: DESCRIPTION1, DSN, ACSENVIR`);
                report.push('    z/OS: zos/ACMTEST -> MASKLIB, job ACMTLOAD (IEBUPDTE -> TESTBED), potem raports/jcl/ACSTGEN z RESTART=TESTBAS');
                if (missing.size) {
                    report.push(`    Uwaga: rutyny uzywaja zmiennych, ktorych test nie zawiera (w tescie puste): ${[...missing].sort().map(x => '&' + x).join(', ')}`);
                    report.push('    - grupy rozne tylko wg tych zmiennych dadza w ISMF ten sam wynik; wynik testu moze sie roznic od emulacji');
                    report.push('      (kolumny dc/sc/mc/sg w grupy.csv liczone z danymi z DCOLLECT). Pelniejsze testy: NaviQuest (ACMRSEL + ACBQBAG1).');
                }
            }
        }

        const text = report.join('\n') + '\n';
        io.out(text);
        if (o['dry-run']) return 0;
        const outDir = o.out ? path.resolve(o.out) : runDir(cmd as RunKind);
        fs.mkdirSync(path.join(outDir, 'zos'), { recursive: true });
        files['wywolanie.txt'] = runInfo(cmd, argv);
        files[cmd === 'sim' ? 'SYMULACJA.txt' : 'REPREZENTANCI.txt'] = text;
        // poprzednie testy w zos/testy - usuwane, zeby nie zostaly membery z innego przebiegu
        if (Object.keys(files).some(k => k.startsWith(path.join('zos', 'testy')))) {
            fs.rmSync(path.join(outDir, 'zos', 'testy'), { recursive: true, force: true });
        }
        for (const [rel, body] of Object.entries(files)) {
            fs.mkdirSync(path.dirname(path.join(outDir, rel)), { recursive: true });
            fs.writeFileSync(path.join(outDir, rel), body);
        }
        const shown = Object.keys(files).filter(k => !k.startsWith(path.join('zos', 'testy') + path.sep)).sort();
        const nTests = Object.keys(files).length - shown.length;
        io.err(`Zapisano: ${outDir}/ (${shown.join(', ')}${nTests ? `, zos/testy/: ${nTests} memberow` : ''})\n`);
        return 0;
    } catch (err) {
        if (err instanceof ArgError) {
            io.err(`Blad: ${err.message}\n${USAGE}`);
            return 1;
        }
        if (err instanceof AcsError || err instanceof CsvError || err instanceof ZosTextError || err instanceof TestCaseError) {
            io.err(`Blad: ${err.message}\n`);
            return 1;
        }
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            io.err(`Blad: brak pliku ${(err as NodeJS.ErrnoException).path}\n`);
            return 1;
        }
        throw err;
    }
}
