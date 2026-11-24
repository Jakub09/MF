/**
 * Maski EXCLUDE: jak najszersze, bo nowy zbior objety przypadkiem zostaje wtedy tam, gdzie byl. Kolejnosc:
 *   1. jeden kwalifikator, pelny albo niepelny     **.DUMP.**   **.*DUMP*.**
 *   2. dwa kwalifikatory (gdy wylaczaja o 1/4 wiecej KB niz najlepszy jeden)   **.DATA.**.EXTRACT.**
 *   3. pelna maska, gdy dwoma sie nie da (fullMask)
 * Wygrywa maska o najwiekszej wylaczonej alokacji duzych (minus alokacja straconych malych); z roznych o 2% pelny
 * kwalifikator przed niepelnym, niepelny przed cyframi. Nazwy jako ciagi elementow (auto-quals) z waga w KB.
 */
import { CheckInput } from './auto-check';
import { literalChars, MAX_LEN, mine } from './auto-mine';
import { buildSequences, readNames, Sequences } from './auto-quals';
import { MaskTree } from './auto-tree';
import { IntList, Tick } from './auto-util';

/** ile najwiekszych kwalifikatorow jest sprawdzanych jako pierwszy albo drugi z pary */
const PAIR_HEADS = 60;
/** o tyle gorszy wynik nadal przegrywa z lepszym rodzajem kwalifikatora */
const NEAR = 0.98;
/** o tyle wiecej musza wylaczac dwa kwalifikatory */
const TWO = 1.25;

/** Wagi ciagow: duze (KB, sztuki) i male (sztuki, KB), ktore maska ma wylaczyc / oszczedzic. */
export interface Weights {
    kb: Float64Array;
    n: Float64Array;
    small: Float64Array;
    smallKb: Float64Array;
}

export interface ExLimits {
    /** ile malych wolno stracic */
    maxLoss: number;
    minKb: number;
    minCount: number;
}

export class ExcludeSpace {
    readonly q: Sequences;
    /** liczba duzych; rowSeq: duze, potem male */
    readonly nl: number;
    readonly ns: number;

    constructor(readonly input: CheckInput, private readonly head: string[], minKb: number, partial: number, tick: Tick) {
        this.nl = input.neg.length;
        this.ns = input.pos.length;
        const names = readNames({ ...input, pos: input.neg, neg: input.pos }, head.length, p => tick(0.4 * p), true);
        this.q = buildSequences(names, Math.max(1, minKb), partial, head.length > 0, p => tick(0.4 + 0.6 * p));
    }

    text(combo: number[]): string {
        return [...this.head, '**', ...combo.flatMap(t => [this.q.tokens[t].text, '**'])].join('.');
    }

    /** useL / useS: 1 = duzy do wylaczenia / maly do oszczedzenia */
    weigh(useL: Uint8Array, useS: Uint8Array): Weights {
        const { rowSeq, count } = this.q;
        const { allocKb, pos, neg } = this.input;
        const w = { kb: new Float64Array(count), n: new Float64Array(count), small: new Float64Array(count), smallKb: new Float64Array(count) };
        for (let i = 0; i < this.nl; i++) {
            if (!useL[i]) continue;
            w.kb[rowSeq[i]] += allocKb[neg[i]];
            w.n[rowSeq[i]]++;
        }
        for (let i = 0; i < this.ns; i++) {
            if (!useS[i]) continue;
            w.small[rowSeq[this.nl + i]]++;
            w.smallKb[rowSeq[this.nl + i]] += allocKb[pos[i]];
        }
        return w;
    }

