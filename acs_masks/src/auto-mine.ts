/**
 * Szukanie masek dla milionow zbiorow. Maska = ciag elementow, po jednym na kwalifikator:
 *   literal            ABC
 *   cyfry -> %         D%%%%%%   (wzorzec z kwalifikatora malego zbioru)
 *   poczatek*          LOG*      (wspolny poczatek co najmniej dwoch kwalifikatorow malych zbiorow)
 *   *                  dowolny jeden kwalifikator
 * przed literalem, wzorcem i poczatkiem* moze stac ** (dowolnie wiele kwalifikatorow), na koncu maski tez (.**).
 * maxWild ogranicza liczbe *, poczatek* i ** w jednej masce (koncowe ** sie nie liczy). Pomijane: maska bez zadnego
 * znaku stalego, dluzsza niz 44 znaki; literal z data, czasem, numerem JES (D241113, T010203, JOB12345) poza pierwszym kwalifikatorem.
 *
 * Im wiecej znakow wieloznacznych, tym latwiej o maske czysta przypadkiem, wiec z dwoma i wiecej (maxWild) wymagane jest
 * odpowiednio wiecej malych: minCount * 2, * 3...
 *
 * Przeszukanie jest pelne: maski sa rozwijane od lewej, razem z lista nazw, ktore do nich pasuja (male i duze), wiec
 * liczby sa dokladne. Galaz konczy sie, gdy maska z .** ma mniej niz minCount malych (dluzsza nie bedzie miec wiecej)
 * albo spelnia prog czystosci (dluzsza nie obejmie wiecej). Nazwy o tych samych elementach sa jedna pozycja z waga.
 *
 * Wybor zachlanny: maska o najwiekszej liczbie nowo objetych malych (>= minCount, czystosc >= minPurity). Potem
 * kazda wybrana maska jest uscislana: najbardziej szczegolowa z obejmujacych te same male zbiory (najmniej duzych,
 * potem najwiecej znakow stalych, najmniej *, najkrotsza).
 */
import { MaskTree, within } from './auto-tree';
import { grow, Interner, IntList, PairMap, Tick } from './auto-util';

export interface MineOptions {
    minPurity: number;
    minCount: number;
    maxMasks: number;
    /** ile *, poczatek* i ** w masce poza koncowym ** */
    maxWild: number;
    /** kwalifikatory, od ktorych zaczyna sie kazda maska (bez '**'); wszystkie nazwy musza do nich pasowac */
    head?: string[];
}

export interface MaskRow {
    text: string;
    small: number;
    large: number;
    purity: number;
    smallKb: number;
    largeKb: number;
}

export interface MineResult {
    masks: MaskRow[];
    /** wszystkie maski razem, kazdy zbior raz */
    total: MaskRow;
    /** ile masek sprawdzono */
    candidates: number;
    /** kolejne wybory (przed usunieciem zbednych i uscisleniem): maska i liczba nowo objetych malych */
    steps: { text: string; gain: number }[];
}

export interface MineInput {
    names: Interner;
    allocKb: Float64Array;
    /** numery wierszy zbiorow malych i duzych */
    pos: Int32Array;
    neg: Int32Array;
}

/** Etapy: przygotowanie nazw, szukanie (liczba roznych ciagow kwalifikatorow), wybor (liczba sprawdzonych masek). */
export interface Stages {
    prepare: Tick;
    search: (sequences: number) => Tick;
    select: (candidates: number) => Tick;
}

