/**
 * FILTLIST z jak najmniejsza liczba masek (INCLUDE i EXCLUDE razem) przy jak najwiekszym pokryciu malych zbiorow.
 *
 *   INCLUDE  maski silnika auto-mine o czystosci od minPurity (przed EXCLUDE), zaczynajace sie od pelnego albo niepelnego
 *            kwalifikatora (bez anyStart), kazda (takze kazdy EXCLUDE dobrany do niej) daje co najmniej minCount nowych malych; waskie (nowy zbior objety
 *            przypadkiem trafilby nie tam, gdzie trzeba)
 *   EXCLUDE  jak najszersze (auto-exclude), kazda wylacza co najmniej exGain alokacji objetych duzych; dzialaja na
 *            cala liste, razem zabieraja najwyzej loss objetych malych
 *   granica  alokacja objetych duzych najwyzej maxLarge (czesc alokacji objetych malych albo KB)
 *
 * Wybor krok po kroku: INCLUDE razem z EXCLUDE potrzebnymi, zeby zmiescic sie w granicy; wygrywa pakiet o najwiekszej
 * liczbie nowych malych na maske. Trzy przebiegi z rozna cena EXCLUDE (1, 1/2, 0); z wszystkich krokow dla kazdej
 * liczby masek zostaje najlepszy i jest poprawiany: usuwanie zbednych INCLUDE i EXCLUDE, jedna maska zamiast kilku,
 * lepsza zamiast gorszej. Wynik = krzywa: liczba masek -> pokrycie. To przyblizenie, nie dowod najmniejszej liczby.
 */
import { CheckInput } from './auto-check';
import { ExcludeSpace, Weights } from './auto-exclude';
import { Found, maskOrder, MineOptions, prepare, purityOf, Search, specialise } from './auto-mine';
import { MaskTree } from './auto-tree';
import { thousands, Tick } from './auto-util';

export type LargeLimit = { part: number } | { kb: number };

export interface CompactOptions {
    /** czystosc INCLUDE przed EXCLUDE */
    minPurity: number;
    /** ile nowych malych daje INCLUDE */
    minCount: number;
    /** INCLUDE i EXCLUDE razem */
    maxMasks: number;
    maxWild: number;
    head?: string[];
    /** INCLUDE moze zaczynac sie od ** i * */
    anyStart: boolean;
    maxLarge: LargeLimit;
    /** czesc objetych malych, ktora moga zabrac EXCLUDE */
    loss: number;
    /** ile duzych wylacza EXCLUDE */
    exMin: number;
    /** czesc alokacji objetych duzych, ktora wylacza EXCLUDE */
    exGain: number;
    seconds: number;
}

export interface Point {
    include: string[];
    exclude: string[];
    /** po EXCLUDE */
    small: number;
    large: number;
    smallKb: number;
    largeKb: number;
    /** male objete INCLUDE, zabrane przez EXCLUDE */
    lost: number;
}

export interface CompactResult {
    small: number;
    large: number;
    smallKb: number;
    /** od najmniejszej liczby masek; kazdy nastepny ma wieksze pokrycie */
    points: Point[];
    candidates: number;
    /** przerwane po czasie */
    stopped: boolean;
}

/** INCLUDE: ciagi nazw, ktore obejmuje */
interface Cand {
    found: Found;
    text: string;
    seqs: Int32Array;
}

interface Ex {
    text: string;
    l: Uint8Array;
    s: Uint8Array;
}

interface Solution {
    inc: number[];
    exc: Ex[];
}

interface Totals {
    small: number;
    large: number;
    smallKb: number;
    largeKb: number;
    lost: number;
    /** przed EXCLUDE */
    rawKb: number;
}

/** wpisow w listach kandydatow; przy wiekszej liczbie rosnie prog malych */
const MAX_LIST = 60e6;
/** ile kandydatow jest dokladnie sprawdzanych w jednym kroku */
const MAX_EVAL = 40;
const MAX_FULL = 3;
/** pelna maska EXCLUDE tylko przy takiej liczbie duzych */
const FULL_ROWS = 200000;
const PRICES = [1, 0.5, 0];

class TooMany extends Error {}

