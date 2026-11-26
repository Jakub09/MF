/**
 * Budowanie FILTLIST po jednej masce (--build). Kazda maska powstaje z dwoch rankingow kwalifikatorow, liczonych od
 * nowa po kazdym kroku tylko w zbiorach, ktore maska teraz obejmuje:
 *   ranking 1   % malych z kwalifikatorem minus % duzych z nim      -> kwalifikator do maski
 *   ranking 2   odwrotnie: % duzych minus % malych                  -> maska EXCLUDE (**.DATA.**)
 * Kroki: dodanie kwalifikatora na dowolnym miejscu, EXCLUDE, zawezenie (** -> * albo nic, bez koncowego .**), a na koncu
 * odejmowanie (bez kwalifikatora, krotszy albo inny kwalifikator, szerszy odstep). Rownolegle beam wersji maski.
 *
 * O wyborze decyduja punkty; 1 punkt = 1% malych (waga small = 1):
 *   small * % nowych malych - large * KB nowych duzych (w % KB wszystkich malych)
 *   - risk * KB duzych, ktore maski obejmuja, a zdejmuje EXCLUDE
 *   - masks - exclude * liczba EXCLUDE - percent * liczba % - wild * liczba * i ** (bez koncowego .**) - start, gdy maska zaczyna sie od * albo **
 * Progi: purity maski, nowe male, granica duzych w liscie, male stracone przez EXCLUDE.
 *
 * Gdy zadna maska nie daje juz punktow: wspolne EXCLUDE dla calej listy, a potem druga runda - kazda maska jest wyjmowana
 * i budowana od nowa przy pozostalych (takze jako kilka mniejszych). Calosc dwa razy: raz z maskami od ** na starcie, raz bez;
 * zostaje lista o wiekszej liczbie punktow. To przyblizenie, nie dowod najlepszej listy.
 *
 * Z lista na poczatek (base, --next): jej masek skrypt nie zmienia, dobiera kolejne dla nieobjetych malych, bez drugiej rundy;
 * granice i punkty dotycza calej listy.
 */
import { CheckInput } from './auto-check';
import { LargeLimit } from './auto-compact';
import { literalChars, MAX_LEN, purityOf } from './auto-mine';
import { buildSequences, readNames, Sequences } from './auto-quals';
import { MaskTree } from './auto-tree';
import { IntList, Tick } from './auto-util';

export interface Points {
    small: number;
    large: number;
    masks: number;
    exclude: number;
    /** duze, ktore maski obejmuja, a zdejmuje EXCLUDE */
    risk: number;
    percent: number;
    wild: number;
    start: number;
}

export const POINTS: Points = { small: 1, large: 2, masks: 0.5, exclude: 0.5, risk: 0.1, percent: 0.05, wild: 0.02, start: 2 };

export interface BuildOptions {
    weights: Points;
    minPurity: number;
    minCount: number;
    /** INCLUDE i EXCLUDE razem */
    maxMasks: number;
    maxLarge: LargeLimit;
    loss: number;
    /** ile duzych wylacza EXCLUDE */
    exMin: number;
    /** najmniej znakow stalych kwalifikatora niepelnego */
    partial: number;
    /** ile wersji maski naraz */
    beam: number;
    /** druga runda: ile razy najwyzej */
    rounds: number;
    head?: string[];
    seconds: number;
    /** lista, ktora juz jest: zostaje bez zmian, szukane sa dalsze maski */
    base?: MaskLists;
}

export interface MaskLists {
    include: string[];
    exclude: string[];
}

/** Wynik kroku budowania. */
export interface Step {
    text: string;
    exclude: string[];
    small: number;
    large: number;
    note: string;
}

export interface Proposal {
    text: string;
    exclude: string[];
    /** nowe male; wszystkie male i duze maski (po EXCLUDE) */
    gain: number;
    small: number;
    large: number;
    points: number;
    steps: Step[];
}

/** Co zrobic z propozycjami (od najlepszej): wziac, odrzucic pierwsza (juz nie proponowac), wpisac wlasna maske, cofnac, skonczyc. */
export type Answer = { take: number } | { reject: true } | { mask: string } | { undo: true } | { stop: true };
/** last: ostatnio przyjeta maska i jej punkty */
export type Ask = (list: Proposal[], no: number, now: Totals, last: Change | null) => Answer;

export interface Totals {
    small: number;
    large: number;
    smallKb: number;
    largeKb: number;
    lost: number;
    /** KB duzych objetych INCLUDE i wylaczonych */
    hiddenKb: number;
}

export interface Change {
    text: string;
    points: number;
}

export interface BuildResult {
    include: string[];
    exclude: string[];
    totals: Totals;
    /** skladniki punktow, juz ze znakiem */
    parts: Record<keyof Points, number>;
    points: number;
    /** jak powstala kazda maska include; null = wpisana albo z listy na poczatek */
    how: (Proposal | null)[];
    /** zmiany listy po kolei, z punktami */
    changes: Change[];
    stopped: boolean;
    /** ile pierwszych masek include i exclude pochodzi z listy na poczatek */
    old: { include: number; exclude: number };
    /** stan tej listy */
    before: Totals;
    /** nieobjete male, w tym wylaczone przez EXCLUDE (nie do objecia) */
    left: { small: number; dead: number };
}

interface Gap {
    min: number;
    /** min albo wiecej kwalifikatorow */
    any: boolean;
}

/** Maska: kwalifikatory z odstepami przed nimi i za ostatnim. */
export interface Pattern {
    toks: number[];
    gaps: Gap[];
    tail: Gap;
}

const ANY: Gap = { min: 0, any: true };
const NEXT: Gap = { min: 0, any: false };
const MAX_QUALS = 30;
/** najwiecej kwalifikatorow i EXCLUDE jednej maski */
const MAX_TOKS = 5;
const MAX_EX = 2;
/** przy tych samych zbiorach przegrywa szerszy odstep, potem mniej znakow stalych */
const EPS = 1e-4;
const LIT = 1e-5;
/** najmniejsza purity maski przed EXCLUDE: w drugiej rundzie i przy pierwszym budowaniu (ostroznie) */
const RAW = [0.5, 0.8];
/** na ile masek najwyzej dzielona jest jedna w drugiej rundzie */
const SPLIT = 4;
/** --next: kolejnosc prob; maska zostaje na stale, wiec najpierw bez ** na poczatku i prawie bez duzych */
const STEP_RAW = [0.95, 0.8, 0.5];
const cubed = (x: number) => x * x * x;

/** Nazwy jako ciagi klas kwalifikatorow i maski z elementow tych klas. */
export class Space {
    readonly q: Sequences;
    readonly small: Float64Array;
    readonly large: Float64Array;
    readonly smallKb: Float64Array;
    readonly largeKb: Float64Array;
    readonly np: number;
    readonly nl: number;
    readonly allKb: number;
    readonly byText: Map<string, number>;
    /** lista na poczatek: OLD_INC, OLD_EXC */
    readonly mark: Uint8Array;
    private readonly inClass = new Map<number, Uint8Array>();
    private readonly lists = new Map<number, Int32Array>();

    /** minCount: od ilu malych element; needKb: od ilu KB duzych */
    constructor(readonly input: CheckInput, readonly head: string[], readonly minCount: number, readonly needKb: number,
        readonly partial: number, readonly extra: string[], tick: Tick, base?: MaskLists) {
        const { names, allocKb, pos, neg } = input;
        this.np = pos.length;
        this.nl = neg.length;
        const weight = new Float64Array(allocKb.length);
        for (let i = 0; i < neg.length; i++) weight[neg[i]] = allocKb[neg[i]] * (minCount / needKb);
        const rows = new Int32Array(this.np + this.nl);
        rows.set(pos);
        rows.set(neg, this.np);
        const n = readNames({ names, allocKb: weight, pos: rows, neg: new Int32Array(0) }, head.length, p => tick(0.4 * p), true);
        const q = buildSequences(n, minCount, partial, head.length > 0, p => tick(0.4 + 0.6 * p), true, extra);
        [this.q, this.mark] = base?.include.length ? split(q, oldMarks(input, rows, base)) : [q, new Uint8Array(q.count)];
        const { count, rowSeq } = this.q;
        this.small = new Float64Array(count);
        this.large = new Float64Array(count);
        this.smallKb = new Float64Array(count);
        this.largeKb = new Float64Array(count);
        let kb = 0;
        for (let i = 0; i < rows.length; i++) {
            const s = rowSeq[i];
            if (i < this.np) {
                this.small[s]++;
                this.smallKb[s] += allocKb[rows[i]];
                kb += allocKb[rows[i]];
            } else {
                this.large[s]++;
                this.largeKb[s] += allocKb[rows[i]];
            }
        }
        this.allKb = kb;
        this.byText = new Map(this.q.tokens.map((t, i) => [t.text, i]));
    }

