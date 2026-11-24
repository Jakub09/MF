/**
 * Szukanie masek DSN wg kryteriow z CSV DCOLLECT (job ACMCSV) i sprawdzanie gotowej listy masek. Wersja jednoplikowa: acs-masks-auto.cjs (bez npm).
 *
 *   node acs-masks-auto.cjs DCOLLECT.CSV [opcje]
 *
 *   --scope "WARUNKI"  zbiory brane pod uwage                  (domyslnie "sms=true dsorg=PS")
 *   --when "WARUNKI"   kryterium: zbior "maly"; reszta = "duze" (domyslnie "allocTrk=315 usedTrk<=3")
 *   --prefix MASKA     poczatek kazdej maski, np. "ABC%.**": ABC%.**, ABC%.X.**, ABC%.**.LIST; liczone sa tylko zbiory
 *                      o tak zaczynajacych sie nazwach (% i * w kwalifikatorach; ** tylko na koncu, mozna pominac)
 *   --min-purity X     najmniejsza czystosc maski 0-1: male / (male + duze)      (domyslnie 0.95)
 *   --min-count N      ile malych, nieobjetych wczesniejszymi maskami, ma dodac maska (domyslnie 10)
 *   --max-masks N      najwiecej masek                                            (domyslnie 100)
 *   --unit MB|GB|TB    jednostka sumy alokacji                                   (domyslnie GB)
 *   --out PLIK         maski takze do pliku CSV (separator ;)
 *
 *   --masks PLIK       sprawdza maski z pliku (po jednej w linii albo po przecinku; CSV z --out tez): liczby dla kazdej
 *                      maski, pokrycie wszystkich razem, maski zbedne, pary nakladajace sie; potem szuka nowych masek
 *                      dla malych zbiorow, ktorych lista nie obejmuje (zbiory objete lista, male i duze, sa pominiete).
 *                      --prefix: poczatek nowych masek, zaweza tez zbiory, na ktorych sprawdzana jest lista.
 *
 * WARUNKI: pole, operator (= != < <= > >=), wartosc; kilka warunkow po spacji = wszystkie naraz (AND).
 *   Wartosc tekstowa po = / != moze byc maska: dsn=PROD.**  sg=SGEAV*
 * Pola liczbowe: allocTrk usedTrk freeTrk allocKb usedKb extents vols nqual lrecl blksize ageDays unrefDays
 *   tekstowe: dsn hlq llq vol dsorg recfm sc mc dc sg createJob    true / false: sms temp pdse gds ef vsam
 *
 * Postep: pasek na stderr (przekierowane do pliku: jedna linia na etap).
 * Generacje GDG maja nazwe bez GnnnnVnn - tak widzi ja ACS w &DSN. Zbior wielowolumenowy liczony raz.
 * Malych / Duzych GB = suma alokacji (1 GB = 1024 MB). Kod wyjscia: 0 - OK, 1 - blad.
 */
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { checkMasks, CheckResult, MaskListError, parseMaskList } from './auto-check';
import { mine, MaskRow, MineOptions } from './auto-mine';
import { BOOL, BoolField, Field, NUM, NumField, readStore, Store, STR, StrField } from './auto-read';
import { Interner, Progress, thousands, Tick } from './auto-util';
import { CsvError } from './dataset';
import { MaskError, matches, parseMask } from './mask';

export interface Io {
    out: (t: string) => void;
    err: (t: string) => void;
    /** pasek postepu rysowany w miejscu (terminal); domyslnie: linia na etap */
    tty?: boolean;
}

const STDIO: Io = { out: t => process.stdout.write(t), err: t => process.stderr.write(t), tty: process.stderr.isTTY };

