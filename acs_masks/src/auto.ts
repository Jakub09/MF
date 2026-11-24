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
 *   --wild N           ile *, ** (poza koncowym) i poczatek* moze miec maska       (domyslnie 3; mniej = szybciej)
 *   --unit MB|GB|TB    jednostka sumy alokacji                                   (domyslnie GB)
 *   --out PLIK         maski takze do pliku CSV (separator ;)
 *
 *   --exclude          maski EXCLUDE: duze zbiory objete maskami, bez zadnego malego (najwyzej 255)
 *   --exclude-min N    ile duzych ma wylaczyc maska EXCLUDE                      (domyslnie 2)
 *   --filtlist PLIK    FILTLIST z INCLUDE (i EXCLUDE) do rutyny ACS
 *   --tests PLIK       testy ISMF do masek (wejscie IEBUPDTE, job ACMTLOAD): DSN i opis = maska; EXCLUDE maska;
 *                      BEZ MASKI - maska = nazwa, ktora do maski z * prawie pasuje (inna liczba kwalifikatorow)
 *   --per-mask N       testow kazdego rodzaju na maske (z **: najkrotsze i najdluzsze nazwy)  (domyslnie 1)
 *   --test-prefix P    prefiks memberow testow, 1-4 litery                       (domyslnie ACM)
 *
 *   --masks PLIK       sprawdza maski z pliku (po jednej w linii albo po przecinku; CSV z --out, FILTLIST): liczby dla kazdej
 *                      maski, pokrycie wszystkich razem, maski zbedne, pary nakladajace sie; potem szuka nowych masek
 *                      dla malych zbiorow, ktorych lista nie obejmuje (zbiory objete lista, male i duze, sa pominiete).
 *                      --prefix: poczatek nowych masek, zaweza tez zbiory, na ktorych sprawdzana jest lista.
 *
 *   --quals N          zamiast masek: najczestsze kombinacje 1..N kwalifikatorow w malych zbiorach (N 1-4), osobna tabela
 *                      dla kazdej liczby; A + B = nazwy **.A.**.B.**, obok najwezsza maska z tymi samymi malymi.
 *                      Takze kwalifikatory niepelne: ABC* *ABC *ABC* AB%% D%%%%%%. Z --masks: tylko zbiory spoza listy
 *   --partial N        ile znakow stalych ma miec kwalifikator niepelny, 2-7; 0 = tylko pelne    (domyslnie 3)
 *   --top N            wierszy w kazdej tabeli                                   (domyslnie 20)
 *   --time SEK         najdluzej szuka kombinacji; potem wynik dla wiekszej liczby malych        (domyslnie 600)
 *   --try LISTA        sprawdza podane kombinacje i ich skrocenia, np. "PROD+SYSOUT, LOGDAY, TMP*"
 *                      Z --quals i --try: --min-purity tylko, gdy podane (domyslnie bez progu); --out: CSV z maskami
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
import { acsProblem, ExcludeResult, filtlistText, findExcludes, maskTests, testFile } from './auto-acs';
import { CheckInput, checkMasks, CheckResult, MaskListError, parseMaskList } from './auto-check';
import { mine, MaskRow, MineOptions, MineResult } from './auto-mine';
import { Combo, findCombos, parseTries, QualResult, tryCombos, TryRow } from './auto-quals';
import { BOOL, BoolField, Field, NUM, NumField, readStore, Store, STR, StrField } from './auto-read';
import { Interner, Progress, thousands, Tick } from './auto-util';
import { CsvError } from './dataset';
import { MaskError, matches, parseMask } from './mask';
import { memberNames, TestCaseError } from './testcase';

export interface Io {
    out: (t: string) => void;
    err: (t: string) => void;
    /** pasek postepu rysowany w miejscu (terminal); domyslnie: linia na etap */
    tty?: boolean;
}

const STDIO: Io = { out: t => process.stdout.write(t), err: t => process.stderr.write(t), tty: process.stderr.isTTY };