    /** klasa -> czy pasuje element t */
    has(t: number): Uint8Array {
        let h = this.inClass.get(t);
        if (h) return h;
        const { clsOff, clsTok } = this.q;
        h = new Uint8Array(clsOff.length - 1);
        for (let c = 0; c < h.length; c++) {
            for (let y = clsOff[c]; y < clsOff[c + 1]; y++) if (clsTok[y] === t) h[c] = 1;
        }
        this.inClass.set(t, h);
        return h;
    }

    /** ciagi z elementem t na jakimkolwiek miejscu */
    seqsOf(t: number): Int32Array {
        let l = this.lists.get(t);
        if (l) return l;
        const { count, off, cls } = this.q;
        const h = this.has(t);
        const out = new IntList();
        for (let s = 0; s < count; s++) {
            for (let p = off[s]; p < off[s + 1]; p++) {
                if (!h[cls[p]]) continue;
                out.push(s);
                break;
            }
        }
        this.lists.set(t, l = out.a.slice(0, out.n));
        return l;
    }

    text(m: Pattern): string {
        const parts = this.head.slice();
        const gap = (g: Gap) => {
            for (let i = 0; i < g.min; i++) parts.push('*');
            if (g.any) parts.push('**');
        };
        m.toks.forEach((t, i) => {
            gap(m.gaps[i]);
            parts.push(this.q.tokens[t].text);
        });
        gap(m.tail);
        return parts.join('.');
    }

    /** null = element, ktorego nie ma (extra) */
    parse(text: string): Pattern | null {
        const quals = text.split('.');
        if (this.head.some((h, i) => quals[i] !== h)) return null;
        const m: Pattern = { toks: [], gaps: [], tail: NEXT };
        let g: Gap = { min: 0, any: false };
        for (const x of quals.slice(this.head.length)) {
            if (x === '**') {
                g = { ...g, any: true };
            } else if (x === '*') {
                g = { ...g, min: g.min + 1 };
            } else {
                const t = this.byText.get(x);
                if (t === undefined) return null;
                m.toks.push(t);
                m.gaps.push(g);
                g = { min: 0, any: false };
            }
        }
        m.tail = g;
        return m;
    }

    private static move(m: number, g: Gap): number {
        m <<= g.min;
        // od najnizszej pozycji w gore
        return g.any && m ? -(m & -m) : m;
    }

    matcher(m: Pattern): (s: number) => boolean {
        const { off, cls } = this.q;
        const has = m.toks.map(t => this.has(t));
        return s => {
            const base = off[s];
            const n = off[s + 1] - base;
            if (n > MAX_QUALS) return false;
            let at = 1;
            for (let i = 0; i < has.length; i++) {
                at = Space.move(at, m.gaps[i]);
                let next = 0;
                for (let p = 0; p < n; p++) if ((at >>> p) & 1 && has[i][cls[base + p]]) next |= 1 << (p + 1);
                if (next === 0) return false;
                at = next;
            }
            return ((Space.move(at, m.tail) >>> n) & 1) === 1;
        };
    }

    /** ciagi objete maska */
    select(m: Pattern, from?: Int32Array): Int32Array {
        const ok = this.matcher(m);
        let list = from;
        if (!list) {
            for (const t of m.toks) {
                const l = this.seqsOf(t);
                if (!list || l.length < list.length) list = l;
            }
        }
        if (!list) return Int32Array.from({ length: this.q.count }, (_, s) => s).filter(ok);
        return list.filter(ok);
    }
}

const OLD_INC = 1;
const OLD_EXC = 2;

/** Ktore zbiory obejmuje i wylacza lista na poczatek (zwykle porownanie masek z nazwami). */
function oldMarks({ names }: CheckInput, rows: Int32Array, base: MaskLists): Uint8Array {
    const inc = new MaskTree(base.include.map(m => m.split('.')));
    const exc = new MaskTree(base.exclude.map(m => m.split('.')));
    return Uint8Array.from(rows, row => {
        const s = names.start[row];
        const e = s + names.len[row];
        return (inc.match(names.pool, s, e).length ? OLD_INC : 0) | (base.exclude.length && exc.match(names.pool, s, e).length ? OLD_EXC : 0);
    });
}

/** Ciagi podzielone wg znacznikow zbiorow. */
function split(q: Sequences, marks: Uint8Array): [Sequences, Uint8Array] {
    const ids = new Map<number, number>();
    const from = new IntList();
    const rowSeq = q.rowSeq.map((s, i) => {
        const k = 4 * s + marks[i];
        let x = ids.get(k);
        if (x === undefined) {
            ids.set(k, x = from.n);
            from.push(k);
        }
        return x;
    });
    const count = from.n;
    const mark = new Uint8Array(count);
    const off = new Int32Array(count + 1);
    const end = new Uint8Array(count);
    const sums = { wp: new Int32Array(count), wn: new Int32Array(count), kp: new Float64Array(count), kn: new Float64Array(count) };
    for (let x = 0; x < count; x++) {
        const s = from.a[x] >> 2;
        mark[x] = from.a[x] & 3;
        off[x + 1] = off[x] + q.off[s + 1] - q.off[s];
        end[x] = q.end[s];
    }
    const cls = new Int32Array(off[count]);
    for (let x = 0; x < count; x++) cls.set(q.cls.subarray(q.off[from.a[x] >> 2], q.off[(from.a[x] >> 2) + 1]), off[x]);
    return [{ ...q, ...sums, count, off, cls, end, rowSeq }, mark];
}

/** Stan listy: ktore ciagi sa objete i wylaczone. */
interface Live {
    /** male i duze niewylaczone */
    ns: Float64Array;
    nl: Float64Array;
    /** z nich nieobjete: male (sztuki, KB), duze (KB) */
    us: Float64Array;
    usKb: Float64Array;
    ul: Float64Array;
    /** wylaczone duze nieobjete INCLUDE (KB) */
    dl: Float64Array;
    t: Totals;
    /** nieobjete male, ktore wylacza EXCLUDE: wszystkie i tylko przez nowe EXCLUDE */
    dead: number;
    killed: number;
}

interface Item {
    m: Pattern;
    seqs: Int32Array;
}

interface List {
    inc: Item[];
    exc: Item[];
}

interface State {
    m: Pattern;
    ex: number[];
    /** objete, bez wylaczonych przez ex */
    seqs: Int32Array;
    /** wylaczone przez ex */
    gone: Int32Array;
    /** nowe male, wszystkie male, duze, KB nowych malych i duzych, stracone male */
    us: number;
    ns: number;
    nl: number;
    usKb: number;
    ul: number;
    lost: number;
    /** KB duzych wylaczonych przez ex i EXCLUDE listy */
    hidden: number;
    /** purity bez zadnego EXCLUDE */
    raw: number;
    points: number;
    parent: State | null;
    note: string;
}

/** zestaw ciagow jako tekst: suma, suma wymieszanych numerow i liczba */
function coverKey(...lists: Int32Array[]): string {
    let a = 0;
    let b = 0;
    let n = 0;
    for (const l of lists) {
        for (let i = 0; i < l.length; i++) {
            const h = Math.imul(l[i] + 1, 0x9e3779b1);
            a = (a + Math.imul(h ^ (h >>> 15), 0x85ebca6b)) | 0;
            b = (b ^ Math.imul(h ^ (h >>> 13), 0xc2b2ae35)) | 0;
            n++;
        }
    }
    return `#${a}|${b}|${n}`;
}

const key = (m: Pattern) => `${m.toks}|${[...m.gaps, m.tail].map(g => g.min + (g.any ? '+' : ''))}`;
const stars = (t: string) => t.split('*').length - 1;

/** Koszt wygladu maski w punktach. */
export function shapeCost(text: string, w: Points, head = 0): number {
    const quals = text.split('.');
    let cost = (/^\*/.test(text) && head === 0 ? w.start : 0) - LIT * literalChars(text);
    quals.forEach((x, i) => {
        if (x === '**') cost += i === quals.length - 1 ? EPS : w.wild + EPS;
        else cost += w.wild * stars(x) + w.percent * (x.split('%').length - 1);
    });
    return cost;
}

