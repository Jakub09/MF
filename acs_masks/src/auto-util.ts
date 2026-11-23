/** Struktury na tablicach typowanych i pasek postepu dla szukania masek (src/auto*.ts): miliony pozycji bez obiektow. */

type Typed = Uint8Array | Int32Array | Float64Array;

/** Kopia tablicy, co najmniej dwa razy dluzsza. */
export function grow<T extends Typed>(a: T, min: number): T {
    const b = new (a.constructor as new (n: number) => T)(Math.max(a.length * 2, min));
    b.set(a);
    return b;
}

/** Zbior ciagow bajtow (do 255): ciag -> numer (0, 1, 2...). */
export class Interner {
    size = 0;
    pool = new Uint8Array(1 << 16);
    start = new Int32Array(1 << 10);
    len = new Uint8Array(1 << 10);
    private hash = new Int32Array(1 << 10);
    private table = new Int32Array(1 << 11).fill(-1);
    private used = 0;

    private static hashOf(buf: Uint8Array, s: number, e: number): number {
        let h = 0x811c9dc5;
        for (let i = s; i < e; i++) h = Math.imul(h ^ buf[i], 16777619);
        return h ^ (h >>> 15);
    }
    private slot(buf: Uint8Array, s: number, e: number, h: number): number {
        const mask = this.table.length - 1;
        const n = e - s;
        for (let p = h & mask; ; p = (p + 1) & mask) {
            const id = this.table[p];
            if (id < 0) return p;
            if (this.hash[id] !== h || this.len[id] !== n) continue;
            const at = this.start[id];
            let i = 0;
            while (i < n && this.pool[at + i] === buf[s + i]) i++;
            if (i === n) return p;
        }
    }
    /** Numer ciagu buf[s..e) albo -1. */
    find(buf: Uint8Array, s: number, e: number): number {
        return this.table[this.slot(buf, s, e, Interner.hashOf(buf, s, e))];
    }
    /** Numer ciagu buf[s..e); nowy ciag dostaje numer = size. */
    add(buf: Uint8Array, s: number, e: number): number {
        const h = Interner.hashOf(buf, s, e);
        const p = this.slot(buf, s, e, h);
        if (this.table[p] >= 0) return this.table[p];
        const id = this.size++;
        const n = e - s;
        if (id >= this.start.length) {
            this.start = grow(this.start, id + 1);
            this.len = grow(this.len, id + 1);
            this.hash = grow(this.hash, id + 1);
        }
        if (this.used + n > this.pool.length) this.pool = grow(this.pool, this.used + n);
        for (let i = 0; i < n; i++) this.pool[this.used + i] = buf[s + i];
        this.start[id] = this.used;
        this.len[id] = n;
        this.hash[id] = h;
        this.used += n;
        this.table[p] = id;
        if (this.size * 2 > this.table.length) this.rehash();
        return id;
    }
    private rehash(): void {
        const t = new Int32Array(this.table.length * 2).fill(-1);
        const mask = t.length - 1;
        for (let id = 0; id < this.size; id++) {
            let p = this.hash[id] & mask;
            while (t[p] >= 0) p = (p + 1) & mask;
            t[p] = id;
        }
        this.table = t;
    }
    /** Zwalnia indeks; potem dziala tylko text / pool / start / len. */
    freeze(): void {
        this.table = new Int32Array(0);
        this.hash = new Int32Array(0);
    }
    text(id: number): string {
        return latin1(this.pool, this.start[id], this.start[id] + this.len[id]);
    }
}

export const latin1 = (b: Uint8Array, s: number, e: number): string =>
    Buffer.from(b.buffer, b.byteOffset + s, e - s).toString('latin1');

/** Rosnaca lista liczb 32-bitowych. */
export class IntList {
    a = new Int32Array(1024);
    n = 0;
    push(v: number): void {
        if (this.n === this.a.length) this.a = grow(this.a, this.n + 1);
        this.a[this.n++] = v;
    }
}

/** Slownik (a, b) -> liczba; a, b >= 0. */
export class PairMap {
    size = 0;
    private a = new Int32Array(1 << 10).fill(-1);
    private b = new Int32Array(1 << 10);
    private v = new Int32Array(1 << 10);

