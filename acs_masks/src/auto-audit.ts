/**
 * Test calej FILTLIST na danych (--check): co obejmuje, co robia z nia duze zbiory i jak ja skrocic.
 *
 * Propozycje to kolejne kroki na tej samej liscie (kazdy liczony po poprzednich):
 *   usun     maska INCLUDE albo EXCLUDE
 *   scal     kilka masek zastapionych jedna szersza (uogolnienie dwoch masek z listy: A.X.** i A.Y.** -> A.**)
 *   zamien   maska, ktora obejmuje duze, zastapiona wezszymi (szukanymi w jej zbiorach) albo maskami z pierwotnej listy
 *   dodaj    maska EXCLUDE
 * Najpierw bez strat: zaden objety maly zbior nie wypada, zaden duzy nie wchodzi (w tych danych) i lista nie rosnie. Potem
 * wymiana: krok, ktory daje punkty wg wag --build, w granicach --max-large, --min-purity i --exclude-loss.
 *
 * Nazwy o tym samym zestawie pasujacych masek (z listy i kandydatow) sa liczone jako jedna grupa, wiec kolejne kroki nie
 * czytaja juz danych. Maski, ktore zastepuje scalona, musza sie w niej zawierac takze jako wzorce (nie tylko w danych).
 */
import { acsProblem, findExcludes } from './auto-acs';
import { MaskLists, Points, shapeCost } from './auto-build';
import { CheckInput, checkMasks } from './auto-check';
import { LargeLimit } from './auto-compact';
import { literalChars, MAX_LEN, mine, purityOf } from './auto-mine';
import { MaskTree, within } from './auto-tree';
import { thousands, Tick } from './auto-util';

/** najwiecej kandydatow do scalenia na raz, osobno INCLUDE i EXCLUDE */
const MAX_CAND = 1000;
/** ile razy najwyzej scalane sa maski juz scalone */
const ROUNDS = 4;
/** najmniej znakow stalych maski od * albo ** */
const MIN_LITERAL = 3;
/** najwiecej *, ** i kwalifikatorow z * w kandydacie, chyba ze maski, z ktorych powstal, maja wiecej */
const MAX_WILD = 3;
const MAX_NOTE = 4;
/** ile masek najwyzej zastepuje jedna (zamien) */
const MAX_SWAP = 3;
/** dla ilu masek z duzymi szukane sa wezsze i jaka najmniejsza czesc duzych listy maja obejmowac */
const MAX_DIRTY = 15;
const MIN_DIRTY = 0.01;
/** najwiecej zbiorow, w ktorych szukane sa wezsze maski jednej maski (wiecej = probka) */
const MAX_SAMPLE = 100_000;
const TINY = 1e-9;

export interface AuditOptions {
    weights: Points;
    maxLarge: LargeLimit;
    minPurity: number;
    loss: number;
    head: number;
    /** limit czasu propozycji (s): potem wynik czesciowy */
    seconds: number;
}

export interface Counts {
    small: number;
    large: number;
    smallKb: number;
    largeKb: number;
}

export interface AuditTotals extends Counts {
    include: number;
    exclude: number;
    /** objete INCLUDE, wylaczone przez EXCLUDE */
    lost: Counts;
}

export interface Fix {
    side: 'INCLUDE' | 'EXCLUDE';
    /** usun: puste; scal: jedna zamiast kilku; zamien: jedna albo kilka zamiast jednej; dodaj: remove puste */
    add: string[];
    remove: string[];
    note: string;
    points: number;
    /** zmiana liczby objetych malych i duzych: co wypada i co dochodzi */
    out: Counts;
    in: Counts;
    /** lista po tym kroku */
    after: AuditTotals;
    lists: MaskLists;
}

/** Scalenie, ktorego nie przepuszczaja duze. */
export interface Blocked {
    text: string;
    remove: string[];
    in: Counts;
    /** duze dochodzace tylko do INCLUDE, zdejmowane przez EXCLUDE */
    hidden: Counts;
}

export interface LargeRow {
    text: string;
    /** objete (INCLUDE) albo wylaczone (EXCLUDE) */
    all: Counts;
    /** tylko przez te maske */
    only: Counts;
}

export interface AuditResult {
    before: AuditTotals;
    /** objete dokladnie przez 1, 2, 3 i wiecej masek INCLUDE (po EXCLUDE) */
    depth: Counts[];
    include: LargeRow[];
    exclude: LargeRow[];
    /** lista bez masek INCLUDE, ktore obejmuja duze */
    pure: AuditTotals;
    /** bez strat, po kolei */
    safe: Fix[];
    /** dalsze, kosztem malych albo duzych */
    trade: Fix[];
    blocked: Blocked[];
    /** lista, gdyby duzych nie bylo (te same zasady, bez strat) */
    noLarge: MaskLists;
    /** przerwano po czasie: propozycje i test bez duzych moga byc niepelne */
    stopped: boolean;
}