    /** Najlepsza maska z jednego albo dwoch kwalifikatorow. */
    best(w: Weights, lim: ExLimits): number[] | null {
        const { tokens, count, off, cls, clsOff, clsTok, end } = this.q;
        const nt = tokens.length;
        const stamp = new Int32Array(nt);
        let round = 0;
        const sum = { kb: new Float64Array(nt), n: new Float64Array(nt), small: new Float64Array(nt), smallKb: new Float64Array(nt) };
        const add = (t: number, s: number) => {
            sum.kb[t] += w.kb[s];
            sum.n[t] += w.n[s];
            sum.small[t] += w.small[s];
            sum.smallKb[t] += w.smallKb[s];
        };
        const clear = () => {
            for (const a of Object.values(sum)) a.fill(0);
        };
        const net = (t: number) => sum.kb[t] - sum.smallKb[t];
        const ok = (t: number) => sum.small[t] <= lim.maxLoss && sum.n[t] >= lim.minCount && sum.kb[t] > 0 && net(t) >= lim.minKb;
        interface Cand { combo: number[]; net: number; loss: number; kind: number; lit: number }
        const make = (combo: number[], t: number): Cand => ({
            combo, net: net(t), loss: sum.small[t],
            kind: Math.max(...combo.map(x => tokens[x].kind)), lit: combo.reduce((n, x) => n + tokens[x].lit, 0),
        });
        const fits = (combo: number[]) => this.text(combo).length <= MAX_LEN;
        const choose = (list: Cand[]): Cand | null => {
            if (list.length === 0) return null;
            const top = list.reduce((m, c) => Math.max(m, c.net), 0);
            return list.filter(c => c.net >= top * NEAR).sort((a, b) => a.kind - b.kind || b.net - a.net || a.loss - b.loss || b.lit - a.lit
                || (this.text(a.combo) < this.text(b.combo) ? -1 : 1))[0];
        };

        for (let s = 0; s < count; s++) {
            if (w.n[s] === 0 && w.small[s] === 0) continue;
            round++;
            for (let p = off[s]; p < off[s] + end[s]; p++) {
                for (let y = clsOff[cls[p]]; y < clsOff[cls[p] + 1]; y++) {
                    const t = clsTok[y];
                    if (stamp[t] === round) continue;
                    stamp[t] = round;
                    add(t, s);
                }
            }
        }
        const one: Cand[] = [];
        const bad: number[] = [];
        for (let t = 0; t < nt; t++) {
            if (sum.n[t] < lim.minCount || sum.kb[t] < lim.minKb) continue;
            if (!ok(t)) bad.push(t);
            else if (fits([t])) one.push(make([t], t));
        }
        const single = choose(one);
        const need = Math.max(lim.minKb, single ? TWO * single.net : 0);

        // ---- pary: co najmniej jeden kwalifikator z najwiekszych, ktore same zabieraja za duzo malych
        const heads = bad.filter(t => sum.kb[t] >= need).sort((a, b) => sum.kb[b] - sum.kb[a]).slice(0, PAIR_HEADS);
        const big = Uint8Array.from(sum.kb, v => Number(v >= need));
        const slot = new Int32Array(nt).fill(-1);
        heads.forEach((t, i) => { slot[t] = i; });
        const lists = heads.map(() => new IntList());
        if (heads.length) {
            for (let s = 0; s < count; s++) {
                if (w.n[s] === 0 && w.small[s] === 0) continue;
                round++;
                for (let p = off[s]; p < off[s] + end[s]; p++) {
                    for (let y = clsOff[cls[p]]; y < clsOff[cls[p] + 1]; y++) {
                        const t = clsTok[y];
                        if (slot[t] < 0 || stamp[t] === round) continue;
                        stamp[t] = round;
                        lists[slot[t]].push(s);
                    }
                }
            }
        }
        const two: Cand[] = [];
        heads.forEach((a, i) => {
            const has = (c: number) => {
                for (let y = clsOff[c]; y < clsOff[c + 1]; y++) if (clsTok[y] === a) return true;
                return false;
            };
            for (const before of [false, true]) {
                clear();
                for (let x = 0; x < lists[i].n; x++) {
                    const s = lists[i].a[x];
                    let lo = off[s];
                    let hi = off[s] + end[s];
                    if (before) {
                        do hi--; while (!has(cls[hi]));
                    } else {
                        while (!has(cls[lo])) lo++;
                        lo++;
                    }
                    round++;
                    for (let p = lo; p < hi; p++) {
                        for (let y = clsOff[cls[p]]; y < clsOff[cls[p] + 1]; y++) {
                            const t = clsTok[y];
                            if (!big[t] || stamp[t] === round) continue;
                            stamp[t] = round;
                            add(t, s);
                        }
                    }
                }
                for (let t = 0; t < nt; t++) {
                    const combo = before ? [t, a] : [a, t];
                    if (big[t] && net(t) >= need && ok(t) && fits(combo)) two.push(make(combo, t));
                }
            }
        });
        return (choose(two) ?? single)?.combo ?? null;
    }

