/**
 * Sprawdzenie gotowej listy masek na danych: ile malych i duzych zbiorow obejmuje kazda maska i wszystkie razem,
 * ktore maski sa zbedne i ktore sie nakladaja.
 *
 *   zbedna     - bez niej pozostale maski obejmuja te same male zbiory; powody:
 *                zawiera sie w innej masce (kazda nazwa, takze przyszla) / w danych obejmuja ja inne maski /
 *                nie obejmuje zadnego malego zbioru
 *   do usuniecia - maski zbedne, ktore mozna usunac naraz (od najnizszej czystosci); reszta zbednych ("zamiast")
 *                po tym usunieciu jest potrzebna
 * Nazwa jest porownywana z cala lista naraz (drzewo masek), wiec czas prawie nie zalezy od liczby masek.
 */
import { MaskRow } from './auto-mine';
import { MaskTree, within } from './auto-tree';
import { Interner, IntList, Tick } from './auto-util';
import { parseMask } from './mask';

/** ile masek wymienia powod zbednosci */
const MAX_NOTE = 4;

export class MaskListError extends Error {}

export interface MaskList {
    masks: string[];
    /** maski EXCLUDE: z FILTLIST albo z CSV (stan "exclude") */
    excludes: string[];
    warnings: string[];
}

/**
 * Lista masek z pliku: po jednej w linii albo po przecinku (wnetrze INCLUDE), FILTLIST z INCLUDE i EXCLUDE (plik
 * z --filtlist), w CSV pierwsza kolumna (plik z --out). Pelna nazwa moze byc w apostrofach; komentarze jak w ACS.
 * Powtorzone maski sa pomijane z ostrzezeniem.
 */