export function findCompact(input: CheckInput, opt: CompactOptions, stages: { candidates: Tick; excludes: (n: number) => Tick; select: () => Tick }): CompactResult {
    const { names, allocKb } = input;
    const deadline = Date.now() + opt.seconds * 1000;
    let allKb = 0;
    for (let i = 0; i < input.pos.length; i++) allKb += allocKb[input.pos[i]];
    const out: CompactResult = { small: input.pos.length, large: input.neg.length, smallKb: allKb, points: [], candidates: 0, stopped: false };
    if (input.pos.length < opt.minCount) return out;

    // ---- kandydaci INCLUDE
    const head = opt.head ?? [];
    const mineOpt: MineOptions = { minPurity: opt.minPurity, minCount: opt.minCount, maxMasks: 0, maxWild: opt.maxWild, head };
    const q = prepare(input, mineOpt, p => stages.candidates(0.4 * p));
    const search = new Search(q, head.join('.'), opt.maxWild, !opt.anyStart);
    const order = maskOrder(q.tokens.text, head);
    const everything = Int32Array.from({ length: q.count }, (_, s) => s);
    let cands: Cand[] = [];
    for (let min = opt.minCount; ; min *= 2) {
        cands = [];
        const byCover = new Map<number, number>();
        let size = 0;
        try {
            search.run(everything, min, true, true, (make, small, large, h1, h2, cover) => {
                if (purityOf(small, large) < opt.minPurity) return false;
                const key = (h1 >>> 0) * 2097152 + (h2 >>> 11);
                const old = byCover.get(key);
                const found = make();
                if (old === undefined || order.rank(found, cands[old].found) < 0) {
                    const list: number[] = [];
                    cover(s => list.push(s), true);
                    const c = { found, text: '', seqs: Int32Array.from(list) };
                    if (old === undefined) {
                        byCover.set(key, cands.length);
                        cands.push(c);
                        size += list.length;
                        if (size > MAX_LIST) throw new TooMany();
                    } else {
                        cands[old] = c;
                    }
                }
                // wezsza nie odetnie juz zadnego duzego
                return large === 0;
            }, p => stages.candidates(0.4 + 0.6 * p, `masek: ${thousands(cands.length)}`));
            break;
        } catch (e) {
            if (!(e instanceof TooMany)) throw e;
        }
    }
    out.candidates = cands.length;
    if (cands.length === 0) return out;

    // ---- zbiory objete ktorymkolwiek kandydatem
    const any = new Uint8Array(q.count);
    for (const c of cands) for (let x = 0; x < c.seqs.length; x++) any[c.seqs[x]] = 1;
    const pick = (rows: Int32Array, seq: Int32Array): [Int32Array, Int32Array] => {
        const ids = Array.prototype.filter.call(Int32Array.from(rows, (_, i) => i), (i: number) => seq[i] >= 0 && any[seq[i]]) as unknown as Int32Array;
        return [Int32Array.from(ids, i => rows[i]), Int32Array.from(ids, i => seq[i])];
    };
    const [sRow, sSeq] = pick(input.pos, q.posSeq);
    const [lRow, lSeq] = pick(input.neg, q.negSeq);
    const ns = sRow.length;
    const nl = lRow.length;
    const sKb = Float64Array.from(sRow, r => allocKb[r]);
    const lKb = Float64Array.from(lRow, r => allocKb[r]);
    const tickEx = stages.excludes(cands.length);
    const total = lKb.reduce((a, b) => a + b, 0);
    const space = nl ? new ExcludeSpace({ names, allocKb, pos: sRow, neg: lRow }, head, 0.1 * opt.exGain * total, 3, tickEx) : null;
    const tick = stages.select();

    const limit = (smallKb: number) => ('kb' in opt.maxLarge ? opt.maxLarge.kb : opt.maxLarge.part * smallKb);
    const fits = (t: Totals) => t.largeKb <= limit(t.smallKb) + 1e-6;
    const lossOk = (t: Totals) => t.lost <= opt.loss * (t.small + t.lost);
    const late = () => {
        if (Date.now() > deadline) out.stopped = true;
        return out.stopped;
    };

    /** 1 = objety i nie wylaczony */
    const masks = (cov: Uint8Array, dead: { l: Uint8Array; s: Uint8Array }) => {
        const useL = new Uint8Array(nl);
        const useS = new Uint8Array(ns);
        const t: Totals = { small: 0, large: 0, smallKb: 0, largeKb: 0, lost: 0, rawKb: 0 };
        for (let i = 0; i < ns; i++) {
            if (!cov[sSeq[i]]) continue;
            if (dead.s[i]) {
                t.lost++;
            } else {
                useS[i] = 1;
                t.small++;
                t.smallKb += sKb[i];
            }
        }
        for (let i = 0; i < nl; i++) {
            if (!cov[lSeq[i]]) continue;
            t.rawKb += lKb[i];
            if (!dead.l[i]) {
                useL[i] = 1;
                t.large++;
                t.largeKb += lKb[i];
            }
        }
        return { useL, useS, t };
    };
    const coverOf = (inc: number[]): Uint8Array => {
        const cov = new Uint8Array(q.count);
        for (const c of inc) for (let x = 0; x < cands[c].seqs.length; x++) cov[cands[c].seqs[x]] = 1;
        return cov;
    };
    const deadOf = (exc: Ex[]) => {
        const d = { l: new Uint8Array(nl), s: new Uint8Array(ns) };
        for (const e of exc) {
            for (let i = 0; i < nl; i++) d.l[i] |= e.l[i];
            for (let i = 0; i < ns; i++) d.s[i] |= e.s[i];
        }
        return d;
    };
    const measure = (x: Solution): Totals => masks(coverOf(x.inc), deadOf(x.exc)).t;

    // ---- pelne maski EXCLUDE sa drogie
    let fullLeft = 0;
    /** INCLUDE inc z EXCLUDE exc i najmniejsza liczba nowych, zeby zmiescic sie w granicy; enough: kiedy dalej nie warto */
    const complete = (inc: number[], exc: Ex[], enough: (t: Totals, added: number) => boolean): { added: Ex[]; t: Totals } | { short: number } => {
        const added: Ex[] = [];
        const cov = coverOf(inc);
        const dead = deadOf(exc);
        for (;;) {
            const { useL, useS, t } = masks(cov, dead);
            if (!lossOk(t)) return { short: Infinity };
            if (fits(t)) return { added, t };
            const short = t.largeKb - limit(t.smallKb);
            if (!space || enough(t, added.length) || inc.length + exc.length + added.length >= opt.maxMasks) return { short };
            const minKb = opt.exGain * t.rawKb;
            const w: Weights = space.weigh(useL, useS);
            const maxLoss = Math.floor(opt.loss * (t.small + t.lost) + 1e-9) - t.lost;
            const combo = space.best(w, { maxLoss, minKb, minCount: opt.exMin });
            let text: string;
            let hit: [Uint8Array, Uint8Array];
            if (combo) {
                text = space.text(combo);
                hit = space.hits(combo);
            } else {
                if (fullLeft <= 0 || t.large > FULL_ROWS) return { short };
                fullLeft--;
                const full = space.fullMasks(useL, useS, { minCount: Math.max(opt.exMin, Math.ceil(0.005 * t.large)), minKb, maxMasks: 5, maxWild: Math.min(2, opt.maxWild) }, () => {});
                if (full.length === 0) return { short };
                text = full[0].text;
                hit = space.hitsOf(text);
            }
            added.push({ text, l: hit[0], s: hit[1] });
            for (let i = 0; i < nl; i++) dead.l[i] |= hit[0][i];
            for (let i = 0; i < ns; i++) dead.s[i] |= hit[1][i];
        }
    };

    // ---- wolne male i duze na ciag nazw, bez objetych wybranymi
    const free = (cov: Uint8Array, dead: { l: Uint8Array; s: Uint8Array }) => {
        const f = { n: new Float64Array(q.count), kb: new Float64Array(q.count), large: new Float64Array(q.count) };
        for (let i = 0; i < ns; i++) {
            if (cov[sSeq[i]] || dead.s[i]) continue;
            f.n[sSeq[i]]++;
            f.kb[sSeq[i]] += sKb[i];
        }
        for (let i = 0; i < nl; i++) if (!cov[lSeq[i]] && !dead.l[i]) f.large[lSeq[i]] += lKb[i];
        return f;
    };

    const snapshots: Solution[] = [];
    const greedy = (price: number, from: number, to: number) => {
        let x: Solution = { inc: [], exc: [] };
        /** kandydat, ktorego nie dalo sie zmiescic: ile KB zabraklo i ile bylo wtedy miejsca */
        const failed = new Map<number, number>();
        while (x.inc.length + x.exc.length < opt.maxMasks && !late()) {
            const dead = deadOf(x.exc);
            const cov = coverOf(x.inc);
            const { t } = masks(cov, dead);
            const f = free(cov, dead);
            const room = limit(t.smallKb) - t.largeKb;
            const list: { c: number; gain: number; large: number; bound: number }[] = [];
            cands.forEach((c, i) => {
                let gain = 0;
                let kb = 0;
                let large = 0;
                for (let y = 0; y < c.seqs.length; y++) {
                    gain += f.n[c.seqs[y]];
                    kb += f.kb[c.seqs[y]];
                    large += f.large[c.seqs[y]];
                }
                if (gain < opt.minCount) return;
                const k = t.largeKb + large <= limit(t.smallKb + kb) ? 0 : 1;
                list.push({ c: i, gain, large, bound: gain / (1 + price * k) });
            });
            list.sort((a, b) => b.bound - a.bound || a.large - b.large || a.c - b.c);
            let best: { score: number; next: Solution } | null = null;
            let evals = 0;
            fullLeft = MAX_FULL;
            for (const l of list) {
                if ((best && l.bound <= best.score) || evals >= MAX_EVAL || late()) break;
                const was = failed.get(l.c);
                if (was !== undefined && room < was) continue;
                evals++;
                const score = (after: Totals, added: number) => (after.small - t.small) / (1 + price * added);
                const r = complete([...x.inc, l.c], x.exc, (after, added) => after.small - t.small < opt.minCount * (2 + added) || (best !== null && score(after, added + 1) <= best.score));
                if ('short' in r) {
                    // przerwane, bo jest lepszy: w nastepnym kroku moze sie oplacic
                    if (!best) failed.set(l.c, room + r.short * 0.5);
                    continue;
                }
                const sc = score(r.t, r.added.length);
                // kazda maska pakietu ma dac minCount
                if (r.t.small - t.small < opt.minCount * (1 + r.added.length) || (best && sc <= best.score)) continue;
                best = { score: sc, next: { inc: [...x.inc, l.c], exc: [...x.exc, ...r.added] } };
            }
            if (!best) break;
            x = best.next;
            snapshots.push(x);
            tick(from + (to - from) * Math.min(1, t.small / input.pos.length), `masek: ${x.inc.length + x.exc.length}`);
        }
    };
    PRICES.forEach((p, i) => greedy(p, 0.2 * i, 0.2 * (i + 1)));

    const count = (x: Solution) => x.inc.length + x.exc.length;
    /** dla kazdej liczby masek najlepsze, bez gorszych od krotszych */
    const pareto = (list: { x: Solution; t: Totals }[]) => {
        list.sort((a, b) => count(a.x) - count(b.x) || b.t.small - a.t.small || a.t.largeKb - b.t.largeKb);
        const keep: typeof list = [];
        for (const p of list) if (keep.length === 0 || p.t.small > keep[keep.length - 1].t.small) keep.push(p);
        return keep;
    };

    // ---- poprawianie
    const polish = (start: Solution): Solution => {
        let x = start;
        let t = measure(x);
        for (let iter = 0; iter < 20 && !late(); iter++) {
            const dead = deadOf(x.exc);
            const times = new Int32Array(q.count);
            const owner = new Int32Array(q.count).fill(-1);
            for (const c of x.inc) {
                const { seqs } = cands[c];
                for (let y = 0; y < seqs.length; y++) {
                    times[seqs[y]]++;
                    owner[seqs[y]] = c;
                }
            }
            const f = free(new Uint8Array(q.count), dead);
            const uniq = new Map<number, number>(x.inc.map(c => [c, 0]));
            for (let s = 0; s < q.count; s++) if (times[s] === 1) uniq.set(owner[s], uniq.get(owner[s])! + f.n[s]);
            let next: { x: Solution; t: Totals } | null = null;
            const consider = (y: Solution, better: (u: Totals) => boolean) => {
                if (y.inc.length === 0) return;
                const u = measure(y);
                if (!fits(u) || !lossOk(u) || !better(u)) return;
                if (!next || count(y) < count(next.x) || (count(y) === count(next.x) && u.small > next.t.small)) next = { x: y, t: u };
            };
            // zbedny INCLUDE i EXCLUDE
            for (const [c, n] of uniq) if (n < opt.minCount) consider({ inc: x.inc.filter(i => i !== c), exc: x.exc }, u => u.small > t.small - opt.minCount);
            for (const e of x.exc) consider({ inc: x.inc, exc: x.exc.filter(i => i !== e) }, u => u.small >= t.small);
            if (!next) {
                // jedna maska zamiast innych
                const swaps: { c: number; drop: number[]; gain: number }[] = [];
                cands.forEach((c, i) => {
                    if (x.inc.includes(i)) return;
                    const over = new Map<number, number>();
                    let gain = 0;
                    for (let y = 0; y < c.seqs.length; y++) {
                        const s = c.seqs[y];
                        if (times[s] === 0) gain += f.n[s];
                        else if (times[s] === 1) over.set(owner[s], (over.get(owner[s]) ?? 0) + f.n[s]);
                    }
                    const drop = x.inc.filter(j => uniq.get(j)! - (over.get(j) ?? 0) < opt.minCount);
                    if (drop.length >= 2 || (drop.length === 1 && gain >= 1)) swaps.push({ c: i, drop, gain });
                });
                swaps.sort((a, b) => b.drop.length - a.drop.length || b.gain - a.gain);
                fullLeft = 1;
                for (const s of swaps.slice(0, 15)) {
                    if (late()) break;
                    const inc = [...x.inc.filter(j => !s.drop.includes(j)), s.c];
                    const r = complete(inc, x.exc, (_t, added) => added + 1 > s.drop.length - 1);
                    if ('short' in r) continue;
                    consider({ inc, exc: [...x.exc, ...r.added] }, u => {
                        const less = s.drop.length - 1 - r.added.length;
                        return (less > 0 && u.small > t.small - opt.minCount) || (less === 0 && u.small > t.small);
                    });
                }
            }
            if (!next) break;
            ({ x, t } = next as { x: Solution; t: Totals });
        }
        return x;
    };
    let curve = pareto(snapshots.map(x => ({ x, t: measure(x) })));
    const better: typeof curve = [];
    curve.forEach((p, i) => {
        tick(0.6 + 0.3 * (i / curve.length), `poprawianie: ${i + 1} z ${curve.length}`);
        const x = polish(p.x);
        better.push({ x, t: measure(x) });
    });
    curve = pareto([...curve, ...better]);

    // ---- uscislenie wybranych INCLUDE; ich ciagi z porownania z nazwami
    const used = [...new Set(curve.flatMap(p => p.x.inc))];
    used.forEach((c, i) => {
        tick(0.9 + 0.08 * (i / used.length), 'uscislanie masek');
        const own = order.textOf(cands[c].found);
        cands[c].text = specialise(search, cands[c].seqs, cands[c].found.small, own, order);
    });
    const tree = new MaskTree(used.map(c => cands[c].text.split('.')));
    const now = used.map(() => new Set<number>());
    const scan = (rows: Int32Array, seq: Int32Array) => {
        for (let i = 0; i < rows.length; i++) {
            const s = names.start[rows[i]];
            for (const m of tree.match(names.pool, s, s + names.len[rows[i]])) now[m].add(seq[i]);
        }
    };
    scan(sRow, sSeq);
    scan(lRow, lSeq);
    used.forEach((c, m) => { cands[c].seqs = Int32Array.from(now[m]); });
    out.points = pareto(curve.map(p => ({ x: p.x, t: measure(p.x) }))).map(({ x, t }) => ({
        include: x.inc.map(c => cands[c].text), exclude: x.exc.map(e => e.text),
        small: t.small, large: t.large, smallKb: t.smallKb, largeKb: t.largeKb, lost: t.lost,
    }));
    return out;
}

/** Punkt krzywej: najmniej masek z pokryciem co najmniej part najwiekszego. */
export function defaultPoint(points: Point[], part: number): Point | null {
    if (points.length === 0) return null;
    const most = points[points.length - 1].small;
    return points.find(p => p.small >= part * most)!;
}