    /** 1 = nazwa pasuje: [duze], [male] */
    hits(combo: number[]): [Uint8Array, Uint8Array] {
        const { count, off, cls, clsOff, clsTok, end, rowSeq } = this.q;
        const flag = new Uint8Array(count);
        for (let s = 0; s < count; s++) {
            let j = 0;
            for (let p = off[s]; p < off[s] + end[s] && j < combo.length; p++) {
                for (let y = clsOff[cls[p]]; y < clsOff[cls[p] + 1]; y++) {
                    if (clsTok[y] !== combo[j]) continue;
                    j++;
                    break;
                }
            }
            flag[s] = Number(j === combo.length);
        }
        const l = new Uint8Array(this.nl);
        const s = new Uint8Array(this.ns);
        for (let i = 0; i < this.nl; i++) l[i] = flag[rowSeq[i]];
        for (let i = 0; i < this.ns; i++) s[i] = flag[rowSeq[this.nl + i]];
        return [l, s];
    }

    hitsOf(mask: string): [Uint8Array, Uint8Array] {
        const { names, pos, neg } = this.input;
        const tree = new MaskTree([mask.split('.')]);
        const test = (rows: Int32Array) => Uint8Array.from(rows, r => Number(tree.match(names.pool, names.start[r], names.start[r] + names.len[r]).length > 0));
        return [test(neg), test(pos)];
    }

    /** Pelne maski bez straty malych dla pozostalych duzych, od najwiekszej alokacji. */
    fullMasks(useL: Uint8Array, useS: Uint8Array, opt: { minCount: number; minKb: number; maxMasks: number; maxWild: number }, tick: Tick): { text: string; kb: number }[] {
        const { input } = this;
        const pos = input.neg.filter((_, i) => useL[i]);
        const neg = input.pos.filter((_, i) => useS[i]);
        const res = mine({ names: input.names, allocKb: input.allocKb, pos, neg }, { ...opt, minPurity: 1, head: this.head },
            { prepare: p => tick(0.2 * p), search: () => p => tick(0.2 + 0.6 * p), select: () => p => tick(0.8 + 0.2 * p) });
        return res.masks.filter(m => m.smallKb >= opt.minKb).map(m => ({ text: m.text, kb: m.smallKb })).sort((a, b) => b.kb - a.kb);
    }
}

/** Maski EXCLUDE dla wszystkich duzych z input (zachlannie), bez zbednych. */
export function pickExcludes(input: CheckInput, head: string[], opt: { minCount: number; gain: number; loss: number; maxWild: number; maxMasks: number }, tick: Tick): string[] {
    const { allocKb, pos, neg } = input;
    let total = 0;
    for (let i = 0; i < neg.length; i++) total += allocKb[neg[i]];
    const minKb = total * opt.gain;
    const space = new ExcludeSpace(input, head, minKb, 3, p => tick(0.4 * p));
    const useL = new Uint8Array(neg.length).fill(1);
    const useS = new Uint8Array(pos.length).fill(1);
    let loss = Math.floor(pos.length * opt.loss);
    const out: { text: string; l: Uint8Array }[] = [];
    const take = (text: string, [l, s]: [Uint8Array, Uint8Array]) => {
        out.push({ text, l });
        for (let i = 0; i < l.length; i++) if (l[i]) useL[i] = 0;
        for (let i = 0; i < s.length; i++) {
            if (!s[i] || !useS[i]) continue;
            useS[i] = 0;
            loss--;
        }
    };
    while (out.length < opt.maxMasks) {
        tick(0.4 + 0.3 * (1 - 1 / (1 + out.length)));
        const combo = space.best(space.weigh(useL, useS), { maxLoss: loss, minKb, minCount: opt.minCount });
        if (!combo) break;
        take(space.text(combo), space.hits(combo));
    }
    if (out.length < opt.maxMasks && useL.includes(1)) {
        const o = { minCount: opt.minCount, minKb, maxMasks: opt.maxMasks - out.length, maxWild: opt.maxWild };
        for (const m of space.fullMasks(useL, useS, o, p => tick(0.7 + 0.3 * p))) out.push({ text: m.text, l: space.hitsOf(m.text)[0] });
    }
    // zbedne: wszystkie ich duze wylaczaja pozostale
    const cover = new Int32Array(neg.length);
    for (const m of out) for (let i = 0; i < cover.length; i++) cover[i] += m.l[i];
    const keep = out.map(() => true);
    for (let j = out.length - 1; j >= 0; j--) {
        if (out[j].l.some((v, i) => v && cover[i] < 2)) continue;
        keep[j] = false;
        for (let i = 0; i < cover.length; i++) cover[i] -= out[j].l[i];
    }
    return out.filter((m, j) => keep[j] && literalChars(m.text)).map(m => m.text);
}