export function parseMaskList(text: string, file: string): MaskList {
    const masks: string[] = [];
    const excludes: string[] = [];
    const warnings: string[] = [];
    // komentarz zamieniony na same konce linii, zeby zgadzaly sie numery wierszy
    const clean = text.replace(/^\ufeff/, '').replace(/\/\*[\s\S]*?\*\//g, c => c.replace(/[^\n]/g, ' '));
    const fail = (i: number, msg: string) => new MaskListError(`${file}, wiersz ${i + 1}: ${msg}`);
    const parse = (item: string, i: number): string => {
        const quoted = /^'(.*)'$/.exec(item);
        if (quoted && /[*%]/.test(quoted[1])) throw fail(i, `${item} - w apostrofach to pelna nazwa; maske podaj bez apostrofow`);
        let mask: string;
        try {
            mask = parseMask(quoted ? quoted[1] : item).text;
        } catch (e) {
            throw fail(i, (e as Error).message);
        }
        if (/^[0-9]/.test(mask)) throw fail(i, `"${mask}" - nazwa zbioru nie zaczyna sie cyfra`);
        return mask;
    };
    const add = (into: string[], mask: string, i: number) => {
        if (into.includes(mask)) warnings.push(`${file}, wiersz ${i + 1}: maska ${mask} powtorzona`);
        else into.push(mask);
    };
    const lines = clean.split(/\r?\n/);
    if (/(^|\s)(INCLUDE|EXCLUDE)\s*\(/i.test(clean)) {
        parseFiltlists(lines, fail).forEach((list, k) => {
            list.include.forEach(x => add(masks, parse(x.item, x.line), x.line));
            // EXCLUDE dziala tylko w swojej liscie; wspolne dla calego pliku jest tylko takie samo w kazdej
            const own: string[] = [];
            list.exclude.forEach(x => add(own, parse(x.item, x.line), x.line));
            if (k === 0) excludes.push(...own);
            else if (own.length !== excludes.length || own.some(x => !excludes.includes(x))) throw fail(list.line, 'FILTLIST maja rozne EXCLUDE - sprawdz kazda osobno');
        });
    } else {
        let state = -1;
        lines.forEach((line, i) => {
            if (/^T;DSN;/i.test(line)) throw fail(i, 'to CSV z DCOLLECT, a nie lista masek');
            if (!line.includes(';')) {
                line.split(/[\s,]+/).filter(Boolean).forEach(item => add(masks, parse(item, i), i));
                return;
            }
            const cols = line.split(';').map(x => x.trim());
            if (cols[0].toLowerCase() === 'maska') state = cols.indexOf('stan');
            else if (cols[0]) add(state >= 0 && cols[state] === 'exclude' ? excludes : masks, parse(cols[0], i), i);
        });
    }
    if (masks.length === 0) throw new MaskListError(`${file}: brak masek`);
    return { masks, excludes, warnings };
}

interface Entry {
    item: string;
    line: number;
}

/** FILTLIST nazwa INCLUDE(...) EXCLUDE(...), dowolnie wiele; bez innych instrukcji rutyny. */
function parseFiltlists(lines: string[], fail: (line: number, msg: string) => Error): { line: number; include: Entry[]; exclude: Entry[] }[] {
    const lists: { line: number; include: Entry[]; exclude: Entry[] }[] = [];
    let section: Entry[] | null = null;
    let expect: 'name' | '(' | null = null;
    lines.forEach((text, line) => {
        // + i - na koncu linii: kontynuacja
        for (const tok of text.replace(/\s[+-]\s*$/, '').match(/[(),]|'[^']*'|[^\s(),]+/g) ?? []) {
            const word = tok.toUpperCase();
            if (expect === 'name') {
                expect = null;
            } else if (expect === '(') {
                if (tok !== '(') throw fail(line, `oczekiwano "(", jest "${tok}"`);
                expect = null;
            } else if (section) {
                if (tok === ')') section = null;
                else if (tok === '(') throw fail(line, 'brak ")" przed "("');
                else if (tok !== ',') section.push({ item: tok, line });
            } else if (word === 'FILTLIST') {
                lists.push({ line, include: [], exclude: [] });
                expect = 'name';
            } else if (word === 'INCLUDE' || word === 'EXCLUDE') {
                // sam INCLUDE(...) bez FILTLIST
                if (lists.length === 0) lists.push({ line, include: [], exclude: [] });
                section = lists[lists.length - 1][word === 'INCLUDE' ? 'include' : 'exclude'];
                expect = '(';
            } else {
                throw fail(line, `"${tok}" - plik moze zawierac tylko FILTLIST`);
            }
        }
    });
    if (section) throw fail(lines.length - 1, 'brak ")"');
    return lists;
}

/** Zbiory objete dokladnie tymi samymi maskami. */
interface Group {
    ids: number[];
    small: number;
    large: number;
    smallKb: number;
    largeKb: number;
}

export interface CheckRow extends MaskRow {
    /** male zbiory, ktorych nie obejmuje zadna inna maska z listy */
    only: number;
    /** pusty = maska potrzebna */
    note: string;
    /** usun = mozna usunac razem z innymi "usun"; zamiast = zbedna tylko, gdy tamte zostana */
    state: '' | 'usun' | 'zamiast';
}

export interface Overlap {
    a: string;
    b: string;
    small: number;
    large: number;
    /** czesc malych zbiorow maski a / b (0-1) */
    partA: number;
    partB: number;
}

export interface CheckResult {
    small: number;
    large: number;
    smallKb: number;
    rows: CheckRow[];
    /** wszystkie maski razem, kazdy zbior raz */
    total: MaskRow;
    /** jak total, bez masek "usun" */
    after: MaskRow;
    /** pary masek ze wspolnymi zbiorami, od najwiekszej liczby malych */
    overlaps: Overlap[];
    /** wiersze zbiorow, ktorych nie obejmuje zadna maska (bez wylaczonych przez EXCLUDE) */
    rest: { pos: Int32Array; neg: Int32Array };
    /** maski EXCLUDE: zbiory, ktore odbieraja maskom INCLUDE (poza tym raportem) */
    excludes: MaskRow[];
}

export interface CheckInput {
    names: Interner;
    allocKb: Float64Array;
    pos: Int32Array;
    neg: Int32Array;
}

const purityOf = (small: number, large: number) => (small ? small / (small + large) : 0);

function sumUp(text: string, groups: Group[]): MaskRow {
    const r: MaskRow = { text, small: 0, large: 0, purity: 0, smallKb: 0, largeKb: 0 };
    for (const g of groups) {
        r.small += g.small;
        r.large += g.large;
        r.smallKb += g.smallKb;
        r.largeKb += g.largeKb;
    }
    r.purity = purityOf(r.small, r.large);
    return r;
}

export function checkMasks(input: CheckInput, masks: string[], excludes: string[], tick: Tick): CheckResult {
    const { names, allocKb, pos, neg } = input;
    const quals = masks.map(m => parseMask(m).quals);
    const tree = new MaskTree(quals);
    const exTree = excludes.length ? new MaskTree(excludes.map(m => m.split('.'))) : null;
    const exRows = excludes.map((text): MaskRow => ({ text, small: 0, large: 0, purity: 0, smallKb: 0, largeKb: 0 }));

    // ---- grupy zbiorow o tym samym zestawie masek
    const single: (Group | undefined)[] = [];
    const multi = new Map<string, Group>();
    const empty = (ids: number[]): Group => ({ ids, small: 0, large: 0, smallKb: 0, largeKb: 0 });
    const groupOf = (row: number, isSmall: boolean): Group | null | 'excluded' => {
        const s = names.start[row];
        const ids = tree.match(names.pool, s, s + names.len[row]);
        const out = exTree?.match(names.pool, s, s + names.len[row]) ?? [];
        if (out.length) {
            for (const x of ids.length ? out : []) {
                exRows[x][isSmall ? 'small' : 'large']++;
                exRows[x][isSmall ? 'smallKb' : 'largeKb'] += allocKb[row];
            }
            return 'excluded';
        }
        if (ids.length === 0) return null;
        if (ids.length === 1) return single[ids[0]] ??= empty(ids);
        const key = ids.join();
        let g = multi.get(key);
        if (!g) multi.set(key, g = empty(ids));
        return g;
    };
    const count = pos.length + neg.length;
    let smallKb = 0;
    const restPos = new IntList();
    const restNeg = new IntList();
    for (let x = 0; x < pos.length; x++) {
        if ((x & 0x3fff) === 0) tick(x / count);
        smallKb += allocKb[pos[x]];
        const g = groupOf(pos[x], true);
        if (g === 'excluded') continue;
        if (!g) {
            restPos.push(pos[x]);
            continue;
        }
        g.small++;
        g.smallKb += allocKb[pos[x]];
    }
    for (let x = 0; x < neg.length; x++) {
        if ((x & 0x3fff) === 0) tick((pos.length + x) / count);
        const g = groupOf(neg[x], false);
        if (g === 'excluded') continue;
        if (!g) {
            restNeg.push(neg[x]);
            continue;
        }
        g.large++;
        g.largeKb += allocKb[neg[x]];
    }
    const groups = [...single.filter(g => g !== undefined), ...multi.values()];
    const of: Group[][] = masks.map(() => []);
    for (const g of groups) for (const m of g.ids) of[m].push(g);

    const rows = masks.map((text, m): CheckRow => ({ ...sumUp(text, of[m]), only: single[m]?.small ?? 0, note: '', state: '' }));

    // ---- zawieranie: w danych kazdy zbior maski m obejmuje tez b, a potem porownanie samych masek
    const inside = masks.map((_, m): number[] => {
        const cand = of[m].length ? of[m].reduce((s, g) => s.filter(b => g.ids.includes(b)), of[m][0].ids) : masks.map((_x, b) => b);
        return cand.filter(b => b !== m && within(quals[m], quals[b]));
    });

    // ---- zbedne: od najnizszej czystosci, przy rownej najpierw zawarte w innej, potem mniej malych, potem dalsze na liscie
    const left = masks.map(() => true);
    const cover = new Map<Group, number>(groups.map(g => [g, g.ids.length]));
    const needed = (m: number) => of[m].some(g => g.small > 0 && cover.get(g)! < 2);
    const spare = masks.map((_, m) => m).filter(m => !needed(m));
    spare.sort((a, b) => rows[a].purity - rows[b].purity || Number(inside[b].length > 0) - Number(inside[a].length > 0)
        || rows[a].small - rows[b].small || b - a);
    for (const m of spare) {
        if (needed(m)) {
            rows[m].state = 'zamiast';
            continue;
        }
        rows[m].state = 'usun';
        left[m] = false;
        for (const g of of[m]) cover.set(g, cover.get(g)! - 1);
    }
    for (const m of spare) {
        // powod usuniecia odwoluje sie do masek, ktore zostaja; "zamiast" - do wszystkich
        const refers = (b: number) => left[b] || left[m];
        const wider = inside[m].filter(refers).sort((a, b) => rows[b].small - rows[a].small || a - b);
        if (wider.length) rows[m].note = `zawiera sie w ${masks[wider[0]]}`;
        else if (of[m].length === 0) rows[m].note = 'nie pasuje do zadnego zbioru';
        else if (rows[m].small === 0) rows[m].note = `nie obejmuje malych zbiorow (duzych: ${rows[m].large})`;
        else {
            const by = coveredBy(m, of[m], refers).map(b => masks[b]);
            const more = by.length > MAX_NOTE ? ` i ${by.length - MAX_NOTE} innych` : '';
            rows[m].note = `w danych jej male zbiory obejmuja: ${by.slice(0, MAX_NOTE).join(', ')}${more}`;
        }
    }

    // ---- pary ze wspolnymi zbiorami
    const pairs = new Map<number, Overlap>();
    for (const g of groups) {
        for (let i = 0; i < g.ids.length; i++) {
            for (let j = i + 1; j < g.ids.length; j++) {
                const key = g.ids[i] * masks.length + g.ids[j];
                let o = pairs.get(key);
                if (!o) pairs.set(key, o = { a: masks[g.ids[i]], b: masks[g.ids[j]], small: 0, large: 0, partA: 0, partB: 0 });
                o.small += g.small;
                o.large += g.large;
            }
        }
    }
    for (const [key, o] of pairs) {
        o.partA = o.small / Math.max(1, rows[Math.floor(key / masks.length)].small);
        o.partB = o.small / Math.max(1, rows[key % masks.length].small);
    }
    const overlaps = [...pairs].sort(([ka, a], [kb, b]) => b.small - a.small || b.large - a.large || ka - kb).map(([, o]) => o);

    return {
        small: pos.length,
        large: neg.length,
        smallKb,
        rows,
        total: sumUp('RAZEM', groups),
        after: sumUp('RAZEM PO USUNIECIU', groups.filter(g => g.ids.some(m => left[m]))),
        overlaps,
        rest: { pos: restPos.a.slice(0, restPos.n), neg: restNeg.a.slice(0, restNeg.n) },
        excludes: exRows,
    };
}

/** Maski (poza m), ktore razem obejmuja male zbiory maski m - zachlannie, od obejmujacej najwiecej. */
function coveredBy(m: number, groups: Group[], allowed: (b: number) => boolean): number[] {
    let open = groups.filter(g => g.small > 0);
    const out: number[] = [];
    while (open.length) {
        const sum = new Map<number, number>();
        for (const g of open) for (const b of g.ids) if (b !== m && allowed(b)) sum.set(b, (sum.get(b) ?? 0) + g.small);
        const best = [...sum].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0][0];
        out.push(best);
        open = open.filter(g => !g.ids.includes(best));
    }
    return out;
}
