/**
 * Ustawienia acs-masks-auto w pliku JSON z komentarzami (--config, --save-config). Komentarze (jak w JS) i przecinek po
 * ostatnim polu sa dozwolone. Pierwszenstwo: wiersz polecen, potem plik, potem wartosci domyslne.
 *
 * Plik zapisany przez skrypt ma wszystkie pola, wiec pole, ktore nie dotyczy trybu pracy (np. weights bez build), jest
 * pomijane; ta sama opcja w wierszu polecen to blad. null = wartosc domyslna.
 */
import fs from 'node:fs';
import { Points, POINTS } from './auto-build';

export class ConfigError extends Error {}

/** Opcje jak w wierszu polecen; weights jako tekst "masks=1 large=4". */
export type Values = Record<string, string | boolean | undefined>;

interface Field {
    name: string;
    /** text: takze liczba; flag: true / false */
    kind: 'text' | 'flag' | 'weights';
    /** wartosc wpisywana do pliku, gdy nie podano; null = zalezy od trybu albo nie ma */
    value: string | number | boolean | null;
    doc: string[];
    /** czy dotyczy trybu pracy; brak = zawsze */
    fits?: (v: Values) => boolean;
}

const checked = (v: Values) => v.check !== undefined;
const search = (v: Values) => !v.build && !v.compact && v.quals === undefined && v.try === undefined && !checked(v);
const combos = (v: Values) => !v.build && !v.compact && !checked(v) && !search(v);
const build = (v: Values) => !!v.build;
const lists = (v: Values) => !!v.build || !!v.compact;

const WEIGHTS: Record<keyof Points, string> = {
    small: 'nagroda za 1% objetych malych (miara dla reszty, zwykle 1)',
    large: 'kara za duze w liscie, za 1% alokacji wszystkich malych; wiecej = mniej duzych',
    masks: 'kara za kazda maske INCLUDE; wiecej = krotsza lista, mniejsze pokrycie',
    exclude: 'kara za kazda maske EXCLUDE',
    risk: 'kara za duze, ktore maski obejmuja, a zdejmuje dopiero EXCLUDE (1% alokacji malych)',
    percent: 'kara za kazdy znak % w masce; wiecej = czesciej D* zamiast D%%%%%%',
    wild: 'kara za kazda * i ** w masce (bez koncowego .**)',
    start: 'kara za maske, ktora zaczyna sie od * albo **; wiecej = rzadziej takie maski',
};