const USAGE = 'Uzycie: node acs-masks-auto.cjs DCOLLECT.CSV [--scope "sms=true dsorg=PS"]\n'
    + '        [--when "allocTrk=315 usedTrk<=3"] [--prefix "ABC%.**"] [--min-purity 0.95]\n'
    + '        [--min-count 10] [--max-masks 100] [--wild 3] [--unit GB] [--out maski.csv]\n'
    + '        [--exclude [--exclude-min 2]] [--filtlist filtlist.txt] [--tests ACMTEST [--per-mask 1] [--test-prefix ACM]]\n'
    + '   albo: node acs-masks-auto.cjs DCOLLECT.CSV --masks maski.txt [opcje jak wyzej]\n'
    + '         (sprawdza liste i szuka masek dla zbiorow, ktorych ona nie obejmuje)\n'
    + '   albo: node acs-masks-auto.cjs DCOLLECT.CSV --quals 4 [--partial 3] [--top 20] [--time 600] [--try "PROD+SYSOUT, TMP*"]\n'
    + '         (najczestsze kombinacje kwalifikatorow; sprawdzanie kwalifikatorow niepelnych)\n'
    + `Pola liczbowe: ${NUM.join(' ')}\n     tekstowe: ${STR.join(' ')}\n     true / false: ${BOOL.join(' ')}\n`
    + 'Operatory: = != < <= > >=; kilka warunkow po spacji = wszystkie naraz\n';

const HELP = USAGE + `
Przyklady (DC = DCOLLECT.CSV; w pliku .bat kazdy % podwojnie, w PowerShell apostrofy zamiast cudzyslowow):
  node acs-masks-auto.cjs DC --scope "sms=true dsorg=PS sg=SGEAV*"                 tylko zbiory z wybranych SG
  node acs-masks-auto.cjs DC --when "allocTrk>=315 usedTrk<15"                     inne kryterium malego zbioru
  node acs-masks-auto.cjs DC --when "unrefDays>365" --unit TB                      nieuzywane od roku
  node acs-masks-auto.cjs DC --prefix "ABC%.**"                                    kazda maska zaczyna sie od ABC%.
  node acs-masks-auto.cjs DC --wild 1                                              prostsze maski, szybciej
  node acs-masks-auto.cjs DC --min-purity 1 --min-count 50 --max-masks 20          malo masek, same czyste
  node acs-masks-auto.cjs DC --masks maski.txt --out wynik.csv                     sprawdzenie listy i czego jej brakuje
  node acs-masks-auto.cjs DC --min-purity 0.8 --exclude --filtlist f.txt           szersze maski i EXCLUDE
  node acs-masks-auto.cjs DC --masks f.txt --tests ACMTEST --per-mask 2            testy ISMF do FILTLIST
  node acs-masks-auto.cjs DC --quals 4                                             najczestsze kombinacje 1-4 kwalifikatorow
  node acs-masks-auto.cjs DC --quals 2 --min-purity 0.95 --top 50                  tylko czyste, do 2 kwalifikatorow
  node acs-masks-auto.cjs DC --quals 3 --masks f.txt                               w zbiorach, ktorych lista nie obejmuje
  node acs-masks-auto.cjs DC --try "PROD+SYSOUT, LOGDAY, TMP*"                     te kombinacje i ich skrocenia
`;

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
    steps: MineResult['steps'];
}

/** Wynik i zbiory w zakresie, na ktorych powstal. */
export type WithInput<T> = T & { input: CheckInput };

export function search(file: string, scope: Conds, when: Conds, opt: MineOptions, bar: Progress,
    warn: (t: string) => void = () => {}): WithInput<SearchResult> {
    const st = load(file, scope, when, bar, warn);
    const tick = bar.stage('Kryteria i nazwy');
    const { pos, neg } = classify(st, scope, when, opt.head, part => tick(0.1 * part));
    return { ...mineRows(st, pos, neg, opt, bar, (part, info) => tick(0.1 + 0.9 * part, info)), input: { names: st.names, allocKb: st.allocKb, pos, neg } };
}