const USAGE = 'Uzycie: node acs-masks-auto.cjs DCOLLECT.CSV [--scope "sms=true dsorg=PS"]\n'
    + '        [--when "allocTrk=315 usedTrk<=3"] [--prefix "ABC%.**"] [--min-purity 0.95]\n'
    + '        [--min-count 10] [--max-masks 100] [--unit GB] [--out maski.csv]\n'
    + '   albo: node acs-masks-auto.cjs DCOLLECT.CSV --masks maski.txt [opcje jak wyzej]\n'
    + '         (sprawdza liste i szuka masek dla zbiorow, ktorych ona nie obejmuje)\n'
    + `Pola liczbowe: ${NUM.join(' ')}\n     tekstowe: ${STR.join(' ')}\n     true / false: ${BOOL.join(' ')}\n`
    + 'Operatory: = != < <= > >=; kilka warunkow po spacji = wszystkie naraz\n';

class ArgError extends Error {}

type Test = (row: number) => boolean;

export interface Conds {
    fields: Field[];
    /** test wiersza (wszystkie warunki naraz) */
    compile(st: Store): Test;
}

const isNum = (f: Field): f is NumField => (NUM as readonly string[]).includes(f);
const isBool = (f: Field): f is BoolField => (BOOL as readonly string[]).includes(f);

/** "allocTrk=315 usedTrk<=3"; pole bez wartosci (brak daty) nie spelnia warunku. */
export function parseConds(text: string, opt: string): Conds {
    const list = text.trim().split(/\s+/).filter(Boolean).map((c): { field: Field; make: (st: Store) => Test } => {
        const m = /^([A-Za-z]+)(<=|>=|!=|=|<|>)(.+)$/.exec(c);
        if (!m) throw new ArgError(`--${opt}: niepoprawny warunek "${c}" (np. allocTrk=315, bez spacji w srodku)`);
        const [, name, op, value] = m;
        const field = [...NUM, ...STR, ...BOOL].find(f => f.toLowerCase() === name.toLowerCase());
        if (!field) throw new ArgError(`--${opt}: nieznane pole "${name}"`);
        if (isNum(field)) {
            const want = Number(value.replace(',', '.'));
            if (!Number.isFinite(want)) throw new ArgError(`--${opt}: "${c}" - wartosc nie jest liczba`);
            return { field, make: st => numTest(st.num(field), op, want) };
        }
        if (op !== '=' && op !== '!=') throw new ArgError(`--${opt}: "${c}" - dla pola ${field} tylko = albo !=`);
        const eq = op === '=';
        if (isBool(field)) {
            if (!/^(true|false)$/i.test(value)) throw new ArgError(`--${opt}: "${c}" - wartosc true albo false`);
            const want = value.toLowerCase() === 'true';
            return {
                field,
                make: st => {
                    const get = st.bool(field);
                    return r => (get(r) === want) === eq;
                },
            };
        }
        const mask = /[*%]/.test(value) ? parseMask(value) : null;
        const want = value.toUpperCase();
        const ok = (v: string) => (mask ? matches(mask, v.toUpperCase()) : v.toUpperCase() === want) === eq;
        return { field, make: st => strTest(st, field, ok) };
    });
    return {
        fields: list.map(c => c.field),
        compile: st => {
            const tests = list.map(c => c.make(st));
            return r => {
                for (let i = 0; i < tests.length; i++) if (!tests[i](r)) return false;
                return true;
            };
        },
    };
}

function numTest(get: (r: number) => number | null, op: string, want: number): Test {
    const cmp: Record<string, (v: number) => boolean> = {
        '=': v => v === want, '!=': v => v !== want, '<': v => v < want, '<=': v => v <= want,
        '>': v => v > want, '>=': v => v >= want,
    };
    const f = cmp[op];
    return r => {
        const v = get(r);
        return v !== null && f(v);
    };
}

function strTest(st: Store, field: StrField, ok: (v: string) => boolean): Test {
    const get = st.str(field);
    const code = st.code(field);
    if (!code) return r => ok(get(r));
    // pole o powtarzajacych sie wartosciach: kazda wartosc porownywana raz
    const memo: boolean[] = [];
    return r => memo[code(r)] ??= ok(get(r));
}

/** "ABC%.**" -> kwalifikatory, od ktorych zaczyna sie kazda maska: ['ABC%']. */
export function parseHead(text: string): string[] {
    const { quals } = parseMask(text);
    if (quals[quals.length - 1] === '**') quals.pop();
    if (quals.includes('**')) throw new ArgError(`--prefix: "${text}" - ** tylko na koncu`);
    return quals;
}