/** Opcje po kolei, w grupach: wszystkie poza help, config i save-config. */
const GROUPS: [string, Field[]][] = [
    ['Dane', [
        { name: 'input', kind: 'text', value: null, doc: ['plik CSV z DCOLLECT; plik podany w wierszu polecen ma pierwszenstwo'] },
        { name: 'scope', kind: 'text', value: 'sms=true dsorg=PS', doc: ['ktore zbiory w ogole brac pod uwage; warunki po spacji = wszystkie naraz (AND)', 'np. "sms=true dsorg=PS sg=SGEAV*"'] },
        { name: 'when', kind: 'text', value: 'allocTrk=315 usedTrk<=3', doc: ['ktory zbior jest maly; pozostale z zakresu to duze'] },
        { name: 'prefix', kind: 'text', value: null, doc: ['poczatek kazdej maski, np. "ABC%.**"; null = dowolny'] },
        { name: 'unit', kind: 'text', value: 'GB', doc: ['jednostka alokacji w raportach: MB, GB, TB'] },
    ]],
    ['Tryb pracy: build albo compact albo check albo quals / try; wszystkie wylaczone = zwykle szukanie masek', [
        { name: 'build', kind: 'flag', value: false, doc: ['lista budowana maska po masce wg wag (weights)'] },
        { name: 'compact', kind: 'flag', value: false, doc: ['najmniej masek przy najwiekszym pokryciu (krzywa)'] },
        { name: 'check', kind: 'text', value: null, doc: ['plik FILTLIST (albo lista masek): test calej listy na danych i propozycje krotszej'] },
        { name: 'quals', kind: 'text', value: null, doc: ['zamiast masek: najczestsze kombinacje 1..N kwalifikatorow, N = 1-4'] },
        { name: 'try', kind: 'text', value: null, doc: ['zamiast masek: sprawdza podane kombinacje, np. "PROD+SYSOUT, TMP*"'] },
        { name: 'masks', kind: 'text', value: null, doc: ['plik z lista masek do sprawdzenia; nowe maski tylko dla zbiorow spoza niej'], fits: v => search(v) || combos(v) },
    ]],
    ['Granice', [
        { name: 'min-purity', kind: 'text', value: null, doc: ['najmniejsza czesc malych wsrod zbiorow maski, 0-1', 'null = 0.95 (compact: 0.5 przed EXCLUDE, quals i try: bez progu)'] },
        { name: 'min-count', kind: 'text', value: null, doc: ['ile co najmniej malych ma dac maska', 'null = 10 (compact: 0,5% malych)'], fits: v => !checked(v) },
        { name: 'max-masks', kind: 'text', value: 100, doc: ['najwiecej masek (build i compact: INCLUDE i EXCLUDE razem, najwyzej 255)'] },
        { name: 'max-large', kind: 'text', value: '5%', doc: ['ile duzych moze zostac w liscie: % alokacji objetych malych albo np. "200GB" (build, compact, check)'], fits: v => lists(v) || checked(v) },
        { name: 'time', kind: 'text', value: 600, doc: ['limit czasu w sekundach; potem wynik czesciowy (build, compact, quals)'], fits: v => lists(v) || combos(v) },
    ]],
    ['EXCLUDE', [
        { name: 'exclude', kind: 'flag', value: false, doc: ['maski EXCLUDE do znalezionych masek (zwykle szukanie i masks; build i compact dobieraja je same)'], fits: search },
        { name: 'exclude-min', kind: 'text', value: 2, doc: ['ile co najmniej duzych ma wylaczyc maska EXCLUDE'] },
        { name: 'exclude-gain', kind: 'text', value: null, doc: ['jaka czesc alokacji objetych duzych ma wylaczyc EXCLUDE; null = 0.5% (z exclude i compact)'], fits: v => !!v.compact || (search(v) && !!v.exclude) },
        { name: 'exclude-loss', kind: 'text', value: null, doc: ['jaka czesc objetych malych moga razem zabrac EXCLUDE', 'null = 1% (build, compact, check) albo 0% (exclude)'], fits: v => lists(v) || checked(v) || (search(v) && !!v.exclude) },
    ]],
    ['build: maska po masce', [
        { name: 'weights', kind: 'weights', value: null, doc: ['priorytety (build, check); 1 punkt = 1% malych przy small = 1'], fits: v => build(v) || checked(v) },
        { name: 'next', kind: 'text', value: null, doc: ['plik FILTLIST, do ktorego kazdy przebieg dopisuje kolejna maske dla zbiorow jeszcze nie objetych', 'null = cala lista od nowa'], fits: build },
        { name: 'steps', kind: 'text', value: 1, doc: ['z next: ile masek w jednym przebiegu; "max" = do konca'], fits: v => build(v) && v.next !== undefined && !v.ask },
        { name: 'beam', kind: 'text', value: 8, doc: ['ile wersji maski naraz; wiecej = dluzej'], fits: build },
        { name: 'rounds', kind: 'text', value: 2, doc: ['ile razy najwyzej druga runda, czyli maski budowane od nowa (nie z next)'], fits: v => build(v) && v.next === undefined },
        { name: 'ask', kind: 'flag', value: false, doc: ['pytanie po kazdej masce'], fits: build },
        { name: 'what-if', kind: 'flag', value: false, doc: ['takze wyniki dla zmienionych wag (7 razy dluzej; nie z next)'], fits: v => build(v) && v.next === undefined },
        { name: 'log', kind: 'text', value: null, doc: ['plik na dziennik krokow; null = na ekran'], fits: build },
    ]],
    ['compact', [
        { name: 'pick', kind: 'text', value: null, doc: ['punkt krzywej: najwyzej N masek albo "max"; null = najmniej masek z pokryciem od 95% najwiekszego'], fits: v => !!v.compact },
        { name: 'any-start', kind: 'flag', value: false, doc: ['INCLUDE moze zaczynac sie od ** i *'], fits: v => !!v.compact },
    ]],
    ['Ksztalt masek, quals i try', [
        { name: 'wild', kind: 'text', value: 3, doc: ['ile * i ** w masce (nie w build i check)'], fits: v => !build(v) && !checked(v) },
        { name: 'partial', kind: 'text', value: 3, doc: ['ile znakow stalych ma miec kwalifikator niepelny (ABC*), 2-7; 0 = tylko pelne (build, quals, try)'], fits: v => build(v) || combos(v) },
        { name: 'top', kind: 'text', value: 20, doc: ['wierszy w kazdej tabeli (quals)'], fits: combos },
    ]],
    ['Wyniki', [
        { name: 'verify', kind: 'text', value: null, doc: ['drugi CSV (np. nowszy) do sprawdzenia listy (build, compact)'], fits: lists },
        { name: 'out', kind: 'text', value: null, doc: ['CSV z maskami'] },
        { name: 'filtlist', kind: 'text', value: null, doc: ['FILTLIST do rutyny ACS, za kazdym razem od nowa (nie z next, quals, try)'], fits: v => !combos(v) && !(build(v) && v.next !== undefined) },
        { name: 'apply', kind: 'text', value: null, doc: ['z check: propozycje wprowadzane do filtlist i tests: "safe" = bez strat (null), "all", N = pierwsze N, 0 = zadnej'], fits: v => checked(v) && (v.filtlist !== undefined || v.tests !== undefined) },
        { name: 'tests', kind: 'text', value: null, doc: ['testy ISMF do masek, wejscie IEBUPDTE (nie z quals i try)'], fits: v => !combos(v) },
        { name: 'per-mask', kind: 'text', value: 1, doc: ['testow kazdego rodzaju na maske'] },
        { name: 'test-prefix', kind: 'text', value: 'ACM', doc: ['prefiks memberow testow, 1-4 litery'] },
    ]],
];