function mineRows(st: Store, pos: Int32Array, neg: Int32Array, opt: MineOptions, bar: Progress, tick: Tick): SearchResult {
    const res = mine({ names: st.names, allocKb: st.allocKb, pos, neg }, opt, {
        prepare: part => tick(part, `malych: ${thousands(pos.length)}`),
        search: sequences => {
            bar.done(`malych: ${thousands(pos.length)}, duzych: ${thousands(neg.length)}, roznych nazw: ${thousands(sequences)}`);
            return bar.stage('Szukanie masek');
        },
        select: candidates => {
            bar.done(`sprawdzonych masek: ${thousands(candidates)}`);
            return bar.stage('Wybor masek');
        },
    });
    bar.done(`wybrano: ${res.masks.length}`);
    return { inScope: pos.length + neg.length, small: pos.length, masks: res.masks, total: res.total, steps: res.steps };
}

/** Sprawdzenie gotowej listy masek, a potem szukanie masek dla zbiorow, ktorych lista nie obejmuje. */
export function check(file: string, scope: Conds, when: Conds, masks: string[], excludes: string[], opt: MineOptions, bar: Progress,
    warn: (t: string) => void = () => {}): WithInput<{ list: CheckResult; fresh: SearchResult }> {
    const st = load(file, scope, when, bar, warn);
    const tick = bar.stage('Sprawdzanie masek');
    const { pos, neg } = classify(st, scope, when, opt.head, part => tick(0.2 * part));
    const input = { names: st.names, allocKb: st.allocKb, pos, neg };
    const list = checkMasks(input, masks, excludes, part => tick(0.2 + 0.8 * part));
    bar.done(`masek: ${masks.length}, malych: ${thousands(pos.length)}, duzych: ${thousands(neg.length)}`);
    const fresh = mineRows(st, list.rest.pos, list.rest.neg, opt, bar, bar.stage('Nazwy spoza listy'));
    return { list, fresh, input };
}

/** o ile czesci wiecej malych musi dac szersza kombinacja, zeby byla obok szczegolowszej */
const MIN_GAIN = 0.02;

export interface QualsInput {
    /** null = bez szukania kombinacji */
    quals: { maxQuals: number; top: number; seconds: number } | null;
    partial: number;
    tries: string[][];
    /** lista masek; zbiory nia objete sa pominiete */
    masks: string[];
    excludes: string[];
}

export interface QualsResult {
    /** null = bez listy masek */
    skipped: { small: number; large: number } | null;
    small: number;
    large: number;
    /** null = bez szukania kombinacji */
    combos: QualResult | null;
    tries: TryRow[][];
}