    private slot(a: number, b: number): number {
        const mask = this.a.length - 1;
        let h = Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca6b);
        h = Math.imul(h ^ (h >>> 15), 0xc2b2ae35);
        let p = (h ^ (h >>> 13)) & mask;
        while (this.a[p] >= 0 && (this.a[p] !== a || this.b[p] !== b)) p = (p + 1) & mask;
        return p;
    }
    get(a: number, b: number): number {
        const p = this.slot(a, b);
        return this.a[p] < 0 ? -1 : this.v[p];
    }
    set(a: number, b: number, v: number): void {
        const p = this.slot(a, b);
        const isNew = this.a[p] < 0;
        this.a[p] = a;
        this.b[p] = b;
        this.v[p] = v;
        if (isNew && ++this.size * 2 > this.a.length) this.rehash();
    }
    /** Istniejaca wartosc, a dla nowej pary kolejny numer (size). */
    index(a: number, b: number): number {
        const p = this.slot(a, b);
        if (this.a[p] >= 0) return this.v[p];
        const id = this.size;
        this.set(a, b, id);
        return id;
    }
    each(f: (a: number, b: number, v: number) => void): void {
        for (let p = 0; p < this.a.length; p++) if (this.a[p] >= 0) f(this.a[p], this.b[p], this.v[p]);
    }
    private rehash(): void {
        const { a, b, v } = this;
        this.a = new Int32Array(a.length * 2).fill(-1);
        this.b = new Int32Array(a.length * 2);
        this.v = new Int32Array(a.length * 2);
        for (let i = 0; i < a.length; i++) {
            if (a[i] < 0) continue;
            const p = this.slot(a[i], b[i]);
            this.a[p] = a[i];
            this.b[p] = b[i];
            this.v[p] = v[i];
        }
    }
}

export const thousands = (n: number) => String(n).replace(/\B(?=(\d{3})+$)/g, ' ');

/** Postep jednego etapu: tick(czesc 0-1, opis); mozna wolac czesto. */
export type Tick = (part: number, info?: string) => void;

const WIDTH = 30;
const EVERY_MS = 100;

/**
 * Pasek postepu: [2/4] Kandydaci   [#########.....]  45%  12,0 s
 * Poza terminalem (przekierowanie do pliku) tylko jedna linia na zakonczony etap.
 */
export class Progress {
    private no = 0;
    private label = '';
    private t0 = 0;
    private last = 0;
    private lastLen = 0;
    private info = '';

    constructor(private readonly stages: number, private readonly write: (t: string) => void,
        private readonly tty: boolean, private readonly columns: () => number = () => 80) {}

    stage(label: string): Tick {
        this.no++;
        this.label = label;
        this.t0 = Date.now();
        this.last = this.t0;
        this.info = '';
        this.draw(0);
        return (part, info) => {
            const now = Date.now();
            if (now - this.last < EVERY_MS) return;
            this.last = now;
            if (info !== undefined) this.info = info;
            this.draw(part);
        };
    }
    done(info = ''): void {
        this.info = info;
        if (this.tty) this.draw(1, true);
        else this.write(`${this.head()} ${this.time()}${info ? `  ${info}` : ''}\n`);
    }
    /** Przerwany etap (blad): komunikat zaczyna sie od nowej linii. */
    abort(): void {
        if (this.lastLen) this.write('\n');
        this.lastLen = 0;
    }
    private head(): string {
        return `[${this.no}/${this.stages}] ${this.label.padEnd(18)}`;
    }
    private time(): string {
        return `${((Date.now() - this.t0) / 1000).toFixed(1).replace('.', ',')} s`;
    }
    private draw(part: number, end = false): void {
        if (!this.tty) return;
        const p = Math.max(0, Math.min(1, part));
        const full = Math.floor(p * WIDTH);
        const line = `${this.head()} [${'#'.repeat(full)}${'.'.repeat(WIDTH - full)}] `
            + `${String(Math.floor(p * 100)).padStart(3)}%  ${this.time()}${this.info ? `  ${this.info}` : ''}`;
        // linia dluzsza niz terminal zawinelaby sie i \r nie wrocilby na jej poczatek (ostatnia w etapie moze)
        const cut = end ? line : line.slice(0, Math.max(20, this.columns() - 1));
        this.write(`\r${cut.padEnd(this.lastLen)}${end ? '\n' : ''}`);
        this.lastLen = end ? 0 : cut.length;
    }
}
