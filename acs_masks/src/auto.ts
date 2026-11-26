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
 *   --exclude          maski EXCLUDE dla duzych zbiorow objetych maskami (najwyzej 255), jak najszersze: jeden kwalifikator
 *                      (**.DUMP.**, **.*DUMP*.**), dwa, a na koncu pelna maska
 *   --exclude-min N    ile duzych ma wylaczyc maska EXCLUDE                      (domyslnie 2)
 *   --exclude-gain P   jaka czesc alokacji objetych duzych ma wylaczyc           (domyslnie 0.5%)
 *   --exclude-loss P   jaka czesc objetych malych moga razem zabrac EXCLUDE      (domyslnie 0%, z --compact 1%)
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
 *   --check PLIK       test calej FILTLIST (albo listy masek): ile malych i duzych obejmuje (zbiory, %, alokacja), co wnosza duze
 *                      (lista na samych duzych; lista, gdyby duzych nie bylo), pokrywanie sie masek i propozycje krotszej listy.
 *                      Propozycje to kolejne kroki: najpierw bez strat, potem kosztem malych albo duzych (--weights,
 *                      --max-large, --min-purity, --exclude-loss)
 *   --apply N          z --check: ktore propozycje wprowadzic do --filtlist i --tests: safe = bez strat (domyslnie), all,
 *                      N = pierwsze N, 0 = zadnej
 *
 *   --compact          FILTLIST z jak najmniejsza liczba masek (INCLUDE i EXCLUDE razem) przy jak najwiekszym pokryciu:
 *                      krzywa liczba masek -> pokrycie i wybrany punkt. Domyslnie --min-purity 0.5 (przed EXCLUDE)
 *                      i --min-count 0,5% malych (najmniej 10); INCLUDE zaczyna sie od kwalifikatora, nie od ** ani *
 *   --max-large P      ile duzych (alokacja) moze zostac w liscie: 5% alokacji objetych malych albo np. 200GB (domyslnie 5%)
 *   --pick N           punkt krzywej: najwyzej N masek; max = najwieksze pokrycie
 *                      (domyslnie najmniej masek z pokryciem od 95% najwiekszego)
 *   --any-start        INCLUDE moze zaczynac sie od ** i *
 *   --verify PLIK      sprawdza wybrany punkt na drugim CSV (np. nowszym), osobno dla nazw, ktorych w pierwszym nie bylo
 *
 *   --build            FILTLIST budowana po jednej masce z dwoch rankingow kwalifikatorow (male / duze), z dziennikiem krokow;
 *                      o wyborze decyduja punkty: 1 punkt = 1% malych. Domyslnie --min-purity 0.95 (po EXCLUDE), --min-count 10
 *   --weights WAGI     priorytety, np. "masks=1 large=4"; pozostale domyslne: small=1 large=2 masks=0.5 exclude=0.5 risk=0.1
 *                      percent=0.05 wild=0.02 start=2
 *                        small    za 1% objetych malych          large    za duze w liscie (1% alokacji wszystkich malych)
 *                        masks    za maske INCLUDE               exclude  za maske EXCLUDE
 *                        risk     za duze objete maskami, ktore zdejmuje dopiero EXCLUDE (1% alokacji malych)
 *                        percent  za kazdy %    wild  za kazda * i ** (bez koncowego .**)    start  za maske od * albo **
 *   --beam N           ile wersji maski naraz (wiecej = dluzej)                  (domyslnie 8)
 *   --rounds N         ile razy najwyzej druga runda (maski wyjmowane i budowane od nowa)  (domyslnie 2)
 *   --ask              pytanie po kazdej masce: przyjac, wybrac inna, odrzucic, wpisac wlasna, cofnac (bez drugiej rundy)
 *   --what-if          takze wyniki dla wag masks + exclude, large, start podzielonych i pomnozonych przez 2 (7 razy dluzej)
 *   --log PLIK         dziennik do pliku zamiast na ekran (z --next: dopisywany)
 *   --next PLIK        kolejna maska do FILTLIST z pliku: wczytuje ja (brak pliku = zaczyna od zera), dobiera maske dla malych
 *                      zbiorow, ktorych FILTLIST jeszcze nie obejmuje, i dopisuje INCLUDE (i EXCLUDE) do tego pliku;
 *                      poprzednia wersja zostaje w PLIK.bak. Masek z pliku nie zmienia; granice i punkty dotycza calej listy
 *   --target CELE      z --build: cel zamiast samych wag, w sztukach, np. "small=90% purity=95%": najpierw maski az do pokrycia
 *                      malych, potem EXCLUDE az do purity listy (i znowu maski, gdy EXCLUDE zabraly pokrycie). Sprawdza kilka
 *                      progow purity maski (50, 70, 80, 90% i cel; --min-purity = jeden prog) i wybiera najkrotsza liste, ktora
 *                      spelnia oba cele. Waga large wynika z progu; --max-large tylko, gdy podane
 *   --steps N          z --next: ile masek w jednym przebiegu; max = do konca     (domyslnie 1)
 *                      Z --build takze: --max-large, --exclude-min, --exclude-loss (1%), --max-masks, --partial, --verify, --time
 *
 *   --quals N          zamiast masek: najczestsze kombinacje 1..N kwalifikatorow w malych zbiorach (N 1-4), osobna tabela
 *                      dla kazdej liczby; A + B = nazwy **.A.**.B.**, obok najwezsza maska z tymi samymi malymi.
 *                      Takze kwalifikatory niepelne: ABC* *ABC *ABC* AB%% D%%%%%%. Z --masks: tylko zbiory spoza listy
 *   --partial N        ile znakow stalych ma miec kwalifikator niepelny, 2-7; 0 = tylko pelne    (domyslnie 3)
 *   --top N            wierszy w kazdej tabeli                                   (domyslnie 20)
 *   --time SEK         limit czasu --quals, --compact, --build i --check; potem wynik czesciowy                     (domyslnie 600)
 *   --try LISTA        sprawdza podane kombinacje i ich skrocenia, np. "PROD+SYSOUT, LOGDAY, TMP*"
 *                      Z --quals i --try: --min-purity tylko, gdy podane (domyslnie bez progu); --out: CSV z maskami
 *
 *   --config PLIK      ustawienia z pliku JSON (z komentarzami); opcje z wiersza polecen maja pierwszenstwo, a pola, ktore nie
 *                      dotycza trybu pracy, sa pomijane. Plik CSV mozna podac w polu input
 *   --save-config PLIK zapisuje obecne ustawienia (plik i wiersz polecen) z komentarzem do kazdego pola; bez pliku CSV
 *                      na tym konczy, z plikiem pracuje dalej. Istniejacy plik zostaje jako PLIK.bak
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
import { Answer, buildList, BuildOptions, BuildResult, buildTarget, Change, Goal, MaskLists, Points, POINTS, Proposal, TargetResult, targetRungs, Totals } from './auto-build';
import { acsProblem, ExcludeResult, filtlistText, findExcludes, maskTests, testFile } from './auto-acs';
import { CheckInput, checkMasks, CheckResult, MaskListError, parseMaskList } from './auto-check';
import { audit, AuditOptions, AuditResult, Counts, Fix } from './auto-audit';
import { CompactResult, defaultPoint, findCompact, LargeLimit, Point } from './auto-compact';
import { mine, MaskRow, MineOptions, MineResult } from './auto-mine';
import { ConfigError, configText, mergeConfig, readConfig, Values } from './auto-config';
import { Combo, findCombos, parseTries, QualResult, tryCombos, TryRow } from './auto-quals';
import { BOOL, BoolField, Field, NUM, NumField, readStore, Store, STR, StrField } from './auto-read';
import { within } from './auto-tree';
import { Interner, Progress, thousands, Tick } from './auto-util';
import { CsvError } from './dataset';
import { MaskError, matches, parseMask } from './mask';
import { MAX_LIST } from './filtlist';
import { memberNames, TestCaseError } from './testcase';

export interface Io {
    out: (t: string) => void;
    err: (t: string) => void;
    /** pasek postepu rysowany w miejscu (terminal); domyslnie: linia na etap */
    tty?: boolean;
    /** linia wpisana przez uzytkownika; null = koniec wejscia */
    line?: () => string | null;
}

/** Linia ze standardowego wejscia (synchronicznie: terminal i plik). */
function stdinLine(): string | null {
    const buf = Buffer.alloc(1);
    const out: number[] = [];
    for (;;) {
        let n = 0;
        try {
            n = fs.readSync(0, buf, 0, 1, null);
        } catch (e) {
            const { code } = e as NodeJS.ErrnoException;
            if (code === 'EAGAIN') {
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
                continue;
            }
            if (code !== 'EOF') throw e;
        }
        if (n === 0) return out.length ? Buffer.from(out).toString('utf-8') : null;
        if (buf[0] === 10) return Buffer.from(out).toString('utf-8');
        out.push(buf[0]);
    }
}

const STDIO: Io = { out: t => process.stdout.write(t), err: t => process.stderr.write(t), tty: process.stderr.isTTY, line: stdinLine };