export class Builder {
    /** wagi; --target zmienia je miedzy etapami */
    private w: Points;
    private readonly all: Int32Array;
    private readonly deadline: number;
    stopped = false;
    /** jak powstaly maski */
    origin = new Map<string, Proposal>();
    /** wpisane, bez progu purity */
    free = new Set<string>();
    private readonly base: MaskLists;
    private readonly baseCount: number;
    /** stan listy na poczatek */
    readonly before: Totals;
    /** lista powstaje na raty: EXCLUDE kosztuje tez male, ktore moglyby objac kolejne maski */
    byStep = false;

    constructor(readonly space: Space, readonly opt: BuildOptions) {
        this.w = opt.weights;
        this.all = Int32Array.from({ length: space.q.count }, (_, s) => s);
        this.deadline = Date.now() + opt.seconds * 1000;
        this.base = opt.base ?? { include: [], exclude: [] };
        this.baseCount = this.base.include.length + this.base.exclude.length;
        this.before = this.live({ inc: [], exc: [] }).t;
    }

    private late(): boolean {
        if (Date.now() > this.deadline) this.stopped = true;
        return this.stopped;
    }
    private pSmall(n: number): number {
        return this.space.np ? this.w.small * 100 * n / this.space.np : 0;
    }
    private pLarge(kb: number): number {
        return this.space.allKb ? this.w.large * 100 * kb / this.space.allKb : 0;
    }
    private pRisk(kb: number): number {
        return this.space.allKb ? this.w.risk * 100 * kb / this.space.allKb : 0;
    }
    /** odrzucona: ten sam tekst albo te same ciagi (takze szerszy zapis, np. PAY.** i **.PAY.**) */
    private isBanned(st: State, banned: Set<string>): boolean {
        return banned.size > 0 && (banned.has(this.space.text(st.m)) || banned.has(coverKey(st.seqs, st.gone)));
    }
    private loose(m: Pattern): boolean {
        return this.space.head.length === 0 && (m.gaps[0].any || m.gaps[0].min > 0);
    }
    private shape(m: Pattern): number {
        return shapeCost(this.space.text(m), this.w, this.space.head.length);
    }
    private exShape(m: Pattern): number {
        // EXCLUDE z natury zaczyna sie od **, a przy tych samych zbiorach wygrywa szerszy
        const text = this.space.text(m);
        return shapeCost(text, { ...this.w, start: 0 }, this.space.head.length) + 2 * LIT * literalChars(text);
    }
    private exPattern(t: number): Pattern {
        return { toks: [t], gaps: [ANY], tail: ANY };
    }
    private valid(m: Pattern): boolean {
        const text = this.space.text(m);
        // "-" w masce: translator ACS bierze za znak kontynuacji
        return text.length <= MAX_LEN && literalChars(text) > 0 && !(text.includes('-') && /[*%]/.test(text));
    }

    live(list: List): Live {
        const { space } = this;
        const n = space.q.count;
        const dead = space.mark.map(m => m & OLD_EXC);
        const cov = space.mark.map(m => m & OLD_INC);
        for (const e of list.exc) for (let x = 0; x < e.seqs.length; x++) dead[e.seqs[x]] |= 1;
        for (const e of list.inc) for (let x = 0; x < e.seqs.length; x++) cov[e.seqs[x]] = 1;
        const l: Live = {
            ns: new Float64Array(n), nl: new Float64Array(n), us: new Float64Array(n), usKb: new Float64Array(n), ul: new Float64Array(n), dl: new Float64Array(n),
            t: { small: 0, large: 0, smallKb: 0, largeKb: 0, lost: 0, hiddenKb: 0 }, dead: 0, killed: 0,
        };
        for (let s = 0; s < n; s++) {
            if (dead[s]) {
                if (cov[s]) {
                    l.t.lost += space.small[s];
                    l.t.hiddenKb += space.largeKb[s];
                } else {
                    l.dl[s] = space.largeKb[s];
                    l.dead += space.small[s];
                    if (dead[s] === 1) l.killed += space.small[s];
                }
                continue;
            }
            l.ns[s] = space.small[s];
            l.nl[s] = space.large[s];
            if (cov[s]) {
                l.t.small += space.small[s];
                l.t.large += space.large[s];
                l.t.smallKb += space.smallKb[s];
                l.t.largeKb += space.largeKb[s];
            } else {
                l.us[s] = space.small[s];
                l.usKb[s] = space.smallKb[s];
                l.ul[s] = space.largeKb[s];
            }
        }
        return l;
    }

    parts(list: List, t: Totals): Record<keyof Points, number> {
        const { w, space } = this;
        const none = { small: 0, large: 0, masks: 0, exclude: 0, risk: 0, percent: 0, wild: 0, start: 0 };
        const only = (k: 'percent' | 'wild' | 'start') => {
            const only1 = { ...none, [k]: w[k] };
            const sum = (l: string[], ex: boolean) => l.reduce((a, x) => a + shapeCost(x, ex ? { ...only1, start: 0 } : only1, space.head.length)
                - shapeCost(x, none, space.head.length), 0);
            return -sum(this.texts(list).include, false) - sum(this.texts(list).exclude, true);
        };
        return {
            small: this.pSmall(t.small), large: -this.pLarge(t.largeKb), masks: -w.masks * this.texts(list).include.length, exclude: -w.exclude * this.texts(list).exclude.length,
            risk: -this.pRisk(t.hiddenKb),
            percent: only('percent'), wild: only('wild'), start: only('start'),
        };
    }

    /** cala lista: najpierw maski, od ktorych zaczeto */
    private texts(list: List): MaskLists {
        return {
            include: [...this.base.include, ...list.inc.map(i => this.space.text(i.m))],
            exclude: [...this.base.exclude, ...list.exc.map(i => this.space.text(i.m))],
        };
    }

    /** Punkty listy, bez stalego kosztu masek, od ktorych zaczeto. */
    score(list: List, { t, killed } = this.live(list)): number {
        let x = this.pSmall(t.small) - this.pLarge(t.largeKb) - this.pRisk(t.hiddenKb) - this.w.masks * list.inc.length - this.w.exclude * list.exc.length;
        if (this.byStep) x -= this.pSmall(killed);
        for (const i of list.inc) x -= this.shape(i.m);
        for (const i of list.exc) x -= this.exShape(i.m);
        return x;
    }

    private largeOk(smallKb: number, largeKb: number): boolean {
        const { maxLarge } = this.opt;
        // lista na poczatek moze przekraczac granice: wtedy nie moze byc gorzej
        return largeKb <= Math.max(this.before.largeKb, 'kb' in maxLarge ? maxLarge.kb : maxLarge.part * smallKb) + 1e-6;
    }

    /** masek co najmniej tyle, ile wolno (over = 1: wiecej) */
    private full(list: List, over = 0): boolean {
        return this.baseCount + list.inc.length + list.exc.length >= this.opt.maxMasks + over;
    }

    /** granice calej listy */
    allowed(list: List, l: Live): boolean {
        const { loss, minPurity } = this.opt;
        const { t } = l;
        if (this.full(list, 1) || !this.largeOk(t.smallKb, t.largeKb) || t.lost > Math.max(this.before.lost, loss * (t.small + t.lost)) + 1e-9) return false;
        return list.inc.every(i => {
            let ns = 0;
            let nl = 0;
            for (let x = 0; x < i.seqs.length; x++) {
                ns += l.ns[i.seqs[x]];
                nl += l.nl[i.seqs[x]];
            }
            // wpisana przez uzytkownika zostaje (minPurity nie dotyczy)
            return this.free.has(this.space.text(i.m)) || purityOf(ns, nl) >= minPurity;
        });
    }

    /** najmniejsza purity maski bez EXCLUDE */
    minRaw = RAW[0];
    /** maska nie zaczyna sie od * ani ** */
    private anchored = false;
    /** maska daje mniej nowych malych */
    private cap = Infinity;

    private measure(l: Live, m: Pattern, ex: number[], seqs: Int32Array, gone: Int32Array, parent: State | null, note: string): State {
        const st: State = { m, ex, seqs, gone, us: 0, ns: 0, nl: 0, usKb: 0, ul: 0, lost: 0, hidden: 0, raw: 0, points: 0, parent, note };
        let rawS = 0;
        let rawL = 0;
        for (let x = 0; x < seqs.length; x++) {
            const s = seqs[x];
            rawS += this.space.small[s];
            rawL += this.space.large[s];
            st.us += l.us[s];
            st.ns += l.ns[s];
            st.nl += l.nl[s];
            st.usKb += l.usKb[s];
            st.ul += l.ul[s];
            st.hidden += l.dl[s];
        }
        for (let x = 0; x < gone.length; x++) {
            rawS += this.space.small[gone[x]];
            rawL += this.space.large[gone[x]];
            st.lost += l.ns[gone[x]];
            st.hidden += l.ul[gone[x]] + l.dl[gone[x]];
        }
        st.raw = purityOf(rawS, rawL);
        st.points = this.pSmall(st.us) - this.pLarge(st.ul) - this.pRisk(st.hidden) - this.w.masks - this.w.exclude * ex.length - this.shape(m);
        return st;
    }