const DOT = 46;
const PCT = 37;
const MAX_LEN = 44;
/** pozycje w nazwie sa bitami liczby 32-bitowej (nazwa z/OS ma najwyzej 22 kwalifikatory) */
const MAX_QUALS = 30;
const DATED = /^[A-Z#@$]{1,3}[0-9]{5,7}$/;

const isDigit = (b: number) => b >= 48 && b <= 57;
const bitPos = (m: number) => 31 - Math.clz32(m & -m);
const purityOf = (small: number, large: number) => (small ? small / (small + large) : 0);
const literalChars = (t: string) => t.replace(/[*%.]/g, '').length;
const starChars = (t: string) => t.replace(/[^*]/g, '').length;

/** Elementy masek (bez *). */
interface Tokens {
    text: string[];
    lit: Int32Array;
    stars: Int32Array;
    len: Int32Array;
    /** 1 = poczatek* (liczy sie do maxWild) */
    cost: Uint8Array;
    isLiteral: Uint8Array;
    /** literal z data, numerem: tylko jako pierwszy kwalifikator nazwy */
    dated: Uint8Array;
}

/** Nazwy jako ciagi klas kwalifikatorow; klasa = zestaw pasujacych elementow: clsTok[clsOff[c]..clsOff[c + 1]). */
interface Sequences {
    count: number;
    off: Int32Array;
    cls: Int32Array;
    clsOff: Int32Array;
    clsTok: Int32Array;
    /** ile malych / duzych zbiorow */
    wp: Int32Array;
    wn: Int32Array;
    /** pozycje duzych zbiorow (-1 = nazwa pominieta) */
    negSeq: Int32Array;
    tokens: Tokens;
}

/** Wynik przeszukania: maska jako ciag pozycji sciezki (element * 2 + 1, gdy przed nim **; STAR = samo *). */
interface Found {
    path: Int32Array;
    open: boolean;
    small: number;
    large: number;
    lit: number;
    stars: number;
    len: number;
}

const STAR = -1;

function prepare(input: MineInput, opt: MineOptions, tick: Tick): Sequences {
    const { names, pos, neg } = input;
    const { pool } = names;
    const min = opt.minCount;
    const np = pos.length;
    const skip = opt.head?.length ?? 0;
    /** poczatek kwalifikatorow za head; nazwa bez dalszych kwalifikatorow: koniec nazwy + 1 */
    const rest = (row: number): number => {
        let p = names.start[row];
        const e = p + names.len[row];
        for (let k = 0; k < skip; k++) {
            while (p < e && pool[p] !== DOT) p++;
            p++;
        }
        return p;
    };

    // ---- kwalifikatory malych zbiorow
    const quals = new Interner();
    let occ = new Int32Array(1 << 10);
    for (let i = 0; i < np; i++) {
        if ((i & 0xffff) === 0) tick(0.15 * (i / np));
        const e = names.start[pos[i]] + names.len[pos[i]];
        let b = rest(pos[i]);
        for (let p = b; p <= e; p++) {
            if (p < e && pool[p] !== DOT) continue;
            const id = quals.add(pool, b, p);
            if (id >= occ.length) occ = grow(occ, id + 1);
            occ[id]++;
            b = p + 1;
        }
    }
    occ = occ.slice(0, quals.size);

    // ---- elementy: czeste literaly, wzorce z %, poczatek*
    const pat = buildPatterns(quals, occ, min, part => tick(0.15 + 0.15 * part));
    const heads = buildHeads(quals, occ, min);
    const litTok = new Int32Array(quals.size).fill(-1);
    const text: string[] = [];
    for (let id = 0; id < quals.size; id++) {
        if (occ[id] < min) continue;
        litTok[id] = text.length;
        text.push(quals.text(id));
    }
    const patBase = text.length;
    text.push(...pat.texts);
    const headBase = text.length;
    text.push(...heads.texts.map(t => `${t}*`));
    const tokens: Tokens = {
        text,
        lit: Int32Array.from(text, literalChars),
        stars: Int32Array.from(text, starChars),
        len: Int32Array.from(text, t => t.length),
        cost: Uint8Array.from(text, (_, t) => Number(t >= headBase)),
        isLiteral: Uint8Array.from(text, (_, t) => Number(t < patBase)),
        dated: Uint8Array.from(text, (t, i) => Number(i < patBase && DATED.test(t))),
    };

    // ---- klasy kwalifikatorow: drzewo list elementow
    const tree = new PairMap();
    const clsParent = new IntList();
    const clsLast = new IntList();
    clsParent.push(-1);
    clsLast.push(-1);
    const list = new IntList();
    const classOf = (literal: number, b: number, e: number, buf: Uint8Array): number => {
        list.n = 0;
        if (literal >= 0) list.push(literal);
        const from = list.n;
        pat.match(buf, b, e, list);
        for (let x = from; x < list.n; x++) list.a[x] += patBase;
        const from2 = list.n;
        heads.match(buf, b, e, list);
        for (let x = from2; x < list.n; x++) list.a[x] += headBase;
        const l = list.a.subarray(0, list.n);
        l.sort();
        let c = 0;
        for (let x = 0; x < l.length; x++) {
            let t = tree.get(c, l[x]);
            if (t < 0) {
                t = clsParent.n;
                tree.set(c, l[x], t);
                clsParent.push(c);
                clsLast.push(l[x]);
            }
            c = t;
        }
        return c;
    };
    const qualClass = new Int32Array(quals.size);
    for (let id = 0; id < quals.size; id++) qualClass[id] = classOf(litTok[id], quals.start[id], quals.start[id] + quals.len[id], quals.pool);

    // ---- ciagi klas: nazwy o tym samym ciagu to jedna pozycja
    const seqs = new Interner();
    let wp = new Int32Array(1 << 10);
    let wn = new Int32Array(1 << 10);
    const buf = new Uint8Array(3 * 256);
    const sequence = (row: number): number => {
        const e = names.start[row] + names.len[row];
        let b = rest(row);
        let n = 0;
        for (let p = b; p <= e; p++) {
            if (p < e && pool[p] !== DOT) continue;
            const id = quals.find(pool, b, p);
            const c = id >= 0 ? qualClass[id] : classOf(-1, b, p, pool);
            buf[3 * n] = c >>> 16;
            buf[3 * n + 1] = c >>> 8;
            buf[3 * n + 2] = c;
            n++;
            b = p + 1;
        }
        if (n > MAX_QUALS) return -1;
        const s = seqs.add(buf, 0, 3 * n);
        if (s >= wp.length) {
            wp = grow(wp, s + 1);
            wn = grow(wn, s + 1);
        }
        return s;
    };
    for (let i = 0; i < np; i++) {
        if ((i & 0x3fff) === 0) tick(0.3 + 0.3 * (i / np));
        const s = sequence(pos[i]);
        if (s >= 0) wp[s]++;
    }
    const negSeq = new Int32Array(neg.length);
    for (let i = 0; i < neg.length; i++) {
        if ((i & 0x3fff) === 0) tick(0.6 + 0.4 * (i / neg.length));
        const s = sequence(neg[i]);
        negSeq[i] = s;
        if (s >= 0) wn[s]++;
    }

    const count = seqs.size;
    const off = new Int32Array(count + 1);
    for (let s = 0; s < count; s++) off[s + 1] = off[s] + seqs.len[s] / 3;
    const cls = new Int32Array(off[count]);
    for (let s = 0; s < count; s++) {
        for (let k = off[s], p = seqs.start[s]; k < off[s + 1]; k++, p += 3) {
            cls[k] = (seqs.pool[p] << 16) | (seqs.pool[p + 1] << 8) | seqs.pool[p + 2];
        }
    }
    const nc = clsParent.n;
    const clsOff = new Int32Array(nc + 1);
    for (let c = 0; c < nc; c++) {
        let n = 0;
        for (let x = c; x > 0; x = clsParent.a[x]) n++;
        clsOff[c + 1] = clsOff[c] + n;
    }
    const clsTok = new Int32Array(clsOff[nc]);
    for (let c = 0; c < nc; c++) {
        let k = clsOff[c + 1];
        for (let x = c; x > 0; x = clsParent.a[x]) clsTok[--k] = clsLast.a[x];
    }
    return { count, off, cls, clsOff, clsTok, wp, wn, negSeq, tokens };
}

/** Przeszukanie masek od lewej; wpis = ciag i pozycje (bity), na ktorych moze sie skonczyc poczatek maski. */
class Search {
    nodes = 0;
    private eSeq = new Int32Array(1 << 12);
    private eMask = new Int32Array(1 << 12);
    private top = 0;
    private readonly stamp: Int32Array;
    private readonly nEnt: Int32Array;
    private readonly wPos: Int32Array;
    private readonly wNeg: Int32Array;
    private readonly sig: Int32Array;
    private readonly slot: Int32Array;
    private readonly last: Int32Array;
    private round = 0;
    private readonly path: number[] = [];
    private readonly rnd1: Int32Array;
    private readonly rnd2: Int32Array;
    private readonly odd: Int32Array;

    constructor(private readonly q: Sequences, private readonly headText: string, private readonly maxWild: number) {
        const t = 2 * q.tokens.text.length;
        this.stamp = new Int32Array(t);
        this.nEnt = new Int32Array(t);
        this.wPos = new Int32Array(t);
        this.wNeg = new Int32Array(t);
        this.sig = new Int32Array(t);
        this.slot = new Int32Array(t).fill(-1);
        this.last = new Int32Array(t);
        let x = 0x9e3779b9;
        const next = () => {
            x = (x + 0x6d2b79f5) | 0;
            let h = Math.imul(x ^ (x >>> 15), 1 | x);
            h = (h + Math.imul(h ^ (h >>> 7), 61 | h)) ^ h;
            return h ^ (h >>> 14);
        };
        this.rnd1 = Int32Array.from({ length: q.count }, next);
        this.rnd2 = Int32Array.from({ length: q.count }, next);
        this.odd = Int32Array.from({ length: 32 }, () => next() | 1);
    }

    /**
     * @param min najmniej malych zbiorow; maska z w znakami wieloznacznymi: min * max(1, w)
     * @param weigh czy podnosic min
     * @param stop czy dobra maska (wynik emit) konczy galaz
     * @param emit maska (open: z koncowym .**) i wpisy, ktore obejmuje: [lo, hi); true = dobra
     */
    run(ids: ArrayLike<number>, min: number, weigh: boolean, stop: boolean,
        emit: (f: () => Found, small: number, large: number, h1: number, h2: number, cover: (f: (seq: number) => void) => void) => boolean, tick: Tick): void {
        const { q } = this;
        this.top = 0;
        this.reserve(ids.length);
        let sp = 0;
        let sn = 0;
        for (let i = 0; i < ids.length; i++) {
            this.eSeq[i] = ids[i];
            this.eMask[i] = 1;
            sp += q.wp[ids[i]];
            sn += q.wn[ids[i]];
        }
        this.top = ids.length;
        const { tokens, off, cls, clsOff, clsTok, wp, wn } = q;
        const { stamp, nEnt, wPos, wNeg, sig, slot, last, path, rnd1, rnd2, odd, maxWild } = this;
        const isHead = this.headText !== '';
        const needOf = (wild: number) => (weigh ? min * Math.max(1, wild) : min);
        const headLit = literalChars(this.headText);
        const headStars = starChars(this.headText);

        const node = (lo: number, hi: number, wild: number, lit: number, stars: number, len: number, small: number, large: number, from: number, to: number): void => {
            if ((this.nodes++ & 0xff) === 0) tick(from);
            const depth = path.length;
            const named = depth > 0 || isHead;
            const allowed = named && (lit > 0 || isHead);
            const need = needOf(wild);
            if (allowed) {
                let h1 = 0;
                let h2 = 0;
                let x1 = 0;
                let x2 = 0;
                let xs = 0;
                let xl = 0;
                for (let i = lo; i < hi; i++) {
                    const s = this.eSeq[i];
                    const exact = (this.eMask[i] >>> (off[s + 1] - off[s])) & 1;
                    if (exact) {
                        xs += wp[s];
                        xl += wn[s];
                    }
                    if (wp[s] === 0) continue;
                    h1 = (h1 + rnd1[s]) | 0;
                    h2 = (h2 + rnd2[s]) | 0;
                    if (exact) {
                        x1 = (x1 + rnd1[s]) | 0;
                        x2 = (x2 + rnd2[s]) | 0;
                    }
                }
                const make = (open: boolean) => (): Found => ({
                    path: Int32Array.from(path), open, small: open ? small : xs, large: open ? large : xl, lit,
                    stars: stars + (open ? 2 : 0), len: len + (open ? 3 : 0),
                });
                if (xs >= need && len <= MAX_LEN) {
                    emit(make(false), xs, xl, x1, x2, f => {
                        for (let i = lo; i < hi; i++) {
                            const s = this.eSeq[i];
                            if (wp[s] && (this.eMask[i] >>> (off[s + 1] - off[s])) & 1) f(s);
                        }
                    });
                }
                if (len + 3 <= MAX_LEN) {
                    const good = emit(make(true), small, large, h1, h2, f => {
                        for (let i = lo; i < hi; i++) if (wp[this.eSeq[i]]) f(this.eSeq[i]);
                    });
                    if (good && stop) return;
                }
            }

            // ---- zliczenie rozwiniec: x = element * 2 + (1: przed nim **)
            const canGap = wild < maxWild;
            const touched: number[] = [];
            let starEnt = 0;
            let starPos = 0;
            let starNeg = 0;
            let starSig = 0;
            for (let i = lo; i < hi; i++) {
                const s = this.eSeq[i];
                const n = off[s + 1] - off[s];
                const m = this.eMask[i] & ((1 << n) - 1);
                if (m === 0) continue;
                const base = off[s];
                const p0 = bitPos(m);
                const round = ++this.round;
                const r = wp[s] ? rnd1[s] : 0;
                starEnt++;
                starPos += wp[s];
                starNeg += wn[s];
                for (let p = p0; p < n; p++) {
                    const adj = (m >>> p) & 1;
                    const h = Math.imul(r, odd[p]);
                    if (adj) starSig = (starSig + h) | 0;
                    else if (!canGap) continue;
                    for (let y = clsOff[cls[base + p]]; y < clsOff[cls[base + p] + 1]; y++) {
                        const t = clsTok[y];
                        if (wild + tokens.cost[t] > maxWild || (tokens.dated[t] && (p > 0 || isHead))) continue;
                        for (let gap = adj ? 0 : 1; gap <= 1; gap++) {
                            if (gap && (!canGap || wild + 1 + tokens.cost[t] > maxWild)) break;
                            const x = 2 * t + gap;
                            if (nEnt[x] === 0) touched.push(x);
                            if (stamp[x] !== round) {
                                stamp[x] = round;
                                nEnt[x]++;
                                wPos[x] += wp[s];
                                wNeg[x] += wn[s];
                            }
                            sig[x] = (sig[x] + h) | 0;
                        }
                    }
                }
            }

            // ---- zostaja czeste; ogolniejsze obejmujace te same male na tych samych pozycjach co szczegolowsze - nie
            const key = (sg: number, w: number) => (sg >>> 0) * 2097152 + (w & 2097151);
            const literals = [new Set<number>(), new Set<number>()];
            const adjacent = new Set<number>();
            for (const x of touched) {
                if (wPos[x] < need) continue;
                const k = key(sig[x], wPos[x]);
                if (tokens.isLiteral[x >> 1]) literals[x & 1].add(k);
                if (!(x & 1)) adjacent.add(k);
            }
            const keep: { x: number; n: number; small: number; large: number; off: number }[] = [];
            const start = this.top;
            for (const x of touched) {
                if (wPos[x] < needOf(wild + (x & 1) + tokens.cost[x >> 1])) continue;
                const k = key(sig[x], wPos[x]);
                if (!tokens.isLiteral[x >> 1] && literals[x & 1].has(k)) continue;
                if (x & 1 && nEnt[x - 1] > 0 && wPos[x - 1] === wPos[x] && sig[x - 1] === sig[x]) continue;
                slot[x] = this.top;
                keep.push({ x, n: nEnt[x], small: wPos[x], large: wNeg[x], off: this.top });
                this.top += nEnt[x];
            }
            const star = wild < maxWild && starPos >= needOf(wild + 1) && !adjacent.has(key(starSig, starPos));
            if (star) {
                keep.push({ x: STAR, n: starEnt, small: starPos, large: starNeg, off: this.top });
                this.top += starEnt;
            }
            for (const x of touched) nEnt[x] = wPos[x] = wNeg[x] = sig[x] = 0;
            if (keep.length === 0) return;
            this.reserve(this.top);

            // ---- listy rozwiniec
            const { eSeq, eMask } = this;
            let starAt = star ? keep[keep.length - 1].off : 0;
            for (let i = lo; i < hi; i++) {
                const s = eSeq[i];
                const n = off[s + 1] - off[s];
                const m = eMask[i] & ((1 << n) - 1);
                if (m === 0) continue;
                const base = off[s];
                const round = ++this.round;
                if (star) {
                    eSeq[starAt] = s;
                    eMask[starAt++] = m << 1;
                }
                for (let p = bitPos(m); p < n; p++) {
                    const adj = (m >>> p) & 1;
                    if (!adj && !canGap) continue;
                    for (let y = clsOff[cls[base + p]]; y < clsOff[cls[base + p] + 1]; y++) {
                        const t = clsTok[y];
                        if (tokens.dated[t] && (p > 0 || isHead)) continue;
                        for (let x = 2 * t + (adj ? 0 : 1); x <= 2 * t + 1; x++) {
                            if (slot[x] < 0) continue;
                            if (stamp[x] !== round) {
                                stamp[x] = round;
                                last[x] = slot[x]++;
                                eSeq[last[x]] = s;
                                eMask[last[x]] = 0;
                            }
                            eMask[last[x]] |= 1 << (p + 1);
                        }
                    }
                }
            }
            let all = 0;
            for (const c of keep) {
                if (c.x !== STAR) slot[c.x] = -1;
                all += c.n;
            }
            let at = from;
            for (const c of keep) {
                const till = at + (to - from) * (c.n / all);
                const dot = named ? 1 : 0;
                path.push(c.x);
                if (c.x === STAR) {
                    node(c.off, c.off + c.n, wild + 1, lit, stars + 1, len + dot + 1, c.small, c.large, at, till);
                } else {
                    const t = c.x >> 1;
                    const gap = c.x & 1;
                    node(c.off, c.off + c.n, wild + gap + tokens.cost[t], lit + tokens.lit[t], stars + 2 * gap + tokens.stars[t],
                        len + dot + 3 * gap + tokens.len[t], c.small, c.large, at, till);
                }
                path.pop();
                at = till;
            }
            this.top = start;
        };
        node(0, ids.length, 0, headLit, headStars, this.headText.length, sp, sn, 0, 1);
    }

    private reserve(n: number): void {
        if (n <= this.eSeq.length) return;
        this.eSeq = grow(this.eSeq, n);
        this.eMask = grow(this.eMask, n);
    }
}

export function mine(input: MineInput, opt: MineOptions, stages: Stages): MineResult {
    const { names, allocKb, pos, neg } = input;
    const min = opt.minCount;
    const headText = (opt.head ?? []).join('.');
    const q = prepare(input, opt, stages.prepare);
    const { wp, wn, tokens } = q;

    // ---- przeszukanie: dobre maski, z masek o tych samych malych zbiorach jedna
    const tickSearch = stages.search(q.count);
    const search = new Search(q, headText, opt.maxWild);
    const textOf = (f: Found): string => {
        const parts = opt.head?.slice() ?? [];
        for (const x of f.path) {
            if (x !== STAR && x & 1) parts.push('**');
            parts.push(x === STAR ? '*' : tokens.text[x >> 1]);
        }
        if (f.open) parts.push('**');
        return parts.join('.');
    };
    /** lepsza z masek o tym samym zysku: czystosc, mniej duzych, wiecej znakow stalych, mniej *, krotsza */
    const rank = (a: Found, b: Found): number => purityOf(b.small, b.large) - purityOf(a.small, a.large) || a.large - b.large
        || b.lit - a.lit || a.stars - b.stars || a.len - b.len || (textOf(a) < textOf(b) ? -1 : 1);
    const good: Found[] = [];
    const byCover = new PairMap();
    const list = new IntList();
    const lo = new IntList();
    lo.push(0);
    if (pos.length >= min && q.count > 0) {
        const ids = new Int32Array(q.count);
        for (let s = 0; s < q.count; s++) ids[s] = s;
        search.run(ids, min, true, true, (make, small, large, h1, h2, cover) => {
            if (purityOf(small, large) < opt.minPurity) return false;
            const k = byCover.get(h1 >>> 1, h2 >>> 1);
            if (k >= 0) {
                const f = make();
                if (rank(f, good[k]) < 0) good[k] = f;
                return true;
            }
            byCover.set(h1 >>> 1, h2 >>> 1, good.length);
            good.push(make());
            cover(s => list.push(s));
            lo.push(list.n);
            return true;
        }, p => tickSearch(p, `sprawdzonych: ${search.nodes}`));
    }
    const candidates = search.nodes;

    // ---- wybor zachlanny, leniwie: zysk na kopcu jest gornym ograniczeniem
    const tickSel = stages.select(candidates);
    const gain = new Int32Array(good.length);
    const better = (x: number, y: number): boolean => (gain[x] !== gain[y] ? gain[x] > gain[y] : rank(good[x], good[y]) < 0);
    const heap = new Int32Array(good.length);
    let hn = 0;
    const up = (i: number) => {
        const v = heap[i];
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (!better(v, heap[p])) break;
            heap[i] = heap[p];
            i = p;
        }
        heap[i] = v;
    };
    const down = (i: number) => {
        const v = heap[i];
        for (;;) {
            let m = 2 * i + 1;
            if (m >= hn) break;
            if (m + 1 < hn && better(heap[m + 1], heap[m])) m++;
            if (!better(heap[m], v)) break;
            heap[i] = heap[m];
            i = m;
        }
        heap[i] = v;
    };
    for (let g = 0; g < good.length; g++) {
        gain[g] = good[g].small;
        heap[hn] = g;
        up(hn++);
    }
    const coveredSeq = new Uint8Array(q.count);
    const chosen: number[] = [];
    const steps: MineResult['steps'] = [];
    let pops = 0;
    while (hn > 0 && chosen.length < opt.maxMasks) {
        if ((pops++ & 0xff) === 0) {
            tickSel(0.6 * Math.max(chosen.length / opt.maxMasks, 1 - hn / good.length), `masek: ${chosen.length}`);
        }
        const g = heap[0];
        let now = 0;
        for (let x = lo.a[g]; x < lo.a[g + 1]; x++) if (!coveredSeq[list.a[x]]) now += wp[list.a[x]];
        if (now === gain[g] && now >= min) {
            for (let x = lo.a[g]; x < lo.a[g + 1]; x++) coveredSeq[list.a[x]] = 1;
            chosen.push(g);
            steps.push({ text: textOf(good[g]), gain: gain[g] });
            now = 0;
        }
        if (now < min) heap[0] = heap[--hn];
        else gain[g] = now;
        if (hn > 0) down(0);
    }

    // maski zbedne: wszystkie ich zbiory obejmuja inne wybrane (od ostatnio wybranych)
    const cover = new Int32Array(q.count);
    for (const g of chosen) for (let x = lo.a[g]; x < lo.a[g + 1]; x++) cover[list.a[x]]++;
    const keep = chosen.map(() => true);
    for (let j = chosen.length - 1; j >= 0; j--) {
        const g = chosen[j];
        let redundant = true;
        for (let x = lo.a[g]; x < lo.a[g + 1] && redundant; x++) if (cover[list.a[x]] < 2) redundant = false;
        if (!redundant) continue;
        keep[j] = false;
        for (let x = lo.a[g]; x < lo.a[g + 1]; x++) cover[list.a[x]]--;
    }
    const final = chosen.filter((_, j) => keep[j]);

    // ---- uscislenie: duze zbiory kazdej maski, potem szukanie wsrod masek obejmujacych wszystkie jej male
    const texts = final.map(g => textOf(good[g]));
    const negOf: Set<number>[] = final.map(() => new Set());
    if (final.length) {
        const tree = new MaskTree(texts.map(t => t.split('.')));
        for (let i = 0; i < neg.length; i++) {
            if ((i & 0x3fff) === 0) tickSel(0.6 + 0.1 * (i / neg.length));
            if (q.negSeq[i] < 0) continue;
            const s = names.start[neg[i]];
            for (const m of tree.match(names.pool, s, s + names.len[neg[i]])) negOf[m].add(q.negSeq[i]);
        }
    }
    final.forEach((g, j) => {
        tickSel(0.7 + 0.2 * (j / final.length), 'uscislanie masek');
        const ids = new Set(negOf[j]);
        for (let x = lo.a[g]; x < lo.a[g + 1]; x++) ids.add(list.a[x]);
        // male zbiory spoza maski nie moga tu trafic: ciag z duzych ma wage malych tylko, gdy pasuje do maski
        const all: Found[] = [];
        search.run([...ids], good[g].small, false, false, make => {
            all.push(make());
            return false;
        }, () => {});
        const own = texts[j].split('.');
        all.sort(rank);
        const best = all.find(f => {
            const t = textOf(f);
            return t === texts[j] || within(t.split('.'), own);
        });
        if (best) texts[j] = textOf(best);
    });

    // ---- liczby wprost z porownania wynikowych masek z nazwami
    const masks = texts.map((text): MaskRow => ({ text, small: 0, large: 0, purity: 0, smallKb: 0, largeKb: 0 }));
    const total: MaskRow = { text: 'RAZEM', small: 0, large: 0, purity: 0, smallKb: 0, largeKb: 0 };
    if (masks.length) {
        const tree = new MaskTree(texts.map(t => t.split('.')));
        const add = (rows: Int32Array, n: 'small' | 'large', kb: 'smallKb' | 'largeKb') => {
            for (let i = 0; i < rows.length; i++) {
                if ((i & 0x3fff) === 0) tickSel(0.9 + 0.1 * (i / rows.length), `masek: ${masks.length}`);
                const s = names.start[rows[i]];
                const ids = tree.match(names.pool, s, s + names.len[rows[i]]);
                if (ids.length === 0) continue;
                total[n]++;
                total[kb] += allocKb[rows[i]];
                for (const m of ids) {
                    masks[m][n]++;
                    masks[m][kb] += allocKb[rows[i]];
                }
            }
        };
        add(pos, 'small', 'smallKb');
        add(neg, 'large', 'largeKb');
        for (const m of [...masks, total]) m.purity = purityOf(m.small, m.large);
    }
    return { masks, total, candidates, steps };
}