const USAGE = 'Uzycie: node acs-masks-auto.cjs DCOLLECT.CSV [--scope "sms=true dsorg=PS"]\n'
    + '        [--when "allocTrk=315 usedTrk<=3"] [--prefix "ABC%.**"] [--min-purity 0.95]\n'
    + '        [--min-count 10] [--max-masks 100] [--wild 3] [--unit GB] [--out maski.csv]\n'
    + '        [--exclude [--exclude-min 2] [--exclude-gain 0.5%] [--exclude-loss 0%]]\n        [--filtlist filtlist.txt] [--tests ACMTEST [--per-mask 1] [--test-prefix ACM]]\n'
    + '   albo: node acs-masks-auto.cjs DCOLLECT.CSV --masks maski.txt [opcje jak wyzej]\n'
    + '         (sprawdza liste i szuka masek dla zbiorow, ktorych ona nie obejmuje)\n'
    + '   albo: node acs-masks-auto.cjs DCOLLECT.CSV --check filtlist.txt [--filtlist nowa.txt [--apply safe]]\n'
    + '         (co obejmuje cala FILTLIST, test na duzych, pokrywanie sie masek, propozycje)\n'
    + '   albo: node acs-masks-auto.cjs DCOLLECT.CSV --compact [--max-large 5%] [--pick N] [--any-start] [--verify NOWSZY.CSV]\n'
    + '         [--filtlist filtlist.txt] (najmniej masek INCLUDE i EXCLUDE, najwieksze pokrycie)\n'
    + '   albo: node acs-masks-auto.cjs DCOLLECT.CSV --build [--weights "masks=1 large=4"] [--ask] [--what-if] [--log dziennik.txt]\n'
    + '         [--verify NOWSZY.CSV] [--filtlist filtlist.txt] (maska po masce, priorytety jako wagi)\n'
    + '   albo: node acs-masks-auto.cjs DCOLLECT.CSV --build --target "small=90% purity=95%" [--filtlist filtlist.txt]\n'
    + '         (maski az do pokrycia malych, potem EXCLUDE az do purity; w sztukach zbiorow)\n'
    + '   albo: node acs-masks-auto.cjs DCOLLECT.CSV --build --next filtlist.txt [--steps 1] [opcje jak wyzej]\n'
    + '         (kazdy przebieg dopisuje do filtlist.txt kolejna maske dla zbiorow jeszcze nie objetych)\n'
    + '   albo: node acs-masks-auto.cjs DCOLLECT.CSV --quals 4 [--partial 3] [--top 20] [--time 600] [--try "PROD+SYSOUT, TMP*"]\n'
    + '         (najczestsze kombinacje kwalifikatorow; sprawdzanie kwalifikatorow niepelnych)\n'
    + '   albo: node acs-masks-auto.cjs --config ustawienia.json [DCOLLECT.CSV] [opcje]   (ustawienia z pliku)\n'
    + '         node acs-masks-auto.cjs --save-config ustawienia.json [opcje]             (zapis ustawien z opisem pol)\n'
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
  node acs-masks-auto.cjs DC --check f.txt                                         test calej FILTLIST i propozycje
  node acs-masks-auto.cjs DC --check f.txt --filtlist nowa.txt                     FILTLIST po propozycjach bez strat
  node acs-masks-auto.cjs DC --check f.txt --filtlist nowa.txt --apply 7           po pierwszych 7 propozycjach
  node acs-masks-auto.cjs DC --compact --verify NOWSZY.CSV                         najmniej masek, sprawdzone na nowszych danych
  node acs-masks-auto.cjs DC --compact --max-large 200GB --pick 12 --filtlist f.txt
  node acs-masks-auto.cjs DC --build --log dziennik.txt --filtlist f.txt           maska po masce, z dziennikiem
  node acs-masks-auto.cjs DC --build --weights "masks=1 large=4"                   mniej masek, jeszcze mniej duzych
  node acs-masks-auto.cjs DC --build --what-if                                     co zmieni kazda waga
  node acs-masks-auto.cjs DC --build --ask                                         kazda maska do zatwierdzenia
  node acs-masks-auto.cjs DC --build --target "small=90% purity=95%"               do celu pokrycia i purity
  node acs-masks-auto.cjs DC --build --target "small=80% purity=99%" --filtlist f.txt
  node acs-masks-auto.cjs DC --build --next f.txt                                  kolejna maska dopisana do f.txt
  node acs-masks-auto.cjs DC --build --next f.txt --steps 5 --log dziennik.txt     piec kolejnych masek
  node acs-masks-auto.cjs DC --build --weights "masks=1" --save-config u.json      zapis ustawien (i przebieg)
  node acs-masks-auto.cjs --config u.json                                          przebieg z zapisanych ustawien
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

export interface AuditRun {
    list: CheckResult;
    result: AuditResult;
    largeKb: number;
    /** listy po propozycjach, policzone od nowa na zbiorach */
    after: { name: string; list: CheckResult }[];
}