    private child(l: Live, p: State, m: Pattern, note: string): State {
        const ok = this.space.matcher(m);
        return this.measure(l, m, p.ex, p.seqs.filter(ok), p.gone.filter(ok), p, note);
    }

    private fresh(l: Live, m: Pattern, ex: number[], parent: State | null, note: string): State {
        let seqs = this.space.select(m);
        const gone = new IntList();
        if (ex.length) {
            const hit = ex.map(t => this.space.matcher(this.exPattern(t)));
            seqs = seqs.filter(s => {
                const out = hit.some(f => f(s));
                if (out) gone.push(s);
                return !out;
            });
        }
        return this.measure(l, m, ex, seqs, gone.a.slice(0, gone.n), parent, note);
    }

    /** czy maska moze wejsc do listy */
    private good(l: Live, st: State): boolean {
        const { opt } = this;
        return st.points > 0 && st.raw >= this.minRaw && st.us < this.cap && !(this.anchored && this.loose(st.m)) && this.largeOk(l.t.smallKb + st.usKb, l.t.largeKb + st.ul) && st.us >= opt.minCount * (1 + st.ex.length) && purityOf(st.ns, st.nl) >= opt.minPurity
            && st.lost <= opt.loss * (st.ns + st.lost) + 1e-9 && this.valid(st.m);
    }

    /**
     * Ranking elementow w zbiorach stanu: miejsca slot = odstep przed kwalifikatorem slot (dlugosc = za ostatnim),
     * -1 = pierwszy kwalifikator nazwy. each(slot, element, nowe male, male, duze, KB duzych).
     */
    private rank(l: Live, st: { m: Pattern; seqs: Int32Array }, each: (slot: number, t: number, us: number, ns: number, nl: number, ul: number) => void): void {
        const { off, cls, clsOff, clsTok, tokens } = this.space.q;
        const { m, seqs } = st;
        const k = m.toks.length;
        const has = m.toks.map(t => this.space.has(t));
        const open: number[] = [];
        for (let i = 0; i <= k; i++) if ((i < k ? m.gaps[i] : m.tail).any) open.push(i);
        if (k > 0 && m.gaps[0].any && m.gaps[0].min === 0) open.push(-1);
        const nt = tokens.length;
        const stamp = new Int32Array(nt);
        const us = new Float64Array(nt);
        const ns = new Float64Array(nt);
        const nl = new Float64Array(nt);
        const ul = new Float64Array(nt);
        let round = 0;
        const from = new Int32Array(k + 1);
        const till = new Int32Array(k + 1);
        for (const slot of open) {
            const touched: number[] = [];
            for (let x = 0; x < seqs.length; x++) {
                const s = seqs[x];
                if (l.us[s] === 0 && l.nl[s] === 0 && l.ns[s] === 0) continue;
                const base = off[s];
                const n = off[s + 1] - base;
                let lo = 0;
                let hi = n;
                if (slot === -1) {
                    hi = Math.min(1, n);
                    // pierwszy kwalifikator maski nie moze stac na poczatku nazwy
                    if (k) {
                        let p = n - 1;
                        for (let i = k - 1; i >= 0 && p >= 0; p--) if (has[i][cls[base + p]]) till[i--] = p;
                        if (till[0] < 1) continue;
                    }
                } else if (k) {
                    // najwczesniejsze miejsca poczatku i najpozniejsze konca (odstepy dokladne sprawdza potem maska)
                    let i = 0;
                    for (let p = 0; p < n && i < slot; p++) if (has[i][cls[base + p]]) from[i++] = p + 1;
                    lo = slot ? from[slot - 1] : 0;
                    i = k - 1;
                    for (let p = n - 1; p >= 0 && i >= slot; p--) if (has[i][cls[base + p]]) till[i--] = p;
                    hi = slot < k ? till[slot] : n;
                }
                if (lo >= hi) continue;
                round++;
                for (let p = lo; p < hi; p++) {
                    const c = cls[base + p];
                    for (let y = clsOff[c]; y < clsOff[c + 1]; y++) {
                        const t = clsTok[y];
                        if (stamp[t] === round) continue;
                        stamp[t] = round;
                        if (us[t] + ns[t] + nl[t] === 0) touched.push(t);
                        us[t] += l.us[s];
                        ns[t] += l.ns[s];
                        nl[t] += l.nl[s];
                        ul[t] += l.ul[s];
                    }
                }
            }
            for (const t of touched) {
                each(slot, t, us[t], ns[t], nl[t], ul[t]);
                us[t] = ns[t] = nl[t] = ul[t] = 0;
            }
        }
    }

    private insert(m: Pattern, slot: number, t: number): Pattern {
        if (slot === -1) return { toks: [t, ...m.toks], gaps: [NEXT, ...m.gaps], tail: m.tail };
        const toks = m.toks.slice();
        const gaps = m.gaps.slice();
        toks.splice(slot, 0, t);
        if (slot === m.toks.length) {
            gaps.push(m.tail);
            return { toks, gaps, tail: ANY };
        }
        gaps.splice(slot, 1, gaps[slot], ANY);
        return { toks, gaps, tail: m.tail };
    }

    private percent(a: number, b: number): string {
        return `${(b ? 100 * a / b : 0).toFixed(1).replace('.', ',')}%`;
    }

    /** wagi rankingow: roznica czesci malych i duzych; male * purity^3 */
    private static ranks(us: number, ns: number, nl: number, allS: number, allL: number): [number, number] {
        return [(allS ? us / allS : 0) - (allL ? nl / allL : 0), us * cubed(purityOf(ns, nl))];
    }

    /** Dalsze wersje stanu. */
    private expand(l: Live, st: State): State[] {
        const { opt, space } = this;
        const { tokens } = space.q;
        const out: State[] = [];
        const k = st.m.toks.length;
        const min = opt.minCount;
        if (k < MAX_TOKS) {
            const adds: { slot: number; t: number; us: number; nl: number; a: number; b: number }[] = [];
            this.rank(l, st, (slot, t, us, ns, nl) => {
                if (us < min) return;
                const [a, b] = Builder.ranks(us, ns, nl, st.us, st.nl);
                adds.push({ slot, t, us, nl, a, b });
            });
            const picked = new Set<number>();
            for (const front of [true, false]) {
                for (const by of ['a', 'b'] as const) {
                    let left = opt.beam;
                    for (const x of adds.filter(y => (y.slot === -1) === front).sort((p, q) => q[by] - p[by] || q.us - p.us || p.t - q.t || p.slot - q.slot)) {
                        if (left-- === 0) break;
                        const id = (x.slot + 1) * tokens.length + x.t;
                        if (picked.has(id)) continue;
                        picked.add(id);
                        const m = this.insert(st.m, x.slot, x.t);
                        if (!this.valid(m)) continue;
                        out.push(this.child(l, st, m, `+ ${tokens[x.t].text}  ranking 1: ${this.percent(x.us, st.us)} malych, ${this.percent(x.nl, st.nl)} duzych`));
                    }
                }
            }
        }
        // ---- zawezenie
        if (st.nl > 0) {
            for (let i = 0; i <= k; i++) {
                const g = i < k ? st.m.gaps[i] : st.m.tail;
                if (!g.any) continue;
                for (const to of [0, 1, 2]) {
                    const gap = { min: to, any: false };
                    const m = { toks: st.m.toks, gaps: st.m.gaps.map((x, j) => (j === i ? gap : x)), tail: i === k ? gap : st.m.tail };
                    if (this.valid(m)) out.push(this.child(l, st, m, 'zawezenie'));
                }
            }
        }
        // ---- EXCLUDE
        if (st.ex.length < MAX_EX && st.nl > 0 && this.w.large > 0) {
            const best: { t: number; nl: number; ns: number; v: number; kind: number }[] = [];
            this.rank(l, { m: { toks: [], gaps: [], tail: ANY }, seqs: st.seqs }, (_slot, t, us, ns, nl, ul) => {
                if (nl < opt.exMin || st.m.toks.includes(t) || tokens[t].dated || tokens[t].text.includes('-')) return;
                const v = this.pLarge(ul) - this.pSmall(us) - this.w.exclude;
                const fits = st.lost + ns <= opt.loss * (st.ns + st.lost) + 1e-9;
                // bez progu punktow: EXCLUDE moze byc potrzebny do purity
                if (fits && (v > 0 || nl >= 0.2 * st.nl)) best.push({ t, nl, ns, v: this.pLarge(ul) - this.pSmall(us), kind: tokens[t].kind });
            });
            best.sort((a, b) => b.v - a.v || a.kind - b.kind || a.t - b.t);
            for (const e of best.slice(0, Math.max(2, opt.beam >> 2))) {
                const hit = space.matcher(this.exPattern(e.t));
                const gone = [...st.gone];
                const seqs = st.seqs.filter(s => {
                    const x = hit(s);
                    if (x) gone.push(s);
                    return !x;
                });
                out.push(this.measure(l, st.m, [...st.ex, e.t], seqs, Int32Array.from(gone), st,
                    `EXCLUDE ${tokens[e.t].text}  ranking 2: ${this.percent(e.nl, st.nl)} duzych, ${this.percent(e.ns, st.ns)} malych`));
            }
        }
        return out;
    }