const zero = (): Counts => ({ small: 0, large: 0, smallKb: 0, largeKb: 0 });
const add = (a: Counts, b: Counts) => {
    a.small += b.small;
    a.large += b.large;
    a.smallKb += b.smallKb;
    a.largeKb += b.largeKb;
};

// ---------------------------------------------------------------- uogolnienia

/** Kwalifikatory obejmujace oba (bez **), od najwezszych. */
function wider(x: string, y: string): string[] {
    if (x === y) return [x];
    if (x === '*' || y === '*') return ['*'];
    const out: string[] = [];
    if (!/\*/.test(x + y) && x.length === y.length) {
        const t = [...x].map((c, i) => (c === y[i] ? c : '%')).join('');
        if (/[^%]/.test(t)) out.push(t);
    }
    const fixed = (c: string | undefined) => c !== undefined && c !== '*' && c !== '%';
    const n = Math.min(x.length, y.length);
    let p = 0;
    while (p < n && x[p] === y[p] && fixed(x[p])) p++;
    let s = 0;
    while (s < n - p && x[x.length - 1 - s] === y[y.length - 1 - s] && fixed(x[x.length - 1 - s])) s++;
    const head = x.slice(0, p);
    const tail = s ? x.slice(-s) : '';
    if (p && s) out.push(`${head}*${tail}`);
    if (p) out.push(`${head}*`);
    if (!p && s > 1) out.push(`*${tail}`);
    out.push('*');
    return out.filter(q => q.length <= 8);
}

/** Wspolne kwalifikatory po kolei (najdluzszy wspolny podciag); pary pozycji. */
function common(a: string[], b: string[]): [number, number][] {
    const w = b.length + 1;
    const best = new Uint8Array((a.length + 1) * w);
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            best[i * w + j] = a[i] === b[j] && a[i] !== '**' ? best[(i + 1) * w + j + 1] + 1 : Math.max(best[(i + 1) * w + j], best[i * w + j + 1]);
        }
    }
    const out: [number, number][] = [];
    for (let i = 0, j = 0; i < a.length && j < b.length;) {
        if (a[i] === b[j] && a[i] !== '**') out.push([i++, j++]);
        else if (best[(i + 1) * w + j] >= best[i * w + j + 1]) i++;
        else j++;
    }
    return out;
}

/** Maski obejmujace obie maski. */
export function generalize(ta: string, tb: string): string[] {
    const a = ta.split('.');
    const b = tb.split('.');
    const out = new Set<string>();
    const put = (quals: string[]) => {
        const text = squeeze(quals).join('.');
        if (text !== '**' && text.length <= MAX_LEN) out.add(text);
    };
    // ---- te same miejsca: rozne kwalifikatory zastapione wzorcem
    if (a.length === b.length && a.every((x, i) => (x === '**') === (b[i] === '**'))) {
        const opts = a.map((x, i) => (x === '**' ? ['**'] : wider(x, b[i])));
        const most = Math.max(...opts.map(x => x.length));
        for (let k = 0; k < most; k++) put(opts.map(x => x[Math.min(k, x.length - 1)]));
    }
    // ---- wspolny poczatek i reszta dowolna
    const starts = a[0] === '**' || b[0] === '**' ? [] : wider(a[0], b[0]);
    for (const s of starts) {
        put([s, '**']);
        // dalsze wspolne kwalifikatory z ** (albo tyloma samymi *) w miejscu roznic
        const pairs = common(a.slice(1), b.slice(1));
        // odstepy jako tyle samo * albo zawsze ** (krotszy zapis, bez limitu *)
        const build = (until: number, loose: boolean) => {
            const quals = [s];
            let i = 0;
            let j = 0;
            for (const [x, y] of pairs.slice(0, until)) {
                quals.push(...(loose ? ['**'] : gap(a.slice(1 + i, 1 + x), b.slice(1 + j, 1 + y))), a[1 + x]);
                i = x + 1;
                j = y + 1;
            }
            const ga = a.slice(1 + i);
            const gb = b.slice(1 + j);
            put([...quals, ...gap(ga, gb)]);
            put([...quals, '**']);
            // wzorzec na nastepnym miejscu: PAY.LOGA.** i PAY.LOGB.X -> PAY.LOG*.**
            if (ga.length && gb.length && ga[0] !== '**' && gb[0] !== '**') for (const q of wider(ga[0], gb[0])) put([...quals, q, '**']);
        };
        for (let k = 0; k <= pairs.length; k++) for (const loose of [false, true]) build(k, loose);
    }
    // ---- jeden wspolny kwalifikator
    for (const q of a) {
        if (q.includes('*') || literalChars(q) < MIN_LITERAL || !b.includes(q)) continue;
        put(['**', q, '**']);
        if (a[a.length - 1] === q && b[b.length - 1] === q) put(['**', q]);
    }
    return [...out];
}