/** Czy nazwa zaczyna sie od kwalifikatorow pasujacych kolejno do head (na bajtach: miliony nazw). */
function headTest(names: Interner, head: string[]): Test {
    const masks = head.map(q => Buffer.from(q, 'latin1'));
    const { pool } = names;
    return row => {
        let b = names.start[row];
        const end = b + names.len[row];
        for (const m of masks) {
            if (b >= end) return false;
            let e = b;
            while (e < end && pool[e] !== 46) e++;
            if (!qualLike(m, pool, b, e)) return false;
            b = e + 1;
        }
        return true;
    };
}

/** Kwalifikator maski (% = znak, * = zero lub wiecej znakow) wobec buf[s..e). */
function qualLike(m: Uint8Array, buf: Uint8Array, s: number, e: number): boolean {
    let i = 0;
    let p = s;
    let star = -1;
    let from = 0;
    while (p < e) {
        if (i < m.length && m[i] === 42) {
            star = i++;
            from = p;
        } else if (i < m.length && (m[i] === 37 || m[i] === buf[p])) {
            i++;
            p++;
        } else if (star >= 0) {
            i = star + 1;
            p = ++from;
        } else {
            return false;
        }
    }
    while (i < m.length && m[i] === 42) i++;
    return i === m.length;
}

function num(v: string, name: string, min: number, max: number, int: boolean): number {
    const x = Number(v.replace(',', '.'));
    if (v.trim() === '' || !Number.isFinite(x) || x < min || x > max || (int && !Number.isInteger(x))) {
        throw new ArgError(`--${name}: niepoprawna wartosc "${v}" (zakres ${min}-${max})`);
    }
    return x;
}

export interface SearchResult {
    /** zbiory w zakresie / spelniajace kryterium */
    inScope: number;
    small: number;
    masks: MaskRow[];
    /** wszystkie maski razem, kazdy zbior raz */
    total: MaskRow;
}

export function search(file: string, scope: Conds, when: Conds, opt: MineOptions, bar: Progress,
    warn: (t: string) => void = () => {}): SearchResult {
    const st = load(file, scope, when, bar, warn);
    const tick = bar.stage('Kryteria i maski');
    const { pos, neg } = classify(st, scope, when, opt.head, part => tick(0.1 * part));
    return mineRows(st, pos, neg, opt, bar, (part, info) => tick(0.1 + 0.9 * part, info));
}

function mineRows(st: Store, pos: Int32Array, neg: Int32Array, opt: MineOptions, bar: Progress, tick: Tick): SearchResult {
    const res = mine({ names: st.names, allocKb: st.allocKb, pos, neg }, opt, {
        candidates: part => tick(part, `malych: ${thousands(pos.length)}`),
        negatives: candidates => {
            bar.done(`malych: ${thousands(pos.length)}, masek do sprawdzenia: ${thousands(candidates)}`);
            return bar.stage('Zbiory duze');
        },
        select: () => {
            bar.done(`duzych: ${thousands(neg.length)}`);
            return bar.stage('Wybor masek');
        },
    });
    bar.done(`wybrano: ${res.masks.length}`);
    return { inScope: pos.length + neg.length, small: pos.length, masks: res.masks, total: res.total };
}

/** Sprawdzenie gotowej listy masek, a potem szukanie masek dla zbiorow, ktorych lista nie obejmuje. */
export function check(file: string, scope: Conds, when: Conds, masks: string[], opt: MineOptions, bar: Progress,
    warn: (t: string) => void = () => {}): { list: CheckResult; fresh: SearchResult } {
    const st = load(file, scope, when, bar, warn);
    const tick = bar.stage('Sprawdzanie masek');
    const { pos, neg } = classify(st, scope, when, opt.head, part => tick(0.2 * part));
    const list = checkMasks({ names: st.names, allocKb: st.allocKb, pos, neg }, masks, part => tick(0.2 + 0.8 * part));
    bar.done(`masek: ${masks.length}, malych: ${thousands(pos.length)}, duzych: ${thousands(neg.length)}`);
    const fresh = mineRows(st, list.rest.pos, list.rest.neg, opt, bar, bar.stage('Nowe maski'));
    return { list, fresh };
}

