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
import { Interner, IntList, PairMap, Tick } from './auto-util';
import { parseMask } from './mask';

const DOT = 46;
const PCT = 37;
const STAR = 42;
/** krawedz '**' w drzewie masek (wzorce kwalifikatorow maja numery od 1) */
const ANY_QUALS = 0;
/** ile masek wymienia powod zbednosci */
const MAX_NOTE = 4;

export class MaskListError extends Error {}

export interface MaskList {
    masks: string[];
    warnings: string[];
}

/**
 * Lista masek z pliku: po jednej w linii albo po przecinku (wnetrze INCLUDE), w CSV pierwsza kolumna (plik z --out).
 * Pelna nazwa moze byc w apostrofach; komentarze jak w ACS. Powtorzone maski sa pomijane z ostrzezeniem.
 */
export function parseMaskList(text: string, file: string): MaskList {
    const masks: string[] = [];
    const warnings: string[] = [];
    const seen = new Set<string>();
    // komentarz zamieniony na same konce linii, zeby zgadzaly sie numery wierszy
    const clean = text.replace(/^﻿/, '').replace(/\/\*[\s\S]*?\*\//g, c => c.replace(/[^\n]/g, ' '));
    clean.split(/\r?\n/).forEach((line, i) => {
        const fail = (msg: string) => new MaskListError(`${file}, wiersz ${i + 1}: ${msg}`);
        const csv = line.includes(';');
        if (/^T;DSN;/i.test(line)) throw fail('to CSV z DCOLLECT, a nie lista masek');
        const items = csv ? [line.split(';')[0]] : line.split(/[\s,]+/);
        for (const item of items.map(x => x.trim()).filter(Boolean)) {
            if (csv && item.toLowerCase() === 'maska') continue;
            const quoted = /^'(.*)'$/.exec(item);
            if (quoted && /[*%]/.test(quoted[1])) throw fail(`${item} - w apostrofach to pelna nazwa; maske podaj bez apostrofow`);
            let mask: string;
            try {
                mask = parseMask(quoted ? quoted[1] : item).text;
            } catch (e) {
                throw fail((e as Error).message);
            }
            if (/^[0-9]/.test(mask)) throw fail(`"${mask}" - nazwa zbioru nie zaczyna sie cyfra`);
            if (seen.has(mask)) warnings.push(`${file}, wiersz ${i + 1}: maska ${mask} powtorzona`);
            else masks.push(mask);
            seen.add(mask);
        }
    });
    if (masks.length === 0) throw new MaskListError(`${file}: brak masek`);
    return { masks, warnings };
}

/** Lista masek jako drzewo kwalifikatorow; kwalifikatory z * i % - drzewo znakow. */
export class MaskTree {
    /** (wezel znakow, bajt) -> wezel; na koncu wzorca jego numer */
    private readonly chars = new PairMap();
    private readonly charLeaf = new IntList();
    /** (wezel masek, wzorzec) -> wezel; na koncu maski ich numery */
    private readonly child = new PairMap();
    private readonly ends: number[][] = [[]];
    private readonly stamp: Int32Array;
    private round = 0;
    private readonly pats = new IntList();
    private readonly qs = new Int32Array(256);
    private readonly qe = new Int32Array(256);
    private readonly from = new Int32Array(256);
    private readonly to = new Int32Array(256);
    private out: number[] = [];

    constructor(masks: string[][]) {
        this.charLeaf.push(0);
        this.stamp = new Int32Array(masks.length);
        const ids = new Map<string, number>([['**', ANY_QUALS]]);
        masks.forEach((quals, m) => {
            let node = 0;
            quals.forEach((q, i) => {
                // ** po ** nic nie zmienia
                if (q === '**' && quals[i - 1] === '**') return;
                let id = ids.get(q);
                if (id === undefined) {
                    ids.set(q, id = ids.size);
                    this.addPattern(q, id);
                }
                let x = this.child.get(node, id);
                if (x < 0) {
                    x = this.ends.length;
                    this.ends.push([]);
                    this.child.set(node, id, x);
                }
                node = x;
            });
            this.ends[node].push(m);
        });
    }

    private addPattern(q: string, id: number): void {
        let node = 0;
        for (let i = 0; i < q.length; i++) {
            let x = this.chars.get(node, q.charCodeAt(i));
            if (x < 0) {
                x = this.charLeaf.n;
                this.charLeaf.push(0);
                this.chars.set(node, q.charCodeAt(i), x);
            }
            node = x;
        }
        this.charLeaf.a[node] = id;
    }

    /** Wzorce pasujace do kwalifikatora buf[p..e). */
    private patterns(buf: Uint8Array, p: number, e: number, node: number): void {
        const star = this.chars.get(node, STAR);
        if (star >= 0) for (let k = p; k <= e; k++) this.patterns(buf, k, e, star);
        if (p === e) {
            if (this.charLeaf.a[node]) this.pats.push(this.charLeaf.a[node]);
            return;
        }
        const any = this.chars.get(node, PCT);
        if (any >= 0) this.patterns(buf, p + 1, e, any);
        const same = this.chars.get(node, buf[p]);
        if (same >= 0) this.patterns(buf, p + 1, e, same);
    }

    private walk(buf: Uint8Array, node: number, i: number, n: number): void {
        const more = this.child.get(node, ANY_QUALS);
        if (more >= 0) for (let k = i; k <= n; k++) this.walk(buf, more, k, n);
        if (i === n) {
            for (const m of this.ends[node]) {
                if (this.stamp[m] === this.round) continue;
                this.stamp[m] = this.round;
                this.out.push(m);
            }
            return;
        }
        if (this.from[i] < 0) {
            this.from[i] = this.pats.n;
            if (this.qs[i] < this.qe[i]) this.patterns(buf, this.qs[i], this.qe[i], 0);
            this.to[i] = this.pats.n;
        }
        for (let y = this.from[i]; y < this.to[i]; y++) {
            const x = this.child.get(node, this.pats.a[y]);
            if (x >= 0) this.walk(buf, x, i + 1, n);
        }
    }

    /** Numery masek pasujacych do nazwy buf[s..e), rosnaco; tablica wazna do nastepnego wywolania. */
    match(buf: Uint8Array, s: number, e: number): number[] {
        this.round++;
        this.pats.n = 0;
        this.out = [];
        let n = 0;
        let b = s;
        for (let p = s; p <= e; p++) {
            if (p < e && buf[p] !== DOT) continue;
            this.qs[n] = b;
            this.qe[n] = p;
            this.from[n++] = -1;
            b = p + 1;
        }
        this.walk(buf, 0, 0, n);
        return this.out.length > 1 ? this.out.sort((x, y) => x - y) : this.out;
    }
}

interface Nfa {
    /** przejscia: znak, '.' albo null = dowolny znak kwalifikatora */
    edges: { on: string | null; to: number }[][];
    eps: number[][];
    end: number;
}

/** Maska jako automat na nazwie z kropka po kazdym kwalifikatorze (A.B -> "A.B."). */
function nfa(quals: string[]): Nfa {
    const edges: Nfa['edges'] = [];
    const eps: number[][] = [];
    const add = (): number => {
        edges.push([]);
        eps.push([]);
        return edges.length - 1;
    };
    let s = add();
    const next = (on: string | null) => {
        const t = add();
        edges[s].push({ on, to: t });
        s = t;
    };
    const loop = () => {
        const t = add();
        eps[s].push(t);
        s = t;
    };
    for (const q of quals) {
        if (q === '**') {
            loop();
            const u = add();
            edges[s].push({ on: null, to: u });
            edges[u].push({ on: null, to: u }, { on: '.', to: s });
            loop();
            continue;
        }
        if (q === '*') next(null);
        for (const c of q) {
            if (c === '*') {
                loop();
                edges[s].push({ on: null, to: s });
                loop();
            } else {
                next(c === '%' ? null : c);
            }
        }
        next('.');
    }
    return { edges, eps, end: s };
}

function closure(a: Nfa, states: Iterable<number>): number[] {
    const seen = new Set<number>(states);
    for (const s of seen) for (const t of a.eps[s]) seen.add(t);
    return [...seen].sort((x, y) => x - y);
}

/** Czy kazda nazwa pasujaca do maski a pasuje tez do b (bez danych: porownanie samych masek). */
export function within(a: string[], b: string[]): boolean {
    const na = nfa(a);
    const nb = nfa(b);
    // znaki, ktore rozroznia b; '\0' = kazdy inny
    const letters = new Set(['\0']);
    for (const l of nb.edges) for (const x of l) if (x.on !== null && x.on !== '.') letters.add(x.on);
    const start = closure(nb, [0]);
    // stany poczatkowe poza seen: pusta nazwa (** bez kwalifikatorow) sie nie liczy
    const todo = closure(na, [0]).map(s => ({ s, set: start, empty: true }));
    const seen = new Set<string>();
    while (todo.length) {
        const { s, set, empty } = todo.pop()!;
        if (!empty && s === na.end && !set.includes(nb.end)) return false;
        for (const x of na.edges[s]) {
            for (const c of x.on === null ? letters : [x.on]) {
                const to = new Set<number>();
                for (const t of set) {
                    for (const y of nb.edges[t]) if (y.on === c || (y.on === null && c !== '.')) to.add(y.to);
                }
                const after = closure(nb, to);
                for (const t of closure(na, [x.to])) {
                    const key = `${t}|${after}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    todo.push({ s: t, set: after, empty: false });
                }
            }
        }
    }
    return true;
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

export function checkMasks(input: CheckInput, masks: string[], tick: Tick): CheckResult {
    const { names, allocKb, pos, neg } = input;
    const quals = masks.map(m => parseMask(m).quals);
    const tree = new MaskTree(quals);

    // ---- grupy zbiorow o tym samym zestawie masek
    const single: (Group | undefined)[] = [];
    const multi = new Map<string, Group>();
    const empty = (ids: number[]): Group => ({ ids, small: 0, large: 0, smallKb: 0, largeKb: 0 });
    const groupOf = (row: number): Group | null => {
        const s = names.start[row];
        const ids = tree.match(names.pool, s, s + names.len[row]);
        if (ids.length === 0) return null;
        if (ids.length === 1) return single[ids[0]] ??= empty(ids);
        const key = ids.join();
        let g = multi.get(key);
        if (!g) multi.set(key, g = empty(ids));
        return g;
    };
    const count = pos.length + neg.length;
    let smallKb = 0;
    for (let x = 0; x < pos.length; x++) {
        if ((x & 0x3fff) === 0) tick(x / count);
        smallKb += allocKb[pos[x]];
        const g = groupOf(pos[x]);
        if (!g) continue;
        g.small++;
        g.smallKb += allocKb[pos[x]];
    }
    for (let x = 0; x < neg.length; x++) {
        if ((x & 0x3fff) === 0) tick((pos.length + x) / count);
        const g = groupOf(neg[x]);
        if (!g) continue;
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
