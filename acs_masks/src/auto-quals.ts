/**
 * Najczestsze kombinacje kwalifikatorow w malych zbiorach. Kombinacja = 1-4 kwalifikatory w tej kolejnosci co w nazwie,
 * na dowolnych miejscach: A + B to wszystkie nazwy pasujace do **.A.**.B.**. Kwalifikator kombinacji:
 *   pelny       ABC
 *   niepelny    ABC*  *ABC  *ABC*   (co najmniej partial znakow stalych, w tym litera); gdy wszystkie male maja
 *               w tym miejscu te sama dlugosc: % zamiast * (ABC%%)
 *   cyfry -> %  D%%%%%%
 * Pomijane: pelny kwalifikator z data, czasem, numerem JES poza pierwszym miejscem; niepelny, ktory obejmuje te same
 * male kwalifikatory co szczegolowszy (PRO*, gdy wszystkie takie to PROD).
 *
 * Kombinacje o tych samych malych zbiorach to jeden wiersz: pierwsza ma najmniej duzych, pozostale sa w also.
 * Maska wiersza: najwezsza z kolejnoscia i odstepami z danych (PROD + TMP -> PROD.*.TMP.**), z tymi samymi malymi.
 *
 * Przeszukanie: kombinacje rozwijane od lewej z lista nazw i pozycja, za ktora mozna szukac dalszych kwalifikatorow
 * (najwczesniejsza wystarcza). Prog liczby malych schodzi poziomami do minCount; poziom konczy prace, gdy kazda tabela
 * jest pelna - pierwszych top wierszy jest wtedy dokladnych. Po przekroczeniu czasu zostaje wynik poprzedniego poziomu.
 *
 * Szersza kombinacja, ktora ma prawie tyle samo malych co szczegolowsza z tej samej tabeli (roznica do minGain), odpada.
 * Z minPurity w tabelach sa tylko kombinacje o tej czystosci, bez zawartych w innej, ktora juz go spelnia (dluzszych, wezszych).
 */
import { buildPatterns, DATED, literalChars, MaskRow, MAX_LEN, purityOf, starChars } from './auto-mine';
import { MaskTree, within } from './auto-tree';
import { CheckInput } from './auto-check';
import { grow, Interner, IntList, PairMap, thousands, Tick } from './auto-util';
import { MaskError, parseMask } from './mask';

export interface QualOptions {
    /** najwiecej kwalifikatorow w kombinacji */
    maxQuals: number;
    /** wierszy w tabeli */
    top: number;
    minCount: number;
    /** 0 = bez progu */
    minPurity: number;
    /** najmniej znakow stalych kwalifikatora niepelnego; 0 = tylko pelne */
    partial: number;
    /** kwalifikatory, od ktorych zaczynaja sie nazwy (nie wchodza do kombinacji) */
    head?: string[];
    seconds: number;
    /** szersza kombinacja musi miec o tyle wiecej malych (czesc) niz szczegolowsza z tej samej tabeli, inaczej jest pomijana */
    minGain: number;
}

export interface Combo {
    quals: string[];
    small: number;
    large: number;
    purity: number;
    smallKb: number;
    largeKb: number;
    /** najwezsza maska z tymi samymi malymi; null = dluzsza niz 44 znaki */
    mask: MaskRow | null;
    /** inne kombinacje o tych samych malych zbiorach */
    also: string[][];
    /** ile kolejnych takich nie zmiescilo sie w also */
    more: number;
}

export interface QualResult {
    small: number;
    large: number;
    /** [kwalifikatorow - 1] */
    tables: Combo[][];
    /** null = wynik pelny; inaczej przerwany: pewne sa tylko kombinacje o co najmniej tylu malych */
    floor: number | null;
    nodes: number;
}