/** Test calej listy. */
export function auditList(file: string, scope: Conds, when: Conds, lists: MaskLists, opt: AuditOptions, head: string[], bar: Progress,
    warn: (t: string) => void = () => {}): WithInput<AuditRun> {
    const st = load(file, scope, when, bar, warn);
    const tick = bar.stage('Sprawdzanie masek');
    const { pos, neg } = classify(st, scope, when, head, part => tick(0.2 * part));
    const input = { names: st.names, allocKb: st.allocKb, pos, neg };
    const list = checkMasks(input, lists.include, lists.exclude, part => tick(0.2 + 0.8 * part));
    bar.done(`masek: ${lists.include.length + lists.exclude.length}, malych: ${thousands(pos.length)}, duzych: ${thousands(neg.length)}`);
    const result = audit(input, lists, opt, bar.stage('Propozycje'));
    bar.done(`bez strat: ${result.safe.length}, inne: ${result.trade.length}`);
    const after = [{ name: 'po propozycjach bez strat', fixes: result.safe }, { name: 'po wszystkich propozycjach', fixes: result.trade }]
        .filter(x => x.fixes.length).map(({ name, fixes }) => {
            const l = fixes[fixes.length - 1].lists;
            return { name, list: checkMasks(input, l.include, l.exclude, () => {}) };
        });
    let largeKb = 0;
    for (const r of neg) largeKb += st.allocKb[r];
    return { list, result, largeKb, after, input };
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

export interface CompactSettings {
    /** null = 0,5% malych, najmniej 10 */
    minCount: number | null;
    exMin: number;
    exGain: number;
    loss: number;
    maxLarge: LargeLimit;
    anyStart: boolean;
    seconds: number;
    /** null = domyslny punkt, Infinity = najwieksze pokrycie */
    pick: number | null;
    verify?: string;
}

export interface Verified {
    small: number;
    large: number;
    list: CheckResult;
    /** zbiory, ktorych nazw nie bylo w pierwszym pliku */
    fresh: CheckResult;
}

export interface CompactRun {
    result: CompactResult;
    minCount: number;
    chosen: Point | null;
    /** wybrane maski na danych */
    list: CheckResult | null;
    verified: Verified | null;
}

const DEFAULT_PART = 0.95;

/** Wynikowe maski na drugim pliku: wszystkie zbiory i te, ktorych nazw nie bylo w pierwszym. */
function verify(input: CheckInput, second: CheckInput, include: string[], exclude: string[]): Verified {
    const known = new Interner();
    for (const rows of [input.pos, input.neg]) {
        for (let x = 0; x < rows.length; x++) known.add(input.names.pool, input.names.start[rows[x]], input.names.start[rows[x]] + input.names.len[rows[x]]);
    }
    const isNew = (r: number) => known.find(second.names.pool, second.names.start[r], second.names.start[r] + second.names.len[r]) < 0;
    return {
        small: second.pos.length, large: second.neg.length,
        list: checkMasks(second, include, exclude, () => {}),
        fresh: checkMasks({ ...second, pos: second.pos.filter(isNew), neg: second.neg.filter(isNew) }, include, exclude, () => {}),
    };
}

/** Krzywa --compact, wybrany punkt i jego sprawdzenie na drugim pliku. */
export function compact(file: string, scope: Conds, when: Conds, c: CompactSettings, opt: MineOptions, bar: Progress,
    warn: (t: string) => void = () => {}): WithInput<CompactRun> {
    const read = (name: string, label: string): CheckInput => {
        const st = load(name, scope, when, bar, warn);
        const tick = bar.stage(label);
        const { pos, neg } = classify(st, scope, when, opt.head, p => tick(p));
        bar.done(`malych: ${thousands(pos.length)}, duzych: ${thousands(neg.length)}`);
        return { names: st.names, allocKb: st.allocKb, pos, neg };
    };
    const input = read(file, 'Kryteria');
    const minCount = c.minCount ?? Math.max(10, Math.ceil(0.005 * input.pos.length));
    const result = findCompact(input, {
        minPurity: opt.minPurity, minCount, maxMasks: opt.maxMasks, maxWild: opt.maxWild, head: opt.head, anyStart: c.anyStart,
        maxLarge: c.maxLarge, loss: c.loss, exMin: c.exMin, exGain: c.exGain, seconds: c.seconds,
    }, {
        candidates: bar.stage('Maski'),
        excludes: n => {
            bar.done(`masek: ${thousands(n)}`);
            return bar.stage('Nazwy EXCLUDE');
        },
        select: () => {
            bar.done();
            return bar.stage('Dobor listy');
        },
    });
    bar.done(`punktow krzywej: ${result.points.length}`);
    const { points } = result;
    const chosen = c.pick === null ? defaultPoint(points, DEFAULT_PART)
        : points.filter(p => p.include.length + p.exclude.length <= c.pick!).pop() ?? null;
    if (points.length && !chosen) throw new ArgError(`--pick: najmniejszy punkt ma masek: ${points[0].include.length + points[0].exclude.length}`);
    const list = chosen && checkMasks(input, chosen.include, chosen.exclude, () => {});
    const verified = chosen && c.verify !== undefined ? verify(input, read(c.verify, 'Kryteria'), chosen.include, chosen.exclude) : null;
    return { result, minCount, chosen, list, verified, input };
}

export interface BuildRun {
    result: BuildResult;
    list: CheckResult;
    verified: Verified | null;
    /** --what-if: nazwa zmiany i wynik */
    variants: { name: string; result: BuildResult }[];
}

/** Zmiany wag w --what-if. */
const VARIANTS: { name: string; keys: (keyof Points)[]; by: number }[] = [
    { name: 'masks, exclude', keys: ['masks', 'exclude'], by: 0.5 }, { name: 'masks, exclude', keys: ['masks', 'exclude'], by: 2 },
    { name: 'large', keys: ['large'], by: 0.5 }, { name: 'large', keys: ['large'], by: 2 },
    { name: 'start', keys: ['start'], by: 0.5 }, { name: 'start', keys: ['start'], by: 2 },
];

export interface TargetBuild extends TargetResult {
    goal: Goal;
    /** wybrana lista na zbiorach (KB jak w CSV) */
    list: CheckResult;
}

/** --build --target */
export function buildToTarget(file: string, scope: Conds, when: Conds, o: BuildOptions, goal: Goal, rungs: number[], bar: Progress, io: Io): WithInput<TargetBuild> {
    const st = load(file, scope, when, bar, io.err);
    const tick = bar.stage('Kryteria');
    const { pos, neg } = classify(st, scope, when, o.head, p => tick(p));
    bar.done(`malych: ${thousands(pos.length)}, duzych: ${thousands(neg.length)}`);
    const input = { names: st.names, allocKb: st.allocKb, pos, neg };
    const r = buildTarget(input, o, goal, rungs, {
        names: bar.stage('Kwalifikatory'),
        build: () => {
            bar.done();
            return bar.stage('Do celu');
        },
    });
    bar.done(`masek: ${r.result.include.length + r.result.exclude.length}, pokrycie ${pct(r.reached.small)}, purity ${pct(r.reached.purity)}${r.ok ? ', cel osiagniety' : ''}`);
    return { ...r, goal, list: checkMasks(input, r.result.include, r.result.exclude, () => {}), input };
}

/** "small=90% purity=95%" (takze 0.9) */
export function parseTarget(text: string): Goal {
    const g: Partial<Goal> = {};
    for (const x of text.trim().split(/[\s,]+(?=[a-zA-Z])/).filter(Boolean)) {
        const m = /^(small|purity)=([0-9.,]+)(%?)$/i.exec(x);
        if (!m) throw new ArgError(`--target: "${x}" - podaj small=PROCENT i purity=PROCENT, np. "small=90% purity=95%"`);
        const v = Number(m[2].replace(',', '.'));
        const part = m[3] || v > 1 ? v / 100 : v;
        if (!Number.isFinite(part) || part <= 0 || part > 1) throw new ArgError(`--target: ${x} - zakres 0-100%`);
        g[m[1].toLowerCase() as keyof Goal] = part;
    }
    if (g.small === undefined || g.purity === undefined) throw new ArgError('--target: podaj oba cele, np. "small=90% purity=95%"');
    return g as Goal;
}

export function targetReport(r: TargetBuild, o: BuildOptions, u: Unit = 'GB'): string {
    const { list, goal } = r;
    const out = [`Zbiorow w zakresie: ${list.small + list.large}, malych: ${list.small}, duzych: ${list.large}`,
        `Cel: pokrycie malych ${pctOf(goal.small)}, purity listy ${pctOf(goal.purity)} (w sztukach)   male stracone przez EXCLUDE: do ${pctOf(o.loss)}`
        + `${Number.isFinite('part' in o.maxLarge ? o.maxLarge.part : 0) ? `   duze w liscie: do ${limitText(o.maxLarge, u)}` : ''}`, ''];
    const row = (x: string[]) => x[0].padEnd(24) + x.slice(1).map(y => y.padStart(11)).join('');
    out.push('Etapy (maski od najczystszych; prog = najmniejsza purity maski po jej EXCLUDE)', '', row(['', 'INCLUDE', 'EXCLUDE', 'Pokrycie', 'Purity']));
    for (const x of r.steps) {
        out.push(row([x.what === 'EXCLUDE' ? 'wspolne EXCLUDE' : `maski, prog ${pctOf(x.floor!)}`, String(x.include), String(x.exclude), pct(x.reached.small), pct(x.reached.purity)]));
    }
    if (r.result.stopped) out.push('', 'Uwaga: przerwano po czasie --time; lista moze byc niepelna.');
    const best = r;
    if (!r.ok) {
        const miss = [r.reached.small < goal.small - 1e-12 ? `pokrycie ${pct(r.reached.small)} z ${pctOf(goal.small)}` : '',
            r.reached.purity < goal.purity - 1e-12 ? `purity ${pct(r.reached.purity)} z ${pctOf(goal.purity)}` : ''].filter(Boolean).join(', ');
        out.push('', `Celu nie osiagnieto: ${miss}. Wiecej da wiekszy --exclude-loss, mniejsze --min-count albo nizszy cel; maski, ktore przeszkadzaja, pokaze --check.`);
        if (r.trimmed) {
            const t = r.trimmed;
            out.push(`Purity ${pctOf(goal.purity)} jest przy pokryciu ${pct(t.reached.small)}: bez masek ${r.result.include.filter(m => !t.result.include.includes(m)).join('  ')}`);
        }
    }
    if (best.result.include.length === 0) return out.join('\n') + '\n';
    out.push('', `Lista: masek ${best.result.include.length + best.result.exclude.length} (INCLUDE ${best.result.include.length}, EXCLUDE ${best.result.exclude.length})`, '',
        line([...heads(u), 'Tylko ta']));
    for (const m of list.rows) out.push(line([...cells(m, u), String(m.only)]));
    out.push(line(cells(list.total, u)), '', `Obejmuja ${part(list.total.small, list.small)} malych (${list.total.small} z ${list.small}), po EXCLUDE; `
        + `purity ${pct(list.total.purity)}; duze ${part(list.total.largeKb, list.total.smallKb)} alokacji objetych malych`);
    if (list.excludes.length) {
        out.push('', wide(['Maska EXCLUDE', 'Duzych', `Duzych ${u}`, 'Malych']));
        for (const m of list.excludes) out.push(wide([m.text, String(m.large), inUnit(m.largeKb, u), String(m.small)]));
    }
    return out.join('\n') + '\n';
}

/** Lista budowana po jednej masce. */
export function build(file: string, scope: Conds, when: Conds, o: BuildOptions, extra: { verify?: string; whatIf: boolean; ask: boolean; unit: Unit; by?: { steps: number; done: (r: BuildResult) => void } }, bar: Progress, io: Io): WithInput<BuildRun> {
    const read = (name: string): CheckInput => {
        const st = load(name, scope, when, bar, io.err);
        const tick = bar.stage('Kryteria');
        const { pos, neg } = classify(st, scope, when, o.head, p => tick(p));
        bar.done(`malych: ${thousands(pos.length)}, duzych: ${thousands(neg.length)}`);
        return { names: st.names, allocKb: st.allocKb, pos, neg };
    };
    const input = read(file);
    const one = (label: string, opt: BuildOptions, ask?: (list: Proposal[], no: number, now: Totals, last: Change | null) => Answer) => {
        const r = buildList(input, opt, {
            names: bar.stage('Kwalifikatory'),
            build: () => {
                bar.done();
                const tick = bar.stage(label);
                // pytania zamiast paska
                if (ask) bar.abort();
                return tick;
            },
        }, ask, extra.by);
        bar.done(`masek: ${r.include.length + r.exclude.length}, punkty: ${points(r.points)}`);
        return r;
    };
    const result = one('Budowanie', o, extra.ask ? (list, no, now, last) => askMask(list, no, now, last, input.pos.length, o, extra.unit, io) : undefined);
    const list = checkMasks(input, result.include, result.exclude, () => {});
    const variants = extra.whatIf ? VARIANTS.map(v => {
        const weights = { ...o.weights };
        for (const k of v.keys) weights[k] *= v.by;
        const name = `${v.name}  x${String(v.by).replace('.', ',')}`;
        return { name, result: one(name, { ...o, weights }) };
    }) : [];
    const verified = extra.verify !== undefined && result.include.length ? verify(input, read(extra.verify), result.include, result.exclude) : null;
    return { result, list, verified, variants, input };
}

const points = (x: number) => `${x < 0 ? '' : '+'}${x.toFixed(2).replace('.', ',')}`;

/** --ask: jedno pytanie, powtarzane do poprawnej odpowiedzi. */
function askMask(list: Proposal[], no: number, now: Totals, last: Change | null, small: number, o: BuildOptions, u: Unit, io: Io): Answer {
    const out = [''];
    if (last) out.push(`Przyjeta: ${last.text}   punkty ${points(last.points)}`);
    out.push(`Lista: ${part(now.small, small)} malych (${now.small} z ${small}), duzych ${now.large} (${inUnit(now.largeKb, u)} ${u})`, '');
    const cap = 'kb' in o.maxLarge ? o.maxLarge.kb : o.maxLarge.part * now.smallKb;
    if (now.largeKb > cap + 1e-6) out.push('Uwaga: lista przekracza --max-large, wiec nie ma dalszych propozycji (c = cofnij ostatnia).', '');
    out.push(list.length ? `Maska ${no} - propozycje:` : `Maska ${no}: zadna nie daje punktow w tych granicach.`);
    list.forEach((p, i) => {
        out.push(`  ${i + 1}. ${p.text.padEnd(44)} nowych malych ${p.gain}, duzych ${p.large}, purity ${pct(p.small / (p.small + p.large))}, punkty ${points(p.points)}`);
        for (const e of p.exclude) out.push(`       EXCLUDE ${e}`);
    });
    io.err(`${out.join('\n')}\n`);
    for (;;) {
        io.err(`${list.length ? 'Enter = 1, numer = inna, n = odrzuc 1, ' : ''}maska = wpisana, c = cofnij ostatnia, k = koniec: `);
        const a = io.line?.()?.trim();
        if (a === undefined) {
            io.err('\n');
            return { stop: true };
        }
        if (a === '' && list.length) return { take: 0 };
        if (/^[0-9]+$/.test(a) && Number(a) >= 1 && Number(a) <= list.length) return { take: Number(a) - 1 };
        if (/^n$/i.test(a) && list.length) return { reject: true };
        if (/^c$/i.test(a)) return { undo: true };
        if (/^k$/i.test(a)) return { stop: true };
        try {
            if (!/[.*]/.test(a)) throw new MaskError('nieznana odpowiedz');
            const { text, quals } = parseMask(a);
            const problem = acsProblem(text);
            if (problem) throw new MaskError(problem);
            if (o.head?.some((h, i) => quals[i] !== h)) throw new MaskError(`maska nie zaczyna sie od ${o.head.join('.')}`);
            return { mask: text };
        } catch (e) {
            if (!(e instanceof MaskError)) throw e;
            io.err(`  ${e.message}\n`);
        }
    }
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
    const out = ['', `EXCLUDE - duze zbiory objete maskami (${r.before.large})${r.total.small ? '' : ', bez zadnego malego'}`, ''];
    if (r.masks.length) {
        out.push(wide(['Maska EXCLUDE', 'Duzych', `Duzych ${u}`, ...(r.total.small ? ['Malych'] : [])]));
        for (const m of [...r.masks, r.total]) out.push(wide([m.text, String(m.large), inUnit(m.largeKb, u), ...(r.total.small ? [String(m.small)] : [])]));
        out.push('', `Masek EXCLUDE: ${r.masks.length}; wylaczaja ${part(r.total.large, r.before.large)} duzych objetych maskami`);
        out.push(`Po EXCLUDE: malych ${r.total.small ? `${r.before.small} -> ` : ''}${r.after.small}, duzych ${r.before.large} -> ${r.after.large}, purity ${pct(r.before.purity)} -> ${pct(r.after.purity)}`);
    } else {
        out.push(r.before.large ? 'Brak masek EXCLUDE (--exclude-min, --exclude-gain; duze pod ta sama maska co male).' : 'Maski nie obejmuja duzych zbiorow - EXCLUDE niepotrzebny.');
    }
    return out.join('\n') + '\n';
}

const signed = (n: number) => `${n < 0 ? '-' : '+'}${Math.abs(n)}`;
const MAX_FIXES = 60;
const MAX_BLOCKED = 15;

/** Jedna propozycja: numer, co zrobic, dlaczego i skutek. */
function fixLines(f: Fix, no: number, list: CheckResult, u: Unit): string[] {
    const change: string[] = [];
    if (f.in.small || f.out.small) change.push(`malych ${[f.in.small && signed(f.in.small), f.out.small && signed(-f.out.small)].filter(Boolean).join(' ')}`);
    if (f.in.large) change.push(`duzych +${f.in.large} (+${inUnit(f.in.largeKb, u)} ${u})`);
    if (f.out.large) change.push(`duzych -${f.out.large} (-${inUnit(f.out.largeKb, u)} ${u})`);
    const what = f.add.length === 0 ? `usun ${f.side} ${f.remove[0]}` : f.remove.length === 0 ? `dodaj ${f.side} ${f.add[0]}`
        : f.remove.length === 1 ? `zamien ${f.side} ${f.remove[0]}` : `scal ${f.side} ${f.add[0]}`;
    return [`${String(no).padStart(3)}. ${what}${f.note ? `   ${f.note}` : ''}`,
        `       ${change.join(', ') || 'pokrycie bez zmian'}; punkty ${points(f.points)}; lista: INCLUDE ${f.after.include}, EXCLUDE ${f.after.exclude}, `
        + `malych ${f.after.small} (${part(f.after.small, list.small)}), duzych ${f.after.large}`];
}

/** Od maski, ktora obejmuje najwiecej zbiorow (male i duze), potem najwiecej malych. */
const byCount = <T extends MaskRow>(l: T[]) => l.slice().sort((a, b) => b.small + b.large - a.small - a.large || b.small - a.small || (a.text < b.text ? -1 : 1));

/** Raport --check. */
export function auditReport(r: AuditRun, file: string, lists: MaskLists, o: AuditOptions, u: Unit = 'GB'): string {
    const { list, result: a } = r;
    const b = a.before;
    const kbOf = (kb: number, all: number) => [inUnit(kb, u), part(kb, all)];
    const row5 = (c: string[]) => c[0].padEnd(34) + c.slice(1).map(x => x.padStart(12)).join('');
    const out = [`FILTLIST ${file}: INCLUDE ${b.include}, EXCLUDE ${b.exclude}`, ''];
    if (a.stopped) out.push('Uwaga: przerwano po czasie --time; propozycje i test bez duzych sa niepelne (dluzej: --time 3600).', '');
    out.push(row5(['', 'Zbiorow', '%', u, '%']));
    const whole = (name: string, n: number, kb: number, get: (c: Counts) => [number, number]) => {
        const [inN, inKb] = get(b);
        const [exN, exKb] = get(b.lost);
        const line5 = (label: string, x: number, k: number) => out.push(row5([label, String(x), part(x, n), ...kbOf(k, kb)]));
        line5(`${name} w zakresie`, n, kb);
        line5('  objete filtlista', inN, inKb);
        line5('  wylaczone przez EXCLUDE', exN, exKb);
        line5('  poza INCLUDE', n - inN - exN, kb - inKb - exKb);
    };
    whole('Male', list.small, list.smallKb, c => [c.small, c.smallKb]);
    whole('Duze', list.large, r.largeKb, c => [c.large, c.largeKb]);
    const cap = 'kb' in o.maxLarge ? o.maxLarge.kb : o.maxLarge.part * b.smallKb;
    out.push('', `Purity: ${part(b.small, b.small + b.large)}; duze to ${part(b.largeKb, b.smallKb)} alokacji objetych malych`
        + ` (granica --max-large ${limitText(o.maxLarge, u)}: ${b.largeKb <= cap + 1e-6 ? 'miesci sie' : 'PRZEKROCZONA'})`, '');
    // od maski, ktora obejmuje (wylacza) najwiecej zbiorow
    const sets = (m: MaskRow) => String(m.small + m.large);
    out.push(line(['Maska', 'Zbiorow', ...heads(u).slice(1), 'Tylko ta']));
    for (const m of byCount(list.rows)) out.push(line([m.text, sets(m), ...cells(m, u).slice(1), String(m.only)]));
    out.push(line([list.total.text, sets(list.total), ...cells(list.total, u).slice(1)]));
    if (list.excludes.length) {
        out.push('', wide(['Maska EXCLUDE (wylacza)', 'Zbiorow', 'Duzych', `Duzych ${u}`, 'Malych']));
        for (const m of byCount(list.excludes)) out.push(wide([m.text, sets(m), String(m.large), inUnit(m.largeKb, u), String(m.small)]));
    }

    // ---- 1
    out.push('', '1. TEST NA SAMYCH DUZYCH', '', `Z ${list.large} duzych filtlista obejmuje ${b.large} (${part(b.large, list.large)}), ${inUnit(b.largeKb, u)} ${u}; EXCLUDE zdejmuje ${b.lost.large} (${inUnit(b.lost.largeKb, u)} ${u}).`);
    const dirty = a.include.filter(x => x.all.large > 0).sort((x, y) => y.all.largeKb - x.all.largeKb || y.all.large - x.all.large);
    const nums = (x: string[]) => x[0].padEnd(44) + x.slice(1).map(y => y.padStart(13)).join('');
    if (dirty.length) {
        out.push(`Maski INCLUDE, ktore obejmuja duze: ${dirty.length} z ${a.include.length}. Kolumny "tylko ta" = co ubedzie po usunieciu samej maski.`, '',
            nums(['Maska', 'Duzych', `Duzych ${u}`, 'tylko ta', `tylko ta ${u}`, 'malych tylko', '% mal.']));
        for (const x of dirty) out.push(nums([x.text, String(x.all.large), inUnit(x.all.largeKb, u), String(x.only.large), inUnit(x.only.largeKb, u), String(x.only.small), part(x.only.small, list.small)]));
        out.push('', `Bez tych masek: INCLUDE ${b.include} -> ${a.pure.include}, malych ${b.small} -> ${a.pure.small} (${part(b.small, list.small)} -> ${part(a.pure.small, list.small)}), duzych ${b.large} -> ${a.pure.large}`);
    } else {
        out.push('Zadna maska INCLUDE nie obejmuje duzych (po EXCLUDE): na samych duzych lista jest pusta.');
    }
    const idle = a.exclude.filter(x => x.all.large === 0);
    if (idle.length) out.push('', `EXCLUDE, ktore na samych duzych nic nie robia: ${idle.map(x => x.text).join('  ')}`);
    const twice = a.exclude.filter(x => x.all.large > 0 && x.only.large === 0);
    if (twice.length) out.push('', `EXCLUDE, ktorych duze wylaczaja tez inne EXCLUDE: ${twice.map(x => x.text).join('  ')}`);

    // ---- 2
    const s = a.safe.length ? a.safe[a.safe.length - 1].after : b;
    out.push('', '2. TEST BEZ DUZYCH (te same male, duze odfiltrowane)', '',
        row5(['', 'INCLUDE', 'EXCLUDE', 'razem']),
        row5(['obecna lista', String(b.include), String(b.exclude), String(b.include + b.exclude)]),
        row5(['po propozycjach bez strat', String(s.include), String(s.exclude), String(s.include + s.exclude)]),
        row5(['to samo, gdyby duzych nie bylo', String(a.noLarge.include.length), '0', String(a.noLarge.include.length)]), '');
    const diff = s.include + s.exclude - a.noLarge.include.length;
    out.push(diff > 0 ? `Bez duzych lista zmniejsza sie o ${diff}: tyle masek jest potrzebnych tylko z powodu duzych.`
        : 'Bez duzych lista sie nie zmniejsza: jej dlugosc nie wynika z duzych.');
    const added = a.noLarge.include.filter(m => !lists.include.includes(m));
    if (added.length) out.push(`Maski, ktore by wtedy wystarczyly zamiast obecnych: ${added.join('  ')}`);
    if (a.blocked.length) {
        out.push('', 'Scalenia, ktorych nie przepuszczaja duze (od najtanszego: duze na oszczedzona maske):', '',
            nums(['Maska', 'mniej masek', '+malych', '+duzych', `+duzych ${u}`]) + '   zamiast');
        for (const x of a.blocked.slice(0, MAX_BLOCKED)) {
            out.push(nums([x.text, String(x.remove.length - 1), String(x.in.small), String(x.in.large), inUnit(x.in.largeKb, u)]) + `   ${x.remove.join('  ')}`);
        }
        if (a.blocked.length > MAX_BLOCKED) out.push(`... i jeszcze ${a.blocked.length - MAX_BLOCKED}`);
    }

    // ---- 3
    out.push('', '3. POKRYWANIE SIE MASEK (po EXCLUDE)', '', row5(['Zbior obejmuje masek INCLUDE', 'Malych', '% objetych', 'Duzych', '% objetych']));
    let more = 0;
    let deep = 0;
    a.depth.forEach((c, i) => {
        if (c.small + c.large) out.push(row5([`  ${i + 1}`, String(c.small), part(c.small, b.small), String(c.large), part(c.large, b.large)]));
        if (i > 0) more += c.small;
        deep += (i + 1) * c.small;
    });
    out.push('', `Male objete wiecej niz jedna maska: ${more} (${part(more, b.small)}); srednio masek na maly zbior: ${(b.small ? deep / b.small : 0).toFixed(2).replace('.', ',')}`);
    out.push(`Pary masek ze wspolnymi zbiorami: ${list.overlaps.length}`);
    if (list.overlaps.length) {
        out.push('', 'Maska 1'.padEnd(44) + ' ' + 'Maska 2'.padEnd(44) + 'Malych'.padStart(9) + 'Duzych'.padStart(9) + '% mal. 1'.padStart(10) + '% mal. 2'.padStart(10));
        for (const x of list.overlaps.slice(0, MAX_PAIRS)) {
            const rel = within(x.a.split('.'), x.b.split('.')) ? '1 zawiera sie w 2' : within(x.b.split('.'), x.a.split('.')) ? '2 zawiera sie w 1'
                : x.partA === 1 && x.partB === 1 ? 'te same male' : x.partA === 1 ? 'w danych 1 w 2' : x.partB === 1 ? 'w danych 2 w 1' : 'czesciowo';
            out.push(x.a.padEnd(44) + ' ' + x.b.padEnd(44) + String(x.small).padStart(9) + String(x.large).padStart(9) + pct(x.partA).padStart(10) + pct(x.partB).padStart(10) + `   ${rel}`);
        }
        if (list.overlaps.length > MAX_PAIRS) out.push(`... i jeszcze ${list.overlaps.length - MAX_PAIRS} par (mniej wspolnych zbiorow)`);
    }

    // ---- 4
    out.push('', '4. PROPOZYCJE (kolejne kroki, kazdy liczony po poprzednich)', '');
    const show = (fixes: Fix[], from: number) => {
        fixes.slice(0, MAX_FIXES).forEach((f, i) => out.push(...fixLines(f, from + i, list, u)));
        if (fixes.length > MAX_FIXES) out.push(`... i jeszcze ${fixes.length - MAX_FIXES}`);
    };
    if (a.safe.length) {
        out.push('Bez strat: w tych danych nie wypada zaden objety maly i nie wchodzi zaden duzy', '');
        show(a.safe, 1);
    } else {
        out.push('Bez strat: brak.');
    }
    if (a.trade.length) {
        out.push('', `Kosztem malych albo duzych (oplacalne przy wagach: ${weightsText(o.weights)})`, '');
        show(a.trade, a.safe.length + 1);
    } else {
        out.push('', 'Kosztem malych albo duzych: brak oplacalnych przy tych wagach i granicach (--weights, --max-large, --min-purity).');
    }
    const last = (name: string, inc: number, exc: number, c: CheckResult) => wide([name, String(inc), String(exc), String(c.total.small), part(c.total.small, list.small),
        String(c.total.large), inUnit(c.total.largeKb, u), c.total.smallKb ? part(c.total.largeKb, c.total.smallKb) : '-']);
    out.push('', wide(['', 'INCLUDE', 'EXCLUDE', 'Malych', '% mal.', 'Duzych', `Duzych ${u}`, 'duze/male']), last('obecna lista', b.include, b.exclude, list));
    for (const x of r.after) out.push(last(x.name, x.list.rows.length, x.list.excludes.length, x.list));
    if (list.small > b.small) out.push('', `Nieobjete male: ${list.small - b.small}; kolejne maski dobiera --build --next ${file}`);
    return out.join('\n') + '\n';
}

/** Maski z listy; propozycja = numer kroku, ktory usuwa maske, i maska zamiast niej. */
export function auditCsv(r: AuditRun, u: Unit = 'GB'): string {
    const fixes = [...r.result.safe, ...r.result.trade];
    const fix = (side: Fix['side'], m: string) => {
        const i = fixes.findIndex(f => f.side === side && f.remove.includes(m));
        if (i < 0) return '';
        const f = fixes[i];
        return `${i + 1}: ${f.add.length === 0 ? 'usun' : f.remove.length > 1 ? `scal w ${f.add[0]}` : `zamien na ${f.add.join('  ')}`}${i < r.result.safe.length ? '' : ' (kosztem malych albo duzych)'}`;
    };
    const cols = (m: MaskRow) => { const c = csvCells(m, u); return [c[0], m.small + m.large, ...c.slice(1)]; };
    return [`${csvHead(u).replace(';', ';zbiorow;')};tylko_ta;stan;propozycja`, ...byCount(r.list.rows).map(m => [...cols(m), m.only, '', fix('INCLUDE', m.text)].join(';')),
        ...byCount(r.list.excludes).map(m => [...cols(m), '', 'exclude', fix('EXCLUDE', m.text)].join(';'))].join('\n') + '\n';
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

const count = (p: Point) => p.include.length + p.exclude.length;
const limitText = (l: LargeLimit, u: Unit) => ('kb' in l ? `${inUnit(l.kb, u)} ${u}` : `${pctOf(l.part)} alokacji objetych malych`);
const pctOf = (x: number) => `${String(Math.round(x * 1e6) / 1e4).replace('.', ',')}%`;

function verifyReport(v: Verified, list: CheckResult, file: string, maxLarge: LargeLimit, u: Unit): string[] {
    const out = ['', `Sprawdzenie na drugim pliku: ${file}`, '', wide(['', 'Malych', 'objete', '% mal.', 'Duze w l.', `Duze ${u}`, 'duze/male'])];
    const sum = (name: string, l: CheckResult) => wide([name, String(l.small), String(l.total.small), part(l.total.small, l.small), String(l.total.large),
        inUnit(l.total.largeKb, u), l.total.smallKb ? part(l.total.largeKb, l.total.smallKb) : '-']);
    out.push(sum('pierwszy plik', list), sum('drugi plik', v.list), sum('w tym nazwy, ktorych w pierwszym nie bylo', v.fresh), '');
    const cap = 'kb' in maxLarge ? maxLarge.kb : maxLarge.part * v.list.total.smallKb;
    out.push(v.list.total.largeKb <= cap + 1e-6 ? 'Duze w drugim pliku mieszcza sie w granicy --max-large.'
        : `Uwaga: duze w drugim pliku przekraczaja granice --max-large (${inUnit(v.list.total.largeKb, u)} z ${inUnit(cap, u)} ${u}).`);
    const worse = v.list.rows.map((m, i) => ({ m, was: list.rows[i] })).filter(x => x.m.small + x.m.large > 0 && x.m.purity < x.was.purity - 0.05);
    if (worse.length) {
        out.push('', 'Maski o purity gorszej o ponad 5 punktow:');
        for (const x of worse) out.push(`  ${x.m.text.padEnd(44)} ${pct(x.was.purity)} -> ${pct(x.m.purity)}  (duzych ${x.m.large}, ${inUnit(x.m.largeKb, u)} ${u})`);
    }
    const none = v.list.rows.filter(m => m.small + m.large === 0);
    if (none.length) out.push('', `Maski bez zbiorow w drugim pliku: ${none.map(m => m.text).join('  ')}`);
    return out;
}

export function compactReport(r: CompactRun, c: CompactSettings, u: Unit = 'GB'): string {
    const { result: res, chosen, list, verified: v } = r;
    const out = [`Zbiorow w zakresie: ${res.small + res.large}, malych: ${res.small}, duzych: ${res.large}`,
        `Duze w liscie: do ${limitText(c.maxLarge, u)}   male stracone przez EXCLUDE: do ${pctOf(c.loss)}   INCLUDE daje malych: od ${r.minCount}`,
        ''];
    if (!chosen || !list) {
        out.push('Brak masek dla tych progow (--min-purity, --min-count, --max-large, --any-start).');
        return out.join('\n') + '\n';
    }
    if (res.stopped) out.push('Uwaga: przerwano po czasie --time; krzywa moze byc niepelna.', '');
    const row = (x: string[]) => [7, 9, 9, 9, 9, 12, 9, 12, 10, 10].map((w, i) => x[i].padStart(w)).join('') + (x[10] ?? '');
    out.push('Krzywa: liczba masek i pokrycie', '', row(['Masek', 'INCLUDE', 'EXCLUDE', 'Malych', '% mal.', `Malych ${u}`, 'Duzych', `Duzych ${u}`, 'duze/male', 'Stracone']));
    for (const p of res.points) {
        out.push(row([String(count(p)), String(p.include.length), String(p.exclude.length), String(p.small), part(p.small, res.small), inUnit(p.smallKb, u),
            String(p.large), inUnit(p.largeKb, u), part(p.largeKb, p.smallKb), String(p.lost), p === chosen ? '   <- wybrany' : '']));
    }
    out.push('', `Wybrany punkt: masek ${count(chosen)} (INCLUDE ${chosen.include.length}, EXCLUDE ${chosen.exclude.length}); inny: --pick N`, '',
        line([...heads(u), 'Tylko ta']));
    for (const m of list.rows) out.push(line([...cells(m, u), String(m.only)]));
    out.push(line(cells(list.total, u)), '', `Obejmuja ${part(list.total.small, list.small)} malych (${list.total.small} z ${list.small}), po EXCLUDE`);
    if (list.excludes.length) {
        out.push('', wide(['Maska EXCLUDE', 'Duzych', `Duzych ${u}`, 'Malych']));
        for (const m of list.excludes) out.push(wide([m.text, String(m.large), inUnit(m.largeKb, u), String(m.small)]));
    }
    if (v) out.push(...verifyReport(v, list, c.verify!, c.maxLarge, u));
    return out.join('\n') + '\n';
}

/** old: ile pierwszych masek juz bylo; dalsze maja stan "nowa" */
export function compactCsv(r: { list: CheckResult | null }, u: Unit = 'GB', old = Infinity): string {
    return [`${csvHead(u)};tylko_ta;stan`, ...(r.list?.rows ?? []).map((m, i) => [...csvCells(m, u), m.only, i < old ? '' : 'nowa'].join(';')),
        ...(r.list?.excludes ?? []).map(m => [...csvCells(m, u), '', 'exclude'].join(';'))].join('\n') + '\n';
}

/** Dziennik: kroki kazdej maski z listy, potem zmiany listy po kolei. */
export function journalText(r: BuildResult): string {
    const out = ['Dziennik: jak powstala kazda maska (male / duze = objete maska, po jej EXCLUDE)'];
    r.include.forEach((text, i) => {
        if (i < r.old.include) return;
        const m = r.how[i];
        out.push('', `${i + 1}. ${text}${m?.exclude.length ? `   EXCLUDE ${m.exclude.join('  ')}` : ''}${m ? '' : '   (wpisana)'}`);
        for (const s of m?.steps ?? []) {
            out.push(`     ${s.text.padEnd(44)}${String(s.small).padStart(9)} /${String(s.large).padStart(8)}${pct(s.small + s.large ? s.small / (s.small + s.large) : 0).padStart(8)}   ${s.note}`);
        }
    });
    if (r.changes.length) out.push('', 'Zmiany listy po kolei', '', ...r.changes.map(c => `${points(c.points).padStart(9)}   ${c.text}`));
    return out.join('\n') + '\n';
}

const LABELS: Record<keyof Points, string> = {
    small: 'objete male', large: 'duze w liscie', masks: 'maski INCLUDE', exclude: 'maski EXCLUDE', risk: 'duze zdejmowane przez EXCLUDE',
    percent: 'znaki %', wild: '* i **', start: 'maski od * albo **',
};
const weightsText = (w: Points) => (Object.keys(POINTS) as (keyof Points)[]).map(k => `${k}=${w[k]}`).join(' ');

export function buildReport(r: BuildRun, o: BuildOptions, file: string | undefined, u: Unit = 'GB'): string {
    const { result: res, list } = r;
    const out = [`Zbiorow w zakresie: ${list.small + list.large}, malych: ${list.small}, duzych: ${list.large}`,
        `Duze w liscie: do ${limitText(o.maxLarge, u)}   male stracone przez EXCLUDE: do ${pctOf(o.loss)}`, `Wagi: ${weightsText(o.weights)}`, ''];
    if (res.stopped) out.push('Uwaga: przerwano po czasie --time; lista moze byc niepelna.', '');
    if (res.include.length === 0) {
        out.push('Brak masek dla tych progow i wag (--min-purity, --min-count, --max-large, --weights).');
        return out.join('\n') + '\n';
    }
    out.push(`Masek ${res.include.length + res.exclude.length} (INCLUDE ${res.include.length}, EXCLUDE ${res.exclude.length})`, '', line([...heads(u), 'Tylko ta']));
    for (const m of list.rows) out.push(line([...cells(m, u), String(m.only)]));
    out.push(line(cells(list.total, u)), '', `Obejmuja ${part(list.total.small, list.small)} malych (${list.total.small} z ${list.small}), po EXCLUDE; `
        + `duze ${part(list.total.largeKb, list.total.smallKb)} alokacji objetych malych`);
    if (list.excludes.length) {
        out.push('', wide(['Maska EXCLUDE', 'Duzych', `Duzych ${u}`, 'Malych']));
        for (const m of list.excludes) out.push(wide([m.text, String(m.large), inUnit(m.largeKb, u), String(m.small)]));
    }
    out.push('', 'Punkty (1 punkt = 1% malych przy small=1)', '');
    for (const k of Object.keys(POINTS) as (keyof Points)[]) out.push(LABELS[k].padEnd(34) + `${k}=${o.weights[k]}`.padEnd(14) + points(res.parts[k]).padStart(10));
    out.push('RAZEM'.padEnd(48) + points(res.points).padStart(10));
    if (r.variants.length) {
        const row = (x: string[]) => x[0].padEnd(30) + x.slice(1).map(y => y.padStart(10)).join('');
        const of = (name: string, v: BuildResult) => row([name, String(v.include.length), String(v.exclude.length), part(v.totals.small, list.small), part(v.totals.largeKb, v.totals.smallKb),
            String(v.include.filter(m => m.startsWith('*')).length)]);
        out.push('', 'Co zmieni waga', '', row(['Wagi', 'INCLUDE', 'EXCLUDE', '% mal.', 'duze/male', 'od **']), of('obecne', res));
        for (const v of r.variants) out.push(of(v.name, v.result));
    }
    if (r.verified && file !== undefined) out.push(...verifyReport(r.verified, list, file, o.maxLarge, u));
    return out.join('\n') + '\n';
}

/** Raport jednego przebiegu --next: co doszlo do FILTLIST i co zostalo. */
export function nextReport(r: BuildRun, o: BuildOptions, next: string, file: string | undefined, u: Unit = 'GB'): string {
    const { result: res, list } = r;
    const { old, before: was, totals: now } = res;
    const out = [`Zbiorow w zakresie: ${list.small + list.large}, malych: ${list.small}, duzych: ${list.large}`,
        `Duze w liscie: do ${limitText(o.maxLarge, u)}   male stracone przez EXCLUDE: do ${pctOf(o.loss)}`, `Wagi: ${weightsText(o.weights)}`, ''];
    if (res.stopped) out.push('Uwaga: przerwano po czasie --time.', '');
    const fresh = list.rows.slice(old.include);
    const freshEx = list.excludes.slice(old.exclude);
    if (fresh.length) {
        out.push(fresh.length === 1 ? 'Nowa maska (liczby po EXCLUDE)' : `Nowe maski: ${fresh.length} (liczby po EXCLUDE)`, '', line([...heads(u), 'Tylko ta']));
        for (const m of fresh) out.push(line([...cells(m, u), String(m.only)]));
        out.push('');
    }
    if (freshEx.length) {
        out.push(wide(['Nowy EXCLUDE', 'Duzych', `Duzych ${u}`, 'Malych']));
        for (const m of freshEx) out.push(wide([m.text, String(m.large), inUnit(m.largeKb, u), String(m.small)]));
        out.push('');
    }
    if (!fresh.length) {
        const full = res.include.length + res.exclude.length >= o.maxMasks;
        out.push(full ? `Brak miejsca na kolejna maske: lista ma juz ${res.include.length + res.exclude.length} (--max-masks).`
            : 'Brak kolejnej maski dla tych progow i wag. Wiecej da mniejsza waga masks albo start, mniejsze --min-count albo wieksze --max-large.', '');
    }
    out.push(wide([`FILTLIST ${next}`, 'INCLUDE', 'EXCLUDE', 'Malych', '% mal.', 'Duzych', `Duzych ${u}`, 'duze/male']));
    const row = (name: string, inc: number, exc: number, t: Totals) => wide([name, String(inc), String(exc), String(t.small), part(t.small, list.small),
        String(t.large), inUnit(t.largeKb, u), t.smallKb ? part(t.largeKb, t.smallKb) : '-']);
    out.push(row('przed', old.include, old.exclude, was), row('po', res.include.length, res.exclude.length, now), '');
    out.push(`Zostalo nieobjetych malych: ${res.left.small}${res.left.dead ? `, w tym wylaczonych przez EXCLUDE: ${res.left.dead}` : ''}`);
    if (now.lost) out.push(`Male objete INCLUDE, ale wylaczone przez EXCLUDE: ${now.lost}`);
    const cap = 'kb' in o.maxLarge ? o.maxLarge.kb : o.maxLarge.part * now.smallKb;
    if (now.largeKb > cap + 1e-6) {
        out.push('', `Uwaga: duze w liscie przekraczaja --max-large (${inUnit(now.largeKb, u)} z ${inUnit(cap, u)} ${u}); do tego czasu nowe maski nie moga dodac duzych.`);
    }
    if (r.verified && file !== undefined) out.push(...verifyReport(r.verified, list, file, o.maxLarge, u));
    return out.join('\n') + '\n';
}

/** Plik --next: FILTLIST (albo sam INCLUDE), przed nia komentarze. */
export interface NextFile extends MaskLists {
    name: string;
    /** tekst przed FILTLIST */
    lead: string;
    warnings: string[];
}

export function readNext(file: string): NextFile {
    let text = '';
    try {
        text = fs.readFileSync(file, 'latin1').replace(/^\xef\xbb\xbf/, '');
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const clean = text.replace(/\/\*[\s\S]*?\*\//g, c => c.replace(/[^\n]/g, ' '));
    if (!clean.trim()) return { name: 'MALE', lead: text.trim() ? `${text.trimEnd()}\n` : '', include: [], exclude: [], warnings: [] };
    const start = /(^|\s)(FILTLIST|INCLUDE\s*\()/i.exec(clean);
    if (!start || !/(^|\s)INCLUDE\s*\(/i.test(clean)) throw new ArgError(`--next: ${file} to nie FILTLIST z INCLUDE(...)`);
    const names = [...clean.matchAll(/(?:^|\s)FILTLIST\s+([^\s(]+)/gi)].map(m => m[1].toUpperCase());
    if (names.length > 1) throw new ArgError(`--next: ${file} - jedna FILTLIST w pliku (jest ${names.length})`);
    const list = parseMaskList(text, file);
    const at = start.index + start[1].length;
    const lead = text.slice(0, at).trimEnd();
    const warnings = list.warnings.slice();
    if (text.slice(at).includes('/*')) warnings.push(`${file}: komentarze wewnatrz i za FILTLIST nie zostana przepisane`);
    return { name: names[0] ?? 'MALE', lead: lead ? `${lead}\n` : '', include: list.masks, exclude: list.excludes, warnings };
}

/** "masks=1 large=4" (takze po przecinku) */
export function parseWeights(text: string): Points {
    const w = { ...POINTS };
    for (const x of text.trim().split(/[\s,]+(?=[a-zA-Z])/).filter(Boolean)) {
        const m = /^([a-z]+)=([0-9.,]+)$/i.exec(x);
        const k = m?.[1].toLowerCase();
        if (!m || !Object.hasOwn(POINTS, k!)) throw new ArgError(`--weights: "${x}" - dozwolone: ${Object.keys(POINTS).join(' ')} (np. masks=1)`);
        w[k as keyof Points] = num(m[2], 'weights', 0, 1e6, false);
    }
    if (w.small === 0) throw new ArgError('--weights: small musi byc wieksze od 0');
    return w;
}

/** "5%" -> 0.05; sama liczba tez znaczy procent */
function percent(v: string, name: string): number {
    return num(v.trim().replace(/%$/, ''), name, 0, 100, false) / 100;
}

function largeLimit(v: string): LargeLimit {
    const m = /^([0-9.,]+)\s*(MB|GB|TB)$/i.exec(v.trim());
    if (m) return { kb: num(m[1], 'max-large', 0, 1e12, false) * UNITS[m[2].toUpperCase() as Unit][0] };
    if (!/^[0-9.,]+%?$/.test(v.trim())) throw new ArgError(`--max-large: niepoprawna wartosc "${v}" (np. 5% albo 200GB)`);
    return { part: num(v.trim().replace(/%$/, ''), 'max-large', 0, 10000, false) / 100 };
}

const text = { type: 'string' } as const;
const flag = { type: 'boolean' } as const;
export const OPTIONS = {
    scope: text, when: text, prefix: text, 'min-purity': text, 'min-count': text, 'max-masks': text, wild: text, masks: text, quals: text, partial: text,
    top: text, time: text, try: text, unit: text, out: { type: 'string', short: 'o' }, exclude: flag, 'exclude-min': text, 'exclude-gain': text,
    'exclude-loss': text, compact: flag, 'max-large': text, pick: text, 'any-start': flag, verify: text, build: flag, weights: text, beam: text, rounds: text,
    ask: flag, 'what-if': flag, log: text, next: text, target: text, steps: text, check: text, apply: text, filtlist: text, tests: text, 'per-mask': text, 'test-prefix': text,
    config: text, 'save-config': text, help: { type: 'boolean', short: 'h' },
} as const;
const DEFAULTS = {
    scope: 'sms=true dsorg=PS', when: 'allocTrk=315 usedTrk<=3', 'max-masks': '100', unit: 'GB', 'exclude-min': '2', 'per-mask': '1', 'test-prefix': 'ACM',
    exclude: false, compact: false, 'any-start': false, build: false, ask: false, 'what-if': false,
};

export function main(argv: string[], io: Io = STDIO): number {
    let bar: Progress | null = null;
    const progress = (stages: number) => bar = new Progress(stages, io.err, io.tty ?? false, () => process.stderr.columns || 80);
    try {
        const { values: cli, positionals: given } = parseArgs({
            args: argv,
            allowPositionals: true,
            options: OPTIONS,
        });
        if (cli.help) {
            io.out(HELP);
            return 0;
        }
        const { config, 'save-config': saveConfig, help: _help, ...own } = cli;
        const merged = mergeConfig(own as Values, config === undefined ? {} : readConfig(config));
        if (merged.skipped.length) io.err(`Uwaga: ${config}: pominiete, nie dotycza tego trybu: ${merged.skipped.join(' ')}\n`);
        const { input, ...set } = merged.values as { input?: string } & Partial<typeof own>;
        const o = { ...DEFAULTS, ...set };
        const positionals = given.length || input === undefined ? given : [input];
        if (positionals.length > 1 || (positionals.length === 0 && saveConfig === undefined)) {
            io.err(USAGE);
            return 1;
        }
        if (saveConfig !== undefined) {
            if (fs.existsSync(saveConfig)) fs.copyFileSync(saveConfig, `${saveConfig}.bak`);
            fs.writeFileSync(saveConfig, configText({ ...merged.all, input: positionals[0] }, parseWeights(String(merged.all.weights ?? ''))));
            io.err(`Zapisano: ${saveConfig}\n`);
            // bez pliku w wierszu polecen: sam zapis
            if (given.length === 0) return 0;
        }
        const scope = parseConds(o.scope!, 'scope');
        const when = parseConds(o.when!, 'when');
        const combos = o.quals !== undefined || o.try !== undefined;
        const opt = {
            minPurity: num(o['min-purity'] ?? (combos ? '0' : o.compact ? '0.5' : '0.95'), 'min-purity', 0, 1, false),
            minCount: num(o['min-count'] ?? '10', 'min-count', 1, 1e9, true),
            maxMasks: num(o['max-masks']!, 'max-masks', 1, 1e6, true),
            maxWild: num(o.wild ?? '3', 'wild', 0, 9, true),
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
        const exGain = percent(o['exclude-gain'] ?? '0.5', 'exclude-gain');
        const loss = percent(o['exclude-loss'] ?? (o.compact || o.build || o.check !== undefined ? '1' : '0'), 'exclude-loss');
        const onlyBuild = (['ask', 'what-if'] as const).find(x => o[x]) ?? (['beam', 'rounds', 'log', 'next', 'target', 'weights'] as const).find(x => o[x] !== undefined);
        const checked = o.check !== undefined;
        if (onlyBuild && !o.build && !(checked && onlyBuild === 'weights')) throw new ArgError(`--${onlyBuild}: tylko z --build${onlyBuild === 'weights' ? ' albo --check' : ''}`);
        if (o.steps !== undefined && o.next === undefined) throw new ArgError('--steps: tylko z --next');
        if (o.next !== undefined) {
            if (o.filtlist !== undefined) throw new ArgError('--filtlist: nie z --next (maski trafiaja do pliku z --next)');
            if (o['what-if']) throw new ArgError('--what-if: nie z --next');
            if (o.rounds !== undefined) throw new ArgError('--rounds: nie z --next (masek z listy skrypt nie zmienia)');
            if (o.ask && o.steps !== undefined) throw new ArgError('--steps: nie z --ask');
        }
        if (o.apply !== undefined && (!checked || (o.filtlist === undefined && o.tests === undefined))) throw new ArgError('--apply: tylko z --check i --filtlist albo --tests');
        if (checked) {
            const other = (['build', 'compact', 'exclude', 'any-start'] as const).find(x => o[x])
                ?? (['masks', 'quals', 'try', 'partial', 'top', 'pick', 'wild', 'min-count', 'exclude-gain', 'verify'] as const).find(x => o[x] !== undefined);
            if (other) throw new ArgError(`--${other}: nie z --check`);
        } else if (o.build) {
            const other = (['compact', 'exclude', 'any-start'] as const).find(x => o[x])
                ?? (['masks', 'quals', 'try', 'top', 'pick', 'wild', 'exclude-gain'] as const).find(x => o[x] !== undefined);
            if (other) throw new ArgError(`--${other}: nie z --build`);
            if (o.ask && o['what-if']) throw new ArgError('--what-if: nie z --ask');
        } else if (o.compact) {
            const other = o.exclude ? 'exclude' : (['masks', 'quals', 'try', 'partial', 'top'] as const).find(x => o[x] !== undefined);
            if (other) throw new ArgError(`--${other}: nie z --compact`);
        } else {
            const lone = o['any-start'] ? 'any-start' : (['max-large', 'pick', 'verify'] as const).find(x => o[x] !== undefined);
            if (lone) throw new ArgError(`--${lone}: tylko z --compact${lone === 'max-large' || lone === 'verify' ? ' albo --build' : ''}${lone === 'max-large' ? ', --check' : ''}`);
            const ex = (['exclude-gain', 'exclude-loss'] as const).find(x => o[x] !== undefined);
            if (ex && !o.exclude) throw new ArgError(`--${ex}: tylko z --exclude, --compact${ex === 'exclude-loss' ? ', --build, --check' : ''}`);
        }
        const partial = num(o.partial ?? '3', 'partial', 0, 7, true);
        if (partial === 1) throw new ArgError('--partial: 2-7 albo 0 (tylko pelne kwalifikatory)');
        if (!combos) {
            const lone = o.top !== undefined ? 'top' : o.partial !== undefined && !o.build ? 'partial' : null;
            if (lone) throw new ArgError(`--${lone}: tylko z --quals albo --try${lone === 'partial' ? ' albo --build' : ''}`);
            if (o.time !== undefined && !o.compact && !o.build && o.check === undefined) throw new ArgError('--time: tylko z --quals, --compact, --build albo --check');
        } else {
            const other = o.exclude ? 'exclude' : (['filtlist', 'tests'] as const).find(x => o[x] !== undefined);
            if (other) throw new ArgError(`--${other}: nie z --quals i --try (wybrane maski zapisz w pliku i podaj w --masks)`);
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
        const finish = (p: Progress, input: CheckInput, include: string[], old: string[], name = 'MALE'): MaskRow[] => {
            let added: MaskRow[] = [];
            if (o.exclude) {
                const tick = p.stage('EXCLUDE');
                const e = findExcludes(input, include, old, { minCount: excludeMin, maxWild: opt.maxWild, head: opt.head, gain: exGain, loss }, tick);
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
                if (inc.length) save(o.filtlist, filtlistText(name, inc, exc).join('\n') + '\n', ` (INCLUDE: ${inc.length}, EXCLUDE: ${exc.length})`);
                else io.err(`Brak masek - ${o.filtlist} nie zapisano\n`);
            }
            return added;
        };
        if (checked) {
            const source = fs.readFileSync(o.check!, 'latin1').replace(/^\xef\xbb\xbf/, '');
            const list = parseMaskList(source, o.check!);
            for (const w of list.warnings) io.err(`Uwaga: ${w}\n`);
            const lists = { include: list.masks, exclude: list.excludes };
            const a: AuditOptions = {
                weights: parseWeights(o.weights ?? ''), maxLarge: largeLimit(o['max-large'] ?? '5%'), minPurity: opt.minPurity, loss, head: opt.head.length,
                seconds: num(o.time ?? '600', 'time', 1, 1e6, true),
            };
            const p = progress(3 + Number(o.tests !== undefined));
            const r = auditList(positionals[0], scope, when, lists, a, opt.head, p, io.err);
            const fixes = [...r.result.safe, ...r.result.trade];
            const apply = o.apply === undefined || o.apply === 'safe' ? r.result.safe.length : o.apply === 'all' ? fixes.length : num(o.apply, 'apply', 0, 1e6, true);
            if (apply > fixes.length) throw new ArgError(`--apply: propozycji jest ${fixes.length}`);
            io.out(`Zakres: ${o.scope}   kryterium: ${o.when}${opt.head.length ? `   poczatek nazw: ${opt.head.join('.')}` : ''}\n`);
            io.out(auditReport(r, o.check!, lists, a, unit));
            if (o.filtlist !== undefined || o.tests !== undefined) {
                const now = apply ? fixes[apply - 1].lists : lists;
                // FILTLIST zapisywana w to samo miejsce: poprzednia wersja zostaje
                if (o.filtlist !== undefined && fs.existsSync(o.filtlist)) fs.copyFileSync(o.filtlist, `${o.filtlist}.bak`);
                const names = [...source.replace(/\/\*[\s\S]*?\*\//g, ' ').matchAll(/(?:^|\s)FILTLIST\s+([^\s(]+)/gi)].map(m => m[1].toUpperCase());
                io.err(`Wprowadzone propozycje: ${apply} z ${fixes.length}\n`);
                finish(p, r.input, now.include, now.exclude, names.length === 1 ? names[0] : 'MALE');
            }
            save(o.out, auditCsv(r, unit));
            return 0;
        }
        if (o.build) {
            if (o.verify !== undefined) fs.accessSync(o.verify);
            const b: BuildOptions = {
                weights: parseWeights(o.weights ?? ''), minPurity: opt.minPurity, minCount: opt.minCount, maxMasks: Math.min(opt.maxMasks, MAX_LIST),
                maxLarge: largeLimit(o['max-large'] ?? '5%'), loss, exMin: excludeMin, partial, beam: num(o.beam ?? '8', 'beam', 1, 1000, true),
                rounds: num(o.rounds ?? '2', 'rounds', 0, 100, true), head: opt.head, seconds: num(o.time ?? '600', 'time', 1, 1e6, true),
            };
            if (o.target !== undefined) {
                const other = o.ask ? 'ask' : o['what-if'] ? 'what-if' : (['next', 'rounds', 'verify', 'steps'] as const).find(x => o[x] !== undefined);
                if (other) throw new ArgError(`--${other}: nie z --target`);
                const goal = parseTarget(o.target);
                const rungs = o['min-purity'] === undefined ? targetRungs(goal.purity) : targetRungs(goal.purity).filter(x => x >= opt.minPurity);
                if (typeof own.weights === 'string' && /large=/i.test(own.weights)) io.err('Uwaga: z --target waga large wynika z progu purity; podana jest pominieta\n');
                const t: BuildOptions = { ...b, maxLarge: o['max-large'] === undefined ? { part: Infinity } : b.maxLarge };
                const r = buildToTarget(positionals[0], scope, when, t, goal, rungs.length ? rungs : [opt.minPurity], progress(4 + Number(o.tests !== undefined)), io);
                io.out(`Zakres: ${o.scope}   kryterium: ${o.when}${opt.head.length ? `   poczatek masek: ${opt.head.join('.')}` : ''}\n`);
                io.out(targetReport(r, t, unit));
                const journal = journalText(r.result);
                if (o.log === undefined) io.out(`\n${journal}`);
                else save(o.log, journal);
                const ok = (l: string[]) => l.filter(m => !acsProblem(m));
                const { include, exclude } = r.result;
                if (ok(include).length && o.filtlist === undefined) io.out(`\n${filtlistText('MALE', ok(include), ok(exclude)).join('\n')}\n`);
                if (include.length) finish(bar!, r.input, include, exclude);
                save(o.out, compactCsv(r, unit));
                return 0;
            }
            const p = progress(4 + 2 * VARIANTS.length * Number(o['what-if']) + 2 * Number(o.verify !== undefined) + Number(o.tests !== undefined));
            if (o.next !== undefined) {
                const { next } = o;
                const list = readNext(next);
                for (const w of list.warnings) io.err(`Uwaga: ${w}\n`);
                b.base = { include: list.include, exclude: list.exclude };
                const steps = o.steps === 'max' ? Infinity : num(o.steps ?? '1', 'steps', 1, 1e6, true);
                let written = false;
                /** po kazdej masce, zeby przerwany przebieg nic nie stracil */
                const write = (x: BuildResult) => {
                    if (!written && fs.existsSync(next)) fs.copyFileSync(next, `${next}.bak`);
                    written = true;
                    fs.writeFileSync(next, list.lead + filtlistText(list.name, x.include, x.exclude).join('\n') + '\n', 'latin1');
                };
                const r = build(positionals[0], scope, when, b, { verify: o.verify, whatIf: false, ask: o.ask!, unit, by: o.ask ? undefined : { steps, done: write } }, p, io);
                const { result } = r;
                const changed = result.include.length > list.include.length || result.exclude.length > list.exclude.length;
                if (o.ask && changed) write(result);
                io.out(`Zakres: ${o.scope}   kryterium: ${o.when}${opt.head.length ? `   poczatek masek: ${opt.head.join('.')}` : ''}   min. purity: ${pct(opt.minPurity)}\n`);
                io.out(nextReport(r, b, next, o.verify, unit));
                if (changed) {
                    const journal = journalText(result);
                    if (o.log === undefined) io.out(`\n${journal}`);
                    else fs.appendFileSync(o.log, `${journal}\n`);
                }
                if (result.include.length) finish(p, r.input, result.include, result.exclude);
                save(o.out, compactCsv(r, unit, result.old.include));
                io.err(changed ? `Zapisano: ${next} (INCLUDE: ${result.include.length}, EXCLUDE: ${result.exclude.length})${fs.existsSync(`${next}.bak`) && list.include.length ? `, poprzednia wersja: ${next}.bak` : ''}\n`
                    : `${next}: bez zmian\n`);
                return 0;
            }
            const r = build(positionals[0], scope, when, b, { verify: o.verify, whatIf: o['what-if']!, ask: o.ask!, unit }, p, io);
            io.out(`Zakres: ${o.scope}   kryterium: ${o.when}${opt.head.length ? `   poczatek masek: ${opt.head.join('.')}` : ''}   min. purity: ${pct(opt.minPurity)}\n`);
            io.out(buildReport(r, b, o.verify, unit));
            const journal = journalText(r.result);
            if (o.log === undefined) io.out(`\n${journal}`);
            else save(o.log, journal);
            const ok = (l: string[]) => l.filter(m => !acsProblem(m));
            if (ok(r.result.include).length && o.filtlist === undefined) io.out(`\n${filtlistText('MALE', ok(r.result.include), ok(r.result.exclude)).join('\n')}\n`);
            if (r.result.include.length) finish(p, r.input, r.result.include, r.result.exclude);
            save(o.out, compactCsv(r, unit));
            return 0;
        }
        if (o.compact) {
            if (o.verify !== undefined) fs.accessSync(o.verify);
            const c: CompactSettings = {
                minCount: o['min-count'] === undefined ? null : opt.minCount, exMin: excludeMin, exGain, loss, anyStart: o['any-start']!,
                maxLarge: largeLimit(o['max-large'] ?? '5%'), seconds: num(o.time ?? '600', 'time', 1, 1e6, true),
                pick: o.pick === undefined ? null : o.pick === 'max' ? Infinity : num(o.pick, 'pick', 1, 1e6, true), verify: o.verify,
            };
            const p = progress(5 + 2 * Number(o.verify !== undefined) + Number(o.tests !== undefined));
            const r = compact(positionals[0], scope, when, c, { ...opt, maxMasks: Math.min(opt.maxMasks, MAX_LIST) }, p, io.err);
            io.out(`Zakres: ${o.scope}   kryterium: ${o.when}${opt.head.length ? `   poczatek masek: ${opt.head.join('.')}` : ''}   min. purity przed EXCLUDE: ${pct(opt.minPurity)}\n`);
            io.out(compactReport(r, c, unit));
            if (r.chosen && o.filtlist === undefined) io.out(`\n${filtlistText('MALE', r.chosen.include.filter(m => !acsProblem(m)), r.chosen.exclude.filter(m => !acsProblem(m))).join('\n')}\n`);
            if (r.chosen) finish(p, r.input, r.chosen.include, r.chosen.exclude);
            save(o.out, compactCsv(r, unit));
            return 0;
        }
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
            || e instanceof TestCaseError || e instanceof ConfigError) {
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
