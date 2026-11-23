/**
 * Szukanie masek dla milionow zbiorow. Kandydaci, progi i wybor zachlanny sa takie same jak w mine.ts (opis tam;
 * zgodnosc sprawdza test/auto.test.ts), inne jest liczenie:
 *  - maska obejmuje najwyzej tyle malych zbiorow, ile jej czesc (prefiks, LLQ, wzorzec z %), wiec kandydaci
 *    powstaja poziomami i rozwijane sa tylko te, ktore maja co najmniej minCount malych zbiorow;
 *  - kwalifikatory, prefiksy i wzorce maja numery, kandydat to para liczb (prefiks, LLQ albo wzorzec);
 *  - wzorce z % sa szukane drzewem, a nie kazdy z kazda nazwa.
 *
 * Rodzaje kandydatow (prefiks = wezel drzewa kwalifikatorow, 0 = pusty):
 *   P prefiks.**   E pelna nazwa   L prefiks.**.LLQ (pusty prefiks: *.**.LLQ)
 *   PD prefiks.wzorzec.**   ED prefiks.wzorzec   LD prefiks.**.wzorzec
 * Narzucony poczatek masek (head): wezel 0 to ten poczatek, a z nazw brane sa tylko dalsze kwalifikatory;
 * dochodza wtedy kandydaci P (head.**) i E (sam head) wezla 0.
 */
import { grow, Interner, IntList, PairMap, Tick } from './auto-util';

export interface MineOptions {
    minPurity: number;
    minCount: number;
    maxMasks: number;
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
    candidates: number;
}

export interface MineInput {
    names: Interner;
    allocKb: Float64Array;
    /** numery wierszy zbiorow malych i duzych */
    pos: Int32Array;
    neg: Int32Array;
}

const P = 0;
const E = 1;
const L = 2;
const PD = 3;
const ED = 4;
const LD = 5;
const HAS_L = 1;
const HAS_PD = 2;
const HAS_ED = 4;
const HAS_LD = 8;
const DOT = 46;
const PCT = 37;
const MAX_QUALS = 128;

/** Etapy: zliczanie kandydatow, zbiory duze, wybor masek - po jednym Tick. */
export interface Stages {
    candidates: Tick;
    negatives: (candidates: number) => Tick;
    select: () => Tick;
}