function gap(ga: string[], gb: string[]): string[] {
    if (ga.length === gb.length && !ga.includes('**') && !gb.includes('**')) return ga.map(() => '*');
    return ['**'];
}

/**
 * Ciag samych * i ** z choc jednym ** -> jedno ** (szersze, wiec nadal obejmuje obie maski): A.**.*.**.*.** to prawie A.**,
 * a takie maski pasuja do kazdej nazwy i bardzo spowalniaja porownanie.
 */
function squeeze(quals: string[]): string[] {
    const out: string[] = [];
    for (let i = 0; i < quals.length;) {
        let j = i;
        while (j < quals.length && (quals[j] === '*' || quals[j] === '**')) j++;
        if (j > i && quals.slice(i, j).includes('**')) {
            out.push('**');
            i = j;
        } else {
            out.push(quals[i++]);
        }
    }
    return out;
}

/** *, ** (poza koncowym) i kwalifikatory z * */
const wildOf = (text: string) => text.split('.').filter((q, i, a) => q.includes('*') && !(q === '**' && i === a.length - 1)).length;

function usable(text: string, parents: string[]): boolean {
    if (wildOf(text) > Math.max(MAX_WILD, ...parents.map(wildOf))) return false;
    if (acsProblem(text) || literalChars(text) === 0 || /^[0-9]/.test(text)) return false;
    const first = text.split('.')[0];
    // poczatek od * albo samych %: tylko z kwalifikatorem, ktory cos mowi
    if (/^[*%]/.test(first)) return literalChars(text) >= MIN_LITERAL;
    // A* z AB1 i AX2 to prawie wszystko
    return first.includes('*') || first.includes('%') ? literalChars(first) >= 2 || parents.every(p => literalChars(p.split('.')[0]) < 2) : true;
}

/** Kandydaci do scalenia z par masek: najpierw powstajacy z wielu par, potem o wiekszej liczbie znakow stalych. */
export function mergeCandidates(masks: string[], known: ReadonlySet<string>): string[] {
    const count = new Map<string, number>();
    for (let i = 0; i < masks.length; i++) {
        for (let j = i + 1; j < masks.length; j++) {
            for (const t of generalize(masks[i], masks[j])) {
                if (!known.has(t) && (count.has(t) || usable(t, [masks[i], masks[j]]))) count.set(t, (count.get(t) ?? 0) + 1);
            }
        }
    }
    return [...count].sort((a, b) => b[1] - a[1] || literalChars(b[0]) - literalChars(a[0]) || (a[0] < b[0] ? -1 : 1)).slice(0, MAX_CAND).map(([t]) => t);
}

// ---------------------------------------------------------------- lista na danych

interface Item {
    text: string;
    inc: boolean;
    on: boolean;
    groups: number[];
    shape: number;
}

interface Group extends Counts {
    /** numery masek: INCLUDE i EXCLUDE, z listy i kandydaci */
    ids: Int32Array;
    inc: number;
    exc: number;
}

interface Move {
    add: number[];
    remove: number[];
    out: Counts;
    in: Counts;
    points: number;
}

class Model {
    readonly items: Item[] = [];
    readonly groups: Group[] = [];
    private readonly np: number;
    private allKb = 0;
    private readonly nested = new Map<number, boolean>();
    /** zmiana liczby masek grupy w liczonym ruchu */
    private readonly delta: Int32Array;