interface Heads {
    texts: string[];
    match(buf: Uint8Array, s: number, e: number, into: IntList): void;
}

/**
 * poczatek*: wspolne poczatki (najdluzsze) par kwalifikatorow malych zbiorow, bez cyfr na koncu; co najmniej 3 znaki
 * albo 2, gdy dalej wspolne sa jeszcze cyfry; tylko pasujace do co najmniej min wystapien.
 */
function buildHeads(quals: Interner, occ: Int32Array, min: number): Heads {
    const { pool, start, len } = quals;
    const order = Int32Array.from({ length: quals.size }, (_, i) => i).sort((a, b) => {
        const n = Math.min(len[a], len[b]);
        for (let i = 0; i < n; i++) {
            const d = pool[start[a] + i] - pool[start[b] + i];
            if (d) return d;
        }
        return len[a] - len[b];
    });
    const set = new Set<string>();
    // wspolny poczatek dowolnej pary = wspolny poczatek pewnej pary sasiadow w porzadku alfabetycznym
    for (let i = 1; i < order.length; i++) {
        const a = order[i - 1];
        const b = order[i];
        let n = 0;
        while (n < len[a] && n < len[b] && pool[start[a] + n] === pool[start[b] + n]) n++;
        const common = n;
        while (n > 0 && isDigit(pool[start[a] + n - 1])) n--;
        if (n >= 8 || n < (common > n ? 2 : 3)) continue;
        set.add(quals.text(a).slice(0, n));
    }
    const next = new PairMap();
    const leaf = new IntList();
    const build = (texts: string[]) => {
        leaf.n = 0;
        leaf.push(-1);
        texts.forEach((t, id) => {
            let node = 0;
            for (let i = 0; i < t.length; i++) {
                let x = next.get(node, t.charCodeAt(i));
                if (x < 0) {
                    x = leaf.n;
                    leaf.push(-1);
                    next.set(node, t.charCodeAt(i), x);
                }
                node = x;
            }
            leaf.a[node] = id;
        });
    };
    const texts = [...set];
    build(texts);
    const sum = new Int32Array(texts.length);
    const walk = (buf: Uint8Array, s: number, e: number, f: (id: number) => void) => {
        let node = 0;
        for (let p = s; p < e; p++) {
            node = next.get(node, buf[p]);
            if (node < 0) return;
            if (leaf.a[node] >= 0) f(leaf.a[node]);
        }
    };
    for (let id = 0; id < quals.size; id++) walk(pool, start[id], start[id] + len[id], t => { sum[t] += occ[id]; });
    // rzadkie odpadaja; numery po kolei
    const renum = new Int32Array(texts.length).fill(-1);
    const kept: string[] = [];
    texts.forEach((t, id) => {
        if (sum[id] < min) return;
        renum[id] = kept.length;
        kept.push(t);
    });
    for (let x = 0; x < leaf.n; x++) if (leaf.a[x] >= 0) leaf.a[x] = renum[leaf.a[x]];
    return { texts: kept, match: (buf, s, e, into) => walk(buf, s, e, t => into.push(t)) };
}

