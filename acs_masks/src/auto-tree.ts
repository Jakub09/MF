/** Dopasowanie nazw do wielu masek naraz (drzewo) i zawieranie masek (automaty); znaczenie masek jak w mask.ts. */
import { IntList, PairMap } from './auto-util';

const DOT = 46;
const PCT = 37;
const STAR = 42;
/** krawedz '**' w drzewie masek (wzorce kwalifikatorow maja numery od 1) */
const ANY_QUALS = 0;

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