    /** extra: kandydaci poza scaleniami (wezsze maski, maski pierwotnej listy, nowe EXCLUDE) */
    constructor(input: CheckInput, lists: MaskLists, extra: MaskLists, private readonly opt: AuditOptions, private readonly known: Set<string>, tick: Tick) {
        const { weights } = opt;
        const put = (text: string, inc: boolean, on: boolean) => this.items.push({
            text, inc, on, groups: [], shape: shapeCost(text, inc ? weights : { ...weights, start: 0 }, opt.head),
        });
        lists.include.forEach(t => put(t, true, true));
        lists.exclude.forEach(t => put(t, false, true));
        const off = (own: string[], more: string[], inc: boolean) => {
            const merge = mergeCandidates(own, new Set(own));
            for (const t of new Set([...merge, ...more.filter(x => !own.includes(x))])) put(t, inc, false);
        };
        off(lists.include, extra.include, true);
        off(lists.exclude, extra.exclude, false);
        for (const x of this.items) known.add(`${x.inc}${x.text}`);

        const { names, allocKb, pos, neg } = input;
        this.np = pos.length;
        const tree = new MaskTree(this.items.map(x => x.text.split('.')));
        const byKey = new Map<number, Group>();
        const total = pos.length + neg.length;
        const scan = (rows: Int32Array, small: boolean, done: number) => {
            for (let x = 0; x < rows.length; x++) {
                if ((x & 0xfff) === 0) tick((done + x) / total, `nazwy: ${thousands(done + x)} z ${thousands(total)}, masek i kandydatow: ${thousands(this.items.length)}`);
                const s = names.start[rows[x]];
                const kb = allocKb[rows[x]];
                if (small) this.allKb += kb;
                const ids = tree.match(names.pool, s, s + names.len[rows[x]]);
                let h1 = 0;
                let h2 = 0;
                let any = false;
                for (let k = 0; k < ids.length; k++) {
                    h1 = Math.imul(h1 ^ ids[k], 0x9e3779b1) + 1 | 0;
                    h1 ^= h1 >>> 15;
                    h2 = Math.imul(h2 + ids[k], 0x85ebca6b) ^ (h2 >>> 13);
                    any ||= this.items[ids[k]].inc;
                }
                if (!any) continue;
                // 53 bity; rozne zestawy o tym samym kluczu sa praktycznie niemozliwe
                const key = (h1 >>> 0) * 0x200000 + (h2 & 0x1fffff);
                let g = byKey.get(key);
                if (!g) byKey.set(key, g = { ids: Int32Array.from(ids), inc: 0, exc: 0, ...zero() });
                g[small ? 'small' : 'large']++;
                g[small ? 'smallKb' : 'largeKb'] += kb;
            }
        };
        scan(pos, true, 0);
        scan(neg, false, pos.length);
        for (const g of byKey.values()) {
            for (const i of g.ids) {
                const x = this.items[i];
                x.groups.push(this.groups.length);
                if (x.on) g[x.inc ? 'inc' : 'exc']++;
            }
            this.groups.push(g);
        }
        this.delta = new Int32Array(this.groups.length);
    }

    lists(): MaskLists {
        const of = (inc: boolean) => this.items.filter(x => x.on && x.inc === inc).map(x => x.text);
        return { include: of(true), exclude: of(false) };
    }

    /** nowi kandydaci, gdyby liczyc ich z obecnej listy */
    fresh(): boolean {
        const l = this.lists();
        const some = (masks: string[], inc: boolean) => mergeCandidates(masks, new Set(masks)).some(t => !this.known.has(`${inc}${t}`));
        return some(l.include, true) || some(l.exclude, false);
    }

    totals(skip?: (x: Item) => boolean): AuditTotals {
        const t: AuditTotals = { include: 0, exclude: 0, ...zero(), lost: zero() };
        const on = this.items.map(x => x.on && !skip?.(x));
        this.items.forEach((x, i) => {
            if (on[i]) t[x.inc ? 'include' : 'exclude']++;
        });
        for (const g of this.groups) {
            const inc = skip ? g.ids.some(i => on[i] && this.items[i].inc) : g.inc > 0;
            if (inc) add(g.exc > 0 ? t.lost : t, g);
        }
        return t;
    }

    depth(): Counts[] {
        const out: Counts[] = [];
        for (const g of this.groups) if (g.inc > 0 && g.exc === 0) add(out[g.inc - 1] ??= zero(), g);
        return Array.from(out, x => x ?? zero());
    }

    /** INCLUDE: objete po EXCLUDE; EXCLUDE: wylaczone z objetych INCLUDE. */
    rows(inc: boolean): LargeRow[] {
        return this.items.filter(x => x.on && x.inc === inc).map(x => {
            const r: LargeRow = { text: x.text, all: zero(), only: zero() };
            for (const k of x.groups) {
                const g = this.groups[k];
                if (inc ? g.exc > 0 : g.inc === 0) continue;
                add(r.all, g);
                if ((inc ? g.inc : g.exc) === 1) add(r.only, g);
            }
            return r;
        });
    }