function load(file: string, scope: Conds, when: Conds, bar: Progress, warn: (t: string) => void): Store {
    const st = readStore(file, new Set([...scope.fields, ...when.fields]), bar.stage('Czytanie CSV'));
    bar.done(`${thousands(st.records)} rekordow, ${thousands(st.sets)} zbiorow`);
    for (const w of st.warnings) warn(`Uwaga: ${w}\n`);
    return st;
}

/** Wiersze zbiorow w zakresie: male (kryterium) i duze. */
function classify(st: Store, scope: Conds, when: Conds, head: string[] | undefined, tick: Tick): { pos: Int32Array; neg: Int32Array } {
    const inScope = scope.compile(st);
    const small = when.compile(st);
    const inHead = head?.length ? headTest(st.names, head) : () => true;
    const kind = new Uint8Array(st.rows);
    let np = 0;
    let nn = 0;
    for (let r = 0; r < st.rows; r++) {
        if ((r & 0xffff) === 0) tick(r / st.rows);
        if (st.dead[r] || !inHead(r) || !inScope(r)) continue;
        if (small(r)) {
            kind[r] = 1;
            np++;
        } else {
            kind[r] = 2;
            nn++;
        }
    }
    const pos = new Int32Array(np);
    const neg = new Int32Array(nn);
    for (let r = 0, p = 0, n = 0; r < st.rows; r++) {
        if (kind[r] === 1) pos[p++] = r;
        else if (kind[r] === 2) neg[n++] = r;
    }
    return { pos, neg };
}

const pct = (x: number) => `${(Math.floor(x * 1000) / 10).toFixed(1).replace('.', ',')}%`;

/** Jednostka sumy alokacji: dzielnik KB i liczba miejsc po przecinku. */
const UNITS = { MB: [1024, 0], GB: [1024 ** 2, 2], TB: [1024 ** 3, 3] } as const;
export type Unit = keyof typeof UNITS;
const inUnit = (kb: number, u: Unit) => (kb / UNITS[u][0]).toFixed(UNITS[u][1]).replace('.', ',');

const line = (c: string[]) => c[0].padEnd(44) + c[1].padStart(9) + c[2].padStart(9) + c[3].padStart(9)
    + c.slice(4).map(x => x.padStart(12)).join('');
const cells = (m: MaskRow, u: Unit) => [m.text, String(m.small), String(m.large), pct(m.purity), inUnit(m.smallKb, u), inUnit(m.largeKb, u)];
const heads = (u: Unit) => ['Maska', 'Malych', 'Duzych', 'Purity', `Malych ${u}`, `Duzych ${u}`];

export function report(r: SearchResult, u: Unit = 'GB'): string {
    const out = [`Zbiorow w zakresie: ${r.inScope}, malych: ${r.small}, duzych: ${r.inScope - r.small}`, '', ...found(r, u)];
    return out.join('\n') + '\n';
}

function found(r: SearchResult, u: Unit): string[] {
    const row = (m: MaskRow) => line(cells(m, u));
    const out: string[] = [];
    if (r.masks.length) {
        out.push(line(heads(u)), ...r.masks.map(row), row(r.total), '');
        out.push(`Masek: ${r.masks.length}; obejmuja ${pct(r.total.small / r.small)} malych (${r.total.small} z ${r.small})`);
    } else {
        out.push('Brak masek dla tych progow (--min-purity, --min-count).');
    }
    return out;
}

