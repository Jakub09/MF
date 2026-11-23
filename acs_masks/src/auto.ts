/**
 * Szukanie masek DSN wg kryteriow z CSV DCOLLECT (job ACMCSV). Wersja jednoplikowa: acs-masks-auto.cjs (bez npm).
 *
 *   node acs-masks-auto.cjs DCOLLECT.CSV [opcje]
 *
 *   --scope "WARUNKI"  zbiory brane pod uwage                  (domyslnie "sms=true dsorg=PS")
 *   --when "WARUNKI"   kryterium: zbior "maly"; reszta = "duze" (domyslnie "allocTrk=315 usedTrk<=3")
 *   --min-purity X     najmniejsza czystosc maski 0-1: male / (male + duze)      (domyslnie 0.95)
 *   --min-count N      ile malych, nieobjetych wczesniejszymi maskami, ma dodac maska (domyslnie 10)
 *   --max-masks N      najwiecej masek                                            (domyslnie 100)
 *   --out PLIK         maski takze do pliku CSV (separator ;)
 *
 * WARUNKI: pole, operator (= != < <= > >=), wartosc; kilka warunkow po spacji = wszystkie naraz (AND).
 *   Wartosc tekstowa po = / != moze byc maska: dsn=PROD.**  sg=SGEAV*
 * Pola liczbowe: allocTrk usedTrk freeTrk allocKb usedKb extents vols nqual lrecl blksize ageDays unrefDays
 *   tekstowe: dsn hlq llq vol dsorg recfm sc mc dc sg createJob    true / false: sms temp pdse gds ef vsam
 *
 * Postep: pasek na stderr (przekierowane do pliku: jedna linia na etap).
 * Generacje GDG maja nazwe bez GnnnnVnn - tak widzi ja ACS w &DSN. Zbior wielowolumenowy liczony raz.
 * MB = suma alokacji. Kod wyjscia: 0 - OK, 1 - blad.
 */
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { mine, MaskRow, MineOptions } from './auto-mine';
import { BOOL, BoolField, Field, NUM, NumField, readStore, Store, STR, StrField } from './auto-read';
import { Progress, thousands } from './auto-util';
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
    + '        [--when "allocTrk=315 usedTrk<=3"] [--min-purity 0.95] [--min-count 10] [--max-masks 100]\n'
    + '        [--out maski.csv]\n'
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
    const st = readStore(file, new Set([...scope.fields, ...when.fields]), bar.stage('Czytanie CSV'));
    bar.done(`${thousands(st.records)} rekordow, ${thousands(st.sets)} zbiorow`);
    for (const w of st.warnings) warn(`Uwaga: ${w}\n`);

    const tick = bar.stage('Kryteria i maski');
    const inScope = scope.compile(st);
    const small = when.compile(st);
    const kind = new Uint8Array(st.rows);
    let np = 0;
    let nn = 0;
    for (let r = 0; r < st.rows; r++) {
        if ((r & 0xffff) === 0) tick(0.1 * (r / st.rows));
        if (st.dead[r] || !inScope(r)) continue;
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
    const res = mine({ names: st.names, allocKb: st.allocKb, pos, neg }, opt, {
        candidates: part => tick(0.1 + 0.9 * part, `malych: ${thousands(np)}`),
        negatives: candidates => {
            bar.done(`malych: ${thousands(np)}, masek do sprawdzenia: ${thousands(candidates)}`);
            return bar.stage('Zbiory duze');
        },
        select: () => {
            bar.done(`duzych: ${thousands(nn)}`);
            return bar.stage('Wybor masek');
        },
    });
    bar.done(`wybrano: ${res.masks.length}`);
    return { inScope: np + nn, small: np, masks: res.masks, total: res.total };
}

const pct = (x: number) => `${(Math.floor(x * 1000) / 10).toFixed(1).replace('.', ',')}%`;
const mb = (x: number) => String(Math.round(x / 1024));

export function report(r: SearchResult): string {
    const line = (c: string[]) => c[0].padEnd(44) + c[1].padStart(9) + c[2].padStart(9) + c[3].padStart(9)
        + c[4].padStart(12) + c[5].padStart(12);
    const row = (m: MaskRow) => line([m.text, String(m.small), String(m.large), pct(m.purity), mb(m.smallKb), mb(m.largeKb)]);
    const out = [`Zbiorow w zakresie: ${r.inScope}, malych: ${r.small}, duzych: ${r.inScope - r.small}`, ''];
    if (r.masks.length) {
        out.push(line(['Maska', 'Malych', 'Duzych', 'Purity', 'Malych MB', 'Duzych MB']), ...r.masks.map(row), row(r.total), '');
        out.push(`Masek: ${r.masks.length}; obejmuja ${pct(r.total.small / r.small)} malych (${r.total.small} z ${r.small})`);
    } else {
        out.push('Brak masek dla tych progow (--min-purity, --min-count).');
    }
    return out.join('\n') + '\n';
}

export function toCsv(r: SearchResult): string {
    return ['maska;malych;duzych;purity;malych_mb;duzych_mb', ...r.masks.map(m =>
        [m.text, m.small, m.large, pct(m.purity).slice(0, -1), mb(m.smallKb), mb(m.largeKb)].join(';'))].join('\n') + '\n';
}

export function main(argv: string[], io: Io = STDIO): number {
    const bar = new Progress(4, io.err, io.tty ?? false, () => process.stderr.columns || 80);
    try {
        const { values: o, positionals } = parseArgs({
            args: argv,
            allowPositionals: true,
            options: {
                scope: { type: 'string', default: 'sms=true dsorg=PS' },
                when: { type: 'string', default: 'allocTrk=315 usedTrk<=3' },
                'min-purity': { type: 'string', default: '0.95' },
                'min-count': { type: 'string', default: '10' },
                'max-masks': { type: 'string', default: '100' },
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
        };
        const r = search(positionals[0], scope, when, opt, bar, io.err);
        io.out(`Zakres: ${o.scope}   kryterium: ${o.when}   min. purity: ${pct(opt.minPurity)}, min. zbiorow: ${opt.minCount}\n`);
        io.out(report(r));
        if (o.out) {
            fs.writeFileSync(o.out, toCsv(r));
            io.err(`Zapisano: ${o.out}\n`);
        }
        return 0;
    } catch (err) {
        bar.abort();
        const e = err as NodeJS.ErrnoException;
        if (e instanceof ArgError || e instanceof CsvError || e instanceof MaskError) {
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