    /** Czy maska m zawiera sie w c: w danych i jako wzorzec. */
    private inside(m: number, c: number): boolean {
        const key = m * this.items.length + c;
        let ok = this.nested.get(key);
        if (ok === undefined) {
            ok = this.items[m].groups.every(k => has(this.groups[k].ids, c)) && within(this.items[m].text.split('.'), this.items[c].text.split('.'));
            this.nested.set(key, ok);
        }
        return ok;
    }

    /** maska z listy, w ktorej zawiera sie i; -1 = brak */
    private wider(i: number): number {
        const x = this.items[i];
        return this.items.findIndex((y, j) => j !== i && y.on && y.inc === x.inc && this.inside(i, j));
    }
    private pSmall(n: number): number {
        return this.np ? this.opt.weights.small * 100 * n / this.np : 0;
    }
    private pKb(kb: number, w: 'large' | 'risk'): number {
        return this.allKb ? this.opt.weights[w] * 100 * kb / this.allKb : 0;
    }

    /** Skutek usuniecia i dodania masek jednego rodzaju. */
    private move(addIds: number[], remove: number[]): Move {
        const { weights: w } = this.opt;
        const { inc } = this.items[addIds[0] ?? remove[0]];
        const m: Move = { add: addIds, remove, out: zero(), in: zero(), points: 0 };
        let hidden = 0;
        const touched: number[] = [];
        const count = (i: number, by: number) => {
            for (const k of this.items[i].groups) {
                if (this.delta[k] === 0) touched.push(k);
                this.delta[k] += by;
            }
        };
        for (const i of addIds) count(i, 1);
        for (const i of remove) count(i, -1);
        for (const k of touched) {
            const g = this.groups[k];
            const d = this.delta[k];
            this.delta[k] = 0;
            if (d === 0) continue;
            const was = inc ? g.inc > 0 : g.exc > 0;
            const now = inc ? g.inc + d > 0 : g.exc + d > 0;
            if (was === now) continue;
            if (inc && g.exc > 0) hidden += now ? g.largeKb : -g.largeKb;
            else if (inc) add(now ? m.in : m.out, g);
            else if (g.inc > 0) {
                hidden += now ? g.largeKb : -g.largeKb;
                add(now ? m.out : m.in, g);
            }
        }
        const shape = (l: number[]) => l.reduce((x, i) => x + this.items[i].shape, 0);
        m.points = this.pSmall(m.in.small - m.out.small) - this.pKb(m.in.largeKb - m.out.largeKb, 'large') - this.pKb(hidden, 'risk')
            + (inc ? w.masks : w.exclude) * (remove.length - addIds.length) + shape(remove) - shape(addIds);
        return m;
    }

    /** Scalenia: kandydat zamiast wszystkich masek, ktore sie w nim zawieraja. */
    private merges(on: number[]): Move[] {
        const out: Move[] = [];
        this.items.forEach((x, c) => {
            if (x.on || x.groups.length === 0) return;
            const remove = on.filter(i => this.items[i].inc === x.inc && this.items[i].groups.length > 0 && this.inside(i, c));
            if (remove.length > 1) out.push(this.move([c], remove));
        });
        return out;
    }

    /** Maska, ktora obejmuje duze albo ma kilka %, zamiast niej najlepsze z masek spoza listy. */
    private swap(i: number): Move | null {
        const x = this.items[i];
        const mine = x.groups.filter(k => this.groups[k].inc === 1 && this.groups[k].exc === 0);
        if (!mine.some(k => this.groups[k].large > 0) && starred(x.text) === x.text) return null;
        const others = new Set<number>();
        for (const k of mine) if (this.groups[k].small > 0) for (const c of this.groups[k].ids) if (this.items[c].inc && !this.items[c].on) others.add(c);
        let best = this.move([], [i]);
        const ok = (m: Move) => m.add.every(c => this.pure(c, m.remove));
        for (let n = 0; n < MAX_SWAP; n++) {
            let next = best;
            for (const c of others) {
                if (best.add.includes(c)) continue;
                const m = this.move([...best.add, c], [i]);
                if (m.points > next.points + TINY && ok(m)) next = m;
            }
            if (next === best) break;
            best = next;
        }
        return best.add.length ? best : null;
    }

    private moves(): Move[] {
        const on = this.items.map((_, i) => i).filter(i => this.items[i].on);
        const out = on.map(i => this.move([], [i]));
        out.push(...this.merges(on));
        for (const i of on) {
            const m = this.items[i].inc ? this.swap(i) : null;
            if (m) out.push(m);
        }
        this.items.forEach((x, c) => {
            if (!x.inc && !x.on) out.push(this.move([c], []));
        });
        return out;
    }