export function mine(input: MineInput, opt: MineOptions, stages: Stages): MineResult {
    const { names, allocKb, pos, neg } = input;
    const { pool } = names;
    const min = opt.minCount;
    const np = pos.length;
    const headText = (opt.head ?? []).join('.');
    const skip = opt.head?.length ?? 0;
    /** ile kwalifikatorow (za head) musi miec nazwa dla masek prefiks.**.LLQ; bez head: *.**.LLQ, czyli dwa */
    const minL = skip ? 1 : 2;
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
    const off = new Int32Array(np + 1);
    const qList = new IntList();
    let maxQ = 0;
    for (let i = 0; i < np; i++) {
        const s = rest(pos[i]);
        const e = names.start[pos[i]] + names.len[pos[i]];
        let b = s;
        for (let p = s; p <= e; p++) {
            if (p < e && pool[p] !== DOT) continue;
            qList.push(quals.add(pool, b, p));
            b = p + 1;
        }
        off[i + 1] = qList.n;
        if (off[i + 1] - off[i] > maxQ) maxQ = off[i + 1] - off[i];
        if ((i & 0xffff) === 0) stages.candidates(0.1 * (i / np));
    }
    const q = qList.a;

    // ---- wzorce z %: tylko takie, do ktorych pasuje co najmniej min kwalifikatorow malych zbiorow
    const occ = new Int32Array(quals.size);
    for (let j = 0; j < qList.n; j++) occ[q[j]]++;
    const pat = buildPatterns(quals, occ, min, part => stages.candidates(0.1 + 0.2 * part));
    const { gen, patOff, patList } = pat;

    // ---- kandydaci
    const fam = new IntList();
    const ca = new IntList();
    const cb = new IntList();
    const cpos = new IntList();
    const addCand = (f: number, a: number, b: number, n: number): number => {
        fam.push(f);
        ca.push(a);
        cb.push(b);
        cpos.push(n);
        return fam.n - 1;
    };
    /** wezly drzewa prefiksow (tylko czeste); 0 = korzen */
    const parent = new IntList();
    const nodeQual = new IntList();
    parent.push(-1);
    nodeQual.push(-1);
    const child = new PairMap();
    const mapL = new PairMap();
    const mapPD = new PairMap();
    const mapED = new PairMap();
    const mapLD = new PairMap();
    /** wezel prefiksu po kwalifikatorze j zbioru i: nd[off[i] + j]; -1 = prefiks rzadki */
    const nd = new Int32Array(qList.n).fill(-1);
    const headAt = (i: number, j: number) => (j === 0 ? 0 : nd[off[i] + j - 1]);

    const levels = maxQ * 3 + 1;
    let levelNo = 0;
    const level = (i: number, n: number) => stages.candidates(0.3 + 0.7 * ((levelNo + i / Math.max(1, n)) / levels));
    const nextLevel = () => void levelNo++;

    if (skip) {
        let exact = 0;
        for (let i = 0; i < np; i++) if (off[i] === off[i + 1]) exact++;
        if (np >= min) addCand(P, 0, 0, np);
        if (exact >= min) addCand(E, 0, 0, exact);
    }

    // P i E: prefiksy poziomami
    {
        let alive = new Int32Array(np);
        for (let i = 0; i < np; i++) alive[i] = i;
        let n = np;
        for (let j = 0; j < maxQ; j++, nextLevel()) {
            const tmp = new PairMap();
            let cnt = new Int32Array(1 << 10);
            const at = new Int32Array(n);
            let m = 0;
            for (let x = 0; x < n; x++) {
                const i = alive[x];
                if (off[i] + j >= off[i + 1]) continue;
                const c = tmp.index(headAt(i, j), q[off[i] + j]);
                if (c >= cnt.length) cnt = grow(cnt, c + 1);
                cnt[c]++;
                at[m] = c;
                alive[m++] = i;
                if ((x & 0xffff) === 0) level(x, n);
            }
            const node = new Int32Array(tmp.size).fill(-1);
            const exact = new Int32Array(tmp.size);
            n = 0;
            for (let x = 0; x < m; x++) {
                const i = alive[x];
                const c = at[x];
                if (cnt[c] < min) continue;
                if (node[c] < 0) {
                    node[c] = parent.n;
                    child.set(headAt(i, j), q[off[i] + j], parent.n);
                    parent.push(headAt(i, j));
                    nodeQual.push(q[off[i] + j]);
                    addCand(P, node[c], 0, cnt[c]);
                }
                nd[off[i] + j] = node[c];
                if (off[i] + j + 1 === off[i + 1]) exact[c]++;
                else alive[n++] = i;
            }
            for (let c = 0; c < node.length; c++) if (exact[c] >= min) addCand(E, node[c], 0, exact[c]);
        }
    }
    const nodes = parent.n;
    const has = new Uint8Array(nodes);

    // L: prefiks.**.LLQ - coraz dluzszy prefiks, dopoki para (prefiks, LLQ) jest czesta
    {
        let alive = new Int32Array(np);
        let n = 0;
        for (let i = 0; i < np; i++) if (off[i + 1] - off[i] >= minL) alive[n++] = i;
        for (let k = 0; k < maxQ && n > 0; k++, nextLevel()) {
            const tmp = new PairMap();
            let cnt = new Int32Array(1 << 10);
            const at = new Int32Array(n);
            let m = 0;
            for (let x = 0; x < n; x++) {
                const i = alive[x];
                if (k > off[i + 1] - off[i] - 1) continue;
                const node = headAt(i, k);
                if (node < 0) continue;
                const c = tmp.index(node, q[off[i + 1] - 1]);
                if (c >= cnt.length) cnt = grow(cnt, c + 1);
                cnt[c]++;
                at[m] = c;
                alive[m++] = i;
                if ((x & 0xffff) === 0) level(x, n);
            }
            n = 0;
            const done = new Uint8Array(tmp.size);
            for (let x = 0; x < m; x++) {
                const c = at[x];
                if (cnt[c] < min) continue;
                const i = alive[x];
                if (!done[c]) {
                    done[c] = 1;
                    const node = headAt(i, k);
                    mapL.set(node, q[off[i + 1] - 1], addCand(L, node, q[off[i + 1] - 1], cnt[c]));
                    has[node] |= HAS_L;
                }
                alive[n++] = i;
            }
        }
    }

    // PD, ED: wzorzec po prefiksie; kandydat istnieje, gdy wzorzec powstal z nazwy pod tym prefiksem
    const registered = (fill: (reg: PairMap, count: (c: number) => void) => void, f: number, map: PairMap, bit: number) => {
        const reg = new PairMap();
        let cnt = new Int32Array(1 << 10);
        fill(reg, c => {
            if (c >= cnt.length) cnt = grow(cnt, c + 1);
            cnt[c]++;
        });
        reg.each((a, b, c) => {
            if (c < cnt.length && cnt[c] >= min) {
                map.set(a, b, addCand(f, a, b, cnt[c]));
                has[a] |= bit;
            }
        });
    };
    for (let j = 0; j < maxQ; j++, nextLevel()) {
        for (const last of [false, true]) {
            registered((reg, count) => {
                for (let i = 0; i < np; i++) {
                    const at = off[i] + j;
                    if (last ? at + 1 !== off[i + 1] : at >= off[i + 1]) continue;
                    const g = gen[q[at]];
                    if (g >= 0 && headAt(i, j) >= 0) reg.index(headAt(i, j), g);
                }
                if (reg.size === 0) return;
                for (let i = 0; i < np; i++) {
                    if ((i & 0xffff) === 0) level(i, np);
                    const at = off[i] + j;
                    if (last ? at + 1 !== off[i + 1] : at >= off[i + 1]) continue;
                    const head = headAt(i, j);
                    if (head < 0) continue;
                    for (let y = patOff[q[at]]; y < patOff[q[at] + 1]; y++) {
                        const c = reg.get(head, patList[y]);
                        if (c >= 0) count(c);
                    }
                }
            }, last ? ED : PD, last ? mapED : mapPD, last ? HAS_ED : HAS_PD);
        }
    }

    // LD: jak L, z wzorcem LLQ; pary (zbior, wzorzec), dopoki czeste
    {
        let ai = new IntList();
        let ap = new IntList();
        for (let i = 0; i < np; i++) {
            if (off[i + 1] - off[i] < minL) continue;
            const l = q[off[i + 1] - 1];
            for (let y = patOff[l]; y < patOff[l + 1]; y++) {
                ai.push(i);
                ap.push(patList[y]);
            }
        }
        for (let k = 0; k < maxQ && ai.n > 0; k++, nextLevel()) {
            const n = ai.n;
            registered((reg, count) => {
                for (let i = 0; i < np; i++) {
                    if (off[i + 1] - off[i] < minL || k > off[i + 1] - off[i] - 1) continue;
                    const g = gen[q[off[i + 1] - 1]];
                    if (g >= 0 && headAt(i, k) >= 0) reg.index(headAt(i, k), g);
                }
                for (let x = 0; x < n; x++) {
                    if ((x & 0xffff) === 0) level(x, n);
                    const i = ai.a[x];
                    if (k > off[i + 1] - off[i] - 1 || headAt(i, k) < 0) continue;
                    const c = reg.get(headAt(i, k), ap.a[x]);
                    if (c >= 0) count(c);
                }
            }, LD, mapLD, HAS_LD);
            const bi = new IntList();
            const bp = new IntList();
            for (let x = 0; x < n; x++) {
                const i = ai.a[x];
                if (k > off[i + 1] - off[i] - 1 || headAt(i, k) < 0 || mapLD.get(headAt(i, k), ap.a[x]) < 0) continue;
                bi.push(i);
                bp.push(ap.a[x]);
            }
            ai = bi;
            ap = bp;
        }
    }

    const nc = fam.n;
    const candP = new Int32Array(nodes).fill(-1);
    const candE = new Int32Array(nodes).fill(-1);
    for (let c = 0; c < nc; c++) {
        if (fam.a[c] === P) candP[ca.a[c]] = c;
        else if (fam.a[c] === E) candE[ca.a[c]] = c;
    }

    // ---- wszystkie maski pasujace do nazwy -> out[0..n)
    let out = new Int32Array(1 << 12);
    let outN = 0;
    const emit = (c: number) => {
        if (c < 0) return;
        if (outN === out.length) out = grow(out, outN + 1);
        out[outN++] = c;
    };
    const qs = new Int32Array(MAX_QUALS);
    const qe = new Int32Array(MAX_QUALS);
    const found = new IntList();
    const llqP = new IntList();
    const patternsOf = (id: number, s: number, e: number, into: IntList) => {
        into.n = 0;
        if (id < 0) pat.match(pool, s, e, into);
        else for (let y = patOff[id]; y < patOff[id + 1]; y++) into.push(patList[y]);
    };
    const matching = (row: number): void => {
        outN = 0;
        const s = rest(row);
        const e = names.start[row] + names.len[row];
        let n = 0;
        let b = s;
        for (let p = s; p <= e; p++) {
            if (p < e && pool[p] !== DOT) continue;
            qs[n] = b;
            qe[n++] = p;
            b = p + 1;
        }
        emit(candP[0]);
        if (n === 0) {
            emit(candE[0]);
            return;
        }
        const llq = quals.find(pool, qs[n - 1], qe[n - 1]);
        let llqReady = false;
        const llqPatterns = () => {
            if (!llqReady) patternsOf(llq, qs[n - 1], qe[n - 1], llqP);
            llqReady = true;
        };
        let head = 0;
        for (let j = 0; j < n; j++) {
            const h = has[head];
            const last = j === n - 1;
            if (n >= minL) {
                if (h & HAS_L && llq >= 0) emit(mapL.get(head, llq));
                if (h & HAS_LD) {
                    llqPatterns();
                    for (let y = 0; y < llqP.n; y++) emit(mapLD.get(head, llqP.a[y]));
                }
            }
            const id = last ? llq : quals.find(pool, qs[j], qe[j]);
            if (h & HAS_PD) {
                patternsOf(id, qs[j], qe[j], found);
                for (let y = 0; y < found.n; y++) emit(mapPD.get(head, found.a[y]));
            }
            if (last && h & HAS_ED) {
                llqPatterns();
                for (let y = 0; y < llqP.n; y++) emit(mapED.get(head, llqP.a[y]));
            }
            if (id < 0) return;
            head = child.get(head, id);
            if (head < 0) return;
            emit(candP[head]);
            if (last) emit(candE[head]);
        }
    };

    // ---- zbiory duze
    const tickNeg = stages.negatives(nc);
    const cneg = new Int32Array(nc);
    const cnegKb = new Float64Array(nc);
    for (let x = 0; x < neg.length; x++) {
        if ((x & 0x3fff) === 0) tickNeg(x / neg.length);
        matching(neg[x]);
        const kb = allocKb[neg[x]];
        for (let y = 0; y < outN; y++) {
            cneg[out[y]]++;
            cnegKb[out[y]] += kb;
        }
    }

    // ---- kandydaci z wystarczajaca czystoscia: listy malych zbiorow
    const tickSel = stages.select();
    const purity = (c: number) => cpos.a[c] / (cpos.a[c] + cneg[c]);
    const slot = new Int32Array(nc).fill(-1);
    const good: number[] = [];
    for (let c = 0; c < nc; c++) {
        if (purity(c) < opt.minPurity) continue;
        slot[c] = good.length;
        good.push(c);
    }
    const lo = new Float64Array(good.length + 1);
    good.forEach((c, g) => { lo[g + 1] = lo[g] + cpos.a[c]; });
    const list = new Int32Array(lo[good.length]);
    const fill = lo.slice();
    for (let i = 0; i < np; i++) {
        if ((i & 0x3fff) === 0) tickSel(0.6 * (i / np));
        matching(pos[i]);
        for (let y = 0; y < outN; y++) {
            const g = slot[out[y]];
            if (g >= 0) list[fill[g]++] = i;
        }
    }

    // ---- wybor zachlanny (kolejnosc i remisy jak w mine.ts)
    const path = (node: number): string => {
        const parts: string[] = [];
        for (let x = node; x > 0; x = parent.a[x]) parts.push(quals.text(nodeQual.a[x]));
        if (skip) parts.push(headText);
        return parts.reverse().join('.');
    };
    const texts: (string | undefined)[] = new Array(good.length);
    const textOf = (g: number): string => texts[g] ??= ((): string => {
        const c = good[g];
        const a = ca.a[c];
        const pre = path(a);
        const dot = pre ? `${pre}.` : '';
        switch (fam.a[c]) {
            case P: return `${pre}.**`;
            case E: return pre;
            case L: return `${pre || '*'}.**.${quals.text(cb.a[c])}`;
            case PD: return `${dot}${pat.texts[cb.a[c]]}.**`;
            case ED: return `${dot}${pat.texts[cb.a[c]]}`;
            default: return `${pre || '*'}.**.${pat.texts[cb.a[c]]}`;
        }
    })();
    const literal = (t: string) => t.replace(/[*%.]/g, '').length;
    const stars = (t: string) => t.replace(/[^*]/g, '').length;
    const gain = new Int32Array(good.length);
    const better = (x: number, y: number): boolean => {
        if (gain[x] !== gain[y]) return gain[x] > gain[y];
        const cx = good[x];
        const cy = good[y];
        const px = purity(cx);
        const py = purity(cy);
        if (px !== py) return px > py;
        if (cneg[cx] !== cneg[cy]) return cneg[cx] < cneg[cy];
        const tx = textOf(x);
        const ty = textOf(y);
        const d = literal(ty) - literal(tx) || stars(tx) - stars(ty) || tx.length - ty.length;
        return d !== 0 ? d < 0 : tx < ty;
    };
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
        gain[g] = cpos.a[good[g]];
        heap[hn] = g;
        up(hn++);
    }
    const covered = new Uint8Array(np);
    const chosen: number[] = [];
    let pops = 0;
    while (hn > 0 && chosen.length < opt.maxMasks) {
        if ((pops++ & 0xff) === 0) {
            tickSel(0.6 + 0.4 * Math.max(chosen.length / opt.maxMasks, 1 - hn / good.length), `masek: ${chosen.length}`);
        }
        const g = heap[0];
        let now = 0;
        for (let x = lo[g]; x < lo[g + 1]; x++) if (!covered[list[x]]) now++;
        if (now === gain[g] && now >= min) {
            for (let x = lo[g]; x < lo[g + 1]; x++) covered[list[x]] = 1;
            chosen.push(g);
            now = 0;
        }
        if (now < min) {
            heap[0] = heap[--hn];
        } else {
            gain[g] = now;
        }
        if (hn > 0) down(0);
    }

    // maski zbedne: wszystkie ich zbiory obejmuja inne wybrane (od ostatnio wybranych)
    const cover = new Int32Array(np);
    for (const g of chosen) for (let x = lo[g]; x < lo[g + 1]; x++) cover[list[x]]++;
    const keep = chosen.map(() => true);
    for (let j = chosen.length - 1; j >= 0; j--) {
        const g = chosen[j];
        let redundant = true;
        for (let x = lo[g]; x < lo[g + 1] && redundant; x++) if (cover[list[x]] < 2) redundant = false;
        if (!redundant) continue;
        keep[j] = false;
        for (let x = lo[g]; x < lo[g + 1]; x++) cover[list[x]]--;
    }
    const final = chosen.filter((_, j) => keep[j]);

    const total: MaskRow = { text: 'RAZEM', small: 0, large: 0, purity: 0, smallKb: 0, largeKb: 0 };
    for (let i = 0; i < np; i++) {
        if (!cover[i]) continue;
        total.small++;
        total.smallKb += allocKb[pos[i]];
    }
    const isFinal = new Uint8Array(nc);
    let anyNeg = false;
    for (const g of final) {
        isFinal[good[g]] = 1;
        if (cneg[good[g]]) anyNeg = true;
    }
    if (anyNeg) {
        for (let x = 0; x < neg.length; x++) {
            if ((x & 0x3fff) === 0) tickSel(0.99);
            matching(neg[x]);
            let hit = false;
            for (let y = 0; y < outN && !hit; y++) if (isFinal[out[y]]) hit = true;
            if (!hit) continue;
            total.large++;
            total.largeKb += allocKb[neg[x]];
        }
    }
    total.purity = total.small ? total.small / (total.small + total.large) : 0;
    const masks = final.map((g): MaskRow => {
        const c = good[g];
        let kb = 0;
        for (let x = lo[g]; x < lo[g + 1]; x++) kb += allocKb[pos[list[x]]];
        return { text: textOf(g), small: cpos.a[c], large: cneg[c], purity: purity(c), smallKb: kb, largeKb: cnegKb[c] };
    });
    return { masks, total, candidates: nc };
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
    const isDigit = (b: number) => b >= 48 && b <= 57;

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