    /** Najlepsze maski dla nieobjetych malych, od najwiekszej liczby punktow. */
    private search(l: Live, banned: Set<string>): State[] {
        const { opt, space } = this;
        const { tokens } = space.q;
        const found = new Map<string, State>();
        let bestPoints = 0;
        const room = { allS: 0, allL: 0 };
        for (let s = 0; s < space.q.count; s++) {
            room.allS += l.us[s];
            room.allL += l.nl[s];
        }
        if (room.allS < opt.minCount) return [];
        const id = (st: State) => `${st.us}|${st.ns}|${st.nl}|${Math.round(st.ul)}|${st.ex.length}`;
        const consider = (st: State) => {
            if (!this.good(l, st) || this.isBanned(st, banned)) return;
            const k = id(st);
            const old = found.get(k);
            if (old && old.points >= st.points) return;
            found.set(k, st);
            bestPoints = Math.max(bestPoints, st.points);
        };

        // ---- start: najlepsze kwalifikatory na dowolnym i na pierwszym miejscu
        const seeds: { front: boolean; t: number; us: number; nl: number; a: number; b: number }[] = [];
        for (const front of [false, true]) {
            const base: Pattern = front ? { toks: [], gaps: [], tail: ANY } : { toks: [], gaps: [], tail: ANY };
            const add = (t: number, us: number, ns: number, nl: number) => {
                if (us < opt.minCount) return;
                const [a, b] = Builder.ranks(us, ns, nl, room.allS, room.allL);
                seeds.push({ front, t, us, nl, a, b });
            };
            if (!front) this.rank(l, { m: base, seqs: this.all }, (_s, t, us, ns, nl) => add(t, us, ns, nl));
            else this.rankFirst(l, add);
        }
        const picked = new Set<string>();
        let beam: State[] = [];
        for (const front of [false, true]) {
            for (const by of ['a', 'b'] as const) {
                for (const x of seeds.filter(y => y.front === front).sort((p, q) => q[by] - p[by] || q.us - p.us || p.t - q.t).slice(0, 3 * opt.beam)) {
                    if (picked.has(`${front}${x.t}`)) continue;
                    picked.add(`${front}${x.t}`);
                    const m: Pattern = { toks: [x.t], gaps: [front ? NEXT : ANY], tail: ANY };
                    if (!this.valid(m)) continue;
                    beam.push(this.fresh(l, m, [], null, `start: ${tokens[x.t].text}  ranking 1: ${this.percent(x.us, room.allS)} malych, ${this.percent(x.nl, room.allL)} duzych`));
                }
            }
        }
        beam.forEach(consider);
        const seen = new Set<string>();
        for (let depth = 0; depth < 2 * MAX_TOKS && beam.length && !this.late(); depth++) {
            const next: State[] = [];
            for (const st of beam) {
                if (this.late()) break;
                for (const c of this.expand(l, st)) {
                    const k = `${key(c.m)}/${c.ex.slice().sort((a, b) => a - b)}`;
                    if (seen.has(k) || c.us < opt.minCount) continue;
                    seen.add(k);
                    next.push(c);
                }
            }
            next.forEach(consider);
            // szansa: gdyby odpadly wszystkie duze
            const hope = next.filter(st => st.nl > 0 && st.points + this.pLarge(st.ul) > bestPoints);
            beam = [];
            const same = new Set<string>();
            for (const front of [true, false]) {
                const part = hope.filter(st => !st.m.gaps[0].any && st.m.gaps[0].min === 0 === front);
                for (const by of [0, 1]) {
                    const v = new Map(part.map(st => [st, Builder.ranks(st.us, st.ns, st.nl, room.allS, room.allL)[by]]));
                    let left = Math.ceil(opt.beam / 2);
                    for (const st of part.sort((a, b) => v.get(b)! - v.get(a)! || b.points - a.points || (key(a.m) < key(b.m) ? -1 : 1))) {
                        if (left === 0) break;
                        const k = `${front}${id(st)}`;
                        if (same.has(k)) continue;
                        same.add(k);
                        beam.push(st);
                        left--;
                    }
                }
            }
        }
        const list = [...found.values()].sort((a, b) => b.points - a.points || (this.space.text(a.m) < this.space.text(b.m) ? -1 : 1)).slice(0, 6);
        const better = new Map<string, State>();
        for (const st of list) {
            const x = this.improve(l, st, banned);
            const k = space.text(x.m);
            if (!better.has(k) || better.get(k)!.points < x.points) better.set(k, x);
        }
        return [...better.values()].sort((a, b) => b.points - a.points || (this.space.text(a.m) < this.space.text(b.m) ? -1 : 1));
    }

    private rankFirst(l: Live, add: (t: number, us: number, ns: number, nl: number) => void): void {
        const { count, off, cls, clsOff, clsTok, tokens } = this.space.q;
        const [us, ns, nl] = [0, 1, 2].map(() => new Float64Array(tokens.length));
        for (let s = 0; s < count; s++) {
            if (off[s] === off[s + 1]) continue;
            const c = cls[off[s]];
            for (let y = clsOff[c]; y < clsOff[c + 1]; y++) {
                us[clsTok[y]] += l.us[s];
                ns[clsTok[y]] += l.ns[s];
                nl[clsTok[y]] += l.nl[s];
            }
        }
        for (let t = 0; t < tokens.length; t++) add(t, us[t], ns[t], nl[t]);
    }