    private purity(i: number): number {
        const c = zero();
        for (const k of this.items[i].groups) if (this.groups[k].exc === 0) add(c, this.groups[k]);
        return purityOf(c.small, c.large);
    }

    /** nowa maska nie gorsza od progu albo od najgorszej zastepowanej */
    private pure(c: number, remove: number[]): boolean {
        return this.purity(c) >= Math.min(this.opt.minPurity, ...remove.map(i => this.purity(i))) - TINY;
    }

    private allowed(m: Move, t: AuditTotals): boolean {
        const { maxLarge, loss } = this.opt;
        const { inc } = this.items[m.add[0] ?? m.remove[0]];
        const largeKb = t.largeKb + m.in.largeKb - m.out.largeKb;
        const smallKb = t.smallKb + m.in.smallKb - m.out.smallKb;
        if (m.in.large && largeKb > Math.max(t.largeKb, 'kb' in maxLarge ? maxLarge.kb : maxLarge.part * smallKb) + 1e-6) return false;
        if (!inc && m.out.small && t.lost.small + m.out.small > Math.max(t.lost.small, loss * (t.small + t.lost.small)) + TINY) return false;
        return !inc || !m.in.large || m.add.every(c => this.pure(c, m.remove));
    }

    private note(m: Move): string {
        const texts = (l: number[]) => l.map(x => this.items[x].text).join('  ');
        if (m.remove.length > 1) return `zamiast ${m.remove.length}: ${texts(m.remove)}`;
        if (m.remove.length === 0) return '';
        if (m.add.length) return `na: ${texts(m.add)}`;
        const [i] = m.remove;
        const x = this.items[i];
        const same = this.items.map((_, j) => j).filter(j => j !== i && this.items[j].on && this.items[j].inc === x.inc);
        const wide = this.wider(i);
        if (wide >= 0) return `zawiera sie w ${this.items[wide].text}`;
        if (x.groups.length === 0) return 'nie pasuje do zadnego zbioru';
        const [row] = this.rows(x.inc).filter(r => r.text === x.text);
        if (!x.inc) {
            if (row.all.small + row.all.large === 0) return 'nie wylacza zadnego zbioru objetego INCLUDE';
            if (row.all.large === 0) return 'wylacza tylko male zbiory';
            return m.in.large === 0 ? 'jej duze wylaczaja inne EXCLUDE' : '';
        }
        if (row.all.small === 0) return row.all.large ? 'nie obejmuje malych zbiorow' : 'wszystkie jej zbiory wylacza EXCLUDE';
        if (m.out.small) return `malych tylko w niej: ${m.out.small}`;
        let open = x.groups.filter(k => this.groups[k].exc === 0 && this.groups[k].small > 0);
        const by: string[] = [];
        while (open.length) {
            const sum = (j: number) => open.reduce((s, k) => s + (has(this.groups[k].ids, j) ? this.groups[k].small : 0), 0);
            const best = same.map(j => ({ j, n: sum(j) })).sort((a, b) => b.n - a.n || a.j - b.j)[0].j;
            by.push(this.items[best].text);
            open = open.filter(k => !has(this.groups[k].ids, best));
        }
        return `w danych jej male obejmuja: ${by.slice(0, MAX_NOTE).join('  ')}${by.length > MAX_NOTE ? ` i ${by.length - MAX_NOTE} innych` : ''}`;
    }

    private set(i: number, on: boolean): void {
        const x = this.items[i];
        x.on = on;
        for (const k of x.groups) this.groups[k][x.inc ? 'inc' : 'exc'] += on ? 1 : -1;
    }

    /** Kroki od dajacego najwiecej punktow, az zaden nic nie da; true = bylo scalenie. */
    run(trade: boolean, fixes: Fix[], tick: () => void, late: () => boolean): boolean {
        let merged = false;
        for (;;) {
            tick();
            if (late()) return false;
            const t = this.totals();
            const good = this.moves().filter(m => (trade ? m.points > TINY && this.allowed(m, t)
                : m.out.small === 0 && m.in.large === 0 && m.add.length <= m.remove.length && (m.add.length === 0 || m.points > TINY)));
            if (good.length === 0) return merged;
            // bez strat najpierw maski zawarte w innych: zbedne takze dla przyszlych nazw, a nie tylko w danych
            const sure = trade ? [] : good.filter(m => m.add.length === 0 && this.wider(m.remove[0]) >= 0);
            const pool = sure.length ? sure : good;
            const top = Math.max(...pool.map(m => m.points));
            // przy tych samych punktach dalsza na liscie
            const [m] = pool.filter(x => x.points > top - TINY).sort((a, b) => Math.max(-1, ...b.remove) - Math.max(-1, ...a.remove));
            const note = this.note(m);
            for (const i of m.remove) this.set(i, false);
            for (const i of m.add) this.set(i, true);
            merged ||= m.add.length > 0;
            fixes.push({
                side: this.items[m.add[0] ?? m.remove[0]].inc ? 'INCLUDE' : 'EXCLUDE', add: m.add.map(i => this.items[i].text), remove: m.remove.map(i => this.items[i].text),
                note, points: m.points, out: m.out, in: m.in, after: this.totals(), lists: this.lists(),
            });
        }
    }