const FIELDS = GROUPS.flatMap(([, f]) => f);
const MODES = ['build', 'compact', 'check', 'quals', 'try'];
/** nazwy opcji w pliku (bez input to dokladnie opcje wiersza polecen) */
export const CONFIG_NAMES = FIELDS.map(f => f.name);

/** Komentarze i przecinki przed nawiasem zamykajacym zamienione na spacje (te same pozycje). */
function plainJson(text: string): string {
    const blank = (t: string) => t.replace(/[^\n]/g, ' ');
    return text.replace(/"(?:[^"\\\n]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, t => (t[0] === '"' ? t : blank(t)))
        .replace(/"(?:[^"\\\n]|\\.)*"|,(?=\s*[}\]])/g, t => (t[0] === '"' ? t : ' '));
}

/** Pola z pliku; null = nieustawione. */
export function readConfig(file: string): Values {
    const text = plainJson(fs.readFileSync(file, 'utf-8').replace(/^\ufeff/, ' '));
    const fail = (msg: string) => new ConfigError(`${file}: ${msg}`);
    const SLASH = 'w sciezkach pisz / albo \\\\ zamiast \\';
    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch (e) {
        const { message } = e as Error;
        const at = /position (\d+)/.exec(message);
        const where = at ? ` (wiersz ${text.slice(0, Number(at[1])).split('\n').length})` : '';
        throw fail(`niepoprawny JSON${where}: ${message}${/escaped character/i.test(message) ? `; ${SLASH}` : ''}`);
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) throw fail('oczekiwano obiektu { ... }');
    const out: Values = {};
    for (const [name, v] of Object.entries(data)) {
        const f = FIELDS.find(x => x.name === name);
        if (!f) throw fail(`nieznane pole "${name}" (dozwolone: ${CONFIG_NAMES.join(' ')})`);
        if (v === null) continue;
        // "C:\temp" to tabulator i "emp"
        if (typeof v === 'string' && /[\x00-\x1f]/.test(v)) throw fail(`"${name}": niedozwolony znak; ${SLASH}`);
        if (f.kind === 'flag') {
            if (typeof v !== 'boolean') throw fail(`"${name}": oczekiwano true albo false`);
            out[name] = v;
        } else if (f.kind === 'weights' && typeof v === 'object' && !Array.isArray(v)) {
            const list = Object.entries(v as object).filter(([, x]) => x !== null);
            for (const [k, x] of list) {
                if (!Object.hasOwn(POINTS, k)) throw fail(`weights: nieznana waga "${k}" (dozwolone: ${Object.keys(POINTS).join(' ')})`);
                if (typeof x !== 'number' || x < 0) throw fail(`weights: "${k}" - oczekiwano liczby od 0`);
            }
            out[name] = list.map(([k, x]) => `${k}=${x}`).join(' ');
        } else if (typeof v === 'string' || typeof v === 'number') {
            out[name] = String(v);
        } else {
            throw fail(`"${name}": oczekiwano ${f.kind === 'weights' ? 'obiektu z wagami' : 'tekstu albo liczby'}`);
        }
    }
    return out;
}