    /** Odejmowanie i poprawianie gotowej maski: kazdy ruch, ktory daje wiecej punktow. */
    private improve(l: Live, start: State, banned: Set<string>): State {
        const { space } = this;
        const { tokens, clsOff, clsTok } = space.q;
        let st = start;
        for (let iter = 0; iter < 12 && !this.late(); iter++) {
            const k = st.m.toks.length;
            const tries: { m: Pattern; ex: number[]; note: string }[] = [];
            const put = (m: Pattern, note: string, ex = st.ex) => {
                if (m.toks.length && this.valid(m)) tries.push({ m, ex, note });
            };
            for (let i = 0; i < k && k > 1; i++) {
                // bez kwalifikatora i: odstep przed nim i za nim razem
                const gaps = st.m.gaps.slice();
                const after = i + 1 < k ? gaps[i + 1] : st.m.tail;
                gaps.splice(i, 2, { min: i === 0 ? 0 : gaps[i].min + after.min, any: i === 0 ? after.any || gaps[0].any : true });
                const toks = st.m.toks.filter((_, j) => j !== i);
                const word = `- ${tokens[st.m.toks[i]].text}`;
                if (i === k - 1) put({ toks, gaps: gaps.slice(0, k - 1), tail: ANY }, word);
                else if (i === 0) {
                    put({ toks, gaps: [ANY, ...gaps.slice(1)], tail: st.m.tail }, word);
                    put({ toks, gaps: [NEXT, ...gaps.slice(1)], tail: st.m.tail }, word);
                } else {
                    put({ toks, gaps, tail: st.m.tail }, word);
                }
            }
            for (let i = 0; i < k; i++) {
                // inny element z tych samych kwalifikatorow (LOGDAY, LOG*, D%%%%%%, D*)
                const h = space.has(st.m.toks[i]);
                const other = new Set<number>();
                for (let c = 0, n = 0; c < h.length && n < 3; c++) {
                    if (!h[c]) continue;
                    n++;
                    for (let y = clsOff[c]; y < clsOff[c + 1]; y++) if (clsTok[y] !== st.m.toks[i] && !tokens[clsTok[y]].dated) other.add(clsTok[y]);
                }
                for (const t of other) put({ ...st.m, toks: st.m.toks.map((x, j) => (j === i ? t : x)) }, `${tokens[st.m.toks[i]].text} -> ${tokens[t].text}`);
            }
            for (let i = 0; i <= k; i++) {
                const g = i < k ? st.m.gaps[i] : st.m.tail;
                const set = (gap: Gap, note: string) => put({ toks: st.m.toks, gaps: st.m.gaps.map((x, j) => (j === i ? gap : x)), tail: i === k ? gap : st.m.tail }, note);
                if (!g.any) set(ANY, 'szerszy odstep');
                for (const min of [0, 1, 2]) if (g.any || g.min !== min) set({ min, any: false }, 'inny odstep');
            }
            if (k < MAX_TOKS) {
                // pelny kwalifikator, ktory maja wszystkie male tej maski: wezsza, o ile wyglad nie drozszy
                const same: { slot: number; t: number }[] = [];
                this.rank(l, st, (slot, t, _us, ns) => {
                    if (slot >= 0 && ns === st.ns && tokens[t].kind === 0 && !tokens[t].dated) same.push({ slot, t });
                });
                for (const { slot, t } of same.sort((a, b) => b.slot - a.slot || a.t - b.t).slice(0, 10)) {
                    const m = this.insert(st.m, slot, t);
                    for (const a of [0, 1, -1]) {
                        for (const c of [0, 1, -1]) {
                            const gap = (x: number): Gap => (x < 0 ? ANY : { min: x, any: false });
                            const gaps = m.gaps.slice();
                            gaps[slot] = gap(a);
                            if (slot + 1 < gaps.length) gaps[slot + 1] = gap(c);
                            put({ toks: m.toks, gaps, tail: slot + 1 < gaps.length ? m.tail : gap(c) }, `+ ${tokens[t].text} (maja wszystkie male)`);
                        }
                    }
                }
            }
            for (const t of st.ex) put(st.m, `bez EXCLUDE ${tokens[t].text}`, st.ex.filter(x => x !== t));
            let best: State | null = null;
            for (const x of tries) {
                const c = this.fresh(l, x.m, x.ex, st, x.note);
                if (c.points > (best ?? st).points + 1e-9 && this.good(l, c) && !this.isBanned(c, banned)) best = c;
            }
            if (!best) break;
            st = best;
        }
        return st;
    }

    item(m: Pattern): Item {
        return { m, seqs: this.space.select(m) };
    }

    /** Lista z maska stanu i jej EXCLUDE (ogolnym albo tylko pod poczatkiem maski), w granicach; null = nie mozna. */
    private apply(list: List, st: State): { list: List; score: number } | null {
        let forms: List[] = [{ inc: [...list.inc, this.item(st.m)], exc: list.exc }];
        for (const t of st.ex) {
            const wide = this.item(this.exPattern(t));
            const local: Pattern[] = [];
            if (!st.m.gaps[0].any && st.m.gaps[0].min === 0) local.push({ toks: [st.m.toks[0], t], gaps: [NEXT, ANY], tail: ANY });
            const narrow = local.filter(m => this.valid(m)).map(m => this.item(m));
            forms = forms.flatMap(f => [wide, ...narrow].map(x => ({ inc: f.inc, exc: [...f.exc, x] })));
        }
        let best: { list: List; score: number } | null = null;
        for (const f of forms) {
            const l = this.live(f);
            if (!this.allowed(f, l)) continue;
            const score = this.score(f, l);
            if (!best || score > best.score + 1e-9) best = { list: f, score };
        }
        return best;
    }

    private proposal(l: Live, st: State, before: number, after: { list: List; score: number }, list: List): Proposal {
        const steps: Step[] = [];
        for (let x: State | null = st; x; x = x.parent) {
            steps.unshift({ text: this.space.text(x.m), exclude: x.ex.map(t => this.space.text(this.exPattern(t))), small: x.ns, large: x.nl, note: x.note });
        }
        return {
            text: this.space.text(st.m), exclude: after.list.exc.slice(list.exc.length).map(i => this.space.text(i.m)),
            gain: st.us, small: st.ns, large: st.nl, points: after.score - before, steps,
        };
    }

    /** Nastepne propozycje, od najlepszej; kazda poprawia liste i miesci sie w granicach. */
    next(list: List, banned: Set<string>): { st: State; after: { list: List; score: number }; p: Proposal }[] {
        if (this.full(list)) return [];
        const l = this.live(list);
        const before = this.score(list, l);
        const out: { st: State; after: { list: List; score: number }; p: Proposal }[] = [];
        for (const st of this.search(l, banned)) {
            const after = this.apply(list, st);
            if (after && after.score > before + 1e-9) out.push({ st, after, p: this.proposal(l, st, before, after, list) });
        }
        return out.sort((a, b) => b.after.score - a.after.score);
    }

    /** EXCLUDE wspolne dla calej listy, dopoki daja punkty. */
    private excludes(list: List, journal: Change[], enough?: (l: List) => boolean): List {
        const { space, opt } = this;
        const { tokens } = space.q;
        let cur = list;
        while (!this.full(cur) && !this.late() && !enough?.(cur)) {
            const l = this.live(cur);
            const before = this.score(cur, l);
            const cov = space.mark.map(m => m & OLD_INC);
            for (const i of cur.inc) for (let x = 0; x < i.seqs.length; x++) cov[i.seqs[x]] = 1;
            const seqs = this.all.filter(s => cov[s] && (l.ns[s] || l.nl[s]));
            const kb: Live = { ...l, ul: space.largeKb };
            const cands: { t: number; v: number }[] = [];
            this.rank(kb, { m: { toks: [], gaps: [], tail: ANY }, seqs }, (_s, t, _us, ns, nl, ul) => {
                const v = this.pLarge(ul) - this.pSmall(ns) - this.w.exclude;
                if (nl >= opt.exMin && v > 0 && !tokens[t].dated && !tokens[t].text.includes('-')) cands.push({ t, v });
            });
            cands.sort((a, b) => b.v - a.v || a.t - b.t);
            let best: { list: List; score: number } | null = null;
            for (const c of cands.slice(0, 20)) {
                const next = { inc: cur.inc, exc: [...cur.exc, this.item(this.exPattern(c.t))] };
                const after = this.live(next);
                const score = this.score(next, after);
                if (score > Math.max(before, best?.score ?? -Infinity) + 1e-9 && this.allowed(next, after)) best = { list: next, score };
            }
            if (!best) break;
            cur = best.list;
            journal.push({ text: `wspolny EXCLUDE ${space.text(cur.exc[cur.exc.length - 1].m)}`, points: best.score - before });
        }
        return cur;
    }

    /** Bez masek i EXCLUDE, ktore kosztuja wiecej, niz daja. */
    private prune(list: List, journal: Change[]): List {
        let cur = list;
        for (;;) {
            const before = this.score(cur);
            let best: { list: List; score: number; text: string } | null = null;
            for (const kind of ['inc', 'exc'] as const) {
                for (const i of cur[kind]) {
                    const next = { ...cur, [kind]: cur[kind].filter(x => x !== i) };
                    const l = this.live(next);
                    const score = this.score(next, l);
                    if (score > (best?.score ?? before) + 1e-9 && this.allowed(next, l)) best = { list: next, score, text: this.space.text(i.m) };
                }
            }
            if (!best) return cur;
            cur = best.list;
            journal.push({ text: `usunieta ${best.text}`, points: best.score - before });
        }
    }

    accept(p: Proposal): Change {
        this.origin.set(p.text, p);
        return { text: `maska ${p.text}${p.exclude.map(e => `  EXCLUDE ${e}`).join('')}`, points: p.points };
    }

    private grow(list: List, journal: Change[], tick: (list: List) => void): List {
        let cur = list;
        while (!this.late()) {
            const [best] = this.next(cur, new Set());
            if (!best) break;
            cur = best.after.list;
            journal.push(this.accept(best.p));
            tick(cur);
        }
        return cur;
    }