    /** Scalenia INCLUDE, ktore wpuszczaja duze: od najtanszego (KB duzych na oszczedzona maske). */
    blocked(): Blocked[] {
        const best = new Map<string, { b: Blocked; shape: number }>();
        for (const m of this.merges(this.items.map((_, i) => i).filter(i => this.items[i].on && this.items[i].inc))) {
            if (m.in.large === 0) continue;
            const x = this.items[m.add[0]];
            const hidden = zero();
            for (const k of x.groups) if (this.groups[k].inc === 0 && this.groups[k].exc > 0) add(hidden, this.groups[k]);
            const b: Blocked = { text: x.text, remove: m.remove.map(i => this.items[i].text), in: m.in, hidden };
            const key = m.remove.join();
            const old = best.get(key);
            if (!old || b.in.largeKb < old.b.in.largeKb || (b.in.largeKb === old.b.in.largeKb && x.shape < old.shape)) best.set(key, { b, shape: x.shape });
        }
        const cost = (b: Blocked) => b.in.largeKb / (b.remove.length - 1);
        return [...best.values()].map(x => x.b).sort((a, b) => cost(a) - cost(b) || b.remove.length - a.remove.length || (a.text < b.text ? -1 : 1));
    }
}

/** czy rosnaca lista zawiera numer */
function has(ids: Int32Array, want: number): boolean {
    let lo = 0;
    let hi = ids.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (ids[mid] === want) return true;
        if (ids[mid] < want) lo = mid + 1;
        else hi = mid - 1;
    }
    return false;
}

/** D%%%%%% -> D* */
const starred = (t: string) => t.replace(/([^.*%])%{2,}(?=\.|$)/g, '$1*');

/** Maska i jej luzniejsze zapisy: D*, koniec albo jeden kwalifikator (za head poczatkowymi) zastapiony **. */
function looser(text: string, head: number): string[] {
    const q = text.split('.');
    const out = [q];
    for (let i = head; i < q.length; i++) {
        out.push([...q.slice(0, i), '**', ...q.slice(i + 1)]);
        // po samych poczatkowych kwalifikatorach byloby to z powrotem cala maska
        if (i > head) out.push([...q.slice(0, i), '**']);
    }
    const texts = out.map(x => x.filter((y, i) => y !== '**' || x[i - 1] !== '**').join('.'));
    return [...new Set([...texts, ...texts.map(starred)])].filter(t => t.length <= MAX_LEN);
}