/**
 * Opcje z wiersza polecen i z pliku. Tryb podany w wierszu polecen zastepuje tryb z pliku; pola z pliku, ktore nie dotycza
 * trybu, odpadaja (skipped: ustawione inaczej niz domyslnie; all: razem z nimi, do zapisu). Wagi z wiersza polecen zmieniaja tylko podane.
 */
export function mergeConfig(cli: Values, file: Values): { values: Values; all: Values; skipped: string[] } {
    const ownMode = MODES.some(m => cli[m] !== undefined);
    const all: Values = { ...file };
    if (ownMode) for (const m of MODES) delete all[m];
    for (const [k, v] of Object.entries(cli)) if (v !== undefined) all[k] = k === 'weights' && file.weights ? `${file.weights} ${v}` : v;
    const out: Values = { ...all };
    const skipped: string[] = [];
    for (const f of FIELDS) {
        if (all[f.name] === undefined || cli[f.name] !== undefined || !f.fits || f.fits(all)) continue;
        delete out[f.name];
        // wartosc domyslna, jak w pliku zapisanym przez skrypt, nic nie znaczy; wagi sa tam zawsze
        if (!ownMode && f.kind !== 'weights' && String(all[f.name]) !== String(f.value)) skipped.push(f.name);
    }
    return { values: out, all, skipped };
}

/** Plik ustawien: kazde pole z komentarzem; v = obecne wartosci, weights = obecne wagi. */
export function configText(v: Values, weights: Points): string {
    const out = ['// Ustawienia acs-masks-auto.cjs.  Uruchomienie: node acs-masks-auto.cjs --config ten_plik',
        '// Opcja w wierszu polecen ma pierwszenstwo przed plikiem. null = wartosc domyslna.',
        '// Pola, ktore nie dotycza trybu pracy, sa pomijane. W sciezkach pisz / albo \\\\ zamiast \\.', '{'];
    const value = (f: Field): unknown => {
        const x = v[f.name];
        if (x === undefined) return f.value;
        // liczby bez cudzyslowow
        return typeof x === 'string' && typeof f.value !== 'string' && String(Number(x)) === x && /^[0-9.]+$/.test(x) ? Number(x) : x;
    };
    const last = FIELDS[FIELDS.length - 1];
    for (const [title, fields] of GROUPS) {
        out.push(...(out[out.length - 1] === '{' ? [] : ['']), `  // ---- ${title}`);
        for (const f of fields) {
            out.push('', ...f.doc.map(d => `  // ${d}`));
            const end = f === last ? '' : ',';
            if (f.kind !== 'weights') {
                out.push(`  ${JSON.stringify(f.name)}: ${JSON.stringify(value(f))}${end}`);
                continue;
            }
            const keys = Object.keys(POINTS) as (keyof Points)[];
            out.push(`  "${f.name}": {`);
            keys.forEach((k, i) => out.push(`    // ${WEIGHTS[k]} (domyslnie ${POINTS[k]})`, `    "${k}": ${weights[k]}${i < keys.length - 1 ? ',' : ''}`));
            out.push(`  }${end}`);
        }
    }
    out.push('}');
    return out.join('\n') + '\n';
}