/** Nowe maski, dla zbiorow nieobjetych lista. */
export function freshReport(list: CheckResult, r: SearchResult, u: Unit = 'GB'): string {
    const out = ['', `Nowe maski - tylko dla zbiorow, ktorych nie obejmuje zadna maska z listy (malych: ${r.small}, duzych: ${r.inScope - r.small})`, ''];
    if (r.small === 0) out.push('Lista obejmuje wszystkie male zbiory.');
    else out.push(...found(r, u));
    if (r.masks.length) {
        // zbiory objete lista i nowymi maskami sa rozlaczne
        const small = list.total.small + r.total.small;
        const large = list.total.large + r.total.large;
        const kb = list.total.smallKb + r.total.smallKb;
        out.push(`Lista i nowe maski razem: ${part(small, list.small)} malych (${small} z ${list.small}), `
            + `${part(kb, list.smallKb)} ich alokacji, duzych ${large}, purity ${part(small, small + large)}`);
    }
    return out.join('\n') + '\n';
}

const csvHead = (u: Unit) => `maska;malych;duzych;purity;malych_${u};duzych_${u}`.toLowerCase();
const csvCells = (m: MaskRow, u: Unit) => [m.text, m.small, m.large, pct(m.purity).slice(0, -1), inUnit(m.smallKb, u), inUnit(m.largeKb, u)];

export function toCsv(r: SearchResult, u: Unit = 'GB'): string {
    return [csvHead(u), ...r.masks.map(m => csvCells(m, u).join(';'))].join('\n') + '\n';
}

const MAX_PAIRS = 50;
const part = (a: number, b: number) => pct(b ? a / b : 0);

export function checkReport(r: CheckResult, u: Unit = 'GB'): string {
    const out = [`Zbiorow w zakresie: ${r.small + r.large}, malych: ${r.small}, duzych: ${r.large}`, '',
        line([...heads(u), 'Tylko ta'])];
    for (const m of r.rows) out.push(line([...cells(m, u), String(m.only)]) + (m.state ? `   ${m.state}` : ''));
    out.push(line(cells(r.total, u)), '');
    out.push(`Masek: ${r.rows.length}; obejmuja ${part(r.total.small, r.small)} malych (${r.total.small} z ${r.small}), `
        + `${part(r.total.smallKb, r.smallKb)} ich alokacji (${inUnit(r.total.smallKb, u)} z ${inUnit(r.smallKb, u)} ${u})`, '');

    const drop = r.rows.filter(m => m.state === 'usun');
    const instead = r.rows.filter(m => m.state === 'zamiast');
    const why = (m: CheckResult['rows'][number]) => `  ${m.text.padEnd(44)}${m.note}`;
    out.push(`Maski zbedne: ${drop.length + instead.length}`);
    if (drop.length) {
        out.push('', 'usun - mozna usunac wszystkie naraz, pokrycie malych sie nie zmieni:', ...drop.map(why),
            `  Po usunieciu: masek ${r.rows.length - drop.length}, malych ${r.after.small}, duzych ${r.total.large} -> ${r.after.large}, `
            + `purity ${pct(r.total.purity)} -> ${pct(r.after.purity)}`);
    }
    if (instead.length) out.push('', 'zamiast - zbedne teraz, ale potrzebne po usunieciu powyzszych:', ...instead.map(why));

    out.push('', `Pary masek ze wspolnymi zbiorami: ${r.overlaps.length}`);
    if (r.overlaps.length) {
        out.push('', 'Maska 1'.padEnd(44) + ' ' + 'Maska 2'.padEnd(44) + 'Malych'.padStart(9) + 'Duzych'.padStart(9)
            + '% mal. 1'.padStart(10) + '% mal. 2'.padStart(10));
        for (const o of r.overlaps.slice(0, MAX_PAIRS)) {
            out.push(o.a.padEnd(44) + ' ' + o.b.padEnd(44) + String(o.small).padStart(9) + String(o.large).padStart(9)
                + pct(o.partA).padStart(10) + pct(o.partB).padStart(10));
        }
        if (r.overlaps.length > MAX_PAIRS) out.push(`... i jeszcze ${r.overlaps.length - MAX_PAIRS} par (mniej wspolnych zbiorow)`);
    }
    return out.join('\n') + '\n';
}

/** Maski z listy i nowe (stan "nowa"); pierwsza kolumna nadaje sie na nastepna liste. */
export function checkCsv(list: CheckResult, fresh: SearchResult, u: Unit = 'GB'): string {
    return [`${csvHead(u)};tylko_ta;stan;uwagi`,
        ...list.rows.map(m => [...csvCells(m, u), m.only, m.state, m.note].join(';')),
        ...fresh.masks.map(m => [...csvCells(m, u), '', 'nowa', ''].join(';'))].join('\n') + '\n';
}