/** Wezsze maski dla masek z duzymi (szukane w ich zbiorach) i nowe EXCLUDE. */
function extras(input: CheckInput, lists: MaskLists, dirty: LargeRow[], opt: AuditOptions, tick: Tick, late: () => boolean): MaskLists {
    const { names, pos, neg } = input;
    const total = dirty.reduce((x, r) => x + r.all.largeKb, 0);
    const list = dirty.filter(r => r.all.large > 0 && r.all.small > 0 && r.all.largeKb >= MIN_DIRTY * total).sort((a, b) => b.all.largeKb - a.all.largeKb).slice(0, MAX_DIRTY);
    const out = new Set([...lists.include, ...lists.include.map(starred)].filter(t => !acsProblem(t)));
    if (list.length) {
        const tree = new MaskTree(list.map(r => r.text.split('.')));
        const exc = lists.exclude.length ? new MaskTree(lists.exclude.map(m => m.split('.'))) : null;
        const rows = list.map(() => [[] as number[], [] as number[]]);
        [pos, neg].forEach((from, side) => {
            for (let x = 0; x < from.length; x++) {
                if ((x & 0xfff) === 0) tick(0.3 * (side + x / from.length) / 2, `zbiory masek z duzymi: ${thousands(x)} z ${thousands(from.length)}`);
                const s = names.start[from[x]];
                const e = s + names.len[from[x]];
                for (const m of tree.match(names.pool, s, e).slice()) if (!exc?.match(names.pool, s, e).length) rows[m][side].push(from[x]);
            }
        });
        list.forEach((r, i) => {
            if (late()) return;
            const info = `wezsze maski: ${i + 1} z ${list.length}, ${r.text}`;
            const part = () => tick(0.3 + 0.4 * i / list.length, info);
            part();
            const quals = r.text.split('.');
            const any = quals.indexOf('**');
            // probka: liczby wezszych masek i tak sa potem liczone na wszystkich zbiorach
            const n = rows[i][0].length + rows[i][1].length;
            const step = Math.max(1, Math.ceil(n / MAX_SAMPLE));
            const every = (l: number[]) => Int32Array.from(step === 1 ? l : l.filter((_, k) => k % step === 0));
            const sample = { ...input, pos: every(rows[i][0]), neg: every(rows[i][1]) };
            const found = mine(sample, {
                minPurity: opt.minPurity, minCount: Math.max(2, Math.ceil(0.01 * sample.pos.length)), maxMasks: 2 * MAX_SWAP, maxWild: 2,
                head: any < 0 ? quals : quals.slice(0, any),
            }, { prepare: part, search: () => part, select: () => part });
            for (const { text } of found.masks) for (const t of looser(text, any < 0 ? quals.length : any)) if (!acsProblem(t) && literalChars(t) >= MIN_LITERAL) out.add(t);
        });
    }
    tick(0.7, 'nowe EXCLUDE');
    const ex = total > 0 && !late() ? findExcludes(input, lists.include, lists.exclude, { minCount: 2, maxWild: 3, gain: 0.005, loss: opt.loss }, p => tick(0.7 + 0.3 * p, 'nowe EXCLUDE')) : null;
    return { include: [...out], exclude: [...new Set([...lists.exclude, ...(ex?.masks ?? []).map(m => m.text).filter(t => !acsProblem(t))])] };
}

export function audit(input: CheckInput, lists: MaskLists, opt: AuditOptions, tick: Tick): AuditResult {
    const deadline = Date.now() + opt.seconds * 1000;
    let stopped = false;
    const late = () => (stopped ||= Date.now() > deadline);
    let no = 1;
    // przejscia przez dane: pierwsze to szukanie wezszych masek; zwykle 3-5, najwyzej tyle
    const passes = 6;
    const make = (from: CheckInput, l: MaskLists, extra: MaskLists, known: Set<string>) => {
        const base = Math.min(no++, passes - 1);
        return new Model(from, l, extra, opt, known, (p, info) => tick((base + 0.9 * p) / passes, `przejscie ${base}: ${info}`));
    };
    const improve = (from: CheckInput, model: Model, extra: MaskLists, known: Set<string>, trade: boolean, fixes: Fix[]): Model => {
        let m = model;
        const step = () => tick(Math.min(1, no / passes), `${trade ? 'kosztem malych albo duzych' : 'bez strat'}: krokow ${fixes.length}`);
        for (let r = 0; m.run(trade, fixes, step, late) && r < ROUNDS && m.fresh() && !late(); r++) m = make(from, m.lists(), extra, known);
        return m;
    };
    const plain = checkRows(input, lists, p => tick(0.5 * p / passes));
    const extra = extras(input, lists, plain, opt, (p, info) => tick((0.5 + 0.5 * p) / passes, info), late);
    const known = new Set<string>();
    let m = make(input, lists, extra, known);
    const out = {
        before: m.totals(), depth: m.depth(), include: m.rows(true), exclude: m.rows(false),
        pure: pureTotals(m), safe: [] as Fix[], trade: [] as Fix[],
    };
    m = improve(input, m, extra, known, false, out.safe);
    const blocked = m.blocked();
    m = improve(input, m, extra, known, true, out.trade);
    const small = { ...input, neg: new Int32Array(0) };
    const kn = new Set<string>();
    const none = { include: [], exclude: [] };
    const last = late() ? null : improve(small, make(small, { include: lists.include, exclude: [] }, none, kn), none, kn, false, []);
    const used = new Set([...out.safe, ...out.trade].flatMap(f => f.add));
    return { ...out, blocked: blocked.filter(b => !used.has(b.text)), noLarge: last?.lists() ?? { include: lists.include, exclude: [] }, stopped };
}

/** Maski INCLUDE na danych, po EXCLUDE (bez only). */
function checkRows(input: CheckInput, lists: MaskLists, tick: Tick): LargeRow[] {
    return checkMasks(input, lists.include, lists.exclude, tick).rows.map(r => ({ text: r.text, all: r, only: zero() }));
}

function pureTotals(m: Model): AuditTotals {
    const dirty = new Set(m.rows(true).filter(r => r.all.large > 0).map(r => r.text));
    return m.totals(x => x.inc && dirty.has(x.text));
}