interface Patterns {
    texts: string[];
    /** kwalifikator -> wzorzec z niego powstaly (cyfry -> %) albo -1 (bez cyfr, wzorzec za rzadki) */
    gen: Int32Array;
    /** kwalifikator -> pasujace wzorce: patList[patOff[id]..patOff[id + 1]) */
    patOff: Int32Array;
    patList: Int32Array;
    /** wzorce pasujace do kwalifikatora spoza malych zbiorow */
    match(buf: Uint8Array, s: number, e: number, into: IntList): void;
}

/**
 * Wzorce (cyfry -> %) kwalifikatorow, do ktorych pasuje co najmniej min wystapien kwalifikatorow o tej dlugosci.
 * Rozwijane znak po znaku: set = kwalifikatory pasujace do poczatku wzorca, own = te, ktorych wlasny wzorzec
 * tak sie zaczyna; galaz konczy sie, gdy own jest puste albo set ma mniej niz min wystapien.
 */
function buildPatterns(quals: Interner, occ: Int32Array, min: number, tick: Tick): Patterns {
    const { pool, start, len } = quals;
    const texts: string[] = [];
    const gen = new Int32Array(quals.size).fill(-1);
    const pq = new IntList();
    const pp = new IntList();
    const byLen: IntList[] = [];
    for (let id = 0; id < quals.size; id++) (byLen[len[id]] ??= new IntList()).push(id);

    const split = (set: Int32Array, d: number): Map<number, Int32Array> => {
        const cnt = new Int32Array(256);
        for (let x = 0; x < set.length; x++) cnt[pool[start[set[x]] + d]]++;
        const out = new Map<number, Int32Array>();
        for (let b = 0; b < 256; b++) {
            if (cnt[b]) out.set(b, new Int32Array(cnt[b]));
            cnt[b] = 0;
        }
        for (let x = 0; x < set.length; x++) {
            const b = pool[start[set[x]] + d];
            out.get(b)![cnt[b]++] = set[x];
        }
        return out;
    };
    const sum = (set: Int32Array) => {
        let s = 0;
        for (let x = 0; x < set.length; x++) s += occ[set[x]];
        return s;
    };
    const grownBy = (set: Int32Array, d: number, n: number, own: Int32Array, text: string, part: (x: number) => void): void => {
        if (d === n) {
            const id = texts.length;
            texts.push(text);
            for (let x = 0; x < set.length; x++) {
                pq.push(set[x]);
                pp.push(id);
            }
            for (let x = 0; x < own.length; x++) gen[own[x]] = id;
            return;
        }
        const ownBy = split(own, d);
        const digits: Int32Array[] = [];
        let nd = 0;
        for (const [b, o] of ownBy) {
            if (!isDigit(b)) continue;
            digits.push(o);
            nd += o.length;
        }
        if (nd) {
            const o = new Int32Array(nd);
            let w = 0;
            for (const x of digits) {
                o.set(x, w);
                w += x.length;
            }
            // occ(set) sie nie zmienia - set bez kopiowania
            grownBy(set, d + 1, n, o, `${text}%`, () => {});
        }
        if (nd < own.length) {
            const setBy = split(set, d);
            let no = 0;
            for (const [b, o] of ownBy) {
                part(++no / ownBy.size);
                if (isDigit(b)) continue;
                const s = setBy.get(b)!;
                if (sum(s) >= min) grownBy(s, d + 1, n, o, text + String.fromCharCode(b), () => {});
            }
        }
    };
    const total = byLen.length;
    byLen.forEach((l, n) => {
        const set = l.a.slice(0, l.n);
        const own = set.filter(id => {
            for (let p = start[id]; p < start[id] + n; p++) if (isDigit(pool[p])) return true;
            return false;
        });
        if (own.length && sum(set) >= min) grownBy(set, 0, n, own, '', x => tick((n - 1 + x) / total));
    });

    const patOff = new Int32Array(quals.size + 1);
    for (let x = 0; x < pq.n; x++) patOff[pq.a[x] + 1]++;
    for (let i = 0; i < quals.size; i++) patOff[i + 1] += patOff[i];
    const patList = new Int32Array(pq.n);
    const fill = patOff.slice();
    for (let x = 0; x < pq.n; x++) patList[fill[pq.a[x]]++] = pp.a[x];

    // drzewo wzorcow: wezel * 256 + bajt -> wezel; koniec wzorca -> numer
    const next = new PairMap();
    const leaf = new IntList();
    leaf.push(-1);
    texts.forEach((t, id) => {
        let node = 0;
        for (let i = 0; i < t.length; i++) {
            const b = t.charCodeAt(i);
            let x = next.get(node, b);
            if (x < 0) {
                x = leaf.n;
                leaf.push(-1);
                next.set(node, b, x);
            }
            node = x;
        }
        leaf.a[node] = id;
    });
    const walk = (buf: Uint8Array, p: number, e: number, node: number, into: IntList): void => {
        if (p === e) {
            if (leaf.a[node] >= 0) into.push(leaf.a[node]);
            return;
        }
        const any = next.get(node, PCT);
        if (any >= 0) walk(buf, p + 1, e, any, into);
        const same = next.get(node, buf[p]);
        if (same >= 0) walk(buf, p + 1, e, same, into);
    };
    return { texts, gen, patOff, patList, match: (buf, s, e, into) => walk(buf, s, e, 0, into) };
}
