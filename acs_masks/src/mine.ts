/**
 * Dobor masek DSN dla zbiorow spelniajacych kryterium reguly.
 *
 * Kandydaci (z nazw zbiorow "pozytywnych", q1..qn = kwalifikatory):
 *   prefiks      q1.q2...qk.**            k = 1..n
 *   pelna nazwa  q1...qn
 *   LLQ          q1...qk.**.qn            k = 1..n-1, oraz *.**.qn
 *   cyfry -> %   ostatni kwalifikator prefiksu / pelnej nazwy / LLQ, np. PROD.D%%%%%%.**
 * Liczenie pokrycia jest dokladne (semantyka FILTLIST, src/mask.ts) - przez indeks kluczy, bez porownywania
 * kazdej maski z kazda nazwa.
 *
 * Wybor (zachlanny): maska o najwiekszej liczbie nowo pokrytych zbiorow pozytywnych, o ile
 *   nowo pokrytych >= minCount i czystosc = poz / (poz + neg) >= minPurity (neg = objete maska, a niespelniajace
 *   kryterium). Remis: wyzsza czystosc, mniej neg, wiecej znakow stalych (maska bardziej szczegolowa -
 *   ostrozniej wobec zbiorow, ktorych jeszcze nie ma), mniej '*', krotsza. Na koncu usuwane maski zbedne
 *   (wszystkie ich zbiory pokrywaja inne wybrane).
 */
import { digitMask, qualMatches } from './mask';

export interface Candidate {
    id: number;
    text: string;
    /** indeksy zbiorow pozytywnych objetych maska */
    pos: number[];
    /** liczba zbiorow negatywnych objetych maska */
    neg: number;
}

export interface MineOptions {
    minPurity: number;
    minCount: number;
    maxMasks: number;
    digitMasks: boolean;
}

export interface Selected {
    cand: Candidate;
    /** zbiory pozytywne pokryte jako pierwsze przez te maske (w kolejnosci wyboru) */
    gain: number;
}

interface DigitCand {
    cand: Candidate;
    /** maska kwalifikatora z '%' */
    pattern: string;
}

/**
 * Indeks masek: klucze literalne (P|, E|, L|) i kubelki masek z '%' (PD|, ED|, LD|).
 * Te same klucze wylicza kazda nazwa (keysOf) - maska pasuje do nazwy <=> wspolny klucz
 * (dla masek z '%' dodatkowo porownanie kwalifikatora).
 */
export class MaskIndex {
    readonly byText = new Map<string, Candidate>();
    private readonly literal = new Map<string, Candidate>();
    private readonly digit = new Map<string, DigitCand[]>();

    constructor(private readonly digitMasks: boolean) {}

    get size(): number {
        return this.byText.size;
    }

    private add(key: string, text: string): Candidate {
        let c = this.byText.get(text);
        if (!c) {
            c = { id: this.byText.size, text, pos: [], neg: 0 };
            this.byText.set(text, c);
            this.literal.set(key, c);
        }
        return c;
    }

    private addDigit(bucket: string, text: string, pattern: string): Candidate {
        let c = this.byText.get(text);
        if (!c) {
            c = { id: this.byText.size, text, pos: [], neg: 0 };
            this.byText.set(text, c);
            let b = this.digit.get(bucket);
            if (!b) this.digit.set(bucket, b = []);
            b.push({ cand: c, pattern });
        }
        return c;
    }

    /** Dodaje wszystkich kandydatow z nazwy (zbior pozytywny). */
    addFrom(q: string[]): void {
        const n = q.length;
        const llq = q[n - 1];
        for (let k = 1; k <= n; k++) {
            const pre = q.slice(0, k).join('.');
            this.add(`P|${pre}`, `${pre}.**`);
            const g = this.digitMasks ? digitMask(q[k - 1]) : null;
            if (g) {
                const head = q.slice(0, k - 1);
                this.addDigit(`PD|${head.join('.')}|${k}|${q[k - 1].length}`, [...head, g, '**'].join('.'), g);
            }
        }
        this.add(`E|${q.join('.')}`, q.join('.'));
        const gl = this.digitMasks ? digitMask(llq) : null;
        if (gl) {
            const head = q.slice(0, n - 1);
            this.addDigit(`ED|${head.join('.')}|${n}|${llq.length}`, [...head, gl].join('.'), gl);
        }
        if (n >= 2) {
            for (let k = 0; k <= n - 1; k++) {
                const pre = k === 0 ? '*' : q.slice(0, k).join('.');
                this.add(`L|${k}|${pre}|${llq}`, `${pre}.**.${llq}`);
                if (gl) this.addDigit(`LD|${k}|${pre}|${llq.length}`, `${pre}.**.${gl}`, gl);
            }
        }
    }