/** Najczestsze kombinacje kwalifikatorow malych zbiorow i sprawdzenie podanych. */
export function quals(file: string, scope: Conds, when: Conds, q: QualsInput, opt: MineOptions, bar: Progress,
    warn: (t: string) => void = () => {}): QualsResult {
    const st = load(file, scope, when, bar, warn);
    const tick = bar.stage('Kryteria');
    let { pos, neg } = classify(st, scope, when, opt.head, p => tick(p));
    bar.done(`malych: ${thousands(pos.length)}, duzych: ${thousands(neg.length)}`);
    let skipped: QualsResult['skipped'] = null;
    if (q.masks.length) {
        const before = { small: pos.length, large: neg.length };
        const { rest } = checkMasks({ names: st.names, allocKb: st.allocKb, pos, neg }, q.masks, q.excludes, bar.stage('Lista masek'));
        ({ pos, neg } = rest);
        skipped = { small: before.small - pos.length, large: before.large - neg.length };
        bar.done(`spoza listy malych: ${thousands(pos.length)}, duzych: ${thousands(neg.length)}`);
    }
    const input = { names: st.names, allocKb: st.allocKb, pos, neg };
    let combos: QualResult | null = null;
    if (q.quals) {
        combos = findCombos(input, { ...q.quals, partial: q.partial, minGain: MIN_GAIN, minCount: opt.minCount, minPurity: opt.minPurity, head: opt.head }, bar.stage('Kombinacje'));
        bar.done(`sprawdzonych: ${thousands(combos.nodes)}`);
    }
    let tries: TryRow[][] = [];
    if (q.tries.length) {
        tries = tryCombos(input, q.tries, q.partial, opt.head ?? [], bar.stage('Podane kombinacje'));
        bar.done(`sprawdzonych: ${tries.reduce((s, t) => s + t.length, 0)}`);
    }
    return { skipped, small: pos.length, large: neg.length, combos, tries };
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
const wide = (c: string[]) => c[0].padEnd(44) + c.slice(1).map(x => x.padStart(12)).join('');
const noPurity = (m: MaskRow, u: Unit) => cells(m, u).filter((_, i) => i !== 3);
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

/** Z EXCLUDE: dodatkowa kolumna stan, zeby plik nadawal sie na liste --masks. */
export function toCsv(r: SearchResult, u: Unit = 'GB', exclude: MaskRow[] = []): string {
    const ex = exclude.length > 0;
    return [csvHead(u) + (ex ? ';stan' : ''), ...r.masks.map(m => [...csvCells(m, u), ...(ex ? [''] : [])].join(';')),
        ...exclude.map(m => [...csvCells(m, u), 'exclude'].join(';'))].join('\n') + '\n';
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

    if (r.excludes.length) {
        out.push('EXCLUDE z listy - zbiory odebrane maskom (nie licza sie wyzej i nie dostaja nowych masek):', wide(heads(u).filter(h => h !== 'Purity')));
        for (const m of r.excludes) out.push(wide(noPurity(m, u)));
        out.push('');
    }
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
export function checkCsv(list: CheckResult, fresh: SearchResult, u: Unit = 'GB', exclude: MaskRow[] = []): string {
    return [`${csvHead(u)};tylko_ta;stan;uwagi`,
        ...list.rows.map(m => [...csvCells(m, u), m.only, m.state, m.note].join(';')),
        ...fresh.masks.map(m => [...csvCells(m, u), '', 'nowa', ''].join(';')),
        ...[...list.excludes, ...exclude].map(m => [...csvCells(m, u), '', 'exclude', ''].join(';'))].join('\n') + '\n';
}

export function excludeReport(r: ExcludeResult, u: Unit = 'GB'): string {
    const out = ['', `EXCLUDE - duze zbiory objete maskami (${r.before.large}), bez zadnego malego`, ''];
    if (r.masks.length) {
        out.push(wide(['Maska EXCLUDE', 'Duzych', `Duzych ${u}`]));
        for (const m of [...r.masks, r.total]) out.push(wide([m.text, String(m.large), inUnit(m.largeKb, u)]));
        out.push('', `Masek EXCLUDE: ${r.masks.length}; wylaczaja ${part(r.total.large, r.before.large)} duzych objetych maskami`);
        out.push(`Po EXCLUDE: malych ${r.after.small}, duzych ${r.before.large} -> ${r.after.large}, purity ${pct(r.before.purity)} -> ${pct(r.after.purity)}`);
    } else {
        out.push(r.before.large ? 'Brak masek EXCLUDE (--exclude-min; duze pod ta sama maska co male).' : 'Maski nie obejmuja duzych zbiorow - EXCLUDE niepotrzebny.');
    }
    return out.join('\n') + '\n';
}

const comboText = (c: string[]) => c.join(' + ');
const MAX_ALSO = 3;

export function qualsReport(r: QualsResult, u: Unit = 'GB'): string {
    const out = [`Zbiorow w zakresie: ${r.small + r.large}, malych: ${r.small}, duzych: ${r.large}`
        + (r.skipped ? ` (pominiete, objete lista masek: malych ${r.skipped.small}, duzych ${r.skipped.large})` : '')];
    const row = (c: string[]) => c[0].padEnd(44) + c[1].padStart(9) + c[2].padStart(8) + c[3].padStart(9) + c[4].padStart(9)
        + c.slice(5, 7).map(x => x.padStart(12)).join('') + (c.length > 7 ? `   ${c[7].padEnd(44)}${c[8].padStart(9)}${c[9].padStart(9)}` : '');
    const nums = (c: Combo | TryRow) => [String(c.small), part(c.small, r.small), String(c.large), pct(c.purity), inUnit(c.smallKb, u), inUnit(c.largeKb, u)];
    const head = ['Malych', '% mal.', 'Duzych', 'Purity', `Malych ${u}`, `Duzych ${u}`];
    r.combos?.tables.forEach((t, i) => {
        out.push('', `Kombinacje: kwalifikatorow ${i + 1}${t.length ? '' : ' - brak (--min-count, --min-purity)'}`);
        if (t.length === 0) return;
        out.push('', row(['Kombinacja', ...head, 'Najwezsza maska', 'Duzych', 'Purity']));
        for (const c of t) {
            out.push(row([comboText(c.quals), ...nums(c), c.mask?.text ?? '(ponad 44 znaki)', c.mask ? String(c.mask.large) : '', c.mask ? pct(c.mask.purity) : '']));
            const more = c.also.length - MAX_ALSO + c.more;
            if (c.also.length) out.push(`    te same male: ${c.also.slice(0, MAX_ALSO).map(comboText).join(';  ')}${more > 0 ? `  (i ${more} innych)` : ''}`);
        }
    });
    if (r.combos && r.combos.floor !== null) {
        out.push('', r.combos.floor > r.combos.small ? 'Uwaga: przerwano po czasie --time; tabele sa niepelne (mniej kwalifikatorow: --quals, --partial 0, wiekszy --min-count).'
            : `Uwaga: przerwano po czasie --time; w tabelach sa tylko kombinacje o co najmniej ${r.combos.floor} malych.`);
    }
    for (const t of r.tries) {
        out.push('', `Sprawdzenie: ${comboText(t[0].quals)}${t.length > 1 ? ' i skrocenia (od najwiekszej purity)' : ''}`, '', row(['Kombinacja', ...head, 'Maska', '+Malych', '+Duzych']));
        for (const x of t) {
            const more = (n: number) => (x.level ? `${n < 0 ? '' : '+'}${n}` : '');
            out.push(row([comboText(x.quals), ...nums(x), x.text.length > 44 ? '(ponad 44 znaki)' : x.text, more(x.small - t[0].small), more(x.large - t[0].large)]));
        }
    }
    return out.join('\n') + '\n';
}

/** Pierwsza kolumna (maska) nadaje sie na liste --masks. */
export function qualsCsv(r: QualsResult, u: Unit = 'GB'): string {
    const out = [`${csvHead(u)};rodzaj;kwalifikatorow;kombinacja;proc_malych;komb_duzych;komb_purity;te_same_male`];
    for (const c of r.combos?.tables.flat() ?? []) {
        const m = c.mask ? csvCells(c.mask, u) : ['', c.small, '', '', inUnit(c.smallKb, u), ''];
        out.push([...m, 'kombinacja', c.quals.length, comboText(c.quals), part(c.small, r.small).slice(0, -1), c.large, pct(c.purity).slice(0, -1),
            c.also.map(comboText).join(', ')].join(';'));
    }
    for (const x of r.tries.flat()) {
        const m = csvCells(x, u);
        if (x.text.length > 44) m[0] = '';
        out.push([...m, x.level ? 'skrocenie' : 'podana', x.quals.length, comboText(x.quals), part(x.small, r.small).slice(0, -1), x.large, pct(x.purity).slice(0, -1), ''].join(';'));
    }
    return out.join('\n') + '\n';
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
                'min-purity': { type: 'string' },
                'min-count': { type: 'string', default: '10' },
                'max-masks': { type: 'string', default: '100' },
                wild: { type: 'string', default: '3' },
                masks: { type: 'string' },
                quals: { type: 'string' },
                partial: { type: 'string' },
                top: { type: 'string' },
                time: { type: 'string' },
                try: { type: 'string' },
                unit: { type: 'string', default: 'GB' },
                out: { type: 'string', short: 'o' },
                exclude: { type: 'boolean', default: false },
                'exclude-min': { type: 'string', default: '2' },
                filtlist: { type: 'string' },
                tests: { type: 'string' },
                'per-mask': { type: 'string', default: '1' },
                'test-prefix': { type: 'string', default: 'ACM' },
                help: { type: 'boolean', short: 'h', default: false },
            },
        });
        if (o.help) {
            io.out(HELP);
            return 0;
        }
        if (positionals.length !== 1) {
            io.err(USAGE);
            return 1;
        }
        const scope = parseConds(o.scope!, 'scope');
        const when = parseConds(o.when!, 'when');
        const combos = o.quals !== undefined || o.try !== undefined;
        const opt = {
            minPurity: num(o['min-purity'] ?? (combos ? '0' : '0.95'), 'min-purity', 0, 1, false),
            minCount: num(o['min-count']!, 'min-count', 1, 1e9, true),
            maxMasks: num(o['max-masks']!, 'max-masks', 1, 1e6, true),
            maxWild: num(o.wild!, 'wild', 0, 9, true),
            head: o.prefix === undefined ? [] : parseHead(o.prefix),
        };
        const unit = o.unit!.toUpperCase() as Unit;
        if (!Object.hasOwn(UNITS, unit)) throw new ArgError(`--unit: "${o.unit}" - dozwolone: ${Object.keys(UNITS).join(' ')}`);
        const excludeMin = num(o['exclude-min']!, 'exclude-min', 1, 1e9, true);
        const perMask = num(o['per-mask']!, 'per-mask', 1, 1000, true);
        memberNames(o['test-prefix']!, 0);
        const save = (file: string | undefined, text: string, info = '') => {
            if (file === undefined) return;
            fs.writeFileSync(file, text);
            io.err(`Zapisano: ${file}${info}\n`);
        };
        if (!combos) {
            const lone = (['partial', 'top', 'time'] as const).find(x => o[x] !== undefined);
            if (lone) throw new ArgError(`--${lone}: tylko z --quals albo --try`);
        } else {
            const other = o.exclude ? 'exclude' : (['filtlist', 'tests'] as const).find(x => o[x] !== undefined);
            if (other) throw new ArgError(`--${other}: nie z --quals i --try (wybrane maski zapisz w pliku i podaj w --masks)`);
            const partial = num(o.partial ?? '3', 'partial', 0, 7, true);
            if (partial === 1) throw new ArgError('--partial: 2-7 albo 0 (tylko pelne kwalifikatory)');
            const q: QualsInput = {
                quals: o.quals === undefined ? null
                    : { maxQuals: num(o.quals, 'quals', 1, 4, true), top: num(o.top ?? '20', 'top', 1, 10000, true), seconds: num(o.time ?? '600', 'time', 1, 1e6, true) },
                partial, tries: o.try === undefined ? [] : parseTries(o.try), masks: [], excludes: [],
            };
            if (o.try !== undefined && q.tries.length === 0) throw new ArgError('--try: brak kombinacji');
            if (o.masks !== undefined) {
                const list = parseMaskList(fs.readFileSync(o.masks, 'latin1').replace(/^\xef\xbb\xbf/, ''), o.masks);
                for (const w of list.warnings) io.err(`Uwaga: ${w}\n`);
                Object.assign(q, { masks: list.masks, excludes: list.excludes });
            }
            const r = quals(positionals[0], scope, when, q, opt, progress(2 + Number(q.masks.length > 0) + Number(q.quals !== null) + Number(q.tries.length > 0)), io.err);
            io.out(`Zakres: ${o.scope}   kryterium: ${o.when}${opt.head.length ? `   poczatek nazw: ${opt.head.join('.')}` : ''}`
                + `${opt.minPurity > 0 ? `   min. purity: ${pct(opt.minPurity)}` : ''}   min. zbiorow: ${opt.minCount}\n`);
            io.out(qualsReport(r, unit));
            save(o.out, qualsCsv(r, unit));
            return 0;
        }
        const extra = Number(o.exclude) + Number(o.tests !== undefined);
        /** EXCLUDE, FILTLIST i testy do masek; wynik: nowe maski EXCLUDE */
        const finish = (p: Progress, input: CheckInput, include: string[], old: string[]): MaskRow[] => {
            let added: MaskRow[] = [];
            if (o.exclude) {
                const tick = p.stage('EXCLUDE');
                const e = findExcludes(input, include, old, { minCount: excludeMin, maxWild: opt.maxWild, head: opt.head }, tick);
                p.done(`masek EXCLUDE: ${e.masks.length}`);
                io.out(excludeReport(e, unit));
                added = e.masks;
            }
            const exclude = [...old, ...added.map(m => m.text)];
            if (o.tests !== undefined) {
                const tests = maskTests(input, include, exclude, perMask, o['test-prefix']!, p.stage('Testy'));
                p.done(`testow: ${tests.length}`);
                if (tests.length) save(o.tests, testFile(tests), ` (testow: ${tests.length}, ${tests[0].member} - ${tests[tests.length - 1].member})`);
                else io.err(`Brak testow - ${o.tests} nie zapisano\n`);
            }
            if (o.filtlist !== undefined) {
                const good = (m: string) => {
                    const why = acsProblem(m);
                    if (why) io.err(`Uwaga: pominieta w FILTLIST: ${m} (${why})\n`);
                    return !why;
                };
                const inc = include.filter(good);
                const exc = exclude.filter(good);
                if (inc.length) save(o.filtlist, filtlistText('MALE', inc, exc).join('\n') + '\n', ` (INCLUDE: ${inc.length}, EXCLUDE: ${exc.length})`);
                else io.err(`Brak masek - ${o.filtlist} nie zapisano\n`);
            }
            return added;
        };
        if (o.masks !== undefined) {
            const list = parseMaskList(fs.readFileSync(o.masks, 'latin1').replace(/^\xef\xbb\xbf/, ''), o.masks);
            for (const w of list.warnings) io.err(`Uwaga: ${w}\n`);
            const p = progress(5 + extra);
            const c = check(positionals[0], scope, when, list.masks, list.excludes, opt, p, io.err);
            io.out(`Zakres: ${o.scope}   kryterium: ${o.when}${opt.head.length ? `   poczatek masek: ${opt.head.join('.')}` : ''}   maski: ${o.masks}   min. purity: ${pct(opt.minPurity)}, min. zbiorow: ${opt.minCount}\n`);
            io.out(checkReport(c.list, unit));
            io.out(freshReport(c.list, c.fresh, unit));
            const added = finish(p, c.input, [...list.masks, ...c.fresh.masks.map(m => m.text)], list.excludes);
            save(o.out, checkCsv(c.list, c.fresh, unit, added));
            return 0;
        }
        const p = progress(4 + extra);
        const r = search(positionals[0], scope, when, opt, p, io.err);
        const start = opt.head.length ? `   poczatek masek: ${opt.head.join('.')}` : '';
        io.out(`Zakres: ${o.scope}   kryterium: ${o.when}${start}   min. purity: ${pct(opt.minPurity)}, min. zbiorow: ${opt.minCount}\n`);
        io.out(report(r, unit));
        const added = finish(p, r.input, r.masks.map(m => m.text), []);
        save(o.out, toCsv(r, unit, added));
        return 0;
    } catch (err) {
        (bar as Progress | null)?.abort();
        const e = err as NodeJS.ErrnoException;
        if (e instanceof ArgError || e instanceof CsvError || e instanceof MaskError || e instanceof MaskListError
            || e instanceof TestCaseError) {
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