const DOT = 46;
const MAX_ALSO = 12;
/** kwalifikator z data, czasem, numerem: nie daje czesci z cyframi */
const NUMBERED = /^[A-Z#@$]{1,3}[0-9]{4,7}$/;
/** wpisow list w jednej grupie rozwiniec (pamiec) */
const GROUP = 1 << 24;

class Timeout extends Error {}

/** Nazwy jako numery kwalifikatorow (za head): male, potem duze. */
interface Names {
    /** kwalifikatory malych zbiorow */
    quals: Interner;
    occ: Int32Array;
    /** kwalifikatory tylko duzych; numer + quals.size */
    other: Interner;
    off: Int32Array;
    ids: Int32Array;
    np: number;
    kb: Float64Array;
}

function readNames(input: CheckInput, skip: number, tick: Tick): Names {
    const { names, allocKb, pos, neg } = input;
    const { pool } = names;
    const total = pos.length + neg.length;
    const quals = new Interner();
    const other = new Interner();
    let occ = new Int32Array(1 << 10);
    const off = new Int32Array(total + 1);
    const ids = new IntList();
    const kb = new Float64Array(total);
    for (let i = 0; i < total; i++) {
        if ((i & 0x3fff) === 0) tick(i / total);
        const small = i < pos.length;
        const row = small ? pos[i] : neg[i - pos.length];
        kb[i] = allocKb[row];
        const e = names.start[row] + names.len[row];
        let b = names.start[row];
        for (let k = 0; k < skip; k++) {
            while (b < e && pool[b] !== DOT) b++;
            b++;
        }
        for (let p = b; p <= e; p++) {
            if (p < e && pool[p] !== DOT) continue;
            let id: number;
            if (small) {
                id = quals.add(pool, b, p);
                if (id >= occ.length) occ = grow(occ, id + 1);
                occ[id]++;
            } else {
                id = quals.find(pool, b, p);
                if (id < 0) id = quals.size + other.add(pool, b, p);
            }
            ids.push(id);
            b = p + 1;
        }
        off[i + 1] = ids.n;
    }
    return { quals, occ: occ.slice(0, quals.size), other, off, ids: ids.a.slice(0, ids.n), np: pos.length, kb };
}

/** Czesci kwalifikatorow malych zbiorow jako ABC*, *ABC, *ABC*; liczone po dlugosci (czeste tylko z czestych krotszych). */
function buildPartials(quals: Interner, occ: Int32Array, min: number, partial: number): string[] {
    const { pool, start, len } = quals;
    const out: string[] = [];
    if (partial === 0) return out;
    const literal = new Interner();
    for (let id = 0; id < quals.size; id++) literal.add(pool, start[id], start[id] + len[id]);
    // data, czas, numer JES: czesci tylko sprzed cyfr
    const digitsFrom = Uint8Array.from({ length: quals.size }, (_, id) => (NUMBERED.test(quals.text(id)) ? quals.text(id).search(/[0-9]/) : 255));
    let prev: Interner | null = null;
    let prevOk: Uint8Array = new Uint8Array(0);
    /** czesc o znak krotsza: 1 = dluzsza obejmuje to samo (kolejno: zawiera, poczatek, koniec) */
    let prevDrop: Uint8Array[] = [];
    let prevSum: Float64Array[] = [];
    let flush = () => {};
    for (let n = partial; n <= 8; n++) {
        const parts = new Interner();
        // kolejno: zawiera, poczatek, koniec; kazdy kwalifikator raz
        let sum: Float64Array[] = [0, 1, 2].map(() => new Float64Array(1 << 10));
        // dlugosc i miejsce czesci, gdy zawsze takie same: suma, najmniejsze i najwieksze
        let lo: Uint8Array = new Uint8Array(1 << 10).fill(255);
        let hi: Uint8Array = new Uint8Array(1 << 10);
        let loAt: Uint8Array = new Uint8Array(1 << 10).fill(255);
        let hiAt: Uint8Array = new Uint8Array(1 << 10);
        let preLo: Uint8Array = new Uint8Array(1 << 10).fill(255);
        let preHi: Uint8Array = new Uint8Array(1 << 10);
        let sufLo: Uint8Array = new Uint8Array(1 << 10).fill(255);
        let sufHi: Uint8Array = new Uint8Array(1 << 10);
        let seen: Int32Array = new Int32Array(1 << 10).fill(-1);
        const more = (a: Uint8Array, v: number) => {
            const b = grow(a, a.length * 2);
            if (v) b.fill(v, a.length);
            return b;
        };
        for (let id = 0; id < quals.size; id++) {
            for (let i = 0; i + n <= len[id]; i++) {
                const s = start[id] + i;
                if (digitsFrom[id] < i + n) continue;
                if (prev) {
                    const x = prev.find(pool, s, s + n - 1);
                    const y = prev.find(pool, s + 1, s + n);
                    if (x < 0 || y < 0 || !prevOk[x] || !prevOk[y]) continue;
                }
                const t = parts.add(pool, s, s + n);
                if (t >= seen.length) {
                    sum = sum.map(a => grow(a, t + 1));
                    [lo, loAt, preLo, sufLo] = [lo, loAt, preLo, sufLo].map(a => more(a, 255));
                    [hi, hiAt, preHi, sufHi] = [hi, hiAt, preHi, sufHi].map(a => more(a, 0));
                    const old = seen.length;
                    seen = grow(seen, t + 1);
                    seen.fill(-1, old);
                }
                if (seen[t] !== id) {
                    seen[t] = id;
                    sum[0][t] += occ[id];
                }
                lo[t] = Math.min(lo[t], len[id]);
                hi[t] = Math.max(hi[t], len[id]);
                loAt[t] = Math.min(loAt[t], i);
                hiAt[t] = Math.max(hiAt[t], i);
                if (i === 0) {
                    sum[1][t] += occ[id];
                    preLo[t] = Math.min(preLo[t], len[id]);
                    preHi[t] = Math.max(preHi[t], len[id]);
                }
                if (i + n === len[id]) {
                    sum[2][t] += occ[id];
                    sufLo[t] = Math.min(sufLo[t], len[id]);
                    sufHi[t] = Math.max(sufHi[t], len[id]);
                }
            }
        }
        const ok = new Uint8Array(parts.size);
        for (let t = 0; t < parts.size; t++) {
            if (sum[0][t] < min) continue;
            ok[t] = 1;
            if (!prev) continue;
            // dluzsza czesc obejmuje tyle samo co krotsza = te same kwalifikatory
            const x = prev.find(parts.pool, parts.start[t], parts.start[t] + n - 1);
            const y = prev.find(parts.pool, parts.start[t] + 1, parts.start[t] + n);
            if (sum[0][t] === prevSum[0][x]) prevDrop[0][x] = 1;
            if (sum[0][t] === prevSum[0][y]) prevDrop[0][y] = 1;
            if (sum[1][t] === prevSum[1][x]) prevDrop[1][x] = 1;
            if (sum[2][t] === prevSum[2][y]) prevDrop[2][y] = 1;
        }
        flush();
        const drop = [0, 1, 2].map(() => new Uint8Array(parts.size));
        flush = () => {
            for (let t = 0; t < parts.size; t++) {
                if (!ok[t]) continue;
                const text = parts.text(t);
                if (/^[0-9]+$/.test(text)) continue;
                const q = literal.find(parts.pool, parts.start[t], parts.start[t] + n);
                const own = q < 0 ? 0 : occ[q];
                const pct = (k: number) => '%'.repeat(k);
                if (sum[1][t] >= min && sum[1][t] > own && !drop[1][t]) {
                    out.push(preLo[t] === preHi[t] ? text + pct(preLo[t] - n) : `${text}*`);
                }
                if (sum[2][t] >= min && sum[2][t] > own && !drop[2][t]) {
                    out.push(sufLo[t] === sufHi[t] ? pct(sufLo[t] - n) + text : `*${text}`);
                }
                if (sum[0][t] > sum[1][t] && sum[0][t] > sum[2][t] && !drop[0][t]) {
                    out.push(lo[t] === hi[t] && loAt[t] === hiAt[t] ? pct(loAt[t]) + text + pct(lo[t] - n - loAt[t]) : `*${text}*`);
                }
            }
        };
        prev = parts;
        prevOk = ok;
        prevDrop = drop;
        prevSum = sum;
    }
    flush();
    return out;
}

/** Czy kazdy kwalifikator pasujacy do a pasuje do b (wzorzec b porownany ze znakami a: % i * jako znaki). */
export function narrower(a: string, b: string, i = 0, j = 0): boolean {
    for (; j < b.length; i++, j++) {
        if (b[j] === '*') {
            for (let x = i; x <= a.length; x++) if (narrower(a, b, x, j + 1)) return true;
            return false;
        }
        if (i >= a.length || a[i] === '*' || (b[j] !== '%' && a[i] !== b[j])) return false;
    }
    return i === a.length;
}

interface Token {
    text: string;
    lit: number;
    stars: number;
    /** literal z data, numerem: tylko jako pierwszy kwalifikator */
    dated: boolean;
}

/** Nazwy jako ciagi klas kwalifikatorow; klasa = pasujace elementy: clsTok[clsOff[c]..clsOff[c + 1]). */
interface Sequences {
    tokens: Token[];
    count: number;
    off: Int32Array;
    cls: Int32Array;
    /** za ostatnim kwalifikatorem z jakimkolwiek elementem */
    end: Uint8Array;
    clsOff: Int32Array;
    clsTok: Int32Array;
    wp: Int32Array;
    wn: Int32Array;
    kp: Float64Array;
    kn: Float64Array;
}

function buildSequences(n: Names, min: number, partial: number, hasHead: boolean, tick: Tick): Sequences {
    const { quals, occ, other } = n;
    const texts = new Set<string>();
    for (let id = 0; id < quals.size; id++) if (occ[id] >= min) texts.add(quals.text(id));
    const literals = texts.size;
    if (partial) {
        for (const t of buildPatterns(quals, occ, min, p => tick(0.2 * p)).texts) if (literalChars(t)) texts.add(t);
        for (const t of buildPartials(quals, occ, min, partial)) texts.add(t);
    }
    const tokens = [...texts].map((text, i): Token => ({ text, lit: literalChars(text), stars: starChars(text), dated: i < literals && DATED.test(text) }));
    tick(0.4);

    // ---- klasy: osobno dla pierwszego miejsca (tam wolno literal z data)
    const tree = new MaskTree(tokens.map(t => [t.text]));
    const step = new PairMap();
    const clsParent = new IntList();
    const clsLast = new IntList();
    clsParent.push(-1);
    clsLast.push(-1);
    const classOf = (list: number[]): number => {
        let c = 0;
        for (const t of list) {
            let x = step.get(c, t);
            if (x < 0) {
                x = clsParent.n;
                step.set(c, t, x);
                clsParent.push(c);
                clsLast.push(t);
            }
            c = x;
        }
        return c;
    };
    const all = quals.size + other.size;
    const first = new Int32Array(all);
    const later = new Int32Array(all);
    for (let id = 0; id < all; id++) {
        if ((id & 0xfff) === 0) tick(0.4 + 0.3 * (id / all));
        const from = id < quals.size ? quals : other;
        const x = id < quals.size ? id : id - quals.size;
        const list = tree.match(from.pool, from.start[x], from.start[x] + from.len[x]);
        const plain = list.some(t => tokens[t].dated) ? list.filter(t => !tokens[t].dated) : list;
        later[id] = classOf(plain);
        first[id] = plain === list || hasHead ? later[id] : classOf(list);
    }

    // ---- ciagi klas
    const seqs = new Interner();
    const buf = new Uint8Array(3 * 64);
    let wp = new Int32Array(1 << 10);
    let wn = new Int32Array(1 << 10);
    let kp = new Float64Array(1 << 10);
    let kn = new Float64Array(1 << 10);
    const total = n.off.length - 1;
    for (let i = 0; i < total; i++) {
        if ((i & 0x3fff) === 0) tick(0.7 + 0.3 * (i / total));
        let w = 0;
        for (let k = n.off[i]; k < n.off[i + 1]; k++) {
            const c = k === n.off[i] ? first[n.ids[k]] : later[n.ids[k]];
            buf[w++] = c >>> 16;
            buf[w++] = c >>> 8;
            buf[w++] = c;
        }
        const s = seqs.add(buf, 0, w);
        if (s >= wp.length) {
            wp = grow(wp, s + 1);
            wn = grow(wn, s + 1);
            kp = grow(kp, s + 1);
            kn = grow(kn, s + 1);
        }
        if (i < n.np) {
            wp[s]++;
            kp[s] += n.kb[i];
        } else {
            wn[s]++;
            kn[s] += n.kb[i];
        }
    }
    const count = seqs.size;
    const off = new Int32Array(count + 1);
    for (let s = 0; s < count; s++) off[s + 1] = off[s] + seqs.len[s] / 3;
    const cls = new Int32Array(off[count]);
    const end = new Uint8Array(count);
    for (let s = 0; s < count; s++) {
        for (let k = off[s], p = seqs.start[s]; k < off[s + 1]; k++, p += 3) {
            cls[k] = (seqs.pool[p] << 16) | (seqs.pool[p + 1] << 8) | seqs.pool[p + 2];
            if (cls[k]) end[s] = k - off[s] + 1;
        }
    }
    const nc = clsParent.n;
    const clsOff = new Int32Array(nc + 1);
    for (let c = 0; c < nc; c++) {
        let k = 0;
        for (let x = c; x > 0; x = clsParent.a[x]) k++;
        clsOff[c + 1] = clsOff[c] + k;
    }
    const clsTok = new Int32Array(clsOff[nc]);
    for (let c = 0; c < nc; c++) {
        let k = clsOff[c + 1];
        for (let x = c; x > 0; x = clsParent.a[x]) clsTok[--k] = clsLast.a[x];
    }
    return { tokens, count, off, cls, end, clsOff, clsTok, wp, wn, kp, kn };
}

interface Path {
    toks: number[];
    large: number;
}

/** Kombinacje o tych samych malych zbiorach. */
interface Entry {
    small: number;
    paths: Path[];
    more: number;
}

interface Child {
    t: number;
    n: number;
    small: number;
    large: number;
    c1: number;
    c2: number;
    at: number;
}

class Search {
    nodes = 0;
    /** tabele [liczba kwalifikatorow]: klucz = skrot zestawu malych zbiorow */
    readonly tables: Map<number, Entry>[];
    /** kombinacja tej dlugosci o mniejszej liczbie malych nie wejdzie do tabeli */
    private readonly thr: number[];
    private readonly pruneAt: number[];
    private readonly size: number;
    private eSeq = new Int32Array(1 << 12);
    private ePos = new Uint8Array(1 << 12);
    private top = 0;
    private round = 0;
    private readonly path: number[] = [];
    private readonly aloneOk: Uint8Array;

    constructor(private readonly q: Sequences, private readonly opt: QualOptions, min: number, private readonly deadline: number) {
        // czesc wierszy odpada na koncu (rows)
        this.size = opt.minPurity > 0 || opt.minGain > 0 ? 3 * opt.top : opt.top;
        this.tables = Array.from({ length: opt.maxQuals + 1 }, () => new Map<number, Entry>());
        this.thr = this.tables.map(() => min);
        this.pruneAt = this.tables.map(() => 2 * this.size);
        this.aloneOk = new Uint8Array(q.tokens.length);
    }

    private reserve(n: number): void {
        if (n <= this.eSeq.length) return;
        this.eSeq = grow(this.eSeq, n);
        this.ePos = grow(this.ePos, n);
    }

    /** Czy element a jest co najmniej tak szczegolowy jak b (kazdy kwalifikator a pasuje do b). */
    inside(a: number, b: number): boolean {
        return a === b || narrower(this.q.tokens[a].text, this.q.tokens[b].text);
    }

    rank(a: Path, b: Path): number {
        const { tokens } = this.q;
        const sum = (p: Path, f: 'lit' | 'stars') => p.toks.reduce((s, t) => s + tokens[t][f], 0);
        const text = (p: Path) => p.toks.map(t => tokens[t].text).join('.');
        return a.large - b.large || sum(b, 'lit') - sum(a, 'lit') || sum(a, 'stars') - sum(b, 'stars') || (text(a) < text(b) ? -1 : 1);
    }

    private offer(c: Child): void {
        const k = this.path.length + 1;
        if (c.small < this.thr[k] || purityOf(c.small, c.large) < this.opt.minPurity) return;
        const table = this.tables[k];
        const key = (c.c1 >>> 0) * 2097152 + (c.c2 >>> 11);
        const p: Path = { toks: [...this.path, c.t], large: c.large };
        const e = table.get(key);
        if (!e) {
            table.set(key, { small: c.small, paths: [p], more: 0 });
            if (table.size >= this.pruneAt[k]) this.prune(k);
            return;
        }
        const wider = (a: Path, b: Path) => a.toks.every((t, j) => this.inside(b.toks[j], t));
        if (e.paths.some(x => wider(p, x))) return;
        e.paths = e.paths.filter(x => !wider(x, p));
        e.paths.push(p);
        if (e.paths.length > MAX_ALSO) {
            e.paths.sort((a, b) => this.rank(a, b)).pop();
            e.more++;
        }
    }

    private prune(k: number): void {
        const table = this.tables[k];
        const counts = [...table.values()].map(e => e.small).sort((a, b) => b - a);
        this.thr[k] = Math.max(this.thr[k], counts[this.size - 1]);
        for (const [key, e] of table) if (e.small < this.thr[k]) table.delete(key);
        this.pruneAt[k] = Math.max(2 * this.size, 2 * table.size);
    }

    /** ile malych musi miec kombinacja, zeby ona albo dluzsza weszla do tabeli */
    private need(k: number): number {
        let m = Infinity;
        for (let j = k; j < this.thr.length; j++) m = Math.min(m, this.thr[j]);
        return m;
    }

    run(tick: Tick): void {
        const { q, opt } = this;
        const { off, cls, clsOff, clsTok, end, wp, wn, tokens } = q;
        const nt = tokens.length;
        const stamp = new Int32Array(nt);
        const nEnt = new Int32Array(nt);
        const wPos = new Int32Array(nt);
        const wNeg = new Int32Array(nt);
        const sig = new Int32Array(nt);
        const c1 = new Int32Array(nt);
        const c2 = new Int32Array(nt);
        const slot = new Int32Array(nt).fill(-1);
        let x = 0x9e3779b9;
        const next = () => {
            x = (x + 0x6d2b79f5) | 0;
            let h = Math.imul(x ^ (x >>> 15), 1 | x);
            h = (h + Math.imul(h ^ (h >>> 7), 61 | h)) ^ h;
            return h ^ (h >>> 14);
        };
        const rnd1 = Int32Array.from({ length: q.count }, next);
        const rnd2 = Int32Array.from({ length: q.count }, next);
        const odd = Int32Array.from({ length: 64 }, () => next() | 1);
        const { aloneOk } = this;

        const node = (lo: number, hi: number, from: number, to: number): void => {
            if ((this.nodes++ & 0x1f) === 0) {
                tick(from, `sprawdzonych: ${thousands(this.nodes)}`);
                if (Date.now() > this.deadline) throw new Timeout();
            }
            if (this.round > 2e9 - (hi - lo) * 2) {
                stamp.fill(0);
                this.round = 0;
            }
            const k = this.path.length + 1;
            const touched: number[] = [];
            const { eSeq, ePos } = this;
            for (let i = lo; i < hi; i++) {
                const s = eSeq[i];
                const round = ++this.round;
                const small = wp[s] > 0;
                const base = off[s];
                for (let p = ePos[i]; p < end[s]; p++) {
                    const c = cls[base + p];
                    const h = small ? Math.imul(rnd1[s], odd[p]) : 0;
                    for (let y = clsOff[c]; y < clsOff[c + 1]; y++) {
                        const t = clsTok[y];
                        if (aloneOk[t]) continue;
                        if (stamp[t] !== round) {
                            stamp[t] = round;
                            if (nEnt[t]++ === 0) touched.push(t);
                            wPos[t] += wp[s];
                            wNeg[t] += wn[s];
                            if (small) {
                                c1[t] = (c1[t] + rnd1[s]) | 0;
                                c2[t] = (c2[t] + rnd2[s]) | 0;
                            }
                        }
                        sig[t] = (sig[t] + h) | 0;
                    }
                }
            }
            // z elementow pasujacych do malych na tych samych miejscach odpadaja zawierajace szczegolowszy
            const need = this.need(k);
            const same = new Map<number, Child[]>();
            for (const t of touched) {
                if (wPos[t] >= need) {
                    const c: Child = { t, n: nEnt[t], small: wPos[t], large: wNeg[t], c1: c1[t], c2: c2[t], at: 0 };
                    const key = (sig[t] >>> 0) * 2097152 + (wPos[t] & 2097151);
                    const list = same.get(key);
                    if (!list) same.set(key, [c]);
                    else if (!list.some(x => this.inside(x.t, t))) same.set(key, [...list.filter(x => !this.inside(t, x.t)), c]);
                }
                nEnt[t] = wPos[t] = wNeg[t] = sig[t] = c1[t] = c2[t] = 0;
            }
            let kids = [...same.values()].flat().sort((a, b) => b.small - a.small || a.large - b.large || tokens[b.t].lit - tokens[a.t].lit
                || tokens[a.t].stars - tokens[b.t].stars || (tokens[a.t].text < tokens[b.t].text ? -1 : 1));
            for (const c of kids) this.offer(c);
            if (k === opt.maxQuals) return;
            if (opt.minPurity > 0) {
                const good = (c: Child) => purityOf(c.small, c.large) >= opt.minPurity;
                if (k === 1) for (const c of kids) if (good(c)) aloneOk[c.t] = 1;
                kids = kids.filter(c => !good(c));
            }

            // ---- listy rozwiniec, grupami
            const all = kids.reduce((s, c) => s + c.n, 0);
            let done = 0;
            for (let a = 0; a < kids.length && kids[a].small >= this.need(k + 1);) {
                const start = this.top;
                let b = a;
                let size = 0;
                while (b < kids.length && kids[b].small >= this.need(k + 1) && (b === a || size + kids[b].n <= GROUP)) {
                    kids[b].at = start + size;
                    slot[kids[b].t] = start + size;
                    size += kids[b].n;
                    b++;
                }
                this.reserve(start + size);
                const es = this.eSeq;
                const ep = this.ePos;
                for (let i = lo; i < hi; i++) {
                    const s = es[i];
                    const round = ++this.round;
                    for (let p = ep[i]; p < end[s]; p++) {
                        const c = cls[off[s] + p];
                        for (let y = clsOff[c]; y < clsOff[c + 1]; y++) {
                            const t = clsTok[y];
                            if (slot[t] < 0 || stamp[t] === round) continue;
                            stamp[t] = round;
                            // nazwa bez dalszych elementow nie wejdzie do dluzszej kombinacji
                            if (p + 1 >= end[s]) continue;
                            es[slot[t]] = s;
                            ep[slot[t]++] = p + 1;
                        }
                    }
                }
                const stop: number[] = [];
                for (let j = a; j < b; j++) {
                    stop.push(slot[kids[j].t]);
                    slot[kids[j].t] = -1;
                }
                this.top = start + size;
                for (let j = a; j < b; j++) {
                    const c = kids[j];
                    const at = from + (to - from) * (done / all);
                    done += c.n;
                    if (c.small < this.need(k + 1)) continue;
                    this.path.push(c.t);
                    node(c.at, stop[j - a], at, from + (to - from) * (done / all));
                    this.path.pop();
                }
                this.top = start;
                a = b;
            }
        };
        this.reserve(q.count);
        for (let s = 0; s < q.count; s++) this.eSeq[s] = s;
        this.top = q.count;
        node(0, q.count, 0, 1);
    }

    /** Wiersze tabel: od najwiekszej liczby malych. */
    rows(): { toks: number[]; also: string[][]; more: number }[][] {
        const { tokens } = this.q;
        const { opt } = this;
        const texts = (p: Path) => p.toks.map(t => tokens[t].text);
        const out: { toks: number[]; also: string[][]; more: number }[][] = [];
        const good: Path[] = [];
        for (let k = 1; k <= opt.maxQuals; k++) {
            let list = [...this.tables[k].values()];
            for (const e of list) e.paths.sort((a, b) => this.rank(a, b));
            list.sort((a, b) => b.small - a.small || this.rank(a.paths[0], b.paths[0]));
            if (opt.minPurity > 0) {
                // bez zawartych w kombinacji, ktora juz spelnia prog
                list = list.filter(e => {
                    if (e.paths.some(p => good.some(g => this.longer(p, g)))) return false;
                    good.push(...e.paths);
                    return true;
                });
            } else if (opt.minGain > 0) {
                list = list.filter((e, i) => {
                    for (let j = i + 1; j < list.length && list[j].small >= e.small * (1 - opt.minGain); j++) {
                        if (list[j].paths.some(p => this.longer(p, e.paths[0]))) return false;
                    }
                    return true;
                });
            }
            out.push(list.slice(0, opt.top).map(e => ({ toks: e.paths[0].toks, also: e.paths.slice(1).map(texts), more: e.more })));
        }
        return out;
    }

    /** Czy kazda nazwa z p ma tez krotsza kombinacje g. */
    private longer(p: Path, g: Path): boolean {
        let j = 0;
        for (const t of p.toks) if (j < g.toks.length && this.inside(t, g.toks[j])) j++;
        return j === g.toks.length;
    }
}

/** Liczby i maska wiersza, z ciagow klas. */
function finish(q: Sequences, row: { toks: number[]; also: string[][]; more: number }, head: string[]): Combo {
    const { off, cls, clsOff, clsTok, end, wp, wn, kp, kn } = q;
    const { toks } = row;
    const k = toks.length;
    const bits = new Uint8Array(clsOff.length - 1);
    toks.forEach((t, j) => {
        for (let c = 0; c < bits.length; c++) for (let y = clsOff[c]; y < clsOff[c + 1]; y++) if (clsTok[y] === t) bits[c] |= 1 << j;
    });
    const quals = toks.map(t => q.tokens[t].text);
    const out: Combo = { quals, small: 0, large: 0, purity: 0, smallKb: 0, largeKb: 0, mask: null, also: row.also, more: row.more };
    // odstepy: przed pierwszym, miedzy, za ostatnim; -1 = rozne. Ulozenie od lewej i od prawej.
    const gaps: (number | undefined)[][] = [new Array<undefined>(k + 1), new Array<undefined>(k + 1)];
    const note = (g: (number | undefined)[], j: number, v: number) => {
        g[j] = g[j] === undefined || g[j] === v ? v : -1;
    };
    const hits = new IntList();
    for (let s = 0; s < q.count; s++) {
        const n = off[s + 1] - off[s];
        let j = 0;
        let last = -1;
        const at: number[] = [];
        for (let p = 0; p < end[s] && j < k; p++) {
            if (!(bits[cls[off[s] + p]] & (1 << j))) continue;
            at.push(p - last - 1);
            last = p;
            j++;
        }
        if (j < k) continue;
        out.small += wp[s];
        out.large += wn[s];
        out.smallKb += kp[s];
        out.largeKb += kn[s];
        hits.push(s);
        if (wp[s] === 0) continue;
        at.forEach((v, i) => note(gaps[0], i, v));
        note(gaps[0], k, n - 1 - last);
        let next = n;
        j = k - 1;
        for (let p = end[s] - 1; p >= 0 && j >= 0; p--) {
            if (!(bits[cls[off[s] + p]] & (1 << j))) continue;
            note(gaps[1], j + 1, next - p - 1);
            next = p;
            j--;
        }
        note(gaps[1], 0, next);
    }
    out.purity = purityOf(out.small, out.large);

    // ---- najwezsza maska: element = numer kwalifikatora kombinacji, STAR albo ANY
    const STAR = -1;
    const ANY = -2;
    const build = (g: (number | undefined)[]): number[] => {
        const e: number[] = [];
        g.forEach((v, j) => {
            if (v === -1) e.push(ANY);
            else for (let i = 0; i < v!; i++) e.push(STAR);
            if (j < k) e.push(j);
        });
        return e;
    };
    const text = (e: number[]) => [...head, ...e.map(x => (x === STAR ? '*' : x === ANY ? '**' : quals[x]))].join('.');
    const anys = (e: number[]) => e.filter(x => x === ANY).length;
    const loose = Array.from({ length: 2 * k + 1 }, (_, i) => (i % 2 ? (i - 1) / 2 : ANY));
    const elems = [...gaps.map(build).sort((a, b) => anys(a) - anys(b) || a.length - b.length), loose].find(e => text(e).length <= MAX_LEN);
    if (!elems) return out;
    const mask: MaskRow = { text: text(elems), small: 0, large: 0, purity: 0, smallKb: 0, largeKb: 0 };
    const fits = (s: number, p: number, i: number): boolean => {
        const n = off[s + 1] - off[s];
        for (; i < elems.length; i++) {
            if (elems[i] === ANY) {
                for (let r = p; r <= n; r++) if (fits(s, r, i + 1)) return true;
                return false;
            }
            if (p >= n || (elems[i] !== STAR && !(bits[cls[off[s] + p]] & (1 << elems[i])))) return false;
            p++;
        }
        return p === n;
    };
    for (let x = 0; x < hits.n; x++) {
        const s = hits.a[x];
        if (!fits(s, 0, 0)) continue;
        mask.small += wp[s];
        mask.large += wn[s];
        mask.smallKb += kp[s];
        mask.largeKb += kn[s];
    }
    mask.purity = purityOf(mask.small, mask.large);
    out.mask = mask;
    return out;
}

export function findCombos(input: CheckInput, opt: QualOptions, tick: Tick): QualResult {
    const np = input.pos.length;
    const head = opt.head ?? [];
    const out: QualResult = { small: np, large: input.neg.length, tables: Array.from({ length: opt.maxQuals }, () => []), floor: null, nodes: 0 };
    if (np < opt.minCount) return out;
    const names = readNames(input, head.length, p => tick(0.1 * p));
    const deadline = Date.now() + opt.seconds * 1000;
    // dluzsze kombinacje niz nazwy sa puste i nie zapelnilyby tabeli
    let longest = 0;
    for (let i = 0; i < np; i++) longest = Math.max(longest, names.off[i + 1] - names.off[i]);
    const o = { ...opt, maxQuals: Math.min(opt.maxQuals, longest) };
    let prev: { rows: ReturnType<Search['rows']>; tokens: Token[]; min: number } | null = null;
    for (let min = Math.max(opt.minCount, Math.ceil(np / 5)); ; min = Math.max(opt.minCount, Math.ceil(min / 4))) {
        const from = 1 - min / np;
        const q = buildSequences(names, min, opt.partial, head.length > 0, p => tick(0.1 + 0.9 * Math.min(0.99, from * 0.9 + 0.03 * p), `prog: ${thousands(min)} malych`));
        const search = new Search(q, o, min, deadline);
        let rows: ReturnType<Search['rows']>;
        let stop = min === opt.minCount;
        try {
            search.run((p, info) => tick(0.1 + 0.9 * Math.min(0.99, from * 0.9 + 0.03 + 0.07 * p), `prog: ${thousands(min)} malych, ${info}`));
            rows = search.rows();
            if (rows.every(r => r.length >= opt.top)) stop = true;
        } catch (e) {
            if (!(e instanceof Timeout)) throw e;
            // elementy wyzszego progu sa tez wsrod nizszego
            const id = new Map(q.tokens.map((t, i) => [t.text, i]));
            const old = prev;
            rows = old ? old.rows.map(r => r.map(x => ({ ...x, toks: x.toks.map(t => id.get(old.tokens[t].text)!) }))) : search.rows();
            out.floor = old ? old.min : np + 1;
            stop = true;
        }
        out.nodes += search.nodes;
        if (stop) {
            rows.forEach((r, i) => { out.tables[i] = r.map(x => finish(q, x, head)); });
            return out;
        }
        prev = { rows, tokens: q.tokens, min };
    }
}

// ---------------------------------------------------------------- sprawdzanie podanych kombinacji

/** "LOG*+TMP, SYSOUT" -> [['LOG*', 'TMP'], ['SYSOUT']] */
export function parseTries(text: string): string[][] {
    return text.split(',').map(x => x.trim()).filter(Boolean).map(item => item.split('+').map(x => {
        const q = x.trim();
        if (q === '') throw new MaskError(`"${item}": pusty kwalifikator`);
        const { quals } = parseMask(q);
        if (quals.length > 1) throw new MaskError(`"${item}": kwalifikatory lacz znakiem +, nie kropka`);
        if (!literalChars(quals[0])) throw new MaskError(`"${item}": "${quals[0]}" nie ma zadnego stalego znaku`);
        return quals[0];
    }));
}

export interface TryRow extends MaskRow {
    quals: string[];
    /** 0 = podana kombinacja, 1 = jej skrocenie */
    level: 0 | 1;
}

/**
 * Niepelne postacie kwalifikatora, od najdluzszej: ABCD*, ABC*; *BCDE, *CDE; cyfry -> %.
 * Kwalifikator z % albo * zostaje bez zmian.
 */
export function shorten(q: string, partial: number): string[] {
    if (partial === 0 || /[*%]/.test(q)) return [];
    const out: string[] = [];
    const digits = q.replace(/[0-9]/g, '%');
    if (digits !== q && literalChars(digits)) out.push(digits);
    for (let n = q.length - 1; n >= partial; n--) out.push(`${q.slice(0, n)}*`);
    for (let n = q.length - 1; n >= partial; n--) out.push(`*${q.slice(-n)}`);
    for (let n = Math.min(q.length, 6); n >= partial; n--) {
        for (let i = 0; i + n <= q.length; i++) out.push(`*${q.slice(i, i + n)}*`);
    }
    return out.filter(x => !/^\*?[0-9]+\*?$/.test(x) && x.length <= 8);
}

/** Liczby dla podanych kombinacji i ich skrocen (jeden kwalifikator naraz); skrocenia, ktore nic nie zmieniaja, odpadaja. */
export function tryCombos(input: CheckInput, tries: string[][], partial: number, head: string[], tick: Tick): TryRow[][] {
    const { names, allocKb, pos, neg } = input;
    const groups = tries.map(base => {
        const list = [base];
        base.forEach((q, j) => shorten(q, partial).forEach(v => list.push(base.map((x, i) => (i === j ? v : x)))));
        return list.map((quals, i): TryRow => ({
            quals, level: i ? 1 : 0, text: [...head, '**', ...quals.flatMap(q => [q, '**'])].join('.'),
            small: 0, large: 0, purity: 0, smallKb: 0, largeKb: 0,
        }));
    });
    const rows = groups.flat();
    const tree = new MaskTree(rows.map(r => r.text.split('.')));
    const total = pos.length + neg.length;
    let done = 0;
    const scan = (list: Int32Array, n: 'small' | 'large', kb: 'smallKb' | 'largeKb') => {
        for (let x = 0; x < list.length; x++) {
            if ((done++ & 0x3fff) === 0) tick(done / total);
            const s = names.start[list[x]];
            for (const m of tree.match(names.pool, s, s + names.len[list[x]])) {
                rows[m][n]++;
                rows[m][kb] += allocKb[list[x]];
            }
        }
    };
    scan(pos, 'small', 'smallKb');
    scan(neg, 'large', 'largeKb');
    for (const r of rows) r.purity = purityOf(r.small, r.large);
    return groups.map(([base, ...rest]) => {
        // szersza maska o tych samych liczbach co wezsza obejmuje te same zbiory
        const seen = [base];
        for (const r of rest) if (!seen.some(x => x.small === r.small && x.large === r.large && within(x.text.split('.'), r.text.split('.')))) seen.push(r);
        return [base, ...seen.slice(1).sort((a, b) => b.purity - a.purity || b.small - a.small)];
    });
}