    /** Wszystkie maski z indeksu pasujace do nazwy. */
    matching(q: string[]): Candidate[] {
        const out: Candidate[] = [];
        const n = q.length;
        const llq = q[n - 1];
        const lit = (key: string) => {
            const c = this.literal.get(key);
            if (c) out.push(c);
        };
        const dig = (bucket: string, qual: string) => {
            const b = this.digit.get(bucket);
            if (b) for (const d of b) if (qualMatches(d.pattern, qual)) out.push(d.cand);
        };
        for (let k = 1; k <= n; k++) {
            lit(`P|${q.slice(0, k).join('.')}`);
            if (this.digitMasks) dig(`PD|${q.slice(0, k - 1).join('.')}|${k}|${q[k - 1].length}`, q[k - 1]);
        }
        lit(`E|${q.join('.')}`);
        if (this.digitMasks) dig(`ED|${q.slice(0, n - 1).join('.')}|${n}|${llq.length}`, llq);
        if (n >= 2) {
            for (let k = 0; k <= n - 1; k++) {
                const pre = k === 0 ? '*' : q.slice(0, k).join('.');
                lit(`L|${k}|${pre}|${llq}`);
                if (this.digitMasks) dig(`LD|${k}|${pre}|${llq.length}`, llq);
            }
        }
        return out;
    }
}

/**
 * Kandydaci z policzonym pokryciem.
 * @param positives kwalifikatory zbiorow spelniajacych kryterium
 * @param negatives kwalifikatory pozostalych zbiorow w zakresie reguly
 */
export function buildCandidates(positives: string[][], negatives: Iterable<string[]>, digitMasks: boolean): MaskIndex {
    const idx = new MaskIndex(digitMasks);
    for (const q of positives) idx.addFrom(q);
    positives.forEach((q, i) => {
        for (const c of idx.matching(q)) c.pos.push(i);
    });
    for (const q of negatives) {
        for (const c of idx.matching(q)) c.neg++;
    }
    return idx;
}

export const purity = (c: Candidate) => c.pos.length / (c.pos.length + c.neg);

/** Liczba znakow stalych maski (bez '*', '%', '.'). */
const literalChars = (t: string) => t.replace(/[*%.]/g, '').length;

function better(a: { gain: number; c: Candidate }, b: { gain: number; c: Candidate }): boolean {
    if (a.gain !== b.gain) return a.gain > b.gain;
    const pa = purity(a.c);
    const pb = purity(b.c);
    if (pa !== pb) return pa > pb;
    if (a.c.neg !== b.c.neg) return a.c.neg < b.c.neg;
    const la = literalChars(a.c.text);
    const lb = literalChars(b.c.text);
    if (la !== lb) return la > lb;
    const sa = (a.c.text.match(/\*/g) ?? []).length;
    const sb = (b.c.text.match(/\*/g) ?? []).length;
    if (sa !== sb) return sa < sb;
    if (a.c.text.length !== b.c.text.length) return a.c.text.length < b.c.text.length;
    return a.c.text < b.c.text;
}

/** Kopiec maksimum dla leniwego algorytmu zachlannego. */
class Heap {
    private a: { gain: number; c: Candidate }[] = [];
    get length(): number {
        return this.a.length;
    }
    push(x: { gain: number; c: Candidate }): void {
        const a = this.a;
        a.push(x);
        let i = a.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (!better(a[i], a[p])) break;
            [a[i], a[p]] = [a[p], a[i]];
            i = p;
        }
    }
    pop(): { gain: number; c: Candidate } | undefined {
        const a = this.a;
        if (a.length === 0) return undefined;
        const top = a[0];
        const last = a.pop()!;
        if (a.length > 0) {
            a[0] = last;
            let i = 0;
            for (;;) {
                const l = 2 * i + 1;
                const r = l + 1;
                let m = i;
                if (l < a.length && better(a[l], a[m])) m = l;
                if (r < a.length && better(a[r], a[m])) m = r;
                if (m === i) break;
                [a[i], a[m]] = [a[m], a[i]];
                i = m;
            }
        }
        return top;
    }
}

export function selectMasks(idx: MaskIndex, nPositives: number, opt: MineOptions): Selected[] {
    const covered = new Uint8Array(nPositives);
    const heap = new Heap();
    for (const c of idx.byText.values()) {
        if (c.pos.length >= opt.minCount && purity(c) >= opt.minPurity) heap.push({ gain: c.pos.length, c });
    }
    const chosen: Selected[] = [];
    while (heap.length > 0 && chosen.length < opt.maxMasks) {
        const top = heap.pop()!;
        let gain = 0;
        for (const i of top.c.pos) if (!covered[i]) gain++;
        if (gain < opt.minCount) continue;
        if (gain < top.gain) {
            heap.push({ gain, c: top.c });
            continue;
        }
        for (const i of top.c.pos) covered[i] = 1;
        chosen.push({ cand: top.c, gain });
    }
    return pruneRedundant(chosen, nPositives);
}

/** Usuwa maski, ktorych wszystkie zbiory pokrywaja inne wybrane maski (od ostatnio wybranych). */
export function pruneRedundant(chosen: Selected[], nPositives: number): Selected[] {
    const cnt = new Uint32Array(nPositives);
    for (const s of chosen) for (const i of s.cand.pos) cnt[i]++;
    const keep = new Array<boolean>(chosen.length).fill(true);
    for (let j = chosen.length - 1; j >= 0; j--) {
        const s = chosen[j];
        if (s.cand.pos.every(i => cnt[i] >= 2)) {
            keep[j] = false;
            for (const i of s.cand.pos) cnt[i]--;
        }
    }
    return chosen.filter((_, j) => keep[j]);
}