export function main(argv: string[], io: Io = STDIO): number {
    let bar: Progress | null = null;
    const progress = (stages: number) => bar = new Progress(stages, io.err, io.tty ?? false, () => process.stderr.columns || 80);
    try {
        const { values: o, positionals } = parseArgs({
            args: argv,
            allowPositionals: true,
            options: {
                scope: { type: 'string', default: 'sms=true dsorg=PS' },
                when: { type: 'string', default: 'allocTrk=315 usedTrk<=3' },
                prefix: { type: 'string' },
                'min-purity': { type: 'string', default: '0.95' },
                'min-count': { type: 'string', default: '10' },
                'max-masks': { type: 'string', default: '100' },
                masks: { type: 'string' },
                unit: { type: 'string', default: 'GB' },
                out: { type: 'string', short: 'o' },
                help: { type: 'boolean', short: 'h', default: false },
            },
        });
        if (o.help) {
            io.out(USAGE);
            return 0;
        }
        if (positionals.length !== 1) {
            io.err(USAGE);
            return 1;
        }
        const scope = parseConds(o.scope!, 'scope');
        const when = parseConds(o.when!, 'when');
        const opt = {
            minPurity: num(o['min-purity']!, 'min-purity', 0, 1, false),
            minCount: num(o['min-count']!, 'min-count', 1, 1e9, true),
            maxMasks: num(o['max-masks']!, 'max-masks', 1, 1e6, true),
            head: o.prefix === undefined ? [] : parseHead(o.prefix),
        };
        const unit = o.unit!.toUpperCase() as Unit;
        if (!Object.hasOwn(UNITS, unit)) throw new ArgError(`--unit: "${o.unit}" - dozwolone: ${Object.keys(UNITS).join(' ')}`);
        const save = (text: string) => {
            if (!o.out) return;
            fs.writeFileSync(o.out, text);
            io.err(`Zapisano: ${o.out}\n`);
        };
        if (o.masks !== undefined) {
            const list = parseMaskList(fs.readFileSync(o.masks, 'latin1').replace(/^\xef\xbb\xbf/, ''), o.masks);
            for (const w of list.warnings) io.err(`Uwaga: ${w}\n`);
            const c = check(positionals[0], scope, when, list.masks, opt, progress(5), io.err);
            io.out(`Zakres: ${o.scope}   kryterium: ${o.when}${opt.head.length ? `   poczatek masek: ${opt.head.join('.')}` : ''}   maski: ${o.masks}   min. purity: ${pct(opt.minPurity)}, min. zbiorow: ${opt.minCount}\n`);
            io.out(checkReport(c.list, unit));
            io.out(freshReport(c.list, c.fresh, unit));
            save(checkCsv(c.list, c.fresh, unit));
            return 0;
        }
        const r = search(positionals[0], scope, when, opt, progress(4), io.err);
        const start = opt.head.length ? `   poczatek masek: ${opt.head.join('.')}` : '';
        io.out(`Zakres: ${o.scope}   kryterium: ${o.when}${start}   min. purity: ${pct(opt.minPurity)}, min. zbiorow: ${opt.minCount}\n`);
        io.out(report(r, unit));
        save(toCsv(r, unit));
        return 0;
    } catch (err) {
        (bar as Progress | null)?.abort();
        const e = err as NodeJS.ErrnoException;
        if (e instanceof ArgError || e instanceof CsvError || e instanceof MaskError || e instanceof MaskListError) {
            io.err(`Blad: ${e.message}\n`);
        } else if (e.code?.startsWith('ERR_PARSE_ARGS')) {
            io.err(`${e.message}\n${USAGE}`);
        } else if (e.code && e.path) {
            io.err(`Blad: ${e.path}: ${e.code === 'ENOENT' ? 'brak pliku albo katalogu' : e.code}\n`);
        } else {
            throw err;
        }
        return 1;
    }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