    /**
     * Lista bez masek gone, zbudowana od nowa kilkoma sposobami; null, gdy zadna nie jest lepsza:
     *   one      najlepsza maska, potem ewentualnie druga
     *   split    mniejsze maski (kazda daje mniej malych niz gone razem)
     *   anchored bez ** na poczatku
     */
    private redo(cur: List, gone: Item[], ways: ('one' | 'split' | 'anchored')[]): { list: List; score: number; steps: Change[] } | null {
        const before = this.score(cur);
        const without = this.prune({ inc: cur.inc.filter(x => !gone.includes(x)), exc: cur.exc }, []);
        const l = this.live(without);
        let gain = 0;
        for (const s of new Set(gone.flatMap(i => [...i.seqs]))) gain += l.us[s];
        let best: { list: List; score: number; steps: Change[] } | null = null;
        for (const way of ways) {
            this.cap = way === 'split' ? 0.95 * gain : Infinity;
            this.anchored = way === 'anchored';
            const steps: Change[] = [];
            let next = without;
            for (let more = 0; more < (way === 'one' ? 2 : SPLIT) && !this.late(); more++) {
                const [x] = this.next(next, new Set());
                if (!x) break;
                next = x.after.list;
                steps.push(this.accept(x.p));
                const after = this.live(next);
                const score = this.score(next, after);
                if (score > Math.max(before, best?.score ?? -Infinity) + 1e-9 && this.allowed(next, after)) best = { list: next, score, steps: steps.slice() };
            }
        }
        this.cap = Infinity;
        this.anchored = false;
        return best;
    }

    /** Druga runda: kazda maska raz wyjeta i zbudowana od nowa przy pozostalych; potem maski o wspolnym poczatku razem. */
    private rebuild(list: List, journal: Change[], tick: (part: number, info: string) => void): List {
        let cur = list;
        const start = this.score(cur);
        const take = (r: ReturnType<Builder['redo']>, gone: Item[]) => {
            if (!r) return;
            journal.push({ text: `druga runda: zamiast ${gone.map(i => this.space.text(i.m)).join('  ')}`, points: r.score - this.score(cur) }, ...r.steps.map(x => ({ ...x, text: `  ${x.text}` })));
            cur = r.list;
        };
        // od maski, ktora daje najmniej
        const worth = cur.inc.map(i => ({ i, v: start - this.score({ inc: cur.inc.filter(x => x !== i), exc: cur.exc }) })).sort((a, b) => a.v - b.v);
        worth.forEach(({ i }, n) => {
            if (this.late() || !cur.inc.includes(i)) return;
            tick(n / worth.length, `druga runda: ${n + 1} z ${worth.length}`);
            take(this.redo(cur, [i], this.loose(i.m) ? ['one', 'split', 'anchored'] : ['one', 'split']), [i]);
        });
        const groups = new Map<string, Item[]>();
        for (const i of cur.inc) {
            if (this.loose(i.m)) continue;
            const k = this.space.q.tokens[i.m.toks[0]].text;
            groups.set(k, [...(groups.get(k) ?? []), i]);
        }
        for (const g of groups.values()) if (g.length > 1 && !this.late() && g.every(i => cur.inc.includes(i))) take(this.redo(cur, g, ['one']), g);
        return cur;
    }

    run(tick: Tick): BuildResult {
        const info = (l: List) => `masek: ${l.inc.length + l.exc.length}`;
        const part = (l: List) => Math.min(0.95, this.live(l).t.small / Math.max(1, this.space.np));
        // dwa starty: z maskami od ** i bez; kazdy poprawiany osobno
        const done = [false, true].map((anchored, n) => {
            const at = (p: number, t?: string) => tick((n + p) / 2, t);
            const journal: Change[] = [];
            this.minRaw = RAW[1];
            this.anchored = anchored;
            let list = this.grow({ inc: [], exc: [] }, journal, l => at(0.4 * part(l), info(l)));
            list = this.excludes(list, journal);
            list = this.prune(list, journal);
            this.minRaw = RAW[0];
            this.anchored = false;
            for (let round = 0; round < this.opt.rounds && !this.late(); round++) {
                const before = this.score(list);
                list = this.rebuild(list, journal, (p, t) => at(0.4 + 0.6 * ((round + p) / this.opt.rounds), t));
                list = this.grow(list, journal, () => {});
                list = this.excludes(list, journal);
                list = this.prune(list, journal);
                if (this.score(list) <= before + 1e-6) break;
            }
            return { list, journal, score: this.score(list) };
        });
        const best = done[1].score > done[0].score + 1e-9 ? done[1] : done[0];
        return this.result(best.list, best.journal);
    }

    /**
     * Lista z jedna maska wiecej (kolejnosc prob: STEP_RAW; od ** dopiero gdy inne nie daja punktow) i wspolnymi EXCLUDE.
     * Gdy nie ma maski, same EXCLUDE - i jeszcze raz maska, bo zwalniaja miejsce na duze. null = nic nie daje punktow.
     */
    step(list: List, journal: Change[]): List | null {
        const one = (from: List): List | null => {
            for (const anchored of this.w.start > 0 ? [true, false] : [false]) {
                for (const raw of STEP_RAW) {
                    this.anchored = anchored;
                    this.minRaw = raw;
                    const [best] = this.next(from, new Set());
                    if (!best) continue;
                    journal.push(this.accept(best.p));
                    return this.excludes(best.after.list, journal);
                }
            }
            return null;
        };
        const next = one(list);
        if (next) return next;
        const clean = this.excludes(list, journal);
        return clean === list ? null : one(clean) ?? clean;
    }

    /**
     * --target: maski az do pokrycia malych, od najczystszych - kazdy szczebel (purity maski po jej EXCLUDE, od najwyzszego)
     * daje maski, dopoki sa; potem wspolne EXCLUDE az do purity listy; jesli EXCLUDE zabraly pokrycie, znowu maski.
     * Liczby w sztukach (dane z allocKb = 1). Waga large na szczeblu p: p / (1 - p), wiec oplaca sie maska o purity od p.
     */
    target(goal: Goal, rungs: number[], tick: Tick): { result: BuildResult; steps: TargetStep[] } {
        this.byStep = true;
        const journal: Change[] = [];
        const steps: TargetStep[] = [];
        const base = this.w;
        let list: List = { inc: [], exc: [] };
        const reach = (l: List) => reached(this.live(l).t, this.space.np);
        const note = (what: TargetStep['what'], floor: number | null, from: List) => {
            const added = list.inc.length - from.inc.length + list.exc.length - from.exc.length;
            if (added) steps.push({ what, floor, include: list.inc.length, exclude: list.exc.length, reached: reach(list) });
        };
        let rung = 0;
        for (let cycle = 0; cycle < CYCLES && !this.late(); cycle++) {
            for (; rung < rungs.length && reach(list).small < goal.small - 1e-12 && !this.late(); rung++) {
                const floor = rungs[rung];
                (this.opt as { minPurity: number }).minPurity = floor;
                this.w = { ...base, large: largeWeight(floor) };
                const from = list;
                for (let r = reach(list); r.small < goal.small - 1e-12 && !this.late(); r = reach(list)) {
                    tick(Math.min(0.95, r.small / goal.small), `prog maski ${Math.round(100 * floor)}%, masek: ${list.inc.length + list.exc.length}, pokrycie ${(100 * r.small).toFixed(1)}%`);
                    const next = this.step(list, journal);
                    if (!next) break;
                    list = next;
                }
                note('maski', floor, from);
                // cel osiagniety na tym szczeblu: kolejne maski (po EXCLUDE) tez z niego
                if (reach(list).small >= goal.small - 1e-12) break;
            }
            this.w = { ...base, large: largeWeight(goal.purity) };
            const from = list;
            list = this.excludes(list, journal, l => reach(l).purity >= goal.purity - 1e-12);
            note('EXCLUDE', null, from);
            if (reach(list).small >= goal.small - 1e-12 || rung >= rungs.length || from === list) break;
        }
        this.w = base;
        return { result: this.result(list, journal), steps };
    }

    /** Lista bez masek INCLUDE o najnizszej purity, az purity listy dojdzie do celu (albo bez masek). */
    trimmed(r: BuildResult, purity: number): BuildResult | null {
        let list: List = { inc: r.include.map(t => this.item(this.space.parse(t)!)), exc: r.exclude.map(t => this.item(this.space.parse(t)!)) };
        const pur = (l: List) => reached(this.live(l).t, this.space.np).purity;
        if (pur(list) >= purity - 1e-12) return null;
        while (list.inc.length && pur(list) < purity - 1e-12) {
            const l = this.live(list);
            const own = (i: Item) => {
                let ns = 0;
                let nl = 0;
                for (let x = 0; x < i.seqs.length; x++) {
                    ns += l.ns[i.seqs[x]];
                    nl += l.nl[i.seqs[x]];
                }
                return purityOf(ns, nl);
            };
            const worst = list.inc.reduce((a, b) => (own(b) < own(a) ? b : a));
            list = { ...list, inc: list.inc.filter(x => x !== worst) };
        }
        return this.result(list, []);
    }

    /** Kolejne maski (--next), najwyzej steps; done po kazdej. */
    steps(steps: number, done: (r: BuildResult) => void, tick: Tick): BuildResult {
        this.byStep = true;
        const journal: Change[] = [];
        let list: List = { inc: [], exc: [] };
        for (let n = 0; n < steps && !this.late(); n++) {
            tick(Math.min(0.95, Math.max(n / steps, this.live(list).t.small / Math.max(1, this.space.np))), `masek: ${list.inc.length + list.exc.length}`);
            const next = this.step(list, journal);
            if (!next) break;
            list = next;
            done(this.result(list, journal));
        }
        return this.result(list, journal);
    }

    result(list: List, journal: Change[]): BuildResult {
        const l = this.live(list);
        const { t } = l;
        const parts = this.parts(list, t);
        // koszt masek, od ktorych zaczeto
        const base = this.base.include.reduce((x, m) => x + this.w.masks + shapeCost(m, this.w, this.space.head.length), 0)
            + this.base.exclude.reduce((x, m) => x + this.w.exclude + shapeCost(m, { ...this.w, start: 0 }, this.space.head.length), 0);
        return {
            ...this.texts(list), how: [...this.base.include.map(() => null), ...list.inc.map(i => this.origin.get(this.space.text(i.m)) ?? null)], changes: journal,
            totals: t, parts, points: this.score(list, { ...l, killed: 0 }) - base, stopped: this.stopped,
            old: { include: this.base.include.length, exclude: this.base.exclude.length }, before: this.before,
            left: { small: this.space.np - t.small - t.lost, dead: l.dead },
        };
    }
}

/** --target: czesc malych objetych lista i purity listy (0-1), w sztukach. */
export interface Goal {
    small: number;
    purity: number;
}

/** ile razy najwyzej maski -> EXCLUDE -> maski */
const CYCLES = 5;

export const reached = (t: Totals, np: number): Goal => ({ small: np ? t.small / np : 0, purity: purityOf(t.small, t.large) });

/** Waga duzych, przy ktorej oplaca sie maska (albo EXCLUDE) o purity od p. */
const largeWeight = (p: number) => Math.min(1000, p / Math.max(1e-9, 1 - p));

/** Etap --target: maski z jednego szczebla albo EXCLUDE; stan listy po nim. */
export interface TargetStep {
    what: 'maski' | 'EXCLUDE';
    floor: number | null;
    include: number;
    exclude: number;
    reached: Goal;
}

export interface TargetResult {
    result: BuildResult;
    steps: TargetStep[];
    reached: Goal;
    ok: boolean;
    /** gdy purity nie doszla do celu: lista bez najbrudniejszych masek, ktora ja spelnia */
    trimmed: { result: BuildResult; reached: Goal } | null;
}

/** Szczeble purity maski: cel purity, 90, 80, 70, 50% (nie wyzej niz cel), od najwyzszego. */
export const targetRungs = (purity: number) => [...new Set([purity, 0.9, 0.8, 0.7, 0.5].filter(x => x <= purity))].sort((a, b) => b - a);

/** Lista do celu (--target). */
export function buildTarget(input: CheckInput, opt: BuildOptions, goal: Goal, rungs: number[], stages: { names: Tick; build: () => Tick }): TargetResult {
    // sztuki zamiast KB: kazdy zbior wazy tyle samo
    const ones: CheckInput = { ...input, allocKb: new Float64Array(input.allocKb.length).fill(1) };
    const o = { ...opt, minCount: enough(input.pos.length, opt), maxLarge: opt.maxLarge };
    // EXCLUDE musza byc dostepne takze dla wagi celu purity
    const space = makeSpace(ones, { ...o, weights: { ...opt.weights, large: largeWeight(goal.purity) } }, stages.names);
    const b = new Builder(space, { ...o, minPurity: rungs[0] });
    const { result, steps } = b.target(goal, rungs, stages.build());
    const r = reached(result.totals, space.np);
    const ok = r.small >= goal.small - 1e-12 && r.purity >= goal.purity - 1e-12;
    const t = b.trimmed(result, goal.purity);
    return { result, steps, reached: r, ok, trimmed: t && { result: t, reached: reached(t.totals, space.np) } };
}

/** KB duzych, ktore musi wylaczyc EXCLUDE, zeby sie oplacil. */
function needKb(input: CheckInput, w: Points): number {
    let kb = 0;
    for (let i = 0; i < input.pos.length; i++) kb += input.allocKb[input.pos[i]];
    const part = w.large > 0 ? w.exclude / (100 * w.large) : 1;
    return Math.max(1, kb * Math.max(0.0005, part));
}

/** Ile malych musi dac maska, zeby sie oplacila. */
export function enough(np: number, opt: BuildOptions): number {
    const { small, masks } = opt.weights;
    return Math.max(opt.minCount, small > 0 ? Math.ceil(np * masks / (100 * small) - 1e-9) : np);
}

export function makeSpace(input: CheckInput, opt: BuildOptions, tick: Tick, extra: string[] = []): Space {
    return new Space(input, opt.head ?? [], enough(input.pos.length, opt), 0.5 * needKb(input, opt.weights), opt.partial, extra, tick, opt.base);
}

/** Cala lista automatem, z pytaniem po kazdej masce (ask) albo po kilka masek (by; jak ask z base: dalszy ciag listy). */
export function buildList(input: CheckInput, opt: BuildOptions, stages: { names: Tick; build: () => Tick }, ask?: Ask, by?: { steps: number; done: (r: BuildResult) => void }): BuildResult {
    const o = { ...opt, minCount: enough(input.pos.length, opt) };
    let space = makeSpace(input, o, stages.names);
    const tick = stages.build();
    let b = new Builder(space, o);
    if (by) return b.steps(by.steps, by.done, tick);
    if (!ask) return b.run(tick);
    const byStep = opt.base !== undefined;
    b.byStep = byStep;
    b.minRaw = RAW[1];
    const banned = new Set<string>();
    const extra: string[] = [];
    let list: List = { inc: [], exc: [] };
    let journal: Change[] = [];
    /** poprzednie stany listy: maski i dlugosc dziennika */
    const past: { texts: string[][]; journal: number }[] = [];
    const textsOf = (l: List) => [l.inc, l.exc].map(x => x.map(i => space.text(i.m)));
    const restore = (texts: string[][]): List => {
        const [inc, exc] = texts.map(l => l.map(t => b.item(space.parse(t)!)));
        return { inc, exc };
    };
    const put = (next: List, entry: Change) => {
        past.push({ texts: textsOf(list), journal: journal.length });
        list = next;
        journal.push(entry);
    };
    for (;;) {
        const found = b.next(list, banned);
        const last = journal[journal.length - 1];
        const a = ask(found.map(x => x.p), (opt.base?.include.length ?? 0) + list.inc.length + 1, b.live(list).t,
            last ?? null);
        if ('stop' in a) break;
        if ('undo' in a) {
            const old = past.pop();
            if (!old) continue;
            list = restore(old.texts);
            journal = journal.slice(0, old.journal);
        } else if ('take' in a) {
            const x = found[a.take];
            if (x) put(x.after.list, b.accept(x.p));
        } else if ('reject' in a) {
            if (found.length === 0) break;
            banned.add(found[0].p.text);
            banned.add(coverKey(found[0].st.seqs, found[0].st.gone));
        } else {
            let m = space.parse(a.mask);
            if (!m) {
                // elementy, ktorych nie bylo: nowe klasy kwalifikatorow, ta sama lista
                extra.push(...a.mask.split('.').filter(x => x !== '*' && x !== '**'));
                const texts = textsOf(list);
                space = makeSpace(input, o, () => {}, extra);
                for (const x of [...banned]) if (x.startsWith('#')) banned.delete(x);
                const { origin, free } = b;
                b = new Builder(space, o);
                b.byStep = byStep;
                b.minRaw = RAW[1];
                b.origin = origin;
                b.free = free;
                list = restore(texts);
                m = space.parse(a.mask);
            }
            if (!m) continue;
            b.free.add(space.text(m));
            const next = { inc: [...list.inc, b.item(m)], exc: list.exc };
            put(next, { text: `wpisana ${a.mask}`, points: b.score(next) - b.score(list) });
        }
    }
    return b.result(list, journal);
}
