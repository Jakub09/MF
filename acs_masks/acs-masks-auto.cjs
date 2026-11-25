#!/usr/bin/env node
// Szukanie masek DSN wg kryteriow z CSV DCOLLECT (job ACMCSV). Jeden plik, bez npm; Node.js >= 18.3.
// WYGENEROWANE z src/ przez tools/standalone.mjs - nie edytowac recznie.
//   node acs-masks-auto.cjs DCOLLECT.CSV [opcje] - opis opcji: --help
const MODULES = {};
const LOADED = {};
function load(name) {
    if (!MODULES[name]) return require(name);
    if (!LOADED[name]) {
        LOADED[name] = {};
        MODULES[name](LOADED[name], load, module);
    }
    return LOADED[name];
}
load.main = require.main;

// ==================== src/auto-util.ts
MODULES["./auto-util"] = function (exports, require, module) {
"use strict";
/** Struktury na tablicach typowanych i pasek postepu dla szukania masek (src/auto*.ts): miliony pozycji bez obiektow. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.Progress = exports.thousands = exports.PairMap = exports.IntList = exports.latin1 = exports.Interner = void 0;
exports.grow = grow;
/** Kopia tablicy, co najmniej dwa razy dluzsza. */
function grow(a, min) {
    const b = new a.constructor(Math.max(a.length * 2, min));
    b.set(a);
    return b;
}
/** Zbior ciagow bajtow (do 255): ciag -> numer (0, 1, 2...). */
class Interner {
    size = 0;
    pool = new Uint8Array(1 << 16);
    start = new Int32Array(1 << 10);
    len = new Uint8Array(1 << 10);
    hash = new Int32Array(1 << 10);
    table = new Int32Array(1 << 11).fill(-1);
    used = 0;
    static hashOf(buf, s, e) {
        let h = 0x811c9dc5;
        for (let i = s; i < e; i++)
            h = Math.imul(h ^ buf[i], 16777619);
        return h ^ (h >>> 15);
    }
    slot(buf, s, e, h) {
        const mask = this.table.length - 1;
        const n = e - s;
        for (let p = h & mask;; p = (p + 1) & mask) {
            const id = this.table[p];
            if (id < 0)
                return p;
            if (this.hash[id] !== h || this.len[id] !== n)
                continue;
            const at = this.start[id];
            let i = 0;
            while (i < n && this.pool[at + i] === buf[s + i])
                i++;
            if (i === n)
                return p;
        }
    }
    /** Numer ciagu buf[s..e) albo -1. */
    find(buf, s, e) {
        return this.table[this.slot(buf, s, e, Interner.hashOf(buf, s, e))];
    }
    /** Numer ciagu buf[s..e); nowy ciag dostaje numer = size. */
    add(buf, s, e) {
        const h = Interner.hashOf(buf, s, e);
        const p = this.slot(buf, s, e, h);
        if (this.table[p] >= 0)
            return this.table[p];
        const id = this.size++;
        const n = e - s;
        if (id >= this.start.length) {
            this.start = grow(this.start, id + 1);
            this.len = grow(this.len, id + 1);
            this.hash = grow(this.hash, id + 1);
        }
        if (this.used + n > this.pool.length)
            this.pool = grow(this.pool, this.used + n);
        for (let i = 0; i < n; i++)
            this.pool[this.used + i] = buf[s + i];
        this.start[id] = this.used;
        this.len[id] = n;
        this.hash[id] = h;
        this.used += n;
        this.table[p] = id;
        if (this.size * 2 > this.table.length)
            this.rehash();
        return id;
    }
    rehash() {
        const t = new Int32Array(this.table.length * 2).fill(-1);
        const mask = t.length - 1;
        for (let id = 0; id < this.size; id++) {
            let p = this.hash[id] & mask;
            while (t[p] >= 0)
                p = (p + 1) & mask;
            t[p] = id;
        }
        this.table = t;
    }
    /** Zwalnia indeks; potem dziala tylko text / pool / start / len. */
    freeze() {
        this.table = new Int32Array(0);
        this.hash = new Int32Array(0);
    }
    text(id) {
        return (0, exports.latin1)(this.pool, this.start[id], this.start[id] + this.len[id]);
    }
}
exports.Interner = Interner;
const latin1 = (b, s, e) => Buffer.from(b.buffer, b.byteOffset + s, e - s).toString('latin1');
exports.latin1 = latin1;
/** Rosnaca lista liczb 32-bitowych. */
class IntList {
    a = new Int32Array(1024);
    n = 0;
    push(v) {
        if (this.n === this.a.length)
            this.a = grow(this.a, this.n + 1);
        this.a[this.n++] = v;
    }
}
exports.IntList = IntList;
/** Slownik (a, b) -> liczba; a, b >= 0. */
class PairMap {
    size = 0;
    a = new Int32Array(1 << 10).fill(-1);
    b = new Int32Array(1 << 10);
    v = new Int32Array(1 << 10);
    slot(a, b) {
        const mask = this.a.length - 1;
        let h = Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca6b);
        h = Math.imul(h ^ (h >>> 15), 0xc2b2ae35);
        let p = (h ^ (h >>> 13)) & mask;
        while (this.a[p] >= 0 && (this.a[p] !== a || this.b[p] !== b))
            p = (p + 1) & mask;
        return p;
    }
    get(a, b) {
        const p = this.slot(a, b);
        return this.a[p] < 0 ? -1 : this.v[p];
    }
    set(a, b, v) {
        const p = this.slot(a, b);
        const isNew = this.a[p] < 0;
        this.a[p] = a;
        this.b[p] = b;
        this.v[p] = v;
        if (isNew && ++this.size * 2 > this.a.length)
            this.rehash();
    }
    /** Istniejaca wartosc, a dla nowej pary kolejny numer (size). */
    index(a, b) {
        const p = this.slot(a, b);
        if (this.a[p] >= 0)
            return this.v[p];
        const id = this.size;
        this.set(a, b, id);
        return id;
    }
    each(f) {
        for (let p = 0; p < this.a.length; p++)
            if (this.a[p] >= 0)
                f(this.a[p], this.b[p], this.v[p]);
    }
    rehash() {
        const { a, b, v } = this;
        this.a = new Int32Array(a.length * 2).fill(-1);
        this.b = new Int32Array(a.length * 2);
        this.v = new Int32Array(a.length * 2);
        for (let i = 0; i < a.length; i++) {
            if (a[i] < 0)
                continue;
            const p = this.slot(a[i], b[i]);
            this.a[p] = a[i];
            this.b[p] = b[i];
            this.v[p] = v[i];
        }
    }
}
exports.PairMap = PairMap;
const thousands = (n) => String(n).replace(/\B(?=(\d{3})+$)/g, ' ');
exports.thousands = thousands;
const WIDTH = 30;
const EVERY_MS = 100;
/**
 * Pasek postepu: [2/4] Kandydaci   [#########.....]  45%  12,0 s
 * Poza terminalem (przekierowanie do pliku) tylko jedna linia na zakonczony etap.
 */
class Progress {
    stages;
    write;
    tty;
    columns;
    no = 0;
    label = '';
    t0 = 0;
    last = 0;
    lastLen = 0;
    info = '';
    constructor(stages, write, tty, columns = () => 80) {
        this.stages = stages;
        this.write = write;
        this.tty = tty;
        this.columns = columns;
    }
    stage(label) {
        this.no++;
        this.label = label;
        this.t0 = Date.now();
        this.last = this.t0;
        this.info = '';
        this.draw(0);
        return (part, info) => {
            const now = Date.now();
            if (now - this.last < EVERY_MS)
                return;
            this.last = now;
            if (info !== undefined)
                this.info = info;
            this.draw(part);
        };
    }
    done(info = '') {
        this.info = info;
        if (this.tty)
            this.draw(1, true);
        else
            this.write(`${this.head()} ${this.time()}${info ? `  ${info}` : ''}\n`);
    }
    /** Przerwany etap (blad): komunikat zaczyna sie od nowej linii. */
    abort() {
        if (this.lastLen)
            this.write('\n');
        this.lastLen = 0;
    }
    head() {
        return `[${this.no}/${this.stages}] ${this.label.padEnd(18)}`;
    }
    time() {
        return `${((Date.now() - this.t0) / 1000).toFixed(1).replace('.', ',')} s`;
    }
    draw(part, end = false) {
        if (!this.tty)
            return;
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
exports.Progress = Progress;
};

// ==================== src/auto-tree.ts
MODULES["./auto-tree"] = function (exports, require, module) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MaskTree = void 0;
exports.within = within;
/** Dopasowanie nazw do wielu masek naraz (drzewo) i zawieranie masek (automaty); znaczenie masek jak w mask.ts. */
const auto_util_1 = require("./auto-util");
const DOT = 46;
const PCT = 37;
const STAR = 42;
/** krawedz '**' w drzewie masek (wzorce kwalifikatorow maja numery od 1) */
const ANY_QUALS = 0;
/** Lista masek jako drzewo kwalifikatorow; kwalifikatory z * i % - drzewo znakow. */
class MaskTree {
    /** (wezel znakow, bajt) -> wezel; na koncu wzorca jego numer */
    chars = new auto_util_1.PairMap();
    charLeaf = new auto_util_1.IntList();
    /** (wezel masek, wzorzec) -> wezel; na koncu maski ich numery */
    child = new auto_util_1.PairMap();
    ends = [[]];
    stamp;
    round = 0;
    pats = new auto_util_1.IntList();
    qs = new Int32Array(256);
    qe = new Int32Array(256);
    from = new Int32Array(256);
    to = new Int32Array(256);
    out = [];
    constructor(masks) {
        this.charLeaf.push(0);
        this.stamp = new Int32Array(masks.length);
        const ids = new Map([['**', ANY_QUALS]]);
        masks.forEach((quals, m) => {
            let node = 0;
            quals.forEach((q, i) => {
                // ** po ** nic nie zmienia
                if (q === '**' && quals[i - 1] === '**')
                    return;
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
    addPattern(q, id) {
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
    patterns(buf, p, e, node) {
        const star = this.chars.get(node, STAR);
        if (star >= 0)
            for (let k = p; k <= e; k++)
                this.patterns(buf, k, e, star);
        if (p === e) {
            if (this.charLeaf.a[node])
                this.pats.push(this.charLeaf.a[node]);
            return;
        }
        const any = this.chars.get(node, PCT);
        if (any >= 0)
            this.patterns(buf, p + 1, e, any);
        const same = this.chars.get(node, buf[p]);
        if (same >= 0)
            this.patterns(buf, p + 1, e, same);
    }
    walk(buf, node, i, n) {
        const more = this.child.get(node, ANY_QUALS);
        if (more >= 0)
            for (let k = i; k <= n; k++)
                this.walk(buf, more, k, n);
        if (i === n) {
            for (const m of this.ends[node]) {
                if (this.stamp[m] === this.round)
                    continue;
                this.stamp[m] = this.round;
                this.out.push(m);
            }
            return;
        }
        if (this.from[i] < 0) {
            this.from[i] = this.pats.n;
            if (this.qs[i] < this.qe[i])
                this.patterns(buf, this.qs[i], this.qe[i], 0);
            this.to[i] = this.pats.n;
        }
        for (let y = this.from[i]; y < this.to[i]; y++) {
            const x = this.child.get(node, this.pats.a[y]);
            if (x >= 0)
                this.walk(buf, x, i + 1, n);
        }
    }
    /** Numery masek pasujacych do nazwy buf[s..e), rosnaco; tablica wazna do nastepnego wywolania. */
    match(buf, s, e) {
        this.round++;
        this.pats.n = 0;
        this.out = [];
        let n = 0;
        let b = s;
        for (let p = s; p <= e; p++) {
            if (p < e && buf[p] !== DOT)
                continue;
            this.qs[n] = b;
            this.qe[n] = p;
            this.from[n++] = -1;
            b = p + 1;
        }
        this.walk(buf, 0, 0, n);
        return this.out.length > 1 ? this.out.sort((x, y) => x - y) : this.out;
    }
}
exports.MaskTree = MaskTree;
/** Maska jako automat na nazwie z kropka po kazdym kwalifikatorze (A.B -> "A.B."). */
function nfa(quals) {
    const edges = [];
    const eps = [];
    const add = () => {
        edges.push([]);
        eps.push([]);
        return edges.length - 1;
    };
    let s = add();
    const next = (on) => {
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
        if (q === '*')
            next(null);
        for (const c of q) {
            if (c === '*') {
                loop();
                edges[s].push({ on: null, to: s });
                loop();
            }
            else {
                next(c === '%' ? null : c);
            }
        }
        next('.');
    }
    return { edges, eps, end: s };
}
function closure(a, states) {
    const seen = new Set(states);
    for (const s of seen)
        for (const t of a.eps[s])
            seen.add(t);
    return [...seen].sort((x, y) => x - y);
}
/** Czy kazda nazwa pasujaca do maski a pasuje tez do b (bez danych: porownanie samych masek). */
function within(a, b) {
    const na = nfa(a);
    const nb = nfa(b);
    // znaki, ktore rozroznia b; '\0' = kazdy inny
    const letters = new Set(['\0']);
    for (const l of nb.edges)
        for (const x of l)
            if (x.on !== null && x.on !== '.')
                letters.add(x.on);
    const start = closure(nb, [0]);
    // stany poczatkowe poza seen: pusta nazwa (** bez kwalifikatorow) sie nie liczy
    const todo = closure(na, [0]).map(s => ({ s, set: start, empty: true }));
    const seen = new Set();
    while (todo.length) {
        const { s, set, empty } = todo.pop();
        if (!empty && s === na.end && !set.includes(nb.end))
            return false;
        for (const x of na.edges[s]) {
            for (const c of x.on === null ? letters : [x.on]) {
                const to = new Set();
                for (const t of set) {
                    for (const y of nb.edges[t])
                        if (y.on === c || (y.on === null && c !== '.'))
                            to.add(y.to);
                }
                const after = closure(nb, to);
                for (const t of closure(na, [x.to])) {
                    const key = `${t}|${after}`;
                    if (seen.has(key))
                        continue;
                    seen.add(key);
                    todo.push({ s: t, set: after, empty: false });
                }
            }
        }
    }
    return true;
}
};

// ==================== src/auto-mine.ts
MODULES["./auto-mine"] = function (exports, require, module) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Search = exports.STAR = exports.starChars = exports.literalChars = exports.purityOf = exports.isDigit = exports.DATED = exports.MAX_LEN = void 0;
exports.prepare = prepare;
exports.maskOrder = maskOrder;
exports.specialise = specialise;
exports.mine = mine;
exports.buildPatterns = buildPatterns;
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
const auto_tree_1 = require("./auto-tree");
const auto_util_1 = require("./auto-util");
const DOT = 46;
const PCT = 37;
exports.MAX_LEN = 44;
/** pozycje w nazwie sa bitami liczby 32-bitowej (nazwa z/OS ma najwyzej 22 kwalifikatory) */
const MAX_QUALS = 30;
exports.DATED = /^[A-Z#@$]{1,3}[0-9]{5,7}$/;
const isDigit = (b) => b >= 48 && b <= 57;
exports.isDigit = isDigit;
const bitPos = (m) => 31 - Math.clz32(m & -m);
const purityOf = (small, large) => (small ? small / (small + large) : 0);
exports.purityOf = purityOf;
const literalChars = (t) => t.replace(/[*%.]/g, '').length;
exports.literalChars = literalChars;
const starChars = (t) => t.replace(/[^*]/g, '').length;
exports.starChars = starChars;
exports.STAR = -1;
function prepare(input, opt, tick) {
    const { names, pos, neg } = input;
    const { pool } = names;
    const min = opt.minCount;
    const np = pos.length;
    const skip = opt.head?.length ?? 0;
    /** poczatek kwalifikatorow za head; nazwa bez dalszych kwalifikatorow: koniec nazwy + 1 */
    const rest = (row) => {
        let p = names.start[row];
        const e = p + names.len[row];
        for (let k = 0; k < skip; k++) {
            while (p < e && pool[p] !== DOT)
                p++;
            p++;
        }
        return p;
    };
    // ---- kwalifikatory malych zbiorow
    const quals = new auto_util_1.Interner();
    let occ = new Int32Array(1 << 10);
    for (let i = 0; i < np; i++) {
        if ((i & 0xffff) === 0)
            tick(0.15 * (i / np));
        const e = names.start[pos[i]] + names.len[pos[i]];
        let b = rest(pos[i]);
        for (let p = b; p <= e; p++) {
            if (p < e && pool[p] !== DOT)
                continue;
            const id = quals.add(pool, b, p);
            if (id >= occ.length)
                occ = (0, auto_util_1.grow)(occ, id + 1);
            occ[id]++;
            b = p + 1;
        }
    }
    occ = occ.slice(0, quals.size);
    // ---- elementy: czeste literaly, wzorce z %, poczatek*
    const pat = buildPatterns(quals, occ, min, part => tick(0.15 + 0.15 * part));
    const heads = buildHeads(quals, occ, min);
    const litTok = new Int32Array(quals.size).fill(-1);
    const text = [];
    for (let id = 0; id < quals.size; id++) {
        if (occ[id] < min)
            continue;
        litTok[id] = text.length;
        text.push(quals.text(id));
    }
    const patBase = text.length;
    text.push(...pat.texts);
    const headBase = text.length;
    text.push(...heads.texts.map(t => `${t}*`));
    const tokens = {
        text,
        lit: Int32Array.from(text, exports.literalChars),
        stars: Int32Array.from(text, exports.starChars),
        len: Int32Array.from(text, t => t.length),
        cost: Uint8Array.from(text, (_, t) => Number(t >= headBase)),
        isLiteral: Uint8Array.from(text, (_, t) => Number(t < patBase)),
        dated: Uint8Array.from(text, (t, i) => Number(i < patBase && exports.DATED.test(t))),
    };
    // ---- klasy kwalifikatorow: drzewo list elementow
    const tree = new auto_util_1.PairMap();
    const clsParent = new auto_util_1.IntList();
    const clsLast = new auto_util_1.IntList();
    clsParent.push(-1);
    clsLast.push(-1);
    const list = new auto_util_1.IntList();
    const classOf = (literal, b, e, buf) => {
        list.n = 0;
        if (literal >= 0)
            list.push(literal);
        const from = list.n;
        pat.match(buf, b, e, list);
        for (let x = from; x < list.n; x++)
            list.a[x] += patBase;
        const from2 = list.n;
        heads.match(buf, b, e, list);
        for (let x = from2; x < list.n; x++)
            list.a[x] += headBase;
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
    for (let id = 0; id < quals.size; id++)
        qualClass[id] = classOf(litTok[id], quals.start[id], quals.start[id] + quals.len[id], quals.pool);
    // ---- ciagi klas: nazwy o tym samym ciagu to jedna pozycja
    const seqs = new auto_util_1.Interner();
    let wp = new Int32Array(1 << 10);
    let wn = new Int32Array(1 << 10);
    const buf = new Uint8Array(3 * 256);
    const sequence = (row) => {
        const e = names.start[row] + names.len[row];
        let b = rest(row);
        let n = 0;
        for (let p = b; p <= e; p++) {
            if (p < e && pool[p] !== DOT)
                continue;
            const id = quals.find(pool, b, p);
            const c = id >= 0 ? qualClass[id] : classOf(-1, b, p, pool);
            buf[3 * n] = c >>> 16;
            buf[3 * n + 1] = c >>> 8;
            buf[3 * n + 2] = c;
            n++;
            b = p + 1;
        }
        if (n > MAX_QUALS)
            return -1;
        const s = seqs.add(buf, 0, 3 * n);
        if (s >= wp.length) {
            wp = (0, auto_util_1.grow)(wp, s + 1);
            wn = (0, auto_util_1.grow)(wn, s + 1);
        }
        return s;
    };
    const posSeq = new Int32Array(np);
    for (let i = 0; i < np; i++) {
        if ((i & 0x3fff) === 0)
            tick(0.3 + 0.3 * (i / np));
        const s = sequence(pos[i]);
        posSeq[i] = s;
        if (s >= 0)
            wp[s]++;
    }
    const negSeq = new Int32Array(neg.length);
    for (let i = 0; i < neg.length; i++) {
        if ((i & 0x3fff) === 0)
            tick(0.6 + 0.4 * (i / neg.length));
        const s = sequence(neg[i]);
        negSeq[i] = s;
        if (s >= 0)
            wn[s]++;
    }
    const count = seqs.size;
    const off = new Int32Array(count + 1);
    for (let s = 0; s < count; s++)
        off[s + 1] = off[s] + seqs.len[s] / 3;
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
        for (let x = c; x > 0; x = clsParent.a[x])
            n++;
        clsOff[c + 1] = clsOff[c] + n;
    }
    const clsTok = new Int32Array(clsOff[nc]);
    for (let c = 0; c < nc; c++) {
        let k = clsOff[c + 1];
        for (let x = c; x > 0; x = clsParent.a[x])
            clsTok[--k] = clsLast.a[x];
    }
    return { count, off, cls, clsOff, clsTok, wp, wn, posSeq, negSeq, tokens };
}
/** Przeszukanie masek od lewej; wpis = ciag i pozycje (bity), na ktorych moze sie skonczyc poczatek maski. */
class Search {
    q;
    headText;
    maxWild;
    anchored;
    nodes = 0;
    eSeq = new Int32Array(1 << 12);
    eMask = new Int32Array(1 << 12);
    top = 0;
    stamp;
    nEnt;
    wPos;
    wNeg;
    sig;
    slot;
    last;
    round = 0;
    path = [];
    rnd1;
    rnd2;
    odd;
    constructor(q, headText, maxWild, anchored = false) {
        this.q = q;
        this.headText = headText;
        this.maxWild = maxWild;
        this.anchored = anchored;
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
     *   cover(f, true): takze ciagi bez malych
     */
    run(ids, min, weigh, stop, emit, tick) {
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
        const needOf = (wild) => (weigh ? min * Math.max(1, wild) : min);
        const headLit = (0, exports.literalChars)(this.headText);
        const headStars = (0, exports.starChars)(this.headText);
        const node = (lo, hi, wild, lit, stars, len, small, large, from, to) => {
            if ((this.nodes++ & 0xff) === 0)
                tick(from);
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
                    if (wp[s] === 0)
                        continue;
                    h1 = (h1 + rnd1[s]) | 0;
                    h2 = (h2 + rnd2[s]) | 0;
                    if (exact) {
                        x1 = (x1 + rnd1[s]) | 0;
                        x2 = (x2 + rnd2[s]) | 0;
                    }
                }
                const make = (open) => () => ({
                    path: Int32Array.from(path), open, small: open ? small : xs, large: open ? large : xl, lit,
                    stars: stars + (open ? 2 : 0), len: len + (open ? 3 : 0),
                });
                if (xs >= need && len <= exports.MAX_LEN) {
                    emit(make(false), xs, xl, x1, x2, (f, every) => {
                        for (let i = lo; i < hi; i++) {
                            const s = this.eSeq[i];
                            if ((every || wp[s]) && (this.eMask[i] >>> (off[s + 1] - off[s])) & 1)
                                f(s);
                        }
                    });
                }
                if (len + 3 <= exports.MAX_LEN) {
                    const good = emit(make(true), small, large, h1, h2, (f, every) => {
                        for (let i = lo; i < hi; i++)
                            if (every || wp[this.eSeq[i]])
                                f(this.eSeq[i]);
                    });
                    if (good && stop)
                        return;
                }
            }
            // ---- zliczenie rozwiniec: x = element * 2 + (1: przed nim **)
            // anchored: maska nie zaczyna sie od ** ani *
            const first = this.anchored && !named;
            const canGap = wild < maxWild && !first;
            const touched = [];
            let starEnt = 0;
            let starPos = 0;
            let starNeg = 0;
            let starSig = 0;
            for (let i = lo; i < hi; i++) {
                const s = this.eSeq[i];
                const n = off[s + 1] - off[s];
                const m = this.eMask[i] & ((1 << n) - 1);
                if (m === 0)
                    continue;
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
                    if (adj)
                        starSig = (starSig + h) | 0;
                    else if (!canGap)
                        continue;
                    for (let y = clsOff[cls[base + p]]; y < clsOff[cls[base + p] + 1]; y++) {
                        const t = clsTok[y];
                        if (wild + tokens.cost[t] > maxWild || (tokens.dated[t] && (p > 0 || isHead)))
                            continue;
                        for (let gap = adj ? 0 : 1; gap <= 1; gap++) {
                            if (gap && (!canGap || wild + 1 + tokens.cost[t] > maxWild))
                                break;
                            const x = 2 * t + gap;
                            if (nEnt[x] === 0)
                                touched.push(x);
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
            const key = (sg, w) => (sg >>> 0) * 2097152 + (w & 2097151);
            const literals = [new Set(), new Set()];
            const adjacent = new Set();
            for (const x of touched) {
                if (wPos[x] < need)
                    continue;
                const k = key(sig[x], wPos[x]);
                if (tokens.isLiteral[x >> 1])
                    literals[x & 1].add(k);
                if (!(x & 1))
                    adjacent.add(k);
            }
            const keep = [];
            const start = this.top;
            for (const x of touched) {
                if (wPos[x] < needOf(wild + (x & 1) + tokens.cost[x >> 1]))
                    continue;
                const k = key(sig[x], wPos[x]);
                if (!tokens.isLiteral[x >> 1] && literals[x & 1].has(k))
                    continue;
                if (x & 1 && nEnt[x - 1] > 0 && wPos[x - 1] === wPos[x] && sig[x - 1] === sig[x])
                    continue;
                slot[x] = this.top;
                keep.push({ x, n: nEnt[x], small: wPos[x], large: wNeg[x], off: this.top });
                this.top += nEnt[x];
            }
            const star = wild < maxWild && !first && starPos >= needOf(wild + 1) && !adjacent.has(key(starSig, starPos));
            if (star) {
                keep.push({ x: exports.STAR, n: starEnt, small: starPos, large: starNeg, off: this.top });
                this.top += starEnt;
            }
            for (const x of touched)
                nEnt[x] = wPos[x] = wNeg[x] = sig[x] = 0;
            if (keep.length === 0)
                return;
            this.reserve(this.top);
            // ---- listy rozwiniec
            const { eSeq, eMask } = this;
            let starAt = star ? keep[keep.length - 1].off : 0;
            for (let i = lo; i < hi; i++) {
                const s = eSeq[i];
                const n = off[s + 1] - off[s];
                const m = eMask[i] & ((1 << n) - 1);
                if (m === 0)
                    continue;
                const base = off[s];
                const round = ++this.round;
                if (star) {
                    eSeq[starAt] = s;
                    eMask[starAt++] = m << 1;
                }
                for (let p = bitPos(m); p < n; p++) {
                    const adj = (m >>> p) & 1;
                    if (!adj && !canGap)
                        continue;
                    for (let y = clsOff[cls[base + p]]; y < clsOff[cls[base + p] + 1]; y++) {
                        const t = clsTok[y];
                        if (tokens.dated[t] && (p > 0 || isHead))
                            continue;
                        for (let x = 2 * t + (adj ? 0 : 1); x <= 2 * t + 1; x++) {
                            if (slot[x] < 0)
                                continue;
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
                if (c.x !== exports.STAR)
                    slot[c.x] = -1;
                all += c.n;
            }
            let at = from;
            for (const c of keep) {
                const till = at + (to - from) * (c.n / all);
                const dot = named ? 1 : 0;
                path.push(c.x);
                if (c.x === exports.STAR) {
                    node(c.off, c.off + c.n, wild + 1, lit, stars + 1, len + dot + 1, c.small, c.large, at, till);
                }
                else {
                    const t = c.x >> 1;
                    const gap = c.x & 1;
                    node(c.off, c.off + c.n, wild + gap + tokens.cost[t], lit + tokens.lit[t], stars + 2 * gap + tokens.stars[t], len + dot + 3 * gap + tokens.len[t], c.small, c.large, at, till);
                }
                path.pop();
                at = till;
            }
            this.top = start;
        };
        node(0, ids.length, 0, headLit, headStars, this.headText.length, sp, sn, 0, 1);
    }
    reserve(n) {
        if (n <= this.eSeq.length)
            return;
        this.eSeq = (0, auto_util_1.grow)(this.eSeq, n);
        this.eMask = (0, auto_util_1.grow)(this.eMask, n);
    }
}
exports.Search = Search;
/** Tekst maski i kolejnosc masek o tym samym zysku: czystosc, mniej duzych, wiecej znakow stalych, mniej *, krotsza. */
function maskOrder(tokens, head) {
    const textOf = (f) => {
        const parts = head.slice();
        for (const x of f.path) {
            if (x !== exports.STAR && x & 1)
                parts.push('**');
            parts.push(x === exports.STAR ? '*' : tokens[x >> 1]);
        }
        if (f.open)
            parts.push('**');
        return parts.join('.');
    };
    const rank = (a, b) => (0, exports.purityOf)(b.small, b.large) - (0, exports.purityOf)(a.small, a.large) || a.large - b.large
        || b.lit - a.lit || a.stars - b.stars || a.len - b.len || (textOf(a) < textOf(b) ? -1 : 1);
    return { textOf, rank };
}
/** Najbardziej szczegolowa maska zawarta w own i obejmujaca te same male; ids = ciagi, ktore own obejmuje. */
function specialise(search, ids, small, own, order) {
    const all = [];
    search.run(ids, small, false, false, make => {
        all.push(make());
        return false;
    }, () => { });
    all.sort(order.rank);
    const quals = own.split('.');
    const best = all.find(f => {
        const t = order.textOf(f);
        return t === own || (0, auto_tree_1.within)(t.split('.'), quals);
    });
    return best ? order.textOf(best) : own;
}
function mine(input, opt, stages) {
    const { names, allocKb, pos, neg } = input;
    const min = opt.minCount;
    const headText = (opt.head ?? []).join('.');
    const q = prepare(input, opt, stages.prepare);
    const { wp, wn, tokens } = q;
    // ---- przeszukanie: dobre maski, z masek o tych samych malych zbiorach jedna
    const tickSearch = stages.search(q.count);
    const search = new Search(q, headText, opt.maxWild);
    const { textOf, rank } = maskOrder(tokens.text, opt.head ?? []);
    const good = [];
    const byCover = new auto_util_1.PairMap();
    const list = new auto_util_1.IntList();
    const lo = new auto_util_1.IntList();
    lo.push(0);
    if (pos.length >= min && q.count > 0) {
        const ids = new Int32Array(q.count);
        for (let s = 0; s < q.count; s++)
            ids[s] = s;
        search.run(ids, min, true, true, (make, small, large, h1, h2, cover) => {
            if ((0, exports.purityOf)(small, large) < opt.minPurity)
                return false;
            const k = byCover.get(h1 >>> 1, h2 >>> 1);
            if (k >= 0) {
                const f = make();
                if (rank(f, good[k]) < 0)
                    good[k] = f;
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
    const better = (x, y) => (gain[x] !== gain[y] ? gain[x] > gain[y] : rank(good[x], good[y]) < 0);
    const heap = new Int32Array(good.length);
    let hn = 0;
    const up = (i) => {
        const v = heap[i];
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (!better(v, heap[p]))
                break;
            heap[i] = heap[p];
            i = p;
        }
        heap[i] = v;
    };
    const down = (i) => {
        const v = heap[i];
        for (;;) {
            let m = 2 * i + 1;
            if (m >= hn)
                break;
            if (m + 1 < hn && better(heap[m + 1], heap[m]))
                m++;
            if (!better(heap[m], v))
                break;
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
    const chosen = [];
    const steps = [];
    let pops = 0;
    while (hn > 0 && chosen.length < opt.maxMasks) {
        if ((pops++ & 0xff) === 0) {
            tickSel(0.6 * Math.max(chosen.length / opt.maxMasks, 1 - hn / good.length), `masek: ${chosen.length}`);
        }
        const g = heap[0];
        let now = 0;
        for (let x = lo.a[g]; x < lo.a[g + 1]; x++)
            if (!coveredSeq[list.a[x]])
                now += wp[list.a[x]];
        if (now === gain[g] && now >= min) {
            for (let x = lo.a[g]; x < lo.a[g + 1]; x++)
                coveredSeq[list.a[x]] = 1;
            chosen.push(g);
            steps.push({ text: textOf(good[g]), gain: gain[g] });
            now = 0;
        }
        if (now < min)
            heap[0] = heap[--hn];
        else
            gain[g] = now;
        if (hn > 0)
            down(0);
    }
    // maski zbedne: wszystkie ich zbiory obejmuja inne wybrane (od ostatnio wybranych)
    const cover = new Int32Array(q.count);
    for (const g of chosen)
        for (let x = lo.a[g]; x < lo.a[g + 1]; x++)
            cover[list.a[x]]++;
    const keep = chosen.map(() => true);
    for (let j = chosen.length - 1; j >= 0; j--) {
        const g = chosen[j];
        let redundant = true;
        for (let x = lo.a[g]; x < lo.a[g + 1] && redundant; x++)
            if (cover[list.a[x]] < 2)
                redundant = false;
        if (!redundant)
            continue;
        keep[j] = false;
        for (let x = lo.a[g]; x < lo.a[g + 1]; x++)
            cover[list.a[x]]--;
    }
    const final = chosen.filter((_, j) => keep[j]);
    // ---- uscislenie: duze zbiory kazdej maski, potem szukanie wsrod masek obejmujacych wszystkie jej male
    const texts = final.map(g => textOf(good[g]));
    const negOf = final.map(() => new Set());
    if (final.length) {
        const tree = new auto_tree_1.MaskTree(texts.map(t => t.split('.')));
        for (let i = 0; i < neg.length; i++) {
            if ((i & 0x3fff) === 0)
                tickSel(0.6 + 0.1 * (i / neg.length));
            if (q.negSeq[i] < 0)
                continue;
            const s = names.start[neg[i]];
            for (const m of tree.match(names.pool, s, s + names.len[neg[i]]))
                negOf[m].add(q.negSeq[i]);
        }
    }
    final.forEach((g, j) => {
        tickSel(0.7 + 0.2 * (j / final.length), 'uscislanie masek');
        const ids = new Set(negOf[j]);
        for (let x = lo.a[g]; x < lo.a[g + 1]; x++)
            ids.add(list.a[x]);
        // male zbiory spoza maski nie moga tu trafic: ciag z duzych ma wage malych tylko, gdy pasuje do maski
        texts[j] = specialise(search, [...ids], good[g].small, texts[j], { textOf, rank });
    });
    // ---- liczby wprost z porownania wynikowych masek z nazwami
    const masks = texts.map((text) => ({ text, small: 0, large: 0, purity: 0, smallKb: 0, largeKb: 0 }));
    const total = { text: 'RAZEM', small: 0, large: 0, purity: 0, smallKb: 0, largeKb: 0 };
    if (masks.length) {
        const tree = new auto_tree_1.MaskTree(texts.map(t => t.split('.')));
        const add = (rows, n, kb) => {
            for (let i = 0; i < rows.length; i++) {
                if ((i & 0x3fff) === 0)
                    tickSel(0.9 + 0.1 * (i / rows.length), `masek: ${masks.length}`);
                const s = names.start[rows[i]];
                const ids = tree.match(names.pool, s, s + names.len[rows[i]]);
                if (ids.length === 0)
                    continue;
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
        for (const m of [...masks, total])
            m.purity = (0, exports.purityOf)(m.small, m.large);
    }
    return { masks, total, candidates, steps };
}
/**
 * poczatek*: wspolne poczatki (najdluzsze) par kwalifikatorow malych zbiorow, bez cyfr na koncu; co najmniej 3 znaki
 * albo 2, gdy dalej wspolne sa jeszcze cyfry; tylko pasujace do co najmniej min wystapien.
 */
function buildHeads(quals, occ, min) {
    const { pool, start, len } = quals;
    const order = Int32Array.from({ length: quals.size }, (_, i) => i).sort((a, b) => {
        const n = Math.min(len[a], len[b]);
        for (let i = 0; i < n; i++) {
            const d = pool[start[a] + i] - pool[start[b] + i];
            if (d)
                return d;
        }
        return len[a] - len[b];
    });
    const set = new Set();
    // wspolny poczatek dowolnej pary = wspolny poczatek pewnej pary sasiadow w porzadku alfabetycznym
    for (let i = 1; i < order.length; i++) {
        const a = order[i - 1];
        const b = order[i];
        let n = 0;
        while (n < len[a] && n < len[b] && pool[start[a] + n] === pool[start[b] + n])
            n++;
        const common = n;
        while (n > 0 && (0, exports.isDigit)(pool[start[a] + n - 1]))
            n--;
        if (n >= 8 || n < (common > n ? 2 : 3))
            continue;
        set.add(quals.text(a).slice(0, n));
    }
    const next = new auto_util_1.PairMap();
    const leaf = new auto_util_1.IntList();
    const build = (texts) => {
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
    const walk = (buf, s, e, f) => {
        let node = 0;
        for (let p = s; p < e; p++) {
            node = next.get(node, buf[p]);
            if (node < 0)
                return;
            if (leaf.a[node] >= 0)
                f(leaf.a[node]);
        }
    };
    for (let id = 0; id < quals.size; id++)
        walk(pool, start[id], start[id] + len[id], t => { sum[t] += occ[id]; });
    // rzadkie odpadaja; numery po kolei
    const renum = new Int32Array(texts.length).fill(-1);
    const kept = [];
    texts.forEach((t, id) => {
        if (sum[id] < min)
            return;
        renum[id] = kept.length;
        kept.push(t);
    });
    for (let x = 0; x < leaf.n; x++)
        if (leaf.a[x] >= 0)
            leaf.a[x] = renum[leaf.a[x]];
    return { texts: kept, match: (buf, s, e, into) => walk(buf, s, e, t => into.push(t)) };
}
/**
 * Wzorce (cyfry -> %) kwalifikatorow, do ktorych pasuje co najmniej min wystapien kwalifikatorow o tej dlugosci.
 * Rozwijane znak po znaku: set = kwalifikatory pasujace do poczatku wzorca, own = te, ktorych wlasny wzorzec
 * tak sie zaczyna; galaz konczy sie, gdy own jest puste albo set ma mniej niz min wystapien.
 */
function buildPatterns(quals, occ, min, tick) {
    const { pool, start, len } = quals;
    const texts = [];
    const gen = new Int32Array(quals.size).fill(-1);
    const pq = new auto_util_1.IntList();
    const pp = new auto_util_1.IntList();
    const byLen = [];
    for (let id = 0; id < quals.size; id++)
        (byLen[len[id]] ??= new auto_util_1.IntList()).push(id);
    const split = (set, d) => {
        const cnt = new Int32Array(256);
        for (let x = 0; x < set.length; x++)
            cnt[pool[start[set[x]] + d]]++;
        const out = new Map();
        for (let b = 0; b < 256; b++) {
            if (cnt[b])
                out.set(b, new Int32Array(cnt[b]));
            cnt[b] = 0;
        }
        for (let x = 0; x < set.length; x++) {
            const b = pool[start[set[x]] + d];
            out.get(b)[cnt[b]++] = set[x];
        }
        return out;
    };
    const sum = (set) => {
        let s = 0;
        for (let x = 0; x < set.length; x++)
            s += occ[set[x]];
        return s;
    };
    const grownBy = (set, d, n, own, text, part) => {
        if (d === n) {
            const id = texts.length;
            texts.push(text);
            for (let x = 0; x < set.length; x++) {
                pq.push(set[x]);
                pp.push(id);
            }
            for (let x = 0; x < own.length; x++)
                gen[own[x]] = id;
            return;
        }
        const ownBy = split(own, d);
        const digits = [];
        let nd = 0;
        for (const [b, o] of ownBy) {
            if (!(0, exports.isDigit)(b))
                continue;
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
            grownBy(set, d + 1, n, o, `${text}%`, () => { });
        }
        if (nd < own.length) {
            const setBy = split(set, d);
            let no = 0;
            for (const [b, o] of ownBy) {
                part(++no / ownBy.size);
                if ((0, exports.isDigit)(b))
                    continue;
                const s = setBy.get(b);
                if (sum(s) >= min)
                    grownBy(s, d + 1, n, o, text + String.fromCharCode(b), () => { });
            }
        }
    };
    const total = byLen.length;
    byLen.forEach((l, n) => {
        const set = l.a.slice(0, l.n);
        const own = set.filter(id => {
            for (let p = start[id]; p < start[id] + n; p++)
                if ((0, exports.isDigit)(pool[p]))
                    return true;
            return false;
        });
        if (own.length && sum(set) >= min)
            grownBy(set, 0, n, own, '', x => tick((n - 1 + x) / total));
    });
    const patOff = new Int32Array(quals.size + 1);
    for (let x = 0; x < pq.n; x++)
        patOff[pq.a[x] + 1]++;
    for (let i = 0; i < quals.size; i++)
        patOff[i + 1] += patOff[i];
    const patList = new Int32Array(pq.n);
    const fill = patOff.slice();
    for (let x = 0; x < pq.n; x++)
        patList[fill[pq.a[x]]++] = pp.a[x];
    // drzewo wzorcow: wezel * 256 + bajt -> wezel; koniec wzorca -> numer
    const next = new auto_util_1.PairMap();
    const leaf = new auto_util_1.IntList();
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
    const walk = (buf, p, e, node, into) => {
        if (p === e) {
            if (leaf.a[node] >= 0)
                into.push(leaf.a[node]);
            return;
        }
        const any = next.get(node, PCT);
        if (any >= 0)
            walk(buf, p + 1, e, any, into);
        const same = next.get(node, buf[p]);
        if (same >= 0)
            walk(buf, p + 1, e, same, into);
    };
    return { texts, gen, patOff, patList, match: (buf, s, e, into) => walk(buf, s, e, 0, into) };
}
};

// ==================== src/mask.ts
MODULES["./mask"] = function (exports, require, module) {
"use strict";
/**
 * Maski nazw zbiorow jak w FILTLIST rutyn ACS:
 *   %   - dokladnie jeden znak w kwalifikatorze
 *   *   - zero lub wiecej znakow w kwalifikatorze; samo "*" = dokladnie jeden kwalifikator
 *   **  - zero lub wiecej kwalifikatorow (tylko jako caly kwalifikator)
 * Np. PROD.TMP.**, *.**.LOAD, PROD.D%%%%%%.LIST, SYS1.LINKLIB (literal).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MaskError = void 0;
exports.parseMask = parseMask;
exports.qualMatches = qualMatches;
exports.matchQuals = matchQuals;
exports.matches = matches;
exports.digitMask = digitMask;
const QUAL_CHARS = /^[A-Z0-9#@$*%{-]{1,8}$/;
class MaskError extends Error {
}
exports.MaskError = MaskError;
/** Sprawdza i rozbija maske; rzuca MaskError z opisem bledu. */
function parseMask(text) {
    const t = text.trim().toUpperCase();
    if (t.length === 0 || t.length > 44)
        throw new MaskError(`maska "${text}": dlugosc 1-44 znaki`);
    const quals = t.split('.');
    for (const q of quals) {
        if (q === '**')
            continue;
        if (!QUAL_CHARS.test(q))
            throw new MaskError(`maska "${text}": niepoprawny kwalifikator "${q}"`);
        if (q.includes('**'))
            throw new MaskError(`maska "${text}": "**" tylko jako caly kwalifikator`);
    }
    return { text: t, quals, generic: /[*%]/.test(t) };
}
const qualRegexCache = new Map();
function qualRegex(q) {
    let re = qualRegexCache.get(q);
    if (!re) {
        const body = q === '*' ? '.+' : q.replace(/[$#@{-]/g, c => '\\' + c).replace(/\*/g, '.*').replace(/%/g, '.');
        re = new RegExp('^' + body + '$');
        qualRegexCache.set(q, re);
    }
    return re;
}
/** Czy kwalifikator nazwy pasuje do kwalifikatora maski (bez '**'). */
function qualMatches(maskQual, qual) {
    if (!/[*%]/.test(maskQual))
        return maskQual === qual;
    return qualRegex(maskQual).test(qual);
}
/** Czy nazwa (rozbita na kwalifikatory) pasuje do maski. */
function matchQuals(mask, dsn, mi = 0, di = 0) {
    while (mi < mask.length) {
        const m = mask[mi];
        if (m === '**') {
            // '**' = zero lub wiecej kwalifikatorow
            for (let k = di; k <= dsn.length; k++) {
                if (matchQuals(mask, dsn, mi + 1, k))
                    return true;
            }
            return false;
        }
        if (di >= dsn.length || !qualMatches(m, dsn[di]))
            return false;
        mi++;
        di++;
    }
    return di === dsn.length;
}
function matches(mask, dsn) {
    return matchQuals(mask.quals, dsn.split('.'));
}
/** Cyfry kwalifikatora -> '%' (np. D241113 -> D%%%%%%); null, gdy brak cyfr. */
function digitMask(qual) {
    return /[0-9]/.test(qual) ? qual.replace(/[0-9]/g, '%') : null;
}
};

// ==================== src/auto-quals.ts
MODULES["./auto-quals"] = function (exports, require, module) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readNames = readNames;
exports.narrower = narrower;
exports.buildSequences = buildSequences;
exports.findCombos = findCombos;
exports.parseTries = parseTries;
exports.shorten = shorten;
exports.tryCombos = tryCombos;
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
const auto_mine_1 = require("./auto-mine");
const auto_tree_1 = require("./auto-tree");
const auto_util_1 = require("./auto-util");
const mask_1 = require("./mask");
const DOT = 46;
const MAX_ALSO = 12;
/** kwalifikator z data, czasem, numerem: nie daje czesci z cyframi */
const NUMBERED = /^[A-Z#@$]{1,3}[0-9]{4,7}$/;
/** wpisow list w jednej grupie rozwiniec (pamiec) */
const GROUP = 1 << 24;
class Timeout extends Error {
}
function readNames(input, skip, tick, byKb = false) {
    const { names, allocKb, pos, neg } = input;
    const { pool } = names;
    const total = pos.length + neg.length;
    const quals = new auto_util_1.Interner();
    const other = new auto_util_1.Interner();
    let occ = new Float64Array(1 << 10);
    const off = new Int32Array(total + 1);
    const ids = new auto_util_1.IntList();
    const kb = new Float64Array(total);
    for (let i = 0; i < total; i++) {
        if ((i & 0x3fff) === 0)
            tick(i / total);
        const small = i < pos.length;
        const row = small ? pos[i] : neg[i - pos.length];
        kb[i] = allocKb[row];
        const weight = byKb ? Math.max(1, Math.round(kb[i])) : 1;
        const e = names.start[row] + names.len[row];
        let b = names.start[row];
        for (let k = 0; k < skip; k++) {
            while (b < e && pool[b] !== DOT)
                b++;
            b++;
        }
        for (let p = b; p <= e; p++) {
            if (p < e && pool[p] !== DOT)
                continue;
            let id;
            if (small) {
                id = quals.add(pool, b, p);
                if (id >= occ.length)
                    occ = (0, auto_util_1.grow)(occ, id + 1);
                occ[id] += weight;
            }
            else {
                id = quals.find(pool, b, p);
                if (id < 0)
                    id = quals.size + other.add(pool, b, p);
            }
            ids.push(id);
            b = p + 1;
        }
        off[i + 1] = ids.n;
    }
    return { quals, occ: occ.slice(0, quals.size), other, off, ids: ids.a.slice(0, ids.n), np: pos.length, kb };
}
/** Czesci kwalifikatorow malych zbiorow jako ABC*, *ABC, *ABC*; liczone po dlugosci (czeste tylko z czestych krotszych). */
function buildPartials(quals, occ, min, partial) {
    const { pool, start, len } = quals;
    const out = [];
    if (partial === 0)
        return out;
    const literal = new auto_util_1.Interner();
    for (let id = 0; id < quals.size; id++)
        literal.add(pool, start[id], start[id] + len[id]);
    // data, czas, numer JES: czesci tylko sprzed cyfr
    const digitsFrom = Uint8Array.from({ length: quals.size }, (_, id) => (NUMBERED.test(quals.text(id)) ? quals.text(id).search(/[0-9]/) : 255));
    let prev = null;
    let prevOk = new Uint8Array(0);
    /** czesc o znak krotsza: 1 = dluzsza obejmuje to samo (kolejno: zawiera, poczatek, koniec) */
    let prevDrop = [];
    let prevSum = [];
    let flush = () => { };
    for (let n = partial; n <= 8; n++) {
        const parts = new auto_util_1.Interner();
        // kolejno: zawiera, poczatek, koniec; kazdy kwalifikator raz
        let sum = [0, 1, 2].map(() => new Float64Array(1 << 10));
        // dlugosc i miejsce czesci, gdy zawsze takie same: suma, najmniejsze i najwieksze
        let lo = new Uint8Array(1 << 10).fill(255);
        let hi = new Uint8Array(1 << 10);
        let loAt = new Uint8Array(1 << 10).fill(255);
        let hiAt = new Uint8Array(1 << 10);
        let preLo = new Uint8Array(1 << 10).fill(255);
        let preHi = new Uint8Array(1 << 10);
        let sufLo = new Uint8Array(1 << 10).fill(255);
        let sufHi = new Uint8Array(1 << 10);
        let seen = new Int32Array(1 << 10).fill(-1);
        const more = (a, v) => {
            const b = (0, auto_util_1.grow)(a, a.length * 2);
            if (v)
                b.fill(v, a.length);
            return b;
        };
        for (let id = 0; id < quals.size; id++) {
            for (let i = 0; i + n <= len[id]; i++) {
                const s = start[id] + i;
                if (digitsFrom[id] < i + n)
                    continue;
                if (prev) {
                    const x = prev.find(pool, s, s + n - 1);
                    const y = prev.find(pool, s + 1, s + n);
                    if (x < 0 || y < 0 || !prevOk[x] || !prevOk[y])
                        continue;
                }
                const t = parts.add(pool, s, s + n);
                if (t >= seen.length) {
                    sum = sum.map(a => (0, auto_util_1.grow)(a, t + 1));
                    [lo, loAt, preLo, sufLo] = [lo, loAt, preLo, sufLo].map(a => more(a, 255));
                    [hi, hiAt, preHi, sufHi] = [hi, hiAt, preHi, sufHi].map(a => more(a, 0));
                    const old = seen.length;
                    seen = (0, auto_util_1.grow)(seen, t + 1);
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
            if (sum[0][t] < min)
                continue;
            ok[t] = 1;
            if (!prev)
                continue;
            // dluzsza czesc obejmuje tyle samo co krotsza = te same kwalifikatory
            const x = prev.find(parts.pool, parts.start[t], parts.start[t] + n - 1);
            const y = prev.find(parts.pool, parts.start[t] + 1, parts.start[t] + n);
            if (sum[0][t] === prevSum[0][x])
                prevDrop[0][x] = 1;
            if (sum[0][t] === prevSum[0][y])
                prevDrop[0][y] = 1;
            if (sum[1][t] === prevSum[1][x])
                prevDrop[1][x] = 1;
            if (sum[2][t] === prevSum[2][y])
                prevDrop[2][y] = 1;
        }
        flush();
        const drop = [0, 1, 2].map(() => new Uint8Array(parts.size));
        flush = () => {
            for (let t = 0; t < parts.size; t++) {
                if (!ok[t])
                    continue;
                const text = parts.text(t);
                if (/^[0-9]+$/.test(text))
                    continue;
                const q = literal.find(parts.pool, parts.start[t], parts.start[t] + n);
                const own = q < 0 ? 0 : occ[q];
                const pct = (k) => '%'.repeat(k);
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
function narrower(a, b, i = 0, j = 0) {
    for (; j < b.length; i++, j++) {
        if (b[j] === '*') {
            for (let x = i; x <= a.length; x++)
                if (narrower(a, b, x, j + 1))
                    return true;
            return false;
        }
        if (i >= a.length || a[i] === '*' || (b[j] !== '%' && a[i] !== b[j]))
            return false;
    }
    return i === a.length;
}
/** Ile roznych kwalifikatorow zaczyna sie od tych samych liter przed pierwsza cyfra, zeby byl to numer, nie nazwa. */
const NUMBERS = 10;
/** stars: do kazdego elementu z % takze z * zamiast grupy % (D%%%%%% i D*), bez czesci numerow (JA1*, gdy numerow JAnnn jest wiele);
 *  extra: dodatkowe elementy */
function buildSequences(n, min, partial, hasHead, tick, stars = false, extra = []) {
    const { quals, occ, other } = n;
    const texts = new Set();
    for (let id = 0; id < quals.size; id++)
        if (occ[id] >= min)
            texts.add(quals.text(id));
    const literals = texts.size;
    const patterns = new Set();
    if (partial) {
        for (const t of (0, auto_mine_1.buildPatterns)(quals, occ, min, p => tick(0.2 * p)).texts)
            if ((0, auto_mine_1.literalChars)(t))
                patterns.add(t);
        for (const t of patterns)
            texts.add(t);
        for (const t of buildPartials(quals, occ, min, partial))
            texts.add(t);
        if (stars) {
            const stems = new Map();
            for (let id = 0; id < quals.size; id++) {
                const stem = /^([A-Z#@$]+)[0-9]/.exec(quals.text(id))?.[1];
                if (stem !== undefined)
                    stems.set(stem, (stems.get(stem) ?? 0) + 1);
            }
            for (const t of [...texts]) {
                const number = /^([A-Z#@$]+)[0-9]+[%*]+$/.exec(t);
                if (number && (stems.get(number[1]) ?? 0) >= NUMBERS)
                    texts.delete(t);
                else if (t.includes('%'))
                    texts.add(t.replace(/%+\*?|\*%+/g, '*'));
            }
        }
    }
    for (const t of extra)
        texts.add(t);
    const tokens = [...texts].map((text, i) => ({
        text, kind: i < literals ? 0 : patterns.has(text) ? 2 : 1, lit: (0, auto_mine_1.literalChars)(text), stars: (0, auto_mine_1.starChars)(text), dated: i < literals && auto_mine_1.DATED.test(text),
    }));
    tick(0.4);
    // ---- klasy: osobno dla pierwszego miejsca (tam wolno literal z data)
    const tree = new auto_tree_1.MaskTree(tokens.map(t => [t.text]));
    const step = new auto_util_1.PairMap();
    const clsParent = new auto_util_1.IntList();
    const clsLast = new auto_util_1.IntList();
    clsParent.push(-1);
    clsLast.push(-1);
    const classOf = (list) => {
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
        if ((id & 0xfff) === 0)
            tick(0.4 + 0.3 * (id / all));
        const from = id < quals.size ? quals : other;
        const x = id < quals.size ? id : id - quals.size;
        const list = tree.match(from.pool, from.start[x], from.start[x] + from.len[x]);
        const plain = list.some(t => tokens[t].dated) ? list.filter(t => !tokens[t].dated) : list;
        later[id] = classOf(plain);
        first[id] = plain === list || hasHead ? later[id] : classOf(list);
    }
    // ---- ciagi klas
    const seqs = new auto_util_1.Interner();
    const buf = new Uint8Array(3 * 64);
    let wp = new Int32Array(1 << 10);
    let wn = new Int32Array(1 << 10);
    let kp = new Float64Array(1 << 10);
    let kn = new Float64Array(1 << 10);
    const total = n.off.length - 1;
    const rowSeq = new Int32Array(total);
    for (let i = 0; i < total; i++) {
        if ((i & 0x3fff) === 0)
            tick(0.7 + 0.3 * (i / total));
        let w = 0;
        for (let k = n.off[i]; k < n.off[i + 1]; k++) {
            const c = k === n.off[i] ? first[n.ids[k]] : later[n.ids[k]];
            buf[w++] = c >>> 16;
            buf[w++] = c >>> 8;
            buf[w++] = c;
        }
        const s = seqs.add(buf, 0, w);
        rowSeq[i] = s;
        if (s >= wp.length) {
            wp = (0, auto_util_1.grow)(wp, s + 1);
            wn = (0, auto_util_1.grow)(wn, s + 1);
            kp = (0, auto_util_1.grow)(kp, s + 1);
            kn = (0, auto_util_1.grow)(kn, s + 1);
        }
        if (i < n.np) {
            wp[s]++;
            kp[s] += n.kb[i];
        }
        else {
            wn[s]++;
            kn[s] += n.kb[i];
        }
    }
    const count = seqs.size;
    const off = new Int32Array(count + 1);
    for (let s = 0; s < count; s++)
        off[s + 1] = off[s] + seqs.len[s] / 3;
    const cls = new Int32Array(off[count]);
    const end = new Uint8Array(count);
    for (let s = 0; s < count; s++) {
        for (let k = off[s], p = seqs.start[s]; k < off[s + 1]; k++, p += 3) {
            cls[k] = (seqs.pool[p] << 16) | (seqs.pool[p + 1] << 8) | seqs.pool[p + 2];
            if (cls[k])
                end[s] = k - off[s] + 1;
        }
    }
    const nc = clsParent.n;
    const clsOff = new Int32Array(nc + 1);
    for (let c = 0; c < nc; c++) {
        let k = 0;
        for (let x = c; x > 0; x = clsParent.a[x])
            k++;
        clsOff[c + 1] = clsOff[c] + k;
    }
    const clsTok = new Int32Array(clsOff[nc]);
    for (let c = 0; c < nc; c++) {
        let k = clsOff[c + 1];
        for (let x = c; x > 0; x = clsParent.a[x])
            clsTok[--k] = clsLast.a[x];
    }
    return { tokens, count, off, cls, end, clsOff, clsTok, wp, wn, kp, kn, rowSeq };
}
class Search {
    q;
    opt;
    deadline;
    nodes = 0;
    /** tabele [liczba kwalifikatorow]: klucz = skrot zestawu malych zbiorow */
    tables;
    /** kombinacja tej dlugosci o mniejszej liczbie malych nie wejdzie do tabeli */
    thr;
    pruneAt;
    size;
    eSeq = new Int32Array(1 << 12);
    ePos = new Uint8Array(1 << 12);
    top = 0;
    round = 0;
    path = [];
    aloneOk;
    constructor(q, opt, min, deadline) {
        this.q = q;
        this.opt = opt;
        this.deadline = deadline;
        // czesc wierszy odpada na koncu (rows)
        this.size = opt.minPurity > 0 || opt.minGain > 0 ? 3 * opt.top : opt.top;
        this.tables = Array.from({ length: opt.maxQuals + 1 }, () => new Map());
        this.thr = this.tables.map(() => min);
        this.pruneAt = this.tables.map(() => 2 * this.size);
        this.aloneOk = new Uint8Array(q.tokens.length);
    }
    reserve(n) {
        if (n <= this.eSeq.length)
            return;
        this.eSeq = (0, auto_util_1.grow)(this.eSeq, n);
        this.ePos = (0, auto_util_1.grow)(this.ePos, n);
    }
    /** Czy element a jest co najmniej tak szczegolowy jak b (kazdy kwalifikator a pasuje do b). */
    inside(a, b) {
        return a === b || narrower(this.q.tokens[a].text, this.q.tokens[b].text);
    }
    rank(a, b) {
        const { tokens } = this.q;
        const sum = (p, f) => p.toks.reduce((s, t) => s + tokens[t][f], 0);
        const text = (p) => p.toks.map(t => tokens[t].text).join('.');
        return a.large - b.large || sum(b, 'lit') - sum(a, 'lit') || sum(a, 'stars') - sum(b, 'stars') || (text(a) < text(b) ? -1 : 1);
    }
    offer(c) {
        const k = this.path.length + 1;
        if (c.small < this.thr[k] || (0, auto_mine_1.purityOf)(c.small, c.large) < this.opt.minPurity)
            return;
        const table = this.tables[k];
        const key = (c.c1 >>> 0) * 2097152 + (c.c2 >>> 11);
        const p = { toks: [...this.path, c.t], large: c.large };
        const e = table.get(key);
        if (!e) {
            table.set(key, { small: c.small, paths: [p], more: 0 });
            if (table.size >= this.pruneAt[k])
                this.prune(k);
            return;
        }
        const wider = (a, b) => a.toks.every((t, j) => this.inside(b.toks[j], t));
        if (e.paths.some(x => wider(p, x)))
            return;
        e.paths = e.paths.filter(x => !wider(x, p));
        e.paths.push(p);
        if (e.paths.length > MAX_ALSO) {
            e.paths.sort((a, b) => this.rank(a, b)).pop();
            e.more++;
        }
    }
    prune(k) {
        const table = this.tables[k];
        const counts = [...table.values()].map(e => e.small).sort((a, b) => b - a);
        this.thr[k] = Math.max(this.thr[k], counts[this.size - 1]);
        for (const [key, e] of table)
            if (e.small < this.thr[k])
                table.delete(key);
        this.pruneAt[k] = Math.max(2 * this.size, 2 * table.size);
    }
    /** ile malych musi miec kombinacja, zeby ona albo dluzsza weszla do tabeli */
    need(k) {
        let m = Infinity;
        for (let j = k; j < this.thr.length; j++)
            m = Math.min(m, this.thr[j]);
        return m;
    }
    run(tick) {
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
        const node = (lo, hi, from, to) => {
            if ((this.nodes++ & 0x1f) === 0) {
                tick(from, `sprawdzonych: ${(0, auto_util_1.thousands)(this.nodes)}`);
                if (Date.now() > this.deadline)
                    throw new Timeout();
            }
            if (this.round > 2e9 - (hi - lo) * 2) {
                stamp.fill(0);
                this.round = 0;
            }
            const k = this.path.length + 1;
            const touched = [];
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
                        if (aloneOk[t])
                            continue;
                        if (stamp[t] !== round) {
                            stamp[t] = round;
                            if (nEnt[t]++ === 0)
                                touched.push(t);
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
            const same = new Map();
            for (const t of touched) {
                if (wPos[t] >= need) {
                    const c = { t, n: nEnt[t], small: wPos[t], large: wNeg[t], c1: c1[t], c2: c2[t], at: 0 };
                    const key = (sig[t] >>> 0) * 2097152 + (wPos[t] & 2097151);
                    const list = same.get(key);
                    if (!list)
                        same.set(key, [c]);
                    else if (!list.some(x => this.inside(x.t, t)))
                        same.set(key, [...list.filter(x => !this.inside(t, x.t)), c]);
                }
                nEnt[t] = wPos[t] = wNeg[t] = sig[t] = c1[t] = c2[t] = 0;
            }
            let kids = [...same.values()].flat().sort((a, b) => b.small - a.small || a.large - b.large || tokens[b.t].lit - tokens[a.t].lit
                || tokens[a.t].stars - tokens[b.t].stars || (tokens[a.t].text < tokens[b.t].text ? -1 : 1));
            for (const c of kids)
                this.offer(c);
            if (k === opt.maxQuals)
                return;
            if (opt.minPurity > 0) {
                const good = (c) => (0, auto_mine_1.purityOf)(c.small, c.large) >= opt.minPurity;
                if (k === 1)
                    for (const c of kids)
                        if (good(c))
                            aloneOk[c.t] = 1;
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
                            if (slot[t] < 0 || stamp[t] === round)
                                continue;
                            stamp[t] = round;
                            // nazwa bez dalszych elementow nie wejdzie do dluzszej kombinacji
                            if (p + 1 >= end[s])
                                continue;
                            es[slot[t]] = s;
                            ep[slot[t]++] = p + 1;
                        }
                    }
                }
                const stop = [];
                for (let j = a; j < b; j++) {
                    stop.push(slot[kids[j].t]);
                    slot[kids[j].t] = -1;
                }
                this.top = start + size;
                for (let j = a; j < b; j++) {
                    const c = kids[j];
                    const at = from + (to - from) * (done / all);
                    done += c.n;
                    if (c.small < this.need(k + 1))
                        continue;
                    this.path.push(c.t);
                    node(c.at, stop[j - a], at, from + (to - from) * (done / all));
                    this.path.pop();
                }
                this.top = start;
                a = b;
            }
        };
        this.reserve(q.count);
        for (let s = 0; s < q.count; s++)
            this.eSeq[s] = s;
        this.top = q.count;
        node(0, q.count, 0, 1);
    }
    /** Wiersze tabel: od najwiekszej liczby malych. */
    rows() {
        const { tokens } = this.q;
        const { opt } = this;
        const texts = (p) => p.toks.map(t => tokens[t].text);
        const out = [];
        const good = [];
        for (let k = 1; k <= opt.maxQuals; k++) {
            let list = [...this.tables[k].values()];
            for (const e of list)
                e.paths.sort((a, b) => this.rank(a, b));
            list.sort((a, b) => b.small - a.small || this.rank(a.paths[0], b.paths[0]));
            if (opt.minPurity > 0) {
                // bez zawartych w kombinacji, ktora juz spelnia prog
                list = list.filter(e => {
                    if (e.paths.some(p => good.some(g => this.longer(p, g))))
                        return false;
                    good.push(...e.paths);
                    return true;
                });
            }
            else if (opt.minGain > 0) {
                list = list.filter((e, i) => {
                    for (let j = i + 1; j < list.length && list[j].small >= e.small * (1 - opt.minGain); j++) {
                        if (list[j].paths.some(p => this.longer(p, e.paths[0])))
                            return false;
                    }
                    return true;
                });
            }
            out.push(list.slice(0, opt.top).map(e => ({ toks: e.paths[0].toks, also: e.paths.slice(1).map(texts), more: e.more })));
        }
        return out;
    }
    /** Czy kazda nazwa z p ma tez krotsza kombinacje g. */
    longer(p, g) {
        let j = 0;
        for (const t of p.toks)
            if (j < g.toks.length && this.inside(t, g.toks[j]))
                j++;
        return j === g.toks.length;
    }
}
/** Liczby i maska wiersza, z ciagow klas. */
function finish(q, row, head) {
    const { off, cls, clsOff, clsTok, end, wp, wn, kp, kn } = q;
    const { toks } = row;
    const k = toks.length;
    const bits = new Uint8Array(clsOff.length - 1);
    toks.forEach((t, j) => {
        for (let c = 0; c < bits.length; c++)
            for (let y = clsOff[c]; y < clsOff[c + 1]; y++)
                if (clsTok[y] === t)
                    bits[c] |= 1 << j;
    });
    const quals = toks.map(t => q.tokens[t].text);
    const out = { quals, small: 0, large: 0, purity: 0, smallKb: 0, largeKb: 0, mask: null, also: row.also, more: row.more };
    // odstepy: przed pierwszym, miedzy, za ostatnim; -1 = rozne. Ulozenie od lewej i od prawej.
    const gaps = [new Array(k + 1), new Array(k + 1)];
    const note = (g, j, v) => {
        g[j] = g[j] === undefined || g[j] === v ? v : -1;
    };
    const hits = new auto_util_1.IntList();
    for (let s = 0; s < q.count; s++) {
        const n = off[s + 1] - off[s];
        let j = 0;
        let last = -1;
        const at = [];
        for (let p = 0; p < end[s] && j < k; p++) {
            if (!(bits[cls[off[s] + p]] & (1 << j)))
                continue;
            at.push(p - last - 1);
            last = p;
            j++;
        }
        if (j < k)
            continue;
        out.small += wp[s];
        out.large += wn[s];
        out.smallKb += kp[s];
        out.largeKb += kn[s];
        hits.push(s);
        if (wp[s] === 0)
            continue;
        at.forEach((v, i) => note(gaps[0], i, v));
        note(gaps[0], k, n - 1 - last);
        let next = n;
        j = k - 1;
        for (let p = end[s] - 1; p >= 0 && j >= 0; p--) {
            if (!(bits[cls[off[s] + p]] & (1 << j)))
                continue;
            note(gaps[1], j + 1, next - p - 1);
            next = p;
            j--;
        }
        note(gaps[1], 0, next);
    }
    out.purity = (0, auto_mine_1.purityOf)(out.small, out.large);
    // ---- najwezsza maska: element = numer kwalifikatora kombinacji, STAR albo ANY
    const STAR = -1;
    const ANY = -2;
    const build = (g) => {
        const e = [];
        g.forEach((v, j) => {
            if (v === -1)
                e.push(ANY);
            else
                for (let i = 0; i < v; i++)
                    e.push(STAR);
            if (j < k)
                e.push(j);
        });
        return e;
    };
    const text = (e) => [...head, ...e.map(x => (x === STAR ? '*' : x === ANY ? '**' : quals[x]))].join('.');
    const anys = (e) => e.filter(x => x === ANY).length;
    const loose = Array.from({ length: 2 * k + 1 }, (_, i) => (i % 2 ? (i - 1) / 2 : ANY));
    const elems = [...gaps.map(build).sort((a, b) => anys(a) - anys(b) || a.length - b.length), loose].find(e => text(e).length <= auto_mine_1.MAX_LEN);
    if (!elems)
        return out;
    const mask = { text: text(elems), small: 0, large: 0, purity: 0, smallKb: 0, largeKb: 0 };
    const fits = (s, p, i) => {
        const n = off[s + 1] - off[s];
        for (; i < elems.length; i++) {
            if (elems[i] === ANY) {
                for (let r = p; r <= n; r++)
                    if (fits(s, r, i + 1))
                        return true;
                return false;
            }
            if (p >= n || (elems[i] !== STAR && !(bits[cls[off[s] + p]] & (1 << elems[i]))))
                return false;
            p++;
        }
        return p === n;
    };
    for (let x = 0; x < hits.n; x++) {
        const s = hits.a[x];
        if (!fits(s, 0, 0))
            continue;
        mask.small += wp[s];
        mask.large += wn[s];
        mask.smallKb += kp[s];
        mask.largeKb += kn[s];
    }
    mask.purity = (0, auto_mine_1.purityOf)(mask.small, mask.large);
    out.mask = mask;
    return out;
}
function findCombos(input, opt, tick) {
    const np = input.pos.length;
    const head = opt.head ?? [];
    const out = { small: np, large: input.neg.length, tables: Array.from({ length: opt.maxQuals }, () => []), floor: null, nodes: 0 };
    if (np < opt.minCount)
        return out;
    const names = readNames(input, head.length, p => tick(0.1 * p));
    const deadline = Date.now() + opt.seconds * 1000;
    // dluzsze kombinacje niz nazwy sa puste i nie zapelnilyby tabeli
    let longest = 0;
    for (let i = 0; i < np; i++)
        longest = Math.max(longest, names.off[i + 1] - names.off[i]);
    const o = { ...opt, maxQuals: Math.min(opt.maxQuals, longest) };
    let prev = null;
    for (let min = Math.max(opt.minCount, Math.ceil(np / 5));; min = Math.max(opt.minCount, Math.ceil(min / 4))) {
        const from = 1 - min / np;
        const q = buildSequences(names, min, opt.partial, head.length > 0, p => tick(0.1 + 0.9 * Math.min(0.99, from * 0.9 + 0.03 * p), `prog: ${(0, auto_util_1.thousands)(min)} malych`));
        const search = new Search(q, o, min, deadline);
        let rows;
        let stop = min === opt.minCount;
        try {
            search.run((p, info) => tick(0.1 + 0.9 * Math.min(0.99, from * 0.9 + 0.03 + 0.07 * p), `prog: ${(0, auto_util_1.thousands)(min)} malych, ${info}`));
            rows = search.rows();
            if (rows.every(r => r.length >= opt.top))
                stop = true;
        }
        catch (e) {
            if (!(e instanceof Timeout))
                throw e;
            // elementy wyzszego progu sa tez wsrod nizszego
            const id = new Map(q.tokens.map((t, i) => [t.text, i]));
            const old = prev;
            rows = old ? old.rows.map(r => r.map(x => ({ ...x, toks: x.toks.map(t => id.get(old.tokens[t].text)) }))) : search.rows();
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
function parseTries(text) {
    return text.split(',').map(x => x.trim()).filter(Boolean).map(item => item.split('+').map(x => {
        const q = x.trim();
        if (q === '')
            throw new mask_1.MaskError(`"${item}": pusty kwalifikator`);
        const { quals } = (0, mask_1.parseMask)(q);
        if (quals.length > 1)
            throw new mask_1.MaskError(`"${item}": kwalifikatory lacz znakiem +, nie kropka`);
        if (!(0, auto_mine_1.literalChars)(quals[0]))
            throw new mask_1.MaskError(`"${item}": "${quals[0]}" nie ma zadnego stalego znaku`);
        return quals[0];
    }));
}
/**
 * Niepelne postacie kwalifikatora, od najdluzszej: ABCD*, ABC*; *BCDE, *CDE; cyfry -> %.
 * Kwalifikator z % albo * zostaje bez zmian.
 */
function shorten(q, partial) {
    if (partial === 0 || /[*%]/.test(q))
        return [];
    const out = [];
    const digits = q.replace(/[0-9]/g, '%');
    if (digits !== q && (0, auto_mine_1.literalChars)(digits))
        out.push(digits);
    for (let n = q.length - 1; n >= partial; n--)
        out.push(`${q.slice(0, n)}*`);
    for (let n = q.length - 1; n >= partial; n--)
        out.push(`*${q.slice(-n)}`);
    for (let n = Math.min(q.length, 6); n >= partial; n--) {
        for (let i = 0; i + n <= q.length; i++)
            out.push(`*${q.slice(i, i + n)}*`);
    }
    return out.filter(x => !/^\*?[0-9]+\*?$/.test(x) && x.length <= 8);
}
/** Liczby dla podanych kombinacji i ich skrocen (jeden kwalifikator naraz); skrocenia, ktore nic nie zmieniaja, odpadaja. */
function tryCombos(input, tries, partial, head, tick) {
    const { names, allocKb, pos, neg } = input;
    const groups = tries.map(base => {
        const list = [base];
        base.forEach((q, j) => shorten(q, partial).forEach(v => list.push(base.map((x, i) => (i === j ? v : x)))));
        return list.map((quals, i) => ({
            quals, level: i ? 1 : 0, text: [...head, '**', ...quals.flatMap(q => [q, '**'])].join('.'),
            small: 0, large: 0, purity: 0, smallKb: 0, largeKb: 0,
        }));
    });
    const rows = groups.flat();
    const tree = new auto_tree_1.MaskTree(rows.map(r => r.text.split('.')));
    const total = pos.length + neg.length;
    let done = 0;
    const scan = (list, n, kb) => {
        for (let x = 0; x < list.length; x++) {
            if ((done++ & 0x3fff) === 0)
                tick(done / total);
            const s = names.start[list[x]];
            for (const m of tree.match(names.pool, s, s + names.len[list[x]])) {
                rows[m][n]++;
                rows[m][kb] += allocKb[list[x]];
            }
        }
    };
    scan(pos, 'small', 'smallKb');
    scan(neg, 'large', 'largeKb');
    for (const r of rows)
        r.purity = (0, auto_mine_1.purityOf)(r.small, r.large);
    return groups.map(([base, ...rest]) => {
        // szersza maska o tych samych liczbach co wezsza obejmuje te same zbiory
        const seen = [base];
        for (const r of rest)
            if (!seen.some(x => x.small === r.small && x.large === r.large && (0, auto_tree_1.within)(x.text.split('.'), r.text.split('.'))))
                seen.push(r);
        return [base, ...seen.slice(1).sort((a, b) => b.purity - a.purity || b.small - a.small)];
    });
}
};

// ==================== src/auto-build.ts
MODULES["./auto-build"] = function (exports, require, module) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Builder = exports.Space = exports.POINTS = void 0;
exports.shapeCost = shapeCost;
exports.enough = enough;
exports.makeSpace = makeSpace;
exports.buildList = buildList;
const auto_mine_1 = require("./auto-mine");
const auto_quals_1 = require("./auto-quals");
const auto_tree_1 = require("./auto-tree");
const auto_util_1 = require("./auto-util");
exports.POINTS = { small: 1, large: 2, masks: 0.5, exclude: 0.5, risk: 0.1, percent: 0.05, wild: 0.02, start: 2 };
const ANY = { min: 0, any: true };
const NEXT = { min: 0, any: false };
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
const cubed = (x) => x * x * x;
/** Nazwy jako ciagi klas kwalifikatorow i maski z elementow tych klas. */
class Space {
    input;
    head;
    minCount;
    needKb;
    partial;
    extra;
    q;
    small;
    large;
    smallKb;
    largeKb;
    np;
    nl;
    allKb;
    byText;
    /** lista na poczatek: OLD_INC, OLD_EXC */
    mark;
    inClass = new Map();
    lists = new Map();
    /** minCount: od ilu malych element; needKb: od ilu KB duzych */
    constructor(input, head, minCount, needKb, partial, extra, tick, base) {
        this.input = input;
        this.head = head;
        this.minCount = minCount;
        this.needKb = needKb;
        this.partial = partial;
        this.extra = extra;
        const { names, allocKb, pos, neg } = input;
        this.np = pos.length;
        this.nl = neg.length;
        const weight = new Float64Array(allocKb.length);
        for (let i = 0; i < neg.length; i++)
            weight[neg[i]] = allocKb[neg[i]] * (minCount / needKb);
        const rows = new Int32Array(this.np + this.nl);
        rows.set(pos);
        rows.set(neg, this.np);
        const n = (0, auto_quals_1.readNames)({ names, allocKb: weight, pos: rows, neg: new Int32Array(0) }, head.length, p => tick(0.4 * p), true);
        const q = (0, auto_quals_1.buildSequences)(n, minCount, partial, head.length > 0, p => tick(0.4 + 0.6 * p), true, extra);
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
            }
            else {
                this.large[s]++;
                this.largeKb[s] += allocKb[rows[i]];
            }
        }
        this.allKb = kb;
        this.byText = new Map(this.q.tokens.map((t, i) => [t.text, i]));
    }
    /** klasa -> czy pasuje element t */
    has(t) {
        let h = this.inClass.get(t);
        if (h)
            return h;
        const { clsOff, clsTok } = this.q;
        h = new Uint8Array(clsOff.length - 1);
        for (let c = 0; c < h.length; c++) {
            for (let y = clsOff[c]; y < clsOff[c + 1]; y++)
                if (clsTok[y] === t)
                    h[c] = 1;
        }
        this.inClass.set(t, h);
        return h;
    }
    /** ciagi z elementem t na jakimkolwiek miejscu */
    seqsOf(t) {
        let l = this.lists.get(t);
        if (l)
            return l;
        const { count, off, cls } = this.q;
        const h = this.has(t);
        const out = new auto_util_1.IntList();
        for (let s = 0; s < count; s++) {
            for (let p = off[s]; p < off[s + 1]; p++) {
                if (!h[cls[p]])
                    continue;
                out.push(s);
                break;
            }
        }
        this.lists.set(t, l = out.a.slice(0, out.n));
        return l;
    }
    text(m) {
        const parts = this.head.slice();
        const gap = (g) => {
            for (let i = 0; i < g.min; i++)
                parts.push('*');
            if (g.any)
                parts.push('**');
        };
        m.toks.forEach((t, i) => {
            gap(m.gaps[i]);
            parts.push(this.q.tokens[t].text);
        });
        gap(m.tail);
        return parts.join('.');
    }
    /** null = element, ktorego nie ma (extra) */
    parse(text) {
        const quals = text.split('.');
        if (this.head.some((h, i) => quals[i] !== h))
            return null;
        const m = { toks: [], gaps: [], tail: NEXT };
        let g = { min: 0, any: false };
        for (const x of quals.slice(this.head.length)) {
            if (x === '**') {
                g = { ...g, any: true };
            }
            else if (x === '*') {
                g = { ...g, min: g.min + 1 };
            }
            else {
                const t = this.byText.get(x);
                if (t === undefined)
                    return null;
                m.toks.push(t);
                m.gaps.push(g);
                g = { min: 0, any: false };
            }
        }
        m.tail = g;
        return m;
    }
    static move(m, g) {
        m <<= g.min;
        // od najnizszej pozycji w gore
        return g.any && m ? -(m & -m) : m;
    }
    matcher(m) {
        const { off, cls } = this.q;
        const has = m.toks.map(t => this.has(t));
        return s => {
            const base = off[s];
            const n = off[s + 1] - base;
            if (n > MAX_QUALS)
                return false;
            let at = 1;
            for (let i = 0; i < has.length; i++) {
                at = Space.move(at, m.gaps[i]);
                let next = 0;
                for (let p = 0; p < n; p++)
                    if ((at >>> p) & 1 && has[i][cls[base + p]])
                        next |= 1 << (p + 1);
                if (next === 0)
                    return false;
                at = next;
            }
            return ((Space.move(at, m.tail) >>> n) & 1) === 1;
        };
    }
    /** ciagi objete maska */
    select(m, from) {
        const ok = this.matcher(m);
        let list = from;
        if (!list) {
            for (const t of m.toks) {
                const l = this.seqsOf(t);
                if (!list || l.length < list.length)
                    list = l;
            }
        }
        if (!list)
            return Int32Array.from({ length: this.q.count }, (_, s) => s).filter(ok);
        return list.filter(ok);
    }
}
exports.Space = Space;
const OLD_INC = 1;
const OLD_EXC = 2;
/** Ktore zbiory obejmuje i wylacza lista na poczatek (zwykle porownanie masek z nazwami). */
function oldMarks({ names }, rows, base) {
    const inc = new auto_tree_1.MaskTree(base.include.map(m => m.split('.')));
    const exc = new auto_tree_1.MaskTree(base.exclude.map(m => m.split('.')));
    return Uint8Array.from(rows, row => {
        const s = names.start[row];
        const e = s + names.len[row];
        return (inc.match(names.pool, s, e).length ? OLD_INC : 0) | (base.exclude.length && exc.match(names.pool, s, e).length ? OLD_EXC : 0);
    });
}
/** Ciagi podzielone wg znacznikow zbiorow. */
function split(q, marks) {
    const ids = new Map();
    const from = new auto_util_1.IntList();
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
    for (let x = 0; x < count; x++)
        cls.set(q.cls.subarray(q.off[from.a[x] >> 2], q.off[(from.a[x] >> 2) + 1]), off[x]);
    return [{ ...q, ...sums, count, off, cls, end, rowSeq }, mark];
}
/** zestaw ciagow jako tekst: suma, suma wymieszanych numerow i liczba */
function coverKey(...lists) {
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
const key = (m) => `${m.toks}|${[...m.gaps, m.tail].map(g => g.min + (g.any ? '+' : ''))}`;
const stars = (t) => t.split('*').length - 1;
/** Koszt wygladu maski w punktach. */
function shapeCost(text, w, head = 0) {
    const quals = text.split('.');
    let cost = (/^\*/.test(text) && head === 0 ? w.start : 0) - LIT * (0, auto_mine_1.literalChars)(text);
    quals.forEach((x, i) => {
        if (x === '**')
            cost += i === quals.length - 1 ? EPS : w.wild + EPS;
        else
            cost += w.wild * stars(x) + w.percent * (x.split('%').length - 1);
    });
    return cost;
}
class Builder {
    space;
    opt;
    w;
    all;
    deadline;
    stopped = false;
    /** jak powstaly maski */
    origin = new Map();
    /** wpisane, bez progu purity */
    free = new Set();
    base;
    baseCount;
    /** stan listy na poczatek */
    before;
    /** lista powstaje na raty: EXCLUDE kosztuje tez male, ktore moglyby objac kolejne maski */
    byStep = false;
    constructor(space, opt) {
        this.space = space;
        this.opt = opt;
        this.w = opt.weights;
        this.all = Int32Array.from({ length: space.q.count }, (_, s) => s);
        this.deadline = Date.now() + opt.seconds * 1000;
        this.base = opt.base ?? { include: [], exclude: [] };
        this.baseCount = this.base.include.length + this.base.exclude.length;
        this.before = this.live({ inc: [], exc: [] }).t;
    }
    late() {
        if (Date.now() > this.deadline)
            this.stopped = true;
        return this.stopped;
    }
    pSmall(n) {
        return this.space.np ? this.w.small * 100 * n / this.space.np : 0;
    }
    pLarge(kb) {
        return this.space.allKb ? this.w.large * 100 * kb / this.space.allKb : 0;
    }
    pRisk(kb) {
        return this.space.allKb ? this.w.risk * 100 * kb / this.space.allKb : 0;
    }
    /** odrzucona: ten sam tekst albo te same ciagi (takze szerszy zapis, np. PAY.** i **.PAY.**) */
    isBanned(st, banned) {
        return banned.size > 0 && (banned.has(this.space.text(st.m)) || banned.has(coverKey(st.seqs, st.gone)));
    }
    loose(m) {
        return this.space.head.length === 0 && (m.gaps[0].any || m.gaps[0].min > 0);
    }
    shape(m) {
        return shapeCost(this.space.text(m), this.w, this.space.head.length);
    }
    exShape(m) {
        // EXCLUDE z natury zaczyna sie od **, a przy tych samych zbiorach wygrywa szerszy
        const text = this.space.text(m);
        return shapeCost(text, { ...this.w, start: 0 }, this.space.head.length) + 2 * LIT * (0, auto_mine_1.literalChars)(text);
    }
    exPattern(t) {
        return { toks: [t], gaps: [ANY], tail: ANY };
    }
    valid(m) {
        const text = this.space.text(m);
        // "-" w masce: translator ACS bierze za znak kontynuacji
        return text.length <= auto_mine_1.MAX_LEN && (0, auto_mine_1.literalChars)(text) > 0 && !(text.includes('-') && /[*%]/.test(text));
    }
    live(list) {
        const { space } = this;
        const n = space.q.count;
        const dead = space.mark.map(m => m & OLD_EXC);
        const cov = space.mark.map(m => m & OLD_INC);
        for (const e of list.exc)
            for (let x = 0; x < e.seqs.length; x++)
                dead[e.seqs[x]] |= 1;
        for (const e of list.inc)
            for (let x = 0; x < e.seqs.length; x++)
                cov[e.seqs[x]] = 1;
        const l = {
            ns: new Float64Array(n), nl: new Float64Array(n), us: new Float64Array(n), usKb: new Float64Array(n), ul: new Float64Array(n), dl: new Float64Array(n),
            t: { small: 0, large: 0, smallKb: 0, largeKb: 0, lost: 0, hiddenKb: 0 }, dead: 0, killed: 0,
        };
        for (let s = 0; s < n; s++) {
            if (dead[s]) {
                if (cov[s]) {
                    l.t.lost += space.small[s];
                    l.t.hiddenKb += space.largeKb[s];
                }
                else {
                    l.dl[s] = space.largeKb[s];
                    l.dead += space.small[s];
                    if (dead[s] === 1)
                        l.killed += space.small[s];
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
            }
            else {
                l.us[s] = space.small[s];
                l.usKb[s] = space.smallKb[s];
                l.ul[s] = space.largeKb[s];
            }
        }
        return l;
    }
    parts(list, t) {
        const { w, space } = this;
        const none = { small: 0, large: 0, masks: 0, exclude: 0, risk: 0, percent: 0, wild: 0, start: 0 };
        const only = (k) => {
            const only1 = { ...none, [k]: w[k] };
            const sum = (l, ex) => l.reduce((a, x) => a + shapeCost(x, ex ? { ...only1, start: 0 } : only1, space.head.length)
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
    texts(list) {
        return {
            include: [...this.base.include, ...list.inc.map(i => this.space.text(i.m))],
            exclude: [...this.base.exclude, ...list.exc.map(i => this.space.text(i.m))],
        };
    }
    /** Punkty listy, bez stalego kosztu masek, od ktorych zaczeto. */
    score(list, { t, killed } = this.live(list)) {
        let x = this.pSmall(t.small) - this.pLarge(t.largeKb) - this.pRisk(t.hiddenKb) - this.w.masks * list.inc.length - this.w.exclude * list.exc.length;
        if (this.byStep)
            x -= this.pSmall(killed);
        for (const i of list.inc)
            x -= this.shape(i.m);
        for (const i of list.exc)
            x -= this.exShape(i.m);
        return x;
    }
    largeOk(smallKb, largeKb) {
        const { maxLarge } = this.opt;
        // lista na poczatek moze przekraczac granice: wtedy nie moze byc gorzej
        return largeKb <= Math.max(this.before.largeKb, 'kb' in maxLarge ? maxLarge.kb : maxLarge.part * smallKb) + 1e-6;
    }
    /** masek co najmniej tyle, ile wolno (over = 1: wiecej) */
    full(list, over = 0) {
        return this.baseCount + list.inc.length + list.exc.length >= this.opt.maxMasks + over;
    }
    /** granice calej listy */
    allowed(list, l) {
        const { loss, minPurity } = this.opt;
        const { t } = l;
        if (this.full(list, 1) || !this.largeOk(t.smallKb, t.largeKb) || t.lost > Math.max(this.before.lost, loss * (t.small + t.lost)) + 1e-9)
            return false;
        return list.inc.every(i => {
            let ns = 0;
            let nl = 0;
            for (let x = 0; x < i.seqs.length; x++) {
                ns += l.ns[i.seqs[x]];
                nl += l.nl[i.seqs[x]];
            }
            // wpisana przez uzytkownika zostaje (minPurity nie dotyczy)
            return this.free.has(this.space.text(i.m)) || (0, auto_mine_1.purityOf)(ns, nl) >= minPurity;
        });
    }
    /** najmniejsza purity maski bez EXCLUDE */
    minRaw = RAW[0];
    /** maska nie zaczyna sie od * ani ** */
    anchored = false;
    /** maska daje mniej nowych malych */
    cap = Infinity;
    measure(l, m, ex, seqs, gone, parent, note) {
        const st = { m, ex, seqs, gone, us: 0, ns: 0, nl: 0, usKb: 0, ul: 0, lost: 0, hidden: 0, raw: 0, points: 0, parent, note };
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
        st.raw = (0, auto_mine_1.purityOf)(rawS, rawL);
        st.points = this.pSmall(st.us) - this.pLarge(st.ul) - this.pRisk(st.hidden) - this.w.masks - this.w.exclude * ex.length - this.shape(m);
        return st;
    }
    child(l, p, m, note) {
        const ok = this.space.matcher(m);
        return this.measure(l, m, p.ex, p.seqs.filter(ok), p.gone.filter(ok), p, note);
    }
    fresh(l, m, ex, parent, note) {
        let seqs = this.space.select(m);
        const gone = new auto_util_1.IntList();
        if (ex.length) {
            const hit = ex.map(t => this.space.matcher(this.exPattern(t)));
            seqs = seqs.filter(s => {
                const out = hit.some(f => f(s));
                if (out)
                    gone.push(s);
                return !out;
            });
        }
        return this.measure(l, m, ex, seqs, gone.a.slice(0, gone.n), parent, note);
    }
    /** czy maska moze wejsc do listy */
    good(l, st) {
        const { opt } = this;
        return st.points > 0 && st.raw >= this.minRaw && st.us < this.cap && !(this.anchored && this.loose(st.m)) && this.largeOk(l.t.smallKb + st.usKb, l.t.largeKb + st.ul) && st.us >= opt.minCount * (1 + st.ex.length) && (0, auto_mine_1.purityOf)(st.ns, st.nl) >= opt.minPurity
            && st.lost <= opt.loss * (st.ns + st.lost) + 1e-9 && this.valid(st.m);
    }
    /**
     * Ranking elementow w zbiorach stanu: miejsca slot = odstep przed kwalifikatorem slot (dlugosc = za ostatnim),
     * -1 = pierwszy kwalifikator nazwy. each(slot, element, nowe male, male, duze, KB duzych).
     */
    rank(l, st, each) {
        const { off, cls, clsOff, clsTok, tokens } = this.space.q;
        const { m, seqs } = st;
        const k = m.toks.length;
        const has = m.toks.map(t => this.space.has(t));
        const open = [];
        for (let i = 0; i <= k; i++)
            if ((i < k ? m.gaps[i] : m.tail).any)
                open.push(i);
        if (k > 0 && m.gaps[0].any && m.gaps[0].min === 0)
            open.push(-1);
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
            const touched = [];
            for (let x = 0; x < seqs.length; x++) {
                const s = seqs[x];
                if (l.us[s] === 0 && l.nl[s] === 0 && l.ns[s] === 0)
                    continue;
                const base = off[s];
                const n = off[s + 1] - base;
                let lo = 0;
                let hi = n;
                if (slot === -1) {
                    hi = Math.min(1, n);
                    // pierwszy kwalifikator maski nie moze stac na poczatku nazwy
                    if (k) {
                        let p = n - 1;
                        for (let i = k - 1; i >= 0 && p >= 0; p--)
                            if (has[i][cls[base + p]])
                                till[i--] = p;
                        if (till[0] < 1)
                            continue;
                    }
                }
                else if (k) {
                    // najwczesniejsze miejsca poczatku i najpozniejsze konca (odstepy dokladne sprawdza potem maska)
                    let i = 0;
                    for (let p = 0; p < n && i < slot; p++)
                        if (has[i][cls[base + p]])
                            from[i++] = p + 1;
                    lo = slot ? from[slot - 1] : 0;
                    i = k - 1;
                    for (let p = n - 1; p >= 0 && i >= slot; p--)
                        if (has[i][cls[base + p]])
                            till[i--] = p;
                    hi = slot < k ? till[slot] : n;
                }
                if (lo >= hi)
                    continue;
                round++;
                for (let p = lo; p < hi; p++) {
                    const c = cls[base + p];
                    for (let y = clsOff[c]; y < clsOff[c + 1]; y++) {
                        const t = clsTok[y];
                        if (stamp[t] === round)
                            continue;
                        stamp[t] = round;
                        if (us[t] + ns[t] + nl[t] === 0)
                            touched.push(t);
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
    insert(m, slot, t) {
        if (slot === -1)
            return { toks: [t, ...m.toks], gaps: [NEXT, ...m.gaps], tail: m.tail };
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
    percent(a, b) {
        return `${(b ? 100 * a / b : 0).toFixed(1).replace('.', ',')}%`;
    }
    /** wagi rankingow: roznica czesci malych i duzych; male * purity^3 */
    static ranks(us, ns, nl, allS, allL) {
        return [(allS ? us / allS : 0) - (allL ? nl / allL : 0), us * cubed((0, auto_mine_1.purityOf)(ns, nl))];
    }
    /** Dalsze wersje stanu. */
    expand(l, st) {
        const { opt, space } = this;
        const { tokens } = space.q;
        const out = [];
        const k = st.m.toks.length;
        const min = opt.minCount;
        if (k < MAX_TOKS) {
            const adds = [];
            this.rank(l, st, (slot, t, us, ns, nl) => {
                if (us < min)
                    return;
                const [a, b] = Builder.ranks(us, ns, nl, st.us, st.nl);
                adds.push({ slot, t, us, nl, a, b });
            });
            const picked = new Set();
            for (const front of [true, false]) {
                for (const by of ['a', 'b']) {
                    let left = opt.beam;
                    for (const x of adds.filter(y => (y.slot === -1) === front).sort((p, q) => q[by] - p[by] || q.us - p.us || p.t - q.t || p.slot - q.slot)) {
                        if (left-- === 0)
                            break;
                        const id = (x.slot + 1) * tokens.length + x.t;
                        if (picked.has(id))
                            continue;
                        picked.add(id);
                        const m = this.insert(st.m, x.slot, x.t);
                        if (!this.valid(m))
                            continue;
                        out.push(this.child(l, st, m, `+ ${tokens[x.t].text}  ranking 1: ${this.percent(x.us, st.us)} malych, ${this.percent(x.nl, st.nl)} duzych`));
                    }
                }
            }
        }
        // ---- zawezenie
        if (st.nl > 0) {
            for (let i = 0; i <= k; i++) {
                const g = i < k ? st.m.gaps[i] : st.m.tail;
                if (!g.any)
                    continue;
                for (const to of [0, 1, 2]) {
                    const gap = { min: to, any: false };
                    const m = { toks: st.m.toks, gaps: st.m.gaps.map((x, j) => (j === i ? gap : x)), tail: i === k ? gap : st.m.tail };
                    if (this.valid(m))
                        out.push(this.child(l, st, m, 'zawezenie'));
                }
            }
        }
        // ---- EXCLUDE
        if (st.ex.length < MAX_EX && st.nl > 0 && this.w.large > 0) {
            const best = [];
            this.rank(l, { m: { toks: [], gaps: [], tail: ANY }, seqs: st.seqs }, (_slot, t, us, ns, nl, ul) => {
                if (nl < opt.exMin || st.m.toks.includes(t) || tokens[t].dated || tokens[t].text.includes('-'))
                    return;
                const v = this.pLarge(ul) - this.pSmall(us) - this.w.exclude;
                const fits = st.lost + ns <= opt.loss * (st.ns + st.lost) + 1e-9;
                // bez progu punktow: EXCLUDE moze byc potrzebny do purity
                if (fits && (v > 0 || nl >= 0.2 * st.nl))
                    best.push({ t, nl, ns, v: this.pLarge(ul) - this.pSmall(us), kind: tokens[t].kind });
            });
            best.sort((a, b) => b.v - a.v || a.kind - b.kind || a.t - b.t);
            for (const e of best.slice(0, Math.max(2, opt.beam >> 2))) {
                const hit = space.matcher(this.exPattern(e.t));
                const gone = [...st.gone];
                const seqs = st.seqs.filter(s => {
                    const x = hit(s);
                    if (x)
                        gone.push(s);
                    return !x;
                });
                out.push(this.measure(l, st.m, [...st.ex, e.t], seqs, Int32Array.from(gone), st, `EXCLUDE ${tokens[e.t].text}  ranking 2: ${this.percent(e.nl, st.nl)} duzych, ${this.percent(e.ns, st.ns)} malych`));
            }
        }
        return out;
    }
    /** Najlepsze maski dla nieobjetych malych, od najwiekszej liczby punktow. */
    search(l, banned) {
        const { opt, space } = this;
        const { tokens } = space.q;
        const found = new Map();
        let bestPoints = 0;
        const room = { allS: 0, allL: 0 };
        for (let s = 0; s < space.q.count; s++) {
            room.allS += l.us[s];
            room.allL += l.nl[s];
        }
        if (room.allS < opt.minCount)
            return [];
        const id = (st) => `${st.us}|${st.ns}|${st.nl}|${Math.round(st.ul)}|${st.ex.length}`;
        const consider = (st) => {
            if (!this.good(l, st) || this.isBanned(st, banned))
                return;
            const k = id(st);
            const old = found.get(k);
            if (old && old.points >= st.points)
                return;
            found.set(k, st);
            bestPoints = Math.max(bestPoints, st.points);
        };
        // ---- start: najlepsze kwalifikatory na dowolnym i na pierwszym miejscu
        const seeds = [];
        for (const front of [false, true]) {
            const base = front ? { toks: [], gaps: [], tail: ANY } : { toks: [], gaps: [], tail: ANY };
            const add = (t, us, ns, nl) => {
                if (us < opt.minCount)
                    return;
                const [a, b] = Builder.ranks(us, ns, nl, room.allS, room.allL);
                seeds.push({ front, t, us, nl, a, b });
            };
            if (!front)
                this.rank(l, { m: base, seqs: this.all }, (_s, t, us, ns, nl) => add(t, us, ns, nl));
            else
                this.rankFirst(l, add);
        }
        const picked = new Set();
        let beam = [];
        for (const front of [false, true]) {
            for (const by of ['a', 'b']) {
                for (const x of seeds.filter(y => y.front === front).sort((p, q) => q[by] - p[by] || q.us - p.us || p.t - q.t).slice(0, 3 * opt.beam)) {
                    if (picked.has(`${front}${x.t}`))
                        continue;
                    picked.add(`${front}${x.t}`);
                    const m = { toks: [x.t], gaps: [front ? NEXT : ANY], tail: ANY };
                    if (!this.valid(m))
                        continue;
                    beam.push(this.fresh(l, m, [], null, `start: ${tokens[x.t].text}  ranking 1: ${this.percent(x.us, room.allS)} malych, ${this.percent(x.nl, room.allL)} duzych`));
                }
            }
        }
        beam.forEach(consider);
        const seen = new Set();
        for (let depth = 0; depth < 2 * MAX_TOKS && beam.length && !this.late(); depth++) {
            const next = [];
            for (const st of beam) {
                if (this.late())
                    break;
                for (const c of this.expand(l, st)) {
                    const k = `${key(c.m)}/${c.ex.slice().sort((a, b) => a - b)}`;
                    if (seen.has(k) || c.us < opt.minCount)
                        continue;
                    seen.add(k);
                    next.push(c);
                }
            }
            next.forEach(consider);
            // szansa: gdyby odpadly wszystkie duze
            const hope = next.filter(st => st.nl > 0 && st.points + this.pLarge(st.ul) > bestPoints);
            beam = [];
            const same = new Set();
            for (const front of [true, false]) {
                const part = hope.filter(st => !st.m.gaps[0].any && st.m.gaps[0].min === 0 === front);
                for (const by of [0, 1]) {
                    const v = new Map(part.map(st => [st, Builder.ranks(st.us, st.ns, st.nl, room.allS, room.allL)[by]]));
                    let left = Math.ceil(opt.beam / 2);
                    for (const st of part.sort((a, b) => v.get(b) - v.get(a) || b.points - a.points || (key(a.m) < key(b.m) ? -1 : 1))) {
                        if (left === 0)
                            break;
                        const k = `${front}${id(st)}`;
                        if (same.has(k))
                            continue;
                        same.add(k);
                        beam.push(st);
                        left--;
                    }
                }
            }
        }
        const list = [...found.values()].sort((a, b) => b.points - a.points || (this.space.text(a.m) < this.space.text(b.m) ? -1 : 1)).slice(0, 6);
        const better = new Map();
        for (const st of list) {
            const x = this.improve(l, st, banned);
            const k = space.text(x.m);
            if (!better.has(k) || better.get(k).points < x.points)
                better.set(k, x);
        }
        return [...better.values()].sort((a, b) => b.points - a.points || (this.space.text(a.m) < this.space.text(b.m) ? -1 : 1));
    }
    rankFirst(l, add) {
        const { count, off, cls, clsOff, clsTok, tokens } = this.space.q;
        const [us, ns, nl] = [0, 1, 2].map(() => new Float64Array(tokens.length));
        for (let s = 0; s < count; s++) {
            if (off[s] === off[s + 1])
                continue;
            const c = cls[off[s]];
            for (let y = clsOff[c]; y < clsOff[c + 1]; y++) {
                us[clsTok[y]] += l.us[s];
                ns[clsTok[y]] += l.ns[s];
                nl[clsTok[y]] += l.nl[s];
            }
        }
        for (let t = 0; t < tokens.length; t++)
            add(t, us[t], ns[t], nl[t]);
    }
    /** Odejmowanie i poprawianie gotowej maski: kazdy ruch, ktory daje wiecej punktow. */
    improve(l, start, banned) {
        const { space } = this;
        const { tokens, clsOff, clsTok } = space.q;
        let st = start;
        for (let iter = 0; iter < 12 && !this.late(); iter++) {
            const k = st.m.toks.length;
            const tries = [];
            const put = (m, note, ex = st.ex) => {
                if (m.toks.length && this.valid(m))
                    tries.push({ m, ex, note });
            };
            for (let i = 0; i < k && k > 1; i++) {
                // bez kwalifikatora i: odstep przed nim i za nim razem
                const gaps = st.m.gaps.slice();
                const after = i + 1 < k ? gaps[i + 1] : st.m.tail;
                gaps.splice(i, 2, { min: i === 0 ? 0 : gaps[i].min + after.min, any: i === 0 ? after.any || gaps[0].any : true });
                const toks = st.m.toks.filter((_, j) => j !== i);
                const word = `- ${tokens[st.m.toks[i]].text}`;
                if (i === k - 1)
                    put({ toks, gaps: gaps.slice(0, k - 1), tail: ANY }, word);
                else if (i === 0) {
                    put({ toks, gaps: [ANY, ...gaps.slice(1)], tail: st.m.tail }, word);
                    put({ toks, gaps: [NEXT, ...gaps.slice(1)], tail: st.m.tail }, word);
                }
                else {
                    put({ toks, gaps, tail: st.m.tail }, word);
                }
            }
            for (let i = 0; i < k; i++) {
                // inny element z tych samych kwalifikatorow (LOGDAY, LOG*, D%%%%%%, D*)
                const h = space.has(st.m.toks[i]);
                const other = new Set();
                for (let c = 0, n = 0; c < h.length && n < 3; c++) {
                    if (!h[c])
                        continue;
                    n++;
                    for (let y = clsOff[c]; y < clsOff[c + 1]; y++)
                        if (clsTok[y] !== st.m.toks[i] && !tokens[clsTok[y]].dated)
                            other.add(clsTok[y]);
                }
                for (const t of other)
                    put({ ...st.m, toks: st.m.toks.map((x, j) => (j === i ? t : x)) }, `${tokens[st.m.toks[i]].text} -> ${tokens[t].text}`);
            }
            for (let i = 0; i <= k; i++) {
                const g = i < k ? st.m.gaps[i] : st.m.tail;
                const set = (gap, note) => put({ toks: st.m.toks, gaps: st.m.gaps.map((x, j) => (j === i ? gap : x)), tail: i === k ? gap : st.m.tail }, note);
                if (!g.any)
                    set(ANY, 'szerszy odstep');
                for (const min of [0, 1, 2])
                    if (g.any || g.min !== min)
                        set({ min, any: false }, 'inny odstep');
            }
            if (k < MAX_TOKS) {
                // pelny kwalifikator, ktory maja wszystkie male tej maski: wezsza, o ile wyglad nie drozszy
                const same = [];
                this.rank(l, st, (slot, t, _us, ns) => {
                    if (slot >= 0 && ns === st.ns && tokens[t].kind === 0 && !tokens[t].dated)
                        same.push({ slot, t });
                });
                for (const { slot, t } of same.sort((a, b) => b.slot - a.slot || a.t - b.t).slice(0, 10)) {
                    const m = this.insert(st.m, slot, t);
                    for (const a of [0, 1, -1]) {
                        for (const c of [0, 1, -1]) {
                            const gap = (x) => (x < 0 ? ANY : { min: x, any: false });
                            const gaps = m.gaps.slice();
                            gaps[slot] = gap(a);
                            if (slot + 1 < gaps.length)
                                gaps[slot + 1] = gap(c);
                            put({ toks: m.toks, gaps, tail: slot + 1 < gaps.length ? m.tail : gap(c) }, `+ ${tokens[t].text} (maja wszystkie male)`);
                        }
                    }
                }
            }
            for (const t of st.ex)
                put(st.m, `bez EXCLUDE ${tokens[t].text}`, st.ex.filter(x => x !== t));
            let best = null;
            for (const x of tries) {
                const c = this.fresh(l, x.m, x.ex, st, x.note);
                if (c.points > (best ?? st).points + 1e-9 && this.good(l, c) && !this.isBanned(c, banned))
                    best = c;
            }
            if (!best)
                break;
            st = best;
        }
        return st;
    }
    item(m) {
        return { m, seqs: this.space.select(m) };
    }
    /** Lista z maska stanu i jej EXCLUDE (ogolnym albo tylko pod poczatkiem maski), w granicach; null = nie mozna. */
    apply(list, st) {
        let forms = [{ inc: [...list.inc, this.item(st.m)], exc: list.exc }];
        for (const t of st.ex) {
            const wide = this.item(this.exPattern(t));
            const local = [];
            if (!st.m.gaps[0].any && st.m.gaps[0].min === 0)
                local.push({ toks: [st.m.toks[0], t], gaps: [NEXT, ANY], tail: ANY });
            const narrow = local.filter(m => this.valid(m)).map(m => this.item(m));
            forms = forms.flatMap(f => [wide, ...narrow].map(x => ({ inc: f.inc, exc: [...f.exc, x] })));
        }
        let best = null;
        for (const f of forms) {
            const l = this.live(f);
            if (!this.allowed(f, l))
                continue;
            const score = this.score(f, l);
            if (!best || score > best.score + 1e-9)
                best = { list: f, score };
        }
        return best;
    }
    proposal(l, st, before, after, list) {
        const steps = [];
        for (let x = st; x; x = x.parent) {
            steps.unshift({ text: this.space.text(x.m), exclude: x.ex.map(t => this.space.text(this.exPattern(t))), small: x.ns, large: x.nl, note: x.note });
        }
        return {
            text: this.space.text(st.m), exclude: after.list.exc.slice(list.exc.length).map(i => this.space.text(i.m)),
            gain: st.us, small: st.ns, large: st.nl, points: after.score - before, steps,
        };
    }
    /** Nastepne propozycje, od najlepszej; kazda poprawia liste i miesci sie w granicach. */
    next(list, banned) {
        if (this.full(list))
            return [];
        const l = this.live(list);
        const before = this.score(list, l);
        const out = [];
        for (const st of this.search(l, banned)) {
            const after = this.apply(list, st);
            if (after && after.score > before + 1e-9)
                out.push({ st, after, p: this.proposal(l, st, before, after, list) });
        }
        return out.sort((a, b) => b.after.score - a.after.score);
    }
    /** EXCLUDE wspolne dla calej listy, dopoki daja punkty. */
    excludes(list, journal) {
        const { space, opt } = this;
        const { tokens } = space.q;
        let cur = list;
        while (!this.full(cur) && !this.late()) {
            const l = this.live(cur);
            const before = this.score(cur, l);
            const cov = space.mark.map(m => m & OLD_INC);
            for (const i of cur.inc)
                for (let x = 0; x < i.seqs.length; x++)
                    cov[i.seqs[x]] = 1;
            const seqs = this.all.filter(s => cov[s] && (l.ns[s] || l.nl[s]));
            const kb = { ...l, ul: space.largeKb };
            const cands = [];
            this.rank(kb, { m: { toks: [], gaps: [], tail: ANY }, seqs }, (_s, t, _us, ns, nl, ul) => {
                const v = this.pLarge(ul) - this.pSmall(ns) - this.w.exclude;
                if (nl >= opt.exMin && v > 0 && !tokens[t].dated && !tokens[t].text.includes('-'))
                    cands.push({ t, v });
            });
            cands.sort((a, b) => b.v - a.v || a.t - b.t);
            let best = null;
            for (const c of cands.slice(0, 20)) {
                const next = { inc: cur.inc, exc: [...cur.exc, this.item(this.exPattern(c.t))] };
                const after = this.live(next);
                const score = this.score(next, after);
                if (score > Math.max(before, best?.score ?? -Infinity) + 1e-9 && this.allowed(next, after))
                    best = { list: next, score };
            }
            if (!best)
                break;
            cur = best.list;
            journal.push({ text: `wspolny EXCLUDE ${space.text(cur.exc[cur.exc.length - 1].m)}`, points: best.score - before });
        }
        return cur;
    }
    /** Bez masek i EXCLUDE, ktore kosztuja wiecej, niz daja. */
    prune(list, journal) {
        let cur = list;
        for (;;) {
            const before = this.score(cur);
            let best = null;
            for (const kind of ['inc', 'exc']) {
                for (const i of cur[kind]) {
                    const next = { ...cur, [kind]: cur[kind].filter(x => x !== i) };
                    const l = this.live(next);
                    const score = this.score(next, l);
                    if (score > (best?.score ?? before) + 1e-9 && this.allowed(next, l))
                        best = { list: next, score, text: this.space.text(i.m) };
                }
            }
            if (!best)
                return cur;
            cur = best.list;
            journal.push({ text: `usunieta ${best.text}`, points: best.score - before });
        }
    }
    accept(p) {
        this.origin.set(p.text, p);
        return { text: `maska ${p.text}${p.exclude.map(e => `  EXCLUDE ${e}`).join('')}`, points: p.points };
    }
    grow(list, journal, tick) {
        let cur = list;
        while (!this.late()) {
            const [best] = this.next(cur, new Set());
            if (!best)
                break;
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
    redo(cur, gone, ways) {
        const before = this.score(cur);
        const without = this.prune({ inc: cur.inc.filter(x => !gone.includes(x)), exc: cur.exc }, []);
        const l = this.live(without);
        let gain = 0;
        for (const s of new Set(gone.flatMap(i => [...i.seqs])))
            gain += l.us[s];
        let best = null;
        for (const way of ways) {
            this.cap = way === 'split' ? 0.95 * gain : Infinity;
            this.anchored = way === 'anchored';
            const steps = [];
            let next = without;
            for (let more = 0; more < (way === 'one' ? 2 : SPLIT) && !this.late(); more++) {
                const [x] = this.next(next, new Set());
                if (!x)
                    break;
                next = x.after.list;
                steps.push(this.accept(x.p));
                const after = this.live(next);
                const score = this.score(next, after);
                if (score > Math.max(before, best?.score ?? -Infinity) + 1e-9 && this.allowed(next, after))
                    best = { list: next, score, steps: steps.slice() };
            }
        }
        this.cap = Infinity;
        this.anchored = false;
        return best;
    }
    /** Druga runda: kazda maska raz wyjeta i zbudowana od nowa przy pozostalych; potem maski o wspolnym poczatku razem. */
    rebuild(list, journal, tick) {
        let cur = list;
        const start = this.score(cur);
        const take = (r, gone) => {
            if (!r)
                return;
            journal.push({ text: `druga runda: zamiast ${gone.map(i => this.space.text(i.m)).join('  ')}`, points: r.score - this.score(cur) }, ...r.steps.map(x => ({ ...x, text: `  ${x.text}` })));
            cur = r.list;
        };
        // od maski, ktora daje najmniej
        const worth = cur.inc.map(i => ({ i, v: start - this.score({ inc: cur.inc.filter(x => x !== i), exc: cur.exc }) })).sort((a, b) => a.v - b.v);
        worth.forEach(({ i }, n) => {
            if (this.late() || !cur.inc.includes(i))
                return;
            tick(n / worth.length, `druga runda: ${n + 1} z ${worth.length}`);
            take(this.redo(cur, [i], this.loose(i.m) ? ['one', 'split', 'anchored'] : ['one', 'split']), [i]);
        });
        const groups = new Map();
        for (const i of cur.inc) {
            if (this.loose(i.m))
                continue;
            const k = this.space.q.tokens[i.m.toks[0]].text;
            groups.set(k, [...(groups.get(k) ?? []), i]);
        }
        for (const g of groups.values())
            if (g.length > 1 && !this.late() && g.every(i => cur.inc.includes(i)))
                take(this.redo(cur, g, ['one']), g);
        return cur;
    }
    run(tick) {
        const info = (l) => `masek: ${l.inc.length + l.exc.length}`;
        const part = (l) => Math.min(0.95, this.live(l).t.small / Math.max(1, this.space.np));
        // dwa starty: z maskami od ** i bez; kazdy poprawiany osobno
        const done = [false, true].map((anchored, n) => {
            const at = (p, t) => tick((n + p) / 2, t);
            const journal = [];
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
                list = this.grow(list, journal, () => { });
                list = this.excludes(list, journal);
                list = this.prune(list, journal);
                if (this.score(list) <= before + 1e-6)
                    break;
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
    step(list, journal) {
        const one = (from) => {
            for (const anchored of this.w.start > 0 ? [true, false] : [false]) {
                for (const raw of STEP_RAW) {
                    this.anchored = anchored;
                    this.minRaw = raw;
                    const [best] = this.next(from, new Set());
                    if (!best)
                        continue;
                    journal.push(this.accept(best.p));
                    return this.excludes(best.after.list, journal);
                }
            }
            return null;
        };
        const next = one(list);
        if (next)
            return next;
        const clean = this.excludes(list, journal);
        return clean === list ? null : one(clean) ?? clean;
    }
    /** Kolejne maski (--next), najwyzej steps; done po kazdej. */
    steps(steps, done, tick) {
        this.byStep = true;
        const journal = [];
        let list = { inc: [], exc: [] };
        for (let n = 0; n < steps && !this.late(); n++) {
            tick(Math.min(0.95, Math.max(n / steps, this.live(list).t.small / Math.max(1, this.space.np))), `masek: ${list.inc.length + list.exc.length}`);
            const next = this.step(list, journal);
            if (!next)
                break;
            list = next;
            done(this.result(list, journal));
        }
        return this.result(list, journal);
    }
    result(list, journal) {
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
exports.Builder = Builder;
/** KB duzych, ktore musi wylaczyc EXCLUDE, zeby sie oplacil. */
function needKb(input, w) {
    let kb = 0;
    for (let i = 0; i < input.pos.length; i++)
        kb += input.allocKb[input.pos[i]];
    const part = w.large > 0 ? w.exclude / (100 * w.large) : 1;
    return Math.max(1, kb * Math.max(0.0005, part));
}
/** Ile malych musi dac maska, zeby sie oplacila. */
function enough(np, opt) {
    const { small, masks } = opt.weights;
    return Math.max(opt.minCount, small > 0 ? Math.ceil(np * masks / (100 * small) - 1e-9) : np);
}
function makeSpace(input, opt, tick, extra = []) {
    return new Space(input, opt.head ?? [], enough(input.pos.length, opt), 0.5 * needKb(input, opt.weights), opt.partial, extra, tick, opt.base);
}
/** Cala lista automatem, z pytaniem po kazdej masce (ask) albo po kilka masek (by; jak ask z base: dalszy ciag listy). */
function buildList(input, opt, stages, ask, by) {
    const o = { ...opt, minCount: enough(input.pos.length, opt) };
    let space = makeSpace(input, o, stages.names);
    const tick = stages.build();
    let b = new Builder(space, o);
    if (by)
        return b.steps(by.steps, by.done, tick);
    if (!ask)
        return b.run(tick);
    const byStep = opt.base !== undefined;
    b.byStep = byStep;
    b.minRaw = RAW[1];
    const banned = new Set();
    const extra = [];
    let list = { inc: [], exc: [] };
    let journal = [];
    /** poprzednie stany listy: maski i dlugosc dziennika */
    const past = [];
    const textsOf = (l) => [l.inc, l.exc].map(x => x.map(i => space.text(i.m)));
    const restore = (texts) => {
        const [inc, exc] = texts.map(l => l.map(t => b.item(space.parse(t))));
        return { inc, exc };
    };
    const put = (next, entry) => {
        past.push({ texts: textsOf(list), journal: journal.length });
        list = next;
        journal.push(entry);
    };
    for (;;) {
        const found = b.next(list, banned);
        const last = journal[journal.length - 1];
        const a = ask(found.map(x => x.p), (opt.base?.include.length ?? 0) + list.inc.length + 1, b.live(list).t, last ?? null);
        if ('stop' in a)
            break;
        if ('undo' in a) {
            const old = past.pop();
            if (!old)
                continue;
            list = restore(old.texts);
            journal = journal.slice(0, old.journal);
        }
        else if ('take' in a) {
            const x = found[a.take];
            if (x)
                put(x.after.list, b.accept(x.p));
        }
        else if ('reject' in a) {
            if (found.length === 0)
                break;
            banned.add(found[0].p.text);
            banned.add(coverKey(found[0].st.seqs, found[0].st.gone));
        }
        else {
            let m = space.parse(a.mask);
            if (!m) {
                // elementy, ktorych nie bylo: nowe klasy kwalifikatorow, ta sama lista
                extra.push(...a.mask.split('.').filter(x => x !== '*' && x !== '**'));
                const texts = textsOf(list);
                space = makeSpace(input, o, () => { }, extra);
                for (const x of [...banned])
                    if (x.startsWith('#'))
                        banned.delete(x);
                const { origin, free } = b;
                b = new Builder(space, o);
                b.byStep = byStep;
                b.minRaw = RAW[1];
                b.origin = origin;
                b.free = free;
                list = restore(texts);
                m = space.parse(a.mask);
            }
            if (!m)
                continue;
            b.free.add(space.text(m));
            const next = { inc: [...list.inc, b.item(m)], exc: list.exc };
            put(next, { text: `wpisana ${a.mask}`, points: b.score(next) - b.score(list) });
        }
    }
    return b.result(list, journal);
}
};

// ==================== src/auto-check.ts
MODULES["./auto-check"] = function (exports, require, module) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MaskListError = void 0;
exports.parseMaskList = parseMaskList;
exports.checkMasks = checkMasks;
const auto_tree_1 = require("./auto-tree");
const auto_util_1 = require("./auto-util");
const mask_1 = require("./mask");
/** ile masek wymienia powod zbednosci */
const MAX_NOTE = 4;
class MaskListError extends Error {
}
exports.MaskListError = MaskListError;
/**
 * Lista masek z pliku: po jednej w linii albo po przecinku (wnetrze INCLUDE), FILTLIST z INCLUDE i EXCLUDE (plik
 * z --filtlist), w CSV pierwsza kolumna (plik z --out). Pelna nazwa moze byc w apostrofach; komentarze jak w ACS.
 * Powtorzone maski sa pomijane z ostrzezeniem.
 */
function parseMaskList(text, file) {
    const masks = [];
    const excludes = [];
    const warnings = [];
    // komentarz zamieniony na same konce linii, zeby zgadzaly sie numery wierszy
    const clean = text.replace(/^\ufeff/, '').replace(/\/\*[\s\S]*?\*\//g, c => c.replace(/[^\n]/g, ' '));
    const fail = (i, msg) => new MaskListError(`${file}, wiersz ${i + 1}: ${msg}`);
    const parse = (item, i) => {
        const quoted = /^'(.*)'$/.exec(item);
        if (quoted && /[*%]/.test(quoted[1]))
            throw fail(i, `${item} - w apostrofach to pelna nazwa; maske podaj bez apostrofow`);
        let mask;
        try {
            mask = (0, mask_1.parseMask)(quoted ? quoted[1] : item).text;
        }
        catch (e) {
            throw fail(i, e.message);
        }
        if (/^[0-9]/.test(mask))
            throw fail(i, `"${mask}" - nazwa zbioru nie zaczyna sie cyfra`);
        return mask;
    };
    const add = (into, mask, i) => {
        if (into.includes(mask))
            warnings.push(`${file}, wiersz ${i + 1}: maska ${mask} powtorzona`);
        else
            into.push(mask);
    };
    const lines = clean.split(/\r?\n/);
    if (/(^|\s)(INCLUDE|EXCLUDE)\s*\(/i.test(clean)) {
        parseFiltlists(lines, fail).forEach((list, k) => {
            list.include.forEach(x => add(masks, parse(x.item, x.line), x.line));
            // EXCLUDE dziala tylko w swojej liscie; wspolne dla calego pliku jest tylko takie samo w kazdej
            const own = [];
            list.exclude.forEach(x => add(own, parse(x.item, x.line), x.line));
            if (k === 0)
                excludes.push(...own);
            else if (own.length !== excludes.length || own.some(x => !excludes.includes(x)))
                throw fail(list.line, 'FILTLIST maja rozne EXCLUDE - sprawdz kazda osobno');
        });
    }
    else {
        let state = -1;
        lines.forEach((line, i) => {
            if (/^T;DSN;/i.test(line))
                throw fail(i, 'to CSV z DCOLLECT, a nie lista masek');
            if (!line.includes(';')) {
                line.split(/[\s,]+/).filter(Boolean).forEach(item => add(masks, parse(item, i), i));
                return;
            }
            const cols = line.split(';').map(x => x.trim());
            if (cols[0].toLowerCase() === 'maska')
                state = cols.indexOf('stan');
            else if (cols[0])
                add(state >= 0 && cols[state] === 'exclude' ? excludes : masks, parse(cols[0], i), i);
        });
    }
    if (masks.length === 0)
        throw new MaskListError(`${file}: brak masek`);
    return { masks, excludes, warnings };
}
/** FILTLIST nazwa INCLUDE(...) EXCLUDE(...), dowolnie wiele; bez innych instrukcji rutyny. */
function parseFiltlists(lines, fail) {
    const lists = [];
    let section = null;
    let expect = null;
    lines.forEach((text, line) => {
        // + i - na koncu linii: kontynuacja
        for (const tok of text.replace(/\s[+-]\s*$/, '').match(/[(),]|'[^']*'|[^\s(),]+/g) ?? []) {
            const word = tok.toUpperCase();
            if (expect === 'name') {
                expect = null;
            }
            else if (expect === '(') {
                if (tok !== '(')
                    throw fail(line, `oczekiwano "(", jest "${tok}"`);
                expect = null;
            }
            else if (section) {
                if (tok === ')')
                    section = null;
                else if (tok === '(')
                    throw fail(line, 'brak ")" przed "("');
                else if (tok !== ',')
                    section.push({ item: tok, line });
            }
            else if (word === 'FILTLIST') {
                lists.push({ line, include: [], exclude: [] });
                expect = 'name';
            }
            else if (word === 'INCLUDE' || word === 'EXCLUDE') {
                // sam INCLUDE(...) bez FILTLIST
                if (lists.length === 0)
                    lists.push({ line, include: [], exclude: [] });
                section = lists[lists.length - 1][word === 'INCLUDE' ? 'include' : 'exclude'];
                expect = '(';
            }
            else {
                throw fail(line, `"${tok}" - plik moze zawierac tylko FILTLIST`);
            }
        }
    });
    if (section)
        throw fail(lines.length - 1, 'brak ")"');
    return lists;
}
const purityOf = (small, large) => (small ? small / (small + large) : 0);
function sumUp(text, groups) {
    const r = { text, small: 0, large: 0, purity: 0, smallKb: 0, largeKb: 0 };
    for (const g of groups) {
        r.small += g.small;
        r.large += g.large;
        r.smallKb += g.smallKb;
        r.largeKb += g.largeKb;
    }
    r.purity = purityOf(r.small, r.large);
    return r;
}
function checkMasks(input, masks, excludes, tick) {
    const { names, allocKb, pos, neg } = input;
    const quals = masks.map(m => (0, mask_1.parseMask)(m).quals);
    const tree = new auto_tree_1.MaskTree(quals);
    const exTree = excludes.length ? new auto_tree_1.MaskTree(excludes.map(m => m.split('.'))) : null;
    const exRows = excludes.map((text) => ({ text, small: 0, large: 0, purity: 0, smallKb: 0, largeKb: 0 }));
    // ---- grupy zbiorow o tym samym zestawie masek
    const single = [];
    const multi = new Map();
    const empty = (ids) => ({ ids, small: 0, large: 0, smallKb: 0, largeKb: 0 });
    const groupOf = (row, isSmall) => {
        const s = names.start[row];
        const ids = tree.match(names.pool, s, s + names.len[row]);
        const out = exTree?.match(names.pool, s, s + names.len[row]) ?? [];
        if (out.length) {
            for (const x of ids.length ? out : []) {
                exRows[x][isSmall ? 'small' : 'large']++;
                exRows[x][isSmall ? 'smallKb' : 'largeKb'] += allocKb[row];
            }
            return 'excluded';
        }
        if (ids.length === 0)
            return null;
        if (ids.length === 1)
            return single[ids[0]] ??= empty(ids);
        const key = ids.join();
        let g = multi.get(key);
        if (!g)
            multi.set(key, g = empty(ids));
        return g;
    };
    const count = pos.length + neg.length;
    let smallKb = 0;
    const restPos = new auto_util_1.IntList();
    const restNeg = new auto_util_1.IntList();
    for (let x = 0; x < pos.length; x++) {
        if ((x & 0x3fff) === 0)
            tick(x / count);
        smallKb += allocKb[pos[x]];
        const g = groupOf(pos[x], true);
        if (g === 'excluded')
            continue;
        if (!g) {
            restPos.push(pos[x]);
            continue;
        }
        g.small++;
        g.smallKb += allocKb[pos[x]];
    }
    for (let x = 0; x < neg.length; x++) {
        if ((x & 0x3fff) === 0)
            tick((pos.length + x) / count);
        const g = groupOf(neg[x], false);
        if (g === 'excluded')
            continue;
        if (!g) {
            restNeg.push(neg[x]);
            continue;
        }
        g.large++;
        g.largeKb += allocKb[neg[x]];
    }
    const groups = [...single.filter(g => g !== undefined), ...multi.values()];
    const of = masks.map(() => []);
    for (const g of groups)
        for (const m of g.ids)
            of[m].push(g);
    const rows = masks.map((text, m) => ({ ...sumUp(text, of[m]), only: single[m]?.small ?? 0, note: '', state: '' }));
    // ---- zawieranie: w danych kazdy zbior maski m obejmuje tez b, a potem porownanie samych masek
    const inside = masks.map((_, m) => {
        const cand = of[m].length ? of[m].reduce((s, g) => s.filter(b => g.ids.includes(b)), of[m][0].ids) : masks.map((_x, b) => b);
        return cand.filter(b => b !== m && (0, auto_tree_1.within)(quals[m], quals[b]));
    });
    // ---- zbedne: od najnizszej czystosci, przy rownej najpierw zawarte w innej, potem mniej malych, potem dalsze na liscie
    const left = masks.map(() => true);
    const cover = new Map(groups.map(g => [g, g.ids.length]));
    const needed = (m) => of[m].some(g => g.small > 0 && cover.get(g) < 2);
    const spare = masks.map((_, m) => m).filter(m => !needed(m));
    spare.sort((a, b) => rows[a].purity - rows[b].purity || Number(inside[b].length > 0) - Number(inside[a].length > 0)
        || rows[a].small - rows[b].small || b - a);
    for (const m of spare) {
        if (needed(m)) {
            rows[m].state = 'zamiast';
            continue;
        }
        rows[m].state = 'usun';
        left[m] = false;
        for (const g of of[m])
            cover.set(g, cover.get(g) - 1);
    }
    for (const m of spare) {
        // powod usuniecia odwoluje sie do masek, ktore zostaja; "zamiast" - do wszystkich
        const refers = (b) => left[b] || left[m];
        const wider = inside[m].filter(refers).sort((a, b) => rows[b].small - rows[a].small || a - b);
        if (wider.length)
            rows[m].note = `zawiera sie w ${masks[wider[0]]}`;
        else if (of[m].length === 0)
            rows[m].note = 'nie pasuje do zadnego zbioru';
        else if (rows[m].small === 0)
            rows[m].note = `nie obejmuje malych zbiorow (duzych: ${rows[m].large})`;
        else {
            const by = coveredBy(m, of[m], refers).map(b => masks[b]);
            const more = by.length > MAX_NOTE ? ` i ${by.length - MAX_NOTE} innych` : '';
            rows[m].note = `w danych jej male zbiory obejmuja: ${by.slice(0, MAX_NOTE).join(', ')}${more}`;
        }
    }
    // ---- pary ze wspolnymi zbiorami
    const pairs = new Map();
    for (const g of groups) {
        for (let i = 0; i < g.ids.length; i++) {
            for (let j = i + 1; j < g.ids.length; j++) {
                const key = g.ids[i] * masks.length + g.ids[j];
                let o = pairs.get(key);
                if (!o)
                    pairs.set(key, o = { a: masks[g.ids[i]], b: masks[g.ids[j]], small: 0, large: 0, partA: 0, partB: 0 });
                o.small += g.small;
                o.large += g.large;
            }
        }
    }
    for (const [key, o] of pairs) {
        o.partA = o.small / Math.max(1, rows[Math.floor(key / masks.length)].small);
        o.partB = o.small / Math.max(1, rows[key % masks.length].small);
    }
    const overlaps = [...pairs].sort(([ka, a], [kb, b]) => b.small - a.small || b.large - a.large || ka - kb).map(([, o]) => o);
    return {
        small: pos.length,
        large: neg.length,
        smallKb,
        rows,
        total: sumUp('RAZEM', groups),
        after: sumUp('RAZEM PO USUNIECIU', groups.filter(g => g.ids.some(m => left[m]))),
        overlaps,
        rest: { pos: restPos.a.slice(0, restPos.n), neg: restNeg.a.slice(0, restNeg.n) },
        excludes: exRows,
    };
}
/** Maski (poza m), ktore razem obejmuja male zbiory maski m - zachlannie, od obejmujacej najwiecej. */
function coveredBy(m, groups, allowed) {
    let open = groups.filter(g => g.small > 0);
    const out = [];
    while (open.length) {
        const sum = new Map();
        for (const g of open)
            for (const b of g.ids)
                if (b !== m && allowed(b))
                    sum.set(b, (sum.get(b) ?? 0) + g.small);
        const best = [...sum].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0][0];
        out.push(best);
        open = open.filter(g => !g.ids.includes(best));
    }
    return out;
}
};

// ==================== src/auto-exclude.ts
MODULES["./auto-exclude"] = function (exports, require, module) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExcludeSpace = void 0;
exports.pickExcludes = pickExcludes;
const auto_mine_1 = require("./auto-mine");
const auto_quals_1 = require("./auto-quals");
const auto_tree_1 = require("./auto-tree");
const auto_util_1 = require("./auto-util");
/** ile najwiekszych kwalifikatorow jest sprawdzanych jako pierwszy albo drugi z pary */
const PAIR_HEADS = 60;
/** o tyle gorszy wynik nadal przegrywa z lepszym rodzajem kwalifikatora */
const NEAR = 0.98;
/** o tyle wiecej musza wylaczac dwa kwalifikatory */
const TWO = 1.25;
class ExcludeSpace {
    input;
    head;
    q;
    /** liczba duzych; rowSeq: duze, potem male */
    nl;
    ns;
    constructor(input, head, minKb, partial, tick) {
        this.input = input;
        this.head = head;
        this.nl = input.neg.length;
        this.ns = input.pos.length;
        const names = (0, auto_quals_1.readNames)({ ...input, pos: input.neg, neg: input.pos }, head.length, p => tick(0.4 * p), true);
        this.q = (0, auto_quals_1.buildSequences)(names, Math.max(1, minKb), partial, head.length > 0, p => tick(0.4 + 0.6 * p));
    }
    text(combo) {
        return [...this.head, '**', ...combo.flatMap(t => [this.q.tokens[t].text, '**'])].join('.');
    }
    /** useL / useS: 1 = duzy do wylaczenia / maly do oszczedzenia */
    weigh(useL, useS) {
        const { rowSeq, count } = this.q;
        const { allocKb, pos, neg } = this.input;
        const w = { kb: new Float64Array(count), n: new Float64Array(count), small: new Float64Array(count), smallKb: new Float64Array(count) };
        for (let i = 0; i < this.nl; i++) {
            if (!useL[i])
                continue;
            w.kb[rowSeq[i]] += allocKb[neg[i]];
            w.n[rowSeq[i]]++;
        }
        for (let i = 0; i < this.ns; i++) {
            if (!useS[i])
                continue;
            w.small[rowSeq[this.nl + i]]++;
            w.smallKb[rowSeq[this.nl + i]] += allocKb[pos[i]];
        }
        return w;
    }
    /** Najlepsza maska z jednego albo dwoch kwalifikatorow. */
    best(w, lim) {
        const { tokens, count, off, cls, clsOff, clsTok, end } = this.q;
        const nt = tokens.length;
        const stamp = new Int32Array(nt);
        let round = 0;
        const sum = { kb: new Float64Array(nt), n: new Float64Array(nt), small: new Float64Array(nt), smallKb: new Float64Array(nt) };
        const add = (t, s) => {
            sum.kb[t] += w.kb[s];
            sum.n[t] += w.n[s];
            sum.small[t] += w.small[s];
            sum.smallKb[t] += w.smallKb[s];
        };
        const clear = () => {
            for (const a of Object.values(sum))
                a.fill(0);
        };
        const net = (t) => sum.kb[t] - sum.smallKb[t];
        const ok = (t) => sum.small[t] <= lim.maxLoss && sum.n[t] >= lim.minCount && sum.kb[t] > 0 && net(t) >= lim.minKb;
        const make = (combo, t) => ({
            combo, net: net(t), loss: sum.small[t],
            kind: Math.max(...combo.map(x => tokens[x].kind)), lit: combo.reduce((n, x) => n + tokens[x].lit, 0),
        });
        const fits = (combo) => this.text(combo).length <= auto_mine_1.MAX_LEN;
        const choose = (list) => {
            if (list.length === 0)
                return null;
            const top = list.reduce((m, c) => Math.max(m, c.net), 0);
            return list.filter(c => c.net >= top * NEAR).sort((a, b) => a.kind - b.kind || b.net - a.net || a.loss - b.loss || b.lit - a.lit
                || (this.text(a.combo) < this.text(b.combo) ? -1 : 1))[0];
        };
        for (let s = 0; s < count; s++) {
            if (w.n[s] === 0 && w.small[s] === 0)
                continue;
            round++;
            for (let p = off[s]; p < off[s] + end[s]; p++) {
                for (let y = clsOff[cls[p]]; y < clsOff[cls[p] + 1]; y++) {
                    const t = clsTok[y];
                    if (stamp[t] === round)
                        continue;
                    stamp[t] = round;
                    add(t, s);
                }
            }
        }
        const one = [];
        const bad = [];
        for (let t = 0; t < nt; t++) {
            if (sum.n[t] < lim.minCount || sum.kb[t] < lim.minKb)
                continue;
            if (!ok(t))
                bad.push(t);
            else if (fits([t]))
                one.push(make([t], t));
        }
        const single = choose(one);
        const need = Math.max(lim.minKb, single ? TWO * single.net : 0);
        // ---- pary: co najmniej jeden kwalifikator z najwiekszych, ktore same zabieraja za duzo malych
        const heads = bad.filter(t => sum.kb[t] >= need).sort((a, b) => sum.kb[b] - sum.kb[a]).slice(0, PAIR_HEADS);
        const big = Uint8Array.from(sum.kb, v => Number(v >= need));
        const slot = new Int32Array(nt).fill(-1);
        heads.forEach((t, i) => { slot[t] = i; });
        const lists = heads.map(() => new auto_util_1.IntList());
        if (heads.length) {
            for (let s = 0; s < count; s++) {
                if (w.n[s] === 0 && w.small[s] === 0)
                    continue;
                round++;
                for (let p = off[s]; p < off[s] + end[s]; p++) {
                    for (let y = clsOff[cls[p]]; y < clsOff[cls[p] + 1]; y++) {
                        const t = clsTok[y];
                        if (slot[t] < 0 || stamp[t] === round)
                            continue;
                        stamp[t] = round;
                        lists[slot[t]].push(s);
                    }
                }
            }
        }
        const two = [];
        heads.forEach((a, i) => {
            const has = (c) => {
                for (let y = clsOff[c]; y < clsOff[c + 1]; y++)
                    if (clsTok[y] === a)
                        return true;
                return false;
            };
            for (const before of [false, true]) {
                clear();
                for (let x = 0; x < lists[i].n; x++) {
                    const s = lists[i].a[x];
                    let lo = off[s];
                    let hi = off[s] + end[s];
                    if (before) {
                        do
                            hi--;
                        while (!has(cls[hi]));
                    }
                    else {
                        while (!has(cls[lo]))
                            lo++;
                        lo++;
                    }
                    round++;
                    for (let p = lo; p < hi; p++) {
                        for (let y = clsOff[cls[p]]; y < clsOff[cls[p] + 1]; y++) {
                            const t = clsTok[y];
                            if (!big[t] || stamp[t] === round)
                                continue;
                            stamp[t] = round;
                            add(t, s);
                        }
                    }
                }
                for (let t = 0; t < nt; t++) {
                    const combo = before ? [t, a] : [a, t];
                    if (big[t] && net(t) >= need && ok(t) && fits(combo))
                        two.push(make(combo, t));
                }
            }
        });
        return (choose(two) ?? single)?.combo ?? null;
    }
    /** 1 = nazwa pasuje: [duze], [male] */
    hits(combo) {
        const { count, off, cls, clsOff, clsTok, end, rowSeq } = this.q;
        const flag = new Uint8Array(count);
        for (let s = 0; s < count; s++) {
            let j = 0;
            for (let p = off[s]; p < off[s] + end[s] && j < combo.length; p++) {
                for (let y = clsOff[cls[p]]; y < clsOff[cls[p] + 1]; y++) {
                    if (clsTok[y] !== combo[j])
                        continue;
                    j++;
                    break;
                }
            }
            flag[s] = Number(j === combo.length);
        }
        const l = new Uint8Array(this.nl);
        const s = new Uint8Array(this.ns);
        for (let i = 0; i < this.nl; i++)
            l[i] = flag[rowSeq[i]];
        for (let i = 0; i < this.ns; i++)
            s[i] = flag[rowSeq[this.nl + i]];
        return [l, s];
    }
    hitsOf(mask) {
        const { names, pos, neg } = this.input;
        const tree = new auto_tree_1.MaskTree([mask.split('.')]);
        const test = (rows) => Uint8Array.from(rows, r => Number(tree.match(names.pool, names.start[r], names.start[r] + names.len[r]).length > 0));
        return [test(neg), test(pos)];
    }
    /** Pelne maski bez straty malych dla pozostalych duzych, od najwiekszej alokacji. */
    fullMasks(useL, useS, opt, tick) {
        const { input } = this;
        const pos = input.neg.filter((_, i) => useL[i]);
        const neg = input.pos.filter((_, i) => useS[i]);
        const res = (0, auto_mine_1.mine)({ names: input.names, allocKb: input.allocKb, pos, neg }, { ...opt, minPurity: 1, head: this.head }, { prepare: p => tick(0.2 * p), search: () => p => tick(0.2 + 0.6 * p), select: () => p => tick(0.8 + 0.2 * p) });
        return res.masks.filter(m => m.smallKb >= opt.minKb).map(m => ({ text: m.text, kb: m.smallKb })).sort((a, b) => b.kb - a.kb);
    }
}
exports.ExcludeSpace = ExcludeSpace;
/** Maski EXCLUDE dla wszystkich duzych z input (zachlannie), bez zbednych. */
function pickExcludes(input, head, opt, tick) {
    const { allocKb, pos, neg } = input;
    let total = 0;
    for (let i = 0; i < neg.length; i++)
        total += allocKb[neg[i]];
    const minKb = total * opt.gain;
    const space = new ExcludeSpace(input, head, minKb, 3, p => tick(0.4 * p));
    const useL = new Uint8Array(neg.length).fill(1);
    const useS = new Uint8Array(pos.length).fill(1);
    let loss = Math.floor(pos.length * opt.loss);
    const out = [];
    const take = (text, [l, s]) => {
        out.push({ text, l });
        for (let i = 0; i < l.length; i++)
            if (l[i])
                useL[i] = 0;
        for (let i = 0; i < s.length; i++) {
            if (!s[i] || !useS[i])
                continue;
            useS[i] = 0;
            loss--;
        }
    };
    while (out.length < opt.maxMasks) {
        tick(0.4 + 0.3 * (1 - 1 / (1 + out.length)));
        const combo = space.best(space.weigh(useL, useS), { maxLoss: loss, minKb, minCount: opt.minCount });
        if (!combo)
            break;
        take(space.text(combo), space.hits(combo));
    }
    if (out.length < opt.maxMasks && useL.includes(1)) {
        const o = { minCount: opt.minCount, minKb, maxMasks: opt.maxMasks - out.length, maxWild: opt.maxWild };
        for (const m of space.fullMasks(useL, useS, o, p => tick(0.7 + 0.3 * p)))
            out.push({ text: m.text, l: space.hitsOf(m.text)[0] });
    }
    // zbedne: wszystkie ich duze wylaczaja pozostale
    const cover = new Int32Array(neg.length);
    for (const m of out)
        for (let i = 0; i < cover.length; i++)
            cover[i] += m.l[i];
    const keep = out.map(() => true);
    for (let j = out.length - 1; j >= 0; j--) {
        if (out[j].l.some((v, i) => v && cover[i] < 2))
            continue;
        keep[j] = false;
        for (let i = 0; i < cover.length; i++)
            cover[i] -= out[j].l[i];
    }
    return out.filter((m, j) => keep[j] && (0, auto_mine_1.literalChars)(m.text)).map(m => m.text);
}
};

// ==================== src/filtlist.ts
MODULES["./filtlist"] = function (exports, require, module) {
"use strict";
/** FILTLIST rutyn ACS: zapis list w liniach do kolumny 71. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_LIST = exports.ACS_MAX_COL = void 0;
exports.chunks = chunks;
exports.filtlist = filtlist;
exports.ACS_MAX_COL = 71;
/** limit pozycji listy INCLUDE / EXCLUDE */
exports.MAX_LIST = 255;
function chunks(a, n) {
    const out = [];
    for (let i = 0; i < a.length; i += n)
        out.push(a.slice(i, i + n));
    return out;
}
/** Pozycja listy FILTLIST: maska bez apostrofow; nazwa z '-' / '{' w apostrofach. */
function entry(text) {
    return /[-{]/.test(text) && !/[*%]/.test(text) ? `'${text}'` : text;
}
/** Najdluzsza pozycja FILTLIST: nazwa 44 znaki w apostrofach + przecinek. */
const MAX_ENTRY = 47;
/**
 * FILTLIST z zawijaniem do ACS_MAX_COL; kazda linia poza ostatnia konczy sie przecinkiem (albo nawiasem
 * otwierajacym, gdy pierwsza pozycja nie miesci sie za naglowkiem; EXCLUDE od nowej linii, pod INCLUDE). Wciecie
 * kontynuacji pod nawiasem, a gdy przy dlugiej nazwie listy pelna nazwa zbioru by sie nie zmiescila - 4 spacje.
 */
function filtlist(name, items, excludes = []) {
    const start = `  FILTLIST ${name} `;
    const fits = start.length + 'INCLUDE('.length + MAX_ENTRY <= exports.ACS_MAX_COL;
    const list = (head, entries) => {
        const indent = ' '.repeat(fits ? head.length : 4);
        const lines = [];
        let cur = head;
        entries.forEach((it, i) => {
            const piece = entry(it) + (i < entries.length - 1 ? ',' : ')');
            if (cur.length + piece.length > exports.ACS_MAX_COL && cur !== indent) {
                lines.push(cur);
                cur = indent;
            }
            cur += piece;
        });
        lines.push(cur);
        return lines;
    };
    return [...list(`${start}INCLUDE(`, items),
        ...(excludes.length ? list(`${' '.repeat(fits ? start.length : 4)}EXCLUDE(`, excludes) : [])];
}
};

// ==================== src/zos.ts
MODULES["./zos"] = function (exports, require, module) {
"use strict";
/** Kontrola tekstu dla z/OS: FB 80, kolumny 1-71 (ACS, karty DFSORT), znaki bezpieczne dla IBM-1047. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ZosTextError = void 0;
exports.checkZosLines = checkZosLines;
exports.zosText = zosText;
class ZosTextError extends Error {
}
exports.ZosTextError = ZosTextError;
function checkZosLines(member, lines, maxCol = 71) {
    if (!/^[A-Z#@$][A-Z0-9#@$]{0,7}$/.test(member))
        throw new ZosTextError(`niepoprawna nazwa membra ${member}`);
    lines.forEach((l, i) => {
        if (l.length > maxCol)
            throw new ZosTextError(`${member}:${i + 1} linia dluzsza niz ${maxCol} (${l.length})`);
        if (/[^\x20-\x7e]|[[\]\\!^~`]/.test(l)) {
            throw new ZosTextError(`${member}:${i + 1} znak niebezpieczny dla EBCDIC: ${l}`);
        }
    });
}
/**
 * Tekst do pliku z/OS: bez polskich znakow, wielkie litery, tylko znaki bezpieczne dla IBM-1047
 * (bez [ ] \ ! ^ ~ ` i znakow spoza ASCII).
 */
function zosText(s) {
    return s.replace(/[łŁ]/g, 'L').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
        .replace(/[^\x20-\x7e]|[[\]\\!^~`]/g, '?');
}
};

// ==================== src/testcase.ts
MODULES["./testcase"] = function (exports, require, module) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TEST_MAX_COL = exports.TestCaseError = void 0;
exports.memberNames = memberNames;
exports.testLines = testLines;
exports.buildTests = buildTests;
exports.iebupdte = iebupdte;
/**
 * Testy ACS w formacie ISMF (member biblioteki testow, FB 80) - generowane z reprezentantow (acs-masks repr --tests),
 * zamiast testow z DCOLLECT przez NaviQuest (ACBQBAG1; ta droga zostaje).
 *
 * Format membera (z membera utworzonego w ISMF 7.4, 2026-11-17): linie "SLOWO: wartosc"; opis w linii pod
 * DESCRIPTION1:
 *   DESCRIPTION1:
 *   <opis: maski / kwalifikatory z rutyn, do ktorych pasuje DSN>
 *   DSN: <nazwa zbioru>
 *   ACSENVIR: ALLOC
 * Na razie tylko te pola. Pozostale zmienne (DSORG, SIZE, UNIT...) maja w tescie wartosc pusta - warunki rutyn
 * na nich nie roznicuja testow (raport repr je wypisuje).
 *
 * Wynik dla z/OS:
 *   zos/ACMTEST    - wejscie IEBUPDTE (./ ADD NAME=... + linie membera), ladowane jobem ACMTLOAD do TESTBED
 *   zos/testy/*    - te same membery jako osobne pliki (alternatywa: FTP mput do PDS)
 */
const zos_1 = require("./zos");
class TestCaseError extends Error {
}
exports.TestCaseError = TestCaseError;
/** Najdluzsza linia membera (bez kolumn 73-80). */
exports.TEST_MAX_COL = 72;
/** Nazwy memberow jak w NaviQuest: prefiks 1-4 litery + numer do 8 znakow. */
function memberNames(prefix, count) {
    const p = prefix.toUpperCase();
    if (!/^[A-Z#@$]{1,4}$/.test(p))
        throw new TestCaseError(`prefiks testow "${prefix}": 1-4 litery (A-Z # @ $)`);
    const digits = 8 - p.length;
    if (count > 10 ** digits - 1) {
        throw new TestCaseError(`${count} testow nie miesci sie w nazwach ${p}${'n'.repeat(digits)} - uzyj krotszego prefiksu`);
    }
    return Array.from({ length: count }, (_, i) => p + String(i + 1).padStart(digits, '0'));
}
function testLines(description, dsn, acsenvir = 'ALLOC') {
    const desc = (0, zos_1.zosText)(description).replace(/^\.\//, '. /').slice(0, exports.TEST_MAX_COL).trimEnd();
    return ['DESCRIPTION1:', desc, `DSN: ${dsn}`, `ACSENVIR: ${acsenvir}`];
}
function buildTests(prefix, items) {
    const names = memberNames(prefix, items.length);
    return items.map((it, i) => ({ member: names[i], dsn: it.dsn, description: it.description, lines: testLines(it.description, it.dsn) }));
}
/** Wejscie IEBUPDTE (PARM=NEW): kazdy member po "./ ADD NAME=", na koncu "./ ENDUP". */
function iebupdte(tests) {
    const out = [];
    for (const t of tests)
        out.push(`./ ADD NAME=${t.member}`, ...t.lines);
    out.push('./ ENDUP');
    return out;
}
};

// ==================== src/auto-acs.ts
MODULES["./auto-acs"] = function (exports, require, module) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.testFile = void 0;
exports.findExcludes = findExcludes;
exports.acsProblem = acsProblem;
exports.filtlistText = filtlistText;
exports.maskTests = maskTests;
/**
 * Maski -> z/OS: EXCLUDE dla duzych zbiorow objetych maskami, tekst FILTLIST i testy ISMF (jak repr --tests).
 */
const auto_check_1 = require("./auto-check");
const auto_exclude_1 = require("./auto-exclude");
const auto_tree_1 = require("./auto-tree");
const filtlist_1 = require("./filtlist");
const mask_1 = require("./mask");
const testcase_1 = require("./testcase");
/** Wiersze objete maskami (INCLUDE i nie EXCLUDE). */
function covered(input, include, exclude, tick) {
    const { names } = input;
    const inc = new auto_tree_1.MaskTree(include.map(m => m.split('.')));
    const exc = exclude.length ? new auto_tree_1.MaskTree(exclude.map(m => m.split('.'))) : null;
    const total = input.pos.length + input.neg.length;
    let done = 0;
    const pick = (rows) => rows.filter(row => {
        if ((done++ & 0x3fff) === 0)
            tick(done / total);
        const s = names.start[row];
        const e = s + names.len[row];
        return inc.match(names.pool, s, e).length > 0 && !exc?.match(names.pool, s, e).length;
    });
    return { ...input, pos: pick(input.pos), neg: pick(input.neg) };
}
/**
 * Maski EXCLUDE (auto-exclude): jak najszersze - jeden kwalifikator, dwa, a na koncu pelna maska; kazda wylacza co
 * najmniej minCount nowych duzych objetych INCLUDE i gain (czesc) ich alokacji, razem nie wiecej niz loss malych.
 */
function findExcludes(input, include, old, opt, tick) {
    const c = covered(input, include, old, p => tick(0.2 * p));
    const texts = c.neg.length ? (0, auto_exclude_1.pickExcludes)(c, opt.head ?? [], {
        minCount: opt.minCount, gain: opt.gain ?? 0, loss: opt.loss ?? 0, maxWild: opt.maxWild, maxMasks: filtlist_1.MAX_LIST - old.length,
    }, p => tick(0.2 + 0.7 * p)) : [];
    // ---- liczby z porownania masek z nazwami
    const row = (text) => ({ text, small: 0, large: 0, purity: 0, smallKb: 0, largeKb: 0 });
    const masks = texts.map(row);
    const [before, total, after] = [row('PRZED EXCLUDE'), row('RAZEM'), row('PO EXCLUDE')];
    const tree = new auto_tree_1.MaskTree(texts.map(t => t.split('.')));
    const add = (rows, n, kb) => {
        for (let x = 0; x < rows.length; x++) {
            if ((x & 0x3fff) === 0)
                tick(0.9 + 0.1 * (x / rows.length));
            const s = input.names.start[rows[x]];
            const ids = tree.match(input.names.pool, s, s + input.names.len[rows[x]]);
            for (const r of [before, ids.length ? total : after, ...ids.map(m => masks[m])]) {
                r[n]++;
                r[kb] += input.allocKb[rows[x]];
            }
        }
    };
    add(c.pos, 'small', 'smallKb');
    add(c.neg, 'large', 'largeKb');
    for (const r of [before, after])
        r.purity = r.small ? r.small / (r.small + r.large) : 0;
    return { before, after, masks: masks.sort((a, b) => b.largeKb - a.largeKb || (a.text < b.text ? -1 : 1)), total };
}
/** Dlaczego translator ACS nie przyjmie maski; null = dobra. */
function acsProblem(mask) {
    try {
        if ((0, mask_1.parseMask)(mask).generic && mask.includes('-'))
            return '"-" w masce to znak kontynuacji';
        return null;
    }
    catch (e) {
        return e.message;
    }
}
/** FILTLIST z INCLUDE i EXCLUDE; ponad 255 masek - kilka list, kazda z tym samym EXCLUDE. */
function filtlistText(name, include, exclude) {
    if (exclude.length > filtlist_1.MAX_LIST)
        throw new auto_check_1.MaskListError(`EXCLUDE: ${exclude.length} masek, FILTLIST przyjmuje ${filtlist_1.MAX_LIST}`);
    const parts = (0, filtlist_1.chunks)(include, filtlist_1.MAX_LIST);
    return parts.flatMap((p, i) => (0, filtlist_1.filtlist)(parts.length > 1 ? `${name}_${i + 1}` : name, p, exclude));
}
/**
 * Testy do masek INCLUDE i EXCLUDE, najwyzej per zbiorow kazdego rodzaju na maske; opis = maski, do ktorych nazwa pasuje:
 *   maska               zbior objety INCLUDE (maly, a gdy ich nie ma - duzy); maska z **: nazwy o najmniejszej
 *                       i o najwiekszej liczbie kwalifikatorow
 *   EXCLUDE maska       zbior wylaczony
 *   BEZ MASKI - maska   zbior, ktory nie pasuje do zadnej maski, a pasowalby, gdyby * bylo **
 */
function maskTests(input, include, exclude, per, prefix, tick) {
    const { names, pos, neg } = input;
    const inc = new auto_tree_1.MaskTree(include.map(m => m.split('.')));
    const exc = new auto_tree_1.MaskTree(exclude.map(m => m.split('.')));
    const wide = include.filter(m => m.split('.').includes('*'));
    const near = new auto_tree_1.MaskTree(wide.map(m => m.split('.').map(x => (x === '*' ? '**' : x))));
    const make = (n) => Array.from({ length: n }, () => new Map());
    const incSmall = make(include.length);
    const incLarge = make(include.length);
    const excAny = make(exclude.length);
    const nearAny = make(wide.length);
    const put = (reps, key, r) => {
        let list = reps.get(key);
        if (!list)
            reps.set(key, list = []);
        let i = list.length;
        while (i > 0 && (list[i - 1].masks - r.masks || compareNames(names, list[i - 1].row, r.row)) >= 0)
            i--;
        if (i === per)
            return;
        // ta sama nazwa (generacje GDG pod nazwa bazy) raz
        if (list.some(x => compareNames(names, x.row, r.row) === 0))
            return;
        list.splice(i, 0, r);
        if (list.length > per)
            list.pop();
    };
    const total = pos.length + neg.length;
    let done = 0;
    const scan = (rows, small) => {
        for (let x = 0; x < rows.length; x++) {
            if ((done++ & 0x3fff) === 0)
                tick(done / total);
            const s = names.start[rows[x]];
            const e = s + names.len[rows[x]];
            const ids = inc.match(names.pool, s, e);
            if (ids.length === 0) {
                const almost = near.match(names.pool, s, e);
                for (const m of almost)
                    put(nearAny[m], 0, { row: rows[x], masks: almost.length });
                continue;
            }
            const out = exc.match(names.pool, s, e);
            if (out.length) {
                for (const m of out)
                    put(excAny[m], 0, { row: rows[x], masks: out.length });
                continue;
            }
            let n = 1;
            for (let p = s; p < e; p++)
                if (names.pool[p] === 46)
                    n++;
            for (const m of ids)
                put((small ? incSmall : incLarge)[m], n, { row: rows[x], masks: ids.length });
        }
    };
    scan(pos, true);
    scan(neg, false);
    const items = new Map();
    const add = (reps, masks, tree, label) => {
        for (const { row } of reps) {
            const s = names.start[row];
            items.set(names.text(row), label + tree.match(names.pool, s, s + names.len[row]).map(m => masks[m]).join(' '));
        }
    };
    include.forEach((mask, m) => {
        const reps = incSmall[m].size ? incSmall[m] : incLarge[m];
        const keys = [...reps.keys()];
        if (keys.length === 0)
            return;
        add(reps.get(Math.min(...keys)), include, inc, '');
        if (mask.split('.').includes('**'))
            add(reps.get(Math.max(...keys)), include, inc, '');
    });
    excAny.forEach(reps => add(reps.get(0) ?? [], exclude, exc, 'EXCLUDE '));
    nearAny.forEach(reps => add(reps.get(0) ?? [], wide, near, 'BEZ MASKI - '));
    return (0, testcase_1.buildTests)(prefix, [...items].map(([dsn, description]) => ({ dsn, description })));
}
function compareNames(names, a, b) {
    const { pool, start, len } = names;
    const n = Math.min(len[a], len[b]);
    for (let i = 0; i < n; i++) {
        const d = pool[start[a] + i] - pool[start[b] + i];
        if (d)
            return d;
    }
    return len[a] - len[b];
}
const testFile = (tests) => (0, testcase_1.iebupdte)(tests).join('\n') + '\n';
exports.testFile = testFile;
};

// ==================== src/auto-audit.ts
MODULES["./auto-audit"] = function (exports, require, module) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generalize = generalize;
exports.mergeCandidates = mergeCandidates;
exports.audit = audit;
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
const auto_acs_1 = require("./auto-acs");
const auto_build_1 = require("./auto-build");
const auto_check_1 = require("./auto-check");
const auto_mine_1 = require("./auto-mine");
const auto_tree_1 = require("./auto-tree");
/** najwiecej kandydatow do scalenia na raz, osobno INCLUDE i EXCLUDE */
const MAX_CAND = 1000;
/** ile razy najwyzej scalane sa maski juz scalone */
const ROUNDS = 4;
/** najmniej znakow stalych maski od * albo ** */
const MIN_LITERAL = 3;
const MAX_NOTE = 4;
/** ile masek najwyzej zastepuje jedna (zamien) */
const MAX_SWAP = 3;
/** dla ilu masek z duzymi szukane sa wezsze i jaka najmniejsza czesc duzych listy maja obejmowac */
const MAX_DIRTY = 15;
const MIN_DIRTY = 0.01;
const TINY = 1e-9;
const zero = () => ({ small: 0, large: 0, smallKb: 0, largeKb: 0 });
const add = (a, b) => {
    a.small += b.small;
    a.large += b.large;
    a.smallKb += b.smallKb;
    a.largeKb += b.largeKb;
};
// ---------------------------------------------------------------- uogolnienia
/** Kwalifikatory obejmujace oba (bez **), od najwezszych. */
function wider(x, y) {
    if (x === y)
        return [x];
    if (x === '*' || y === '*')
        return ['*'];
    const out = [];
    if (!/\*/.test(x + y) && x.length === y.length) {
        const t = [...x].map((c, i) => (c === y[i] ? c : '%')).join('');
        if (/[^%]/.test(t))
            out.push(t);
    }
    const fixed = (c) => c !== undefined && c !== '*' && c !== '%';
    const n = Math.min(x.length, y.length);
    let p = 0;
    while (p < n && x[p] === y[p] && fixed(x[p]))
        p++;
    let s = 0;
    while (s < n - p && x[x.length - 1 - s] === y[y.length - 1 - s] && fixed(x[x.length - 1 - s]))
        s++;
    const head = x.slice(0, p);
    const tail = s ? x.slice(-s) : '';
    if (p && s)
        out.push(`${head}*${tail}`);
    if (p)
        out.push(`${head}*`);
    if (!p && s > 1)
        out.push(`*${tail}`);
    out.push('*');
    return out.filter(q => q.length <= 8);
}
/** Wspolne kwalifikatory po kolei (najdluzszy wspolny podciag); pary pozycji. */
function common(a, b) {
    const w = b.length + 1;
    const best = new Uint8Array((a.length + 1) * w);
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            best[i * w + j] = a[i] === b[j] && a[i] !== '**' ? best[(i + 1) * w + j + 1] + 1 : Math.max(best[(i + 1) * w + j], best[i * w + j + 1]);
        }
    }
    const out = [];
    for (let i = 0, j = 0; i < a.length && j < b.length;) {
        if (a[i] === b[j] && a[i] !== '**')
            out.push([i++, j++]);
        else if (best[(i + 1) * w + j] >= best[i * w + j + 1])
            i++;
        else
            j++;
    }
    return out;
}
/** Maski obejmujace obie maski. */
function generalize(ta, tb) {
    const a = ta.split('.');
    const b = tb.split('.');
    const out = new Set();
    const put = (quals) => {
        const q = quals.filter((x, i) => x !== '**' || quals[i - 1] !== '**');
        const text = q.join('.');
        if (text !== '**' && text.length <= auto_mine_1.MAX_LEN)
            out.add(text);
    };
    // ---- te same miejsca: rozne kwalifikatory zastapione wzorcem
    if (a.length === b.length && a.every((x, i) => (x === '**') === (b[i] === '**'))) {
        const opts = a.map((x, i) => (x === '**' ? ['**'] : wider(x, b[i])));
        const most = Math.max(...opts.map(x => x.length));
        for (let k = 0; k < most; k++)
            put(opts.map(x => x[Math.min(k, x.length - 1)]));
    }
    // ---- wspolny poczatek i reszta dowolna
    const starts = a[0] === '**' || b[0] === '**' ? [] : wider(a[0], b[0]);
    for (const s of starts) {
        put([s, '**']);
        // dalsze wspolne kwalifikatory z ** (albo tyloma samymi *) w miejscu roznic
        const pairs = common(a.slice(1), b.slice(1));
        const build = (until) => {
            const quals = [s];
            let i = 0;
            let j = 0;
            for (const [x, y] of pairs.slice(0, until)) {
                quals.push(...gap(a.slice(1 + i, 1 + x), b.slice(1 + j, 1 + y)), a[1 + x]);
                i = x + 1;
                j = y + 1;
            }
            const ga = a.slice(1 + i);
            const gb = b.slice(1 + j);
            put([...quals, ...gap(ga, gb)]);
            put([...quals, '**']);
            // wzorzec na nastepnym miejscu: PAY.LOGA.** i PAY.LOGB.X -> PAY.LOG*.**
            if (ga.length && gb.length && ga[0] !== '**' && gb[0] !== '**')
                for (const q of wider(ga[0], gb[0]))
                    put([...quals, q, '**']);
        };
        for (let k = 0; k <= pairs.length; k++)
            build(k);
    }
    // ---- jeden wspolny kwalifikator
    for (const q of a) {
        if (q.includes('*') || (0, auto_mine_1.literalChars)(q) < MIN_LITERAL || !b.includes(q))
            continue;
        put(['**', q, '**']);
        if (a[a.length - 1] === q && b[b.length - 1] === q)
            put(['**', q]);
    }
    return [...out];
}
function gap(ga, gb) {
    if (ga.length === gb.length && !ga.includes('**') && !gb.includes('**'))
        return ga.map(() => '*');
    return ['**'];
}
function usable(text, parents) {
    if ((0, auto_acs_1.acsProblem)(text) || (0, auto_mine_1.literalChars)(text) === 0 || /^[0-9]/.test(text))
        return false;
    const first = text.split('.')[0];
    // poczatek od * albo samych %: tylko z kwalifikatorem, ktory cos mowi
    if (/^[*%]/.test(first))
        return (0, auto_mine_1.literalChars)(text) >= MIN_LITERAL;
    // A* z AB1 i AX2 to prawie wszystko
    return first.includes('*') || first.includes('%') ? (0, auto_mine_1.literalChars)(first) >= 2 || parents.every(p => (0, auto_mine_1.literalChars)(p.split('.')[0]) < 2) : true;
}
/** Kandydaci do scalenia z par masek: najpierw powstajacy z wielu par, potem o wiekszej liczbie znakow stalych. */
function mergeCandidates(masks, known) {
    const count = new Map();
    for (let i = 0; i < masks.length; i++) {
        for (let j = i + 1; j < masks.length; j++) {
            for (const t of generalize(masks[i], masks[j])) {
                if (!known.has(t) && (count.has(t) || usable(t, [masks[i], masks[j]])))
                    count.set(t, (count.get(t) ?? 0) + 1);
            }
        }
    }
    return [...count].sort((a, b) => b[1] - a[1] || (0, auto_mine_1.literalChars)(b[0]) - (0, auto_mine_1.literalChars)(a[0]) || (a[0] < b[0] ? -1 : 1)).slice(0, MAX_CAND).map(([t]) => t);
}
class Model {
    opt;
    known;
    items = [];
    groups = [];
    np;
    allKb = 0;
    nested = new Map();
    /** zmiana liczby masek grupy w liczonym ruchu */
    delta;
    /** extra: kandydaci poza scaleniami (wezsze maski, maski pierwotnej listy, nowe EXCLUDE) */
    constructor(input, lists, extra, opt, known, tick) {
        this.opt = opt;
        this.known = known;
        const { weights } = opt;
        const put = (text, inc, on) => this.items.push({
            text, inc, on, groups: [], shape: (0, auto_build_1.shapeCost)(text, inc ? weights : { ...weights, start: 0 }, opt.head),
        });
        lists.include.forEach(t => put(t, true, true));
        lists.exclude.forEach(t => put(t, false, true));
        const off = (own, more, inc) => {
            const merge = mergeCandidates(own, new Set(own));
            for (const t of new Set([...merge, ...more.filter(x => !own.includes(x))]))
                put(t, inc, false);
        };
        off(lists.include, extra.include, true);
        off(lists.exclude, extra.exclude, false);
        for (const x of this.items)
            known.add(`${x.inc}${x.text}`);
        const { names, allocKb, pos, neg } = input;
        this.np = pos.length;
        const tree = new auto_tree_1.MaskTree(this.items.map(x => x.text.split('.')));
        const byKey = new Map();
        const total = pos.length + neg.length;
        const scan = (rows, small, done) => {
            for (let x = 0; x < rows.length; x++) {
                if ((x & 0x3fff) === 0)
                    tick((done + x) / total);
                const s = names.start[rows[x]];
                const kb = allocKb[rows[x]];
                if (small)
                    this.allKb += kb;
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
                if (!any)
                    continue;
                // 53 bity; rozne zestawy o tym samym kluczu sa praktycznie niemozliwe
                const key = (h1 >>> 0) * 0x200000 + (h2 & 0x1fffff);
                let g = byKey.get(key);
                if (!g)
                    byKey.set(key, g = { ids: Int32Array.from(ids), inc: 0, exc: 0, ...zero() });
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
                if (x.on)
                    g[x.inc ? 'inc' : 'exc']++;
            }
            this.groups.push(g);
        }
        this.delta = new Int32Array(this.groups.length);
    }
    lists() {
        const of = (inc) => this.items.filter(x => x.on && x.inc === inc).map(x => x.text);
        return { include: of(true), exclude: of(false) };
    }
    /** nowi kandydaci, gdyby liczyc ich z obecnej listy */
    fresh() {
        const l = this.lists();
        const some = (masks, inc) => mergeCandidates(masks, new Set(masks)).some(t => !this.known.has(`${inc}${t}`));
        return some(l.include, true) || some(l.exclude, false);
    }
    totals(skip) {
        const t = { include: 0, exclude: 0, ...zero(), lost: zero() };
        const on = this.items.map(x => x.on && !skip?.(x));
        this.items.forEach((x, i) => {
            if (on[i])
                t[x.inc ? 'include' : 'exclude']++;
        });
        for (const g of this.groups) {
            const inc = skip ? g.ids.some(i => on[i] && this.items[i].inc) : g.inc > 0;
            if (inc)
                add(g.exc > 0 ? t.lost : t, g);
        }
        return t;
    }
    depth() {
        const out = [];
        for (const g of this.groups)
            if (g.inc > 0 && g.exc === 0)
                add(out[g.inc - 1] ??= zero(), g);
        return Array.from(out, x => x ?? zero());
    }
    /** INCLUDE: objete po EXCLUDE; EXCLUDE: wylaczone z objetych INCLUDE. */
    rows(inc) {
        return this.items.filter(x => x.on && x.inc === inc).map(x => {
            const r = { text: x.text, all: zero(), only: zero() };
            for (const k of x.groups) {
                const g = this.groups[k];
                if (inc ? g.exc > 0 : g.inc === 0)
                    continue;
                add(r.all, g);
                if ((inc ? g.inc : g.exc) === 1)
                    add(r.only, g);
            }
            return r;
        });
    }
    /** Czy maska m zawiera sie w c: w danych i jako wzorzec. */
    inside(m, c) {
        const key = m * this.items.length + c;
        let ok = this.nested.get(key);
        if (ok === undefined) {
            ok = this.items[m].groups.every(k => has(this.groups[k].ids, c)) && (0, auto_tree_1.within)(this.items[m].text.split('.'), this.items[c].text.split('.'));
            this.nested.set(key, ok);
        }
        return ok;
    }
    /** maska z listy, w ktorej zawiera sie i; -1 = brak */
    wider(i) {
        const x = this.items[i];
        return this.items.findIndex((y, j) => j !== i && y.on && y.inc === x.inc && this.inside(i, j));
    }
    pSmall(n) {
        return this.np ? this.opt.weights.small * 100 * n / this.np : 0;
    }
    pKb(kb, w) {
        return this.allKb ? this.opt.weights[w] * 100 * kb / this.allKb : 0;
    }
    /** Skutek usuniecia i dodania masek jednego rodzaju. */
    move(addIds, remove) {
        const { weights: w } = this.opt;
        const { inc } = this.items[addIds[0] ?? remove[0]];
        const m = { add: addIds, remove, out: zero(), in: zero(), points: 0 };
        let hidden = 0;
        const touched = [];
        const count = (i, by) => {
            for (const k of this.items[i].groups) {
                if (this.delta[k] === 0)
                    touched.push(k);
                this.delta[k] += by;
            }
        };
        for (const i of addIds)
            count(i, 1);
        for (const i of remove)
            count(i, -1);
        for (const k of touched) {
            const g = this.groups[k];
            const d = this.delta[k];
            this.delta[k] = 0;
            if (d === 0)
                continue;
            const was = inc ? g.inc > 0 : g.exc > 0;
            const now = inc ? g.inc + d > 0 : g.exc + d > 0;
            if (was === now)
                continue;
            if (inc && g.exc > 0)
                hidden += now ? g.largeKb : -g.largeKb;
            else if (inc)
                add(now ? m.in : m.out, g);
            else if (g.inc > 0) {
                hidden += now ? g.largeKb : -g.largeKb;
                add(now ? m.out : m.in, g);
            }
        }
        const shape = (l) => l.reduce((x, i) => x + this.items[i].shape, 0);
        m.points = this.pSmall(m.in.small - m.out.small) - this.pKb(m.in.largeKb - m.out.largeKb, 'large') - this.pKb(hidden, 'risk')
            + (inc ? w.masks : w.exclude) * (remove.length - addIds.length) + shape(remove) - shape(addIds);
        return m;
    }
    /** Scalenia: kandydat zamiast wszystkich masek, ktore sie w nim zawieraja. */
    merges(on) {
        const out = [];
        this.items.forEach((x, c) => {
            if (x.on || x.groups.length === 0)
                return;
            const remove = on.filter(i => this.items[i].inc === x.inc && this.items[i].groups.length > 0 && this.inside(i, c));
            if (remove.length > 1)
                out.push(this.move([c], remove));
        });
        return out;
    }
    /** Maska, ktora obejmuje duze albo ma kilka %, zamiast niej najlepsze z masek spoza listy. */
    swap(i) {
        const x = this.items[i];
        const mine = x.groups.filter(k => this.groups[k].inc === 1 && this.groups[k].exc === 0);
        if (!mine.some(k => this.groups[k].large > 0) && starred(x.text) === x.text)
            return null;
        const others = new Set();
        for (const k of mine)
            if (this.groups[k].small > 0)
                for (const c of this.groups[k].ids)
                    if (this.items[c].inc && !this.items[c].on)
                        others.add(c);
        let best = this.move([], [i]);
        const ok = (m) => m.add.every(c => this.pure(c, m.remove));
        for (let n = 0; n < MAX_SWAP; n++) {
            let next = best;
            for (const c of others) {
                if (best.add.includes(c))
                    continue;
                const m = this.move([...best.add, c], [i]);
                if (m.points > next.points + TINY && ok(m))
                    next = m;
            }
            if (next === best)
                break;
            best = next;
        }
        return best.add.length ? best : null;
    }
    moves() {
        const on = this.items.map((_, i) => i).filter(i => this.items[i].on);
        const out = on.map(i => this.move([], [i]));
        out.push(...this.merges(on));
        for (const i of on) {
            const m = this.items[i].inc ? this.swap(i) : null;
            if (m)
                out.push(m);
        }
        this.items.forEach((x, c) => {
            if (!x.inc && !x.on)
                out.push(this.move([c], []));
        });
        return out;
    }
    purity(i) {
        const c = zero();
        for (const k of this.items[i].groups)
            if (this.groups[k].exc === 0)
                add(c, this.groups[k]);
        return (0, auto_mine_1.purityOf)(c.small, c.large);
    }
    /** nowa maska nie gorsza od progu albo od najgorszej zastepowanej */
    pure(c, remove) {
        return this.purity(c) >= Math.min(this.opt.minPurity, ...remove.map(i => this.purity(i))) - TINY;
    }
    allowed(m, t) {
        const { maxLarge, loss } = this.opt;
        const { inc } = this.items[m.add[0] ?? m.remove[0]];
        const largeKb = t.largeKb + m.in.largeKb - m.out.largeKb;
        const smallKb = t.smallKb + m.in.smallKb - m.out.smallKb;
        if (m.in.large && largeKb > Math.max(t.largeKb, 'kb' in maxLarge ? maxLarge.kb : maxLarge.part * smallKb) + 1e-6)
            return false;
        if (!inc && m.out.small && t.lost.small + m.out.small > Math.max(t.lost.small, loss * (t.small + t.lost.small)) + TINY)
            return false;
        return !inc || !m.in.large || m.add.every(c => this.pure(c, m.remove));
    }
    note(m) {
        const texts = (l) => l.map(x => this.items[x].text).join('  ');
        if (m.remove.length > 1)
            return `zamiast ${m.remove.length}: ${texts(m.remove)}`;
        if (m.remove.length === 0)
            return '';
        if (m.add.length)
            return `na: ${texts(m.add)}`;
        const [i] = m.remove;
        const x = this.items[i];
        const same = this.items.map((_, j) => j).filter(j => j !== i && this.items[j].on && this.items[j].inc === x.inc);
        const wide = this.wider(i);
        if (wide >= 0)
            return `zawiera sie w ${this.items[wide].text}`;
        if (x.groups.length === 0)
            return 'nie pasuje do zadnego zbioru';
        const [row] = this.rows(x.inc).filter(r => r.text === x.text);
        if (!x.inc) {
            if (row.all.small + row.all.large === 0)
                return 'nie wylacza zadnego zbioru objetego INCLUDE';
            if (row.all.large === 0)
                return 'wylacza tylko male zbiory';
            return m.in.large === 0 ? 'jej duze wylaczaja inne EXCLUDE' : '';
        }
        if (row.all.small === 0)
            return row.all.large ? 'nie obejmuje malych zbiorow' : 'wszystkie jej zbiory wylacza EXCLUDE';
        if (m.out.small)
            return `malych tylko w niej: ${m.out.small}`;
        let open = x.groups.filter(k => this.groups[k].exc === 0 && this.groups[k].small > 0);
        const by = [];
        while (open.length) {
            const sum = (j) => open.reduce((s, k) => s + (has(this.groups[k].ids, j) ? this.groups[k].small : 0), 0);
            const best = same.map(j => ({ j, n: sum(j) })).sort((a, b) => b.n - a.n || a.j - b.j)[0].j;
            by.push(this.items[best].text);
            open = open.filter(k => !has(this.groups[k].ids, best));
        }
        return `w danych jej male obejmuja: ${by.slice(0, MAX_NOTE).join('  ')}${by.length > MAX_NOTE ? ` i ${by.length - MAX_NOTE} innych` : ''}`;
    }
    set(i, on) {
        const x = this.items[i];
        x.on = on;
        for (const k of x.groups)
            this.groups[k][x.inc ? 'inc' : 'exc'] += on ? 1 : -1;
    }
    /** Kroki od dajacego najwiecej punktow, az zaden nic nie da; true = bylo scalenie. */
    run(trade, fixes, tick) {
        let merged = false;
        for (;;) {
            tick();
            const t = this.totals();
            const good = this.moves().filter(m => (trade ? m.points > TINY && this.allowed(m, t)
                : m.out.small === 0 && m.in.large === 0 && m.add.length <= m.remove.length && (m.add.length === 0 || m.points > TINY)));
            if (good.length === 0)
                return merged;
            // bez strat najpierw maski zawarte w innych: zbedne takze dla przyszlych nazw, a nie tylko w danych
            const sure = trade ? [] : good.filter(m => m.add.length === 0 && this.wider(m.remove[0]) >= 0);
            const pool = sure.length ? sure : good;
            const top = Math.max(...pool.map(m => m.points));
            // przy tych samych punktach dalsza na liscie
            const [m] = pool.filter(x => x.points > top - TINY).sort((a, b) => Math.max(-1, ...b.remove) - Math.max(-1, ...a.remove));
            const note = this.note(m);
            for (const i of m.remove)
                this.set(i, false);
            for (const i of m.add)
                this.set(i, true);
            merged ||= m.add.length > 0;
            fixes.push({
                side: this.items[m.add[0] ?? m.remove[0]].inc ? 'INCLUDE' : 'EXCLUDE', add: m.add.map(i => this.items[i].text), remove: m.remove.map(i => this.items[i].text),
                note, points: m.points, out: m.out, in: m.in, after: this.totals(), lists: this.lists(),
            });
        }
    }
    /** Scalenia INCLUDE, ktore wpuszczaja duze: od najtanszego (KB duzych na oszczedzona maske). */
    blocked() {
        const best = new Map();
        for (const m of this.merges(this.items.map((_, i) => i).filter(i => this.items[i].on && this.items[i].inc))) {
            if (m.in.large === 0)
                continue;
            const x = this.items[m.add[0]];
            const hidden = zero();
            for (const k of x.groups)
                if (this.groups[k].inc === 0 && this.groups[k].exc > 0)
                    add(hidden, this.groups[k]);
            const b = { text: x.text, remove: m.remove.map(i => this.items[i].text), in: m.in, hidden };
            const key = m.remove.join();
            const old = best.get(key);
            if (!old || b.in.largeKb < old.b.in.largeKb || (b.in.largeKb === old.b.in.largeKb && x.shape < old.shape))
                best.set(key, { b, shape: x.shape });
        }
        const cost = (b) => b.in.largeKb / (b.remove.length - 1);
        return [...best.values()].map(x => x.b).sort((a, b) => cost(a) - cost(b) || b.remove.length - a.remove.length || (a.text < b.text ? -1 : 1));
    }
}
/** czy rosnaca lista zawiera numer */
function has(ids, want) {
    let lo = 0;
    let hi = ids.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (ids[mid] === want)
            return true;
        if (ids[mid] < want)
            lo = mid + 1;
        else
            hi = mid - 1;
    }
    return false;
}
/** D%%%%%% -> D* */
const starred = (t) => t.replace(/([^.*%])%{2,}(?=\.|$)/g, '$1*');
/** Maska i jej luzniejsze zapisy: D*, koniec albo jeden kwalifikator (za head poczatkowymi) zastapiony **. */
function looser(text, head) {
    const q = text.split('.');
    const out = [q];
    for (let i = head; i < q.length; i++) {
        out.push([...q.slice(0, i), '**', ...q.slice(i + 1)]);
        // po samych poczatkowych kwalifikatorach byloby to z powrotem cala maska
        if (i > head)
            out.push([...q.slice(0, i), '**']);
    }
    const texts = out.map(x => x.filter((y, i) => y !== '**' || x[i - 1] !== '**').join('.'));
    return [...new Set([...texts, ...texts.map(starred)])].filter(t => t.length <= auto_mine_1.MAX_LEN);
}
/** Wezsze maski dla masek z duzymi (szukane w ich zbiorach) i nowe EXCLUDE. */
function extras(input, lists, dirty, opt, tick) {
    const { names, pos, neg } = input;
    const total = dirty.reduce((x, r) => x + r.all.largeKb, 0);
    const list = dirty.filter(r => r.all.large > 0 && r.all.small > 0 && r.all.largeKb >= MIN_DIRTY * total).sort((a, b) => b.all.largeKb - a.all.largeKb).slice(0, MAX_DIRTY);
    const out = new Set([...lists.include, ...lists.include.map(starred)].filter(t => !(0, auto_acs_1.acsProblem)(t)));
    if (list.length) {
        const tree = new auto_tree_1.MaskTree(list.map(r => r.text.split('.')));
        const exc = lists.exclude.length ? new auto_tree_1.MaskTree(lists.exclude.map(m => m.split('.'))) : null;
        const rows = list.map(() => [[], []]);
        [pos, neg].forEach((from, side) => {
            for (let x = 0; x < from.length; x++) {
                if ((x & 0x3fff) === 0)
                    tick(0.3 * (side + x / from.length) / 2);
                const s = names.start[from[x]];
                const e = s + names.len[from[x]];
                for (const m of tree.match(names.pool, s, e).slice())
                    if (!exc?.match(names.pool, s, e).length)
                        rows[m][side].push(from[x]);
            }
        });
        list.forEach((r, i) => {
            const part = () => tick(0.3 + 0.4 * i / list.length);
            part();
            const quals = r.text.split('.');
            const any = quals.indexOf('**');
            const found = (0, auto_mine_1.mine)({ ...input, pos: Int32Array.from(rows[i][0]), neg: Int32Array.from(rows[i][1]) }, {
                minPurity: opt.minPurity, minCount: Math.max(2, Math.ceil(0.01 * rows[i][0].length)), maxMasks: 2 * MAX_SWAP, maxWild: 3,
                head: any < 0 ? quals : quals.slice(0, any),
            }, { prepare: part, search: () => part, select: () => part });
            for (const { text } of found.masks)
                for (const t of looser(text, any < 0 ? quals.length : any))
                    if (!(0, auto_acs_1.acsProblem)(t) && (0, auto_mine_1.literalChars)(t) >= MIN_LITERAL)
                        out.add(t);
        });
    }
    tick(0.7);
    const ex = total > 0 ? (0, auto_acs_1.findExcludes)(input, lists.include, lists.exclude, { minCount: 2, maxWild: 3, gain: 0.005, loss: opt.loss }, p => tick(0.7 + 0.3 * p)) : null;
    return { include: [...out], exclude: [...new Set([...lists.exclude, ...(ex?.masks ?? []).map(m => m.text).filter(t => !(0, auto_acs_1.acsProblem)(t))])] };
}
function audit(input, lists, opt, tick) {
    let no = 1;
    // przejscia przez dane: pierwsze to szukanie wezszych masek; zwykle 3-5, najwyzej tyle
    const passes = 6;
    const make = (from, l, extra, known) => {
        const base = Math.min(no++, passes - 1);
        return new Model(from, l, extra, opt, known, p => tick((base + 0.9 * p) / passes));
    };
    const improve = (from, model, extra, known, trade, fixes) => {
        let m = model;
        for (let r = 0; m.run(trade, fixes, () => tick(Math.min(1, no / passes))) && r < ROUNDS && m.fresh(); r++)
            m = make(from, m.lists(), extra, known);
        return m;
    };
    const plain = checkRows(input, lists, p => tick(0.5 * p / passes));
    const extra = extras(input, lists, plain, opt, p => tick((0.5 + 0.5 * p) / passes));
    const known = new Set();
    let m = make(input, lists, extra, known);
    const out = {
        before: m.totals(), depth: m.depth(), include: m.rows(true), exclude: m.rows(false),
        pure: pureTotals(m), safe: [], trade: [],
    };
    m = improve(input, m, extra, known, false, out.safe);
    const blocked = m.blocked();
    m = improve(input, m, extra, known, true, out.trade);
    const small = { ...input, neg: new Int32Array(0) };
    const kn = new Set();
    const none = { include: [], exclude: [] };
    const last = improve(small, make(small, { include: lists.include, exclude: [] }, none, kn), none, kn, false, []);
    const used = new Set([...out.safe, ...out.trade].flatMap(f => f.add));
    return { ...out, blocked: blocked.filter(b => !used.has(b.text)), noLarge: last.lists() };
}
/** Maski INCLUDE na danych, po EXCLUDE (bez only). */
function checkRows(input, lists, tick) {
    return (0, auto_check_1.checkMasks)(input, lists.include, lists.exclude, tick).rows.map(r => ({ text: r.text, all: r, only: zero() }));
}
function pureTotals(m) {
    const dirty = new Set(m.rows(true).filter(r => r.all.large > 0).map(r => r.text));
    return m.totals(x => x.inc && dirty.has(x.text));
}
};

// ==================== src/auto-compact.ts
MODULES["./auto-compact"] = function (exports, require, module) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.findCompact = findCompact;
exports.defaultPoint = defaultPoint;
const auto_exclude_1 = require("./auto-exclude");
const auto_mine_1 = require("./auto-mine");
const auto_tree_1 = require("./auto-tree");
const auto_util_1 = require("./auto-util");
/** wpisow w listach kandydatow; przy wiekszej liczbie rosnie prog malych */
const MAX_LIST = 60e6;
/** ile kandydatow jest dokladnie sprawdzanych w jednym kroku */
const MAX_EVAL = 40;
const MAX_FULL = 3;
/** pelna maska EXCLUDE tylko przy takiej liczbie duzych */
const FULL_ROWS = 200000;
const PRICES = [1, 0.5, 0];
class TooMany extends Error {
}
function findCompact(input, opt, stages) {
    const { names, allocKb } = input;
    const deadline = Date.now() + opt.seconds * 1000;
    let allKb = 0;
    for (let i = 0; i < input.pos.length; i++)
        allKb += allocKb[input.pos[i]];
    const out = { small: input.pos.length, large: input.neg.length, smallKb: allKb, points: [], candidates: 0, stopped: false };
    if (input.pos.length < opt.minCount)
        return out;
    // ---- kandydaci INCLUDE
    const head = opt.head ?? [];
    const mineOpt = { minPurity: opt.minPurity, minCount: opt.minCount, maxMasks: 0, maxWild: opt.maxWild, head };
    const q = (0, auto_mine_1.prepare)(input, mineOpt, p => stages.candidates(0.4 * p));
    const search = new auto_mine_1.Search(q, head.join('.'), opt.maxWild, !opt.anyStart);
    const order = (0, auto_mine_1.maskOrder)(q.tokens.text, head);
    const everything = Int32Array.from({ length: q.count }, (_, s) => s);
    let cands = [];
    for (let min = opt.minCount;; min *= 2) {
        cands = [];
        const byCover = new Map();
        let size = 0;
        try {
            search.run(everything, min, true, true, (make, small, large, h1, h2, cover) => {
                if ((0, auto_mine_1.purityOf)(small, large) < opt.minPurity)
                    return false;
                const key = (h1 >>> 0) * 2097152 + (h2 >>> 11);
                const old = byCover.get(key);
                const found = make();
                if (old === undefined || order.rank(found, cands[old].found) < 0) {
                    const list = [];
                    cover(s => list.push(s), true);
                    const c = { found, text: '', seqs: Int32Array.from(list) };
                    if (old === undefined) {
                        byCover.set(key, cands.length);
                        cands.push(c);
                        size += list.length;
                        if (size > MAX_LIST)
                            throw new TooMany();
                    }
                    else {
                        cands[old] = c;
                    }
                }
                // wezsza nie odetnie juz zadnego duzego
                return large === 0;
            }, p => stages.candidates(0.4 + 0.6 * p, `masek: ${(0, auto_util_1.thousands)(cands.length)}`));
            break;
        }
        catch (e) {
            if (!(e instanceof TooMany))
                throw e;
        }
    }
    out.candidates = cands.length;
    if (cands.length === 0)
        return out;
    // ---- zbiory objete ktorymkolwiek kandydatem
    const any = new Uint8Array(q.count);
    for (const c of cands)
        for (let x = 0; x < c.seqs.length; x++)
            any[c.seqs[x]] = 1;
    const pick = (rows, seq) => {
        const ids = Array.prototype.filter.call(Int32Array.from(rows, (_, i) => i), (i) => seq[i] >= 0 && any[seq[i]]);
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
    const space = nl ? new auto_exclude_1.ExcludeSpace({ names, allocKb, pos: sRow, neg: lRow }, head, 0.1 * opt.exGain * total, 3, tickEx) : null;
    const tick = stages.select();
    const limit = (smallKb) => ('kb' in opt.maxLarge ? opt.maxLarge.kb : opt.maxLarge.part * smallKb);
    const fits = (t) => t.largeKb <= limit(t.smallKb) + 1e-6;
    const lossOk = (t) => t.lost <= opt.loss * (t.small + t.lost);
    const late = () => {
        if (Date.now() > deadline)
            out.stopped = true;
        return out.stopped;
    };
    /** 1 = objety i nie wylaczony */
    const masks = (cov, dead) => {
        const useL = new Uint8Array(nl);
        const useS = new Uint8Array(ns);
        const t = { small: 0, large: 0, smallKb: 0, largeKb: 0, lost: 0, rawKb: 0 };
        for (let i = 0; i < ns; i++) {
            if (!cov[sSeq[i]])
                continue;
            if (dead.s[i]) {
                t.lost++;
            }
            else {
                useS[i] = 1;
                t.small++;
                t.smallKb += sKb[i];
            }
        }
        for (let i = 0; i < nl; i++) {
            if (!cov[lSeq[i]])
                continue;
            t.rawKb += lKb[i];
            if (!dead.l[i]) {
                useL[i] = 1;
                t.large++;
                t.largeKb += lKb[i];
            }
        }
        return { useL, useS, t };
    };
    const coverOf = (inc) => {
        const cov = new Uint8Array(q.count);
        for (const c of inc)
            for (let x = 0; x < cands[c].seqs.length; x++)
                cov[cands[c].seqs[x]] = 1;
        return cov;
    };
    const deadOf = (exc) => {
        const d = { l: new Uint8Array(nl), s: new Uint8Array(ns) };
        for (const e of exc) {
            for (let i = 0; i < nl; i++)
                d.l[i] |= e.l[i];
            for (let i = 0; i < ns; i++)
                d.s[i] |= e.s[i];
        }
        return d;
    };
    const measure = (x) => masks(coverOf(x.inc), deadOf(x.exc)).t;
    // ---- pelne maski EXCLUDE sa drogie
    let fullLeft = 0;
    /** INCLUDE inc z EXCLUDE exc i najmniejsza liczba nowych, zeby zmiescic sie w granicy; enough: kiedy dalej nie warto */
    const complete = (inc, exc, enough) => {
        const added = [];
        const cov = coverOf(inc);
        const dead = deadOf(exc);
        for (;;) {
            const { useL, useS, t } = masks(cov, dead);
            if (!lossOk(t))
                return { short: Infinity };
            if (fits(t))
                return { added, t };
            const short = t.largeKb - limit(t.smallKb);
            if (!space || enough(t, added.length) || inc.length + exc.length + added.length >= opt.maxMasks)
                return { short };
            const minKb = opt.exGain * t.rawKb;
            const w = space.weigh(useL, useS);
            const maxLoss = Math.floor(opt.loss * (t.small + t.lost) + 1e-9) - t.lost;
            const combo = space.best(w, { maxLoss, minKb, minCount: opt.exMin });
            let text;
            let hit;
            if (combo) {
                text = space.text(combo);
                hit = space.hits(combo);
            }
            else {
                if (fullLeft <= 0 || t.large > FULL_ROWS)
                    return { short };
                fullLeft--;
                const full = space.fullMasks(useL, useS, { minCount: Math.max(opt.exMin, Math.ceil(0.005 * t.large)), minKb, maxMasks: 5, maxWild: Math.min(2, opt.maxWild) }, () => { });
                if (full.length === 0)
                    return { short };
                text = full[0].text;
                hit = space.hitsOf(text);
            }
            added.push({ text, l: hit[0], s: hit[1] });
            for (let i = 0; i < nl; i++)
                dead.l[i] |= hit[0][i];
            for (let i = 0; i < ns; i++)
                dead.s[i] |= hit[1][i];
        }
    };
    // ---- wolne male i duze na ciag nazw, bez objetych wybranymi
    const free = (cov, dead) => {
        const f = { n: new Float64Array(q.count), kb: new Float64Array(q.count), large: new Float64Array(q.count) };
        for (let i = 0; i < ns; i++) {
            if (cov[sSeq[i]] || dead.s[i])
                continue;
            f.n[sSeq[i]]++;
            f.kb[sSeq[i]] += sKb[i];
        }
        for (let i = 0; i < nl; i++)
            if (!cov[lSeq[i]] && !dead.l[i])
                f.large[lSeq[i]] += lKb[i];
        return f;
    };
    const snapshots = [];
    const greedy = (price, from, to) => {
        let x = { inc: [], exc: [] };
        /** kandydat, ktorego nie dalo sie zmiescic: ile KB zabraklo i ile bylo wtedy miejsca */
        const failed = new Map();
        while (x.inc.length + x.exc.length < opt.maxMasks && !late()) {
            const dead = deadOf(x.exc);
            const cov = coverOf(x.inc);
            const { t } = masks(cov, dead);
            const f = free(cov, dead);
            const room = limit(t.smallKb) - t.largeKb;
            const list = [];
            cands.forEach((c, i) => {
                let gain = 0;
                let kb = 0;
                let large = 0;
                for (let y = 0; y < c.seqs.length; y++) {
                    gain += f.n[c.seqs[y]];
                    kb += f.kb[c.seqs[y]];
                    large += f.large[c.seqs[y]];
                }
                if (gain < opt.minCount)
                    return;
                const k = t.largeKb + large <= limit(t.smallKb + kb) ? 0 : 1;
                list.push({ c: i, gain, large, bound: gain / (1 + price * k) });
            });
            list.sort((a, b) => b.bound - a.bound || a.large - b.large || a.c - b.c);
            let best = null;
            let evals = 0;
            fullLeft = MAX_FULL;
            for (const l of list) {
                if ((best && l.bound <= best.score) || evals >= MAX_EVAL || late())
                    break;
                const was = failed.get(l.c);
                if (was !== undefined && room < was)
                    continue;
                evals++;
                const score = (after, added) => (after.small - t.small) / (1 + price * added);
                const r = complete([...x.inc, l.c], x.exc, (after, added) => after.small - t.small < opt.minCount * (2 + added) || (best !== null && score(after, added + 1) <= best.score));
                if ('short' in r) {
                    // przerwane, bo jest lepszy: w nastepnym kroku moze sie oplacic
                    if (!best)
                        failed.set(l.c, room + r.short * 0.5);
                    continue;
                }
                const sc = score(r.t, r.added.length);
                // kazda maska pakietu ma dac minCount
                if (r.t.small - t.small < opt.minCount * (1 + r.added.length) || (best && sc <= best.score))
                    continue;
                best = { score: sc, next: { inc: [...x.inc, l.c], exc: [...x.exc, ...r.added] } };
            }
            if (!best)
                break;
            x = best.next;
            snapshots.push(x);
            tick(from + (to - from) * Math.min(1, t.small / input.pos.length), `masek: ${x.inc.length + x.exc.length}`);
        }
    };
    PRICES.forEach((p, i) => greedy(p, 0.2 * i, 0.2 * (i + 1)));
    const count = (x) => x.inc.length + x.exc.length;
    /** dla kazdej liczby masek najlepsze, bez gorszych od krotszych */
    const pareto = (list) => {
        list.sort((a, b) => count(a.x) - count(b.x) || b.t.small - a.t.small || a.t.largeKb - b.t.largeKb);
        const keep = [];
        for (const p of list)
            if (keep.length === 0 || p.t.small > keep[keep.length - 1].t.small)
                keep.push(p);
        return keep;
    };
    // ---- poprawianie
    const polish = (start) => {
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
            const uniq = new Map(x.inc.map(c => [c, 0]));
            for (let s = 0; s < q.count; s++)
                if (times[s] === 1)
                    uniq.set(owner[s], uniq.get(owner[s]) + f.n[s]);
            let next = null;
            const consider = (y, better) => {
                if (y.inc.length === 0)
                    return;
                const u = measure(y);
                if (!fits(u) || !lossOk(u) || !better(u))
                    return;
                if (!next || count(y) < count(next.x) || (count(y) === count(next.x) && u.small > next.t.small))
                    next = { x: y, t: u };
            };
            // zbedny INCLUDE i EXCLUDE
            for (const [c, n] of uniq)
                if (n < opt.minCount)
                    consider({ inc: x.inc.filter(i => i !== c), exc: x.exc }, u => u.small > t.small - opt.minCount);
            for (const e of x.exc)
                consider({ inc: x.inc, exc: x.exc.filter(i => i !== e) }, u => u.small >= t.small);
            if (!next) {
                // jedna maska zamiast innych
                const swaps = [];
                cands.forEach((c, i) => {
                    if (x.inc.includes(i))
                        return;
                    const over = new Map();
                    let gain = 0;
                    for (let y = 0; y < c.seqs.length; y++) {
                        const s = c.seqs[y];
                        if (times[s] === 0)
                            gain += f.n[s];
                        else if (times[s] === 1)
                            over.set(owner[s], (over.get(owner[s]) ?? 0) + f.n[s]);
                    }
                    const drop = x.inc.filter(j => uniq.get(j) - (over.get(j) ?? 0) < opt.minCount);
                    if (drop.length >= 2 || (drop.length === 1 && gain >= 1))
                        swaps.push({ c: i, drop, gain });
                });
                swaps.sort((a, b) => b.drop.length - a.drop.length || b.gain - a.gain);
                fullLeft = 1;
                for (const s of swaps.slice(0, 15)) {
                    if (late())
                        break;
                    const inc = [...x.inc.filter(j => !s.drop.includes(j)), s.c];
                    const r = complete(inc, x.exc, (_t, added) => added + 1 > s.drop.length - 1);
                    if ('short' in r)
                        continue;
                    consider({ inc, exc: [...x.exc, ...r.added] }, u => {
                        const less = s.drop.length - 1 - r.added.length;
                        return (less > 0 && u.small > t.small - opt.minCount) || (less === 0 && u.small > t.small);
                    });
                }
            }
            if (!next)
                break;
            ({ x, t } = next);
        }
        return x;
    };
    let curve = pareto(snapshots.map(x => ({ x, t: measure(x) })));
    const better = [];
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
        cands[c].text = (0, auto_mine_1.specialise)(search, cands[c].seqs, cands[c].found.small, own, order);
    });
    const tree = new auto_tree_1.MaskTree(used.map(c => cands[c].text.split('.')));
    const now = used.map(() => new Set());
    const scan = (rows, seq) => {
        for (let i = 0; i < rows.length; i++) {
            const s = names.start[rows[i]];
            for (const m of tree.match(names.pool, s, s + names.len[rows[i]]))
                now[m].add(seq[i]);
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
function defaultPoint(points, part) {
    if (points.length === 0)
        return null;
    const most = points[points.length - 1].small;
    return points.find(p => p.small >= part * most);
}
};

// ==================== src/auto-config.ts
MODULES["./auto-config"] = function (exports, require, module) {
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONFIG_NAMES = exports.ConfigError = void 0;
exports.readConfig = readConfig;
exports.mergeConfig = mergeConfig;
exports.configText = configText;
/**
 * Ustawienia acs-masks-auto w pliku JSON z komentarzami (--config, --save-config). Komentarze (jak w JS) i przecinek po
 * ostatnim polu sa dozwolone. Pierwszenstwo: wiersz polecen, potem plik, potem wartosci domyslne.
 *
 * Plik zapisany przez skrypt ma wszystkie pola, wiec pole, ktore nie dotyczy trybu pracy (np. weights bez build), jest
 * pomijane; ta sama opcja w wierszu polecen to blad. null = wartosc domyslna.
 */
const node_fs_1 = __importDefault(require("node:fs"));
const auto_build_1 = require("./auto-build");
class ConfigError extends Error {
}
exports.ConfigError = ConfigError;
const checked = (v) => v.check !== undefined;
const search = (v) => !v.build && !v.compact && v.quals === undefined && v.try === undefined && !checked(v);
const combos = (v) => !v.build && !v.compact && !checked(v) && !search(v);
const build = (v) => !!v.build;
const lists = (v) => !!v.build || !!v.compact;
const WEIGHTS = {
    small: 'nagroda za 1% objetych malych (miara dla reszty, zwykle 1)',
    large: 'kara za duze w liscie, za 1% alokacji wszystkich malych; wiecej = mniej duzych',
    masks: 'kara za kazda maske INCLUDE; wiecej = krotsza lista, mniejsze pokrycie',
    exclude: 'kara za kazda maske EXCLUDE',
    risk: 'kara za duze, ktore maski obejmuja, a zdejmuje dopiero EXCLUDE (1% alokacji malych)',
    percent: 'kara za kazdy znak % w masce; wiecej = czesciej D* zamiast D%%%%%%',
    wild: 'kara za kazda * i ** w masce (bez koncowego .**)',
    start: 'kara za maske, ktora zaczyna sie od * albo **; wiecej = rzadziej takie maski',
};
/** Opcje po kolei, w grupach: wszystkie poza help, config i save-config. */
const GROUPS = [
    ['Dane', [
            { name: 'input', kind: 'text', value: null, doc: ['plik CSV z DCOLLECT; plik podany w wierszu polecen ma pierwszenstwo'] },
            { name: 'scope', kind: 'text', value: 'sms=true dsorg=PS', doc: ['ktore zbiory w ogole brac pod uwage; warunki po spacji = wszystkie naraz (AND)', 'np. "sms=true dsorg=PS sg=SGEAV*"'] },
            { name: 'when', kind: 'text', value: 'allocTrk=315 usedTrk<=3', doc: ['ktory zbior jest maly; pozostale z zakresu to duze'] },
            { name: 'prefix', kind: 'text', value: null, doc: ['poczatek kazdej maski, np. "ABC%.**"; null = dowolny'] },
            { name: 'unit', kind: 'text', value: 'GB', doc: ['jednostka alokacji w raportach: MB, GB, TB'] },
        ]],
    ['Tryb pracy: build albo compact albo check albo quals / try; wszystkie wylaczone = zwykle szukanie masek', [
            { name: 'build', kind: 'flag', value: false, doc: ['lista budowana maska po masce wg wag (weights)'] },
            { name: 'compact', kind: 'flag', value: false, doc: ['najmniej masek przy najwiekszym pokryciu (krzywa)'] },
            { name: 'check', kind: 'text', value: null, doc: ['plik FILTLIST (albo lista masek): test calej listy na danych i propozycje krotszej'] },
            { name: 'quals', kind: 'text', value: null, doc: ['zamiast masek: najczestsze kombinacje 1..N kwalifikatorow, N = 1-4'] },
            { name: 'try', kind: 'text', value: null, doc: ['zamiast masek: sprawdza podane kombinacje, np. "PROD+SYSOUT, TMP*"'] },
            { name: 'masks', kind: 'text', value: null, doc: ['plik z lista masek do sprawdzenia; nowe maski tylko dla zbiorow spoza niej'], fits: v => search(v) || combos(v) },
        ]],
    ['Granice', [
            { name: 'min-purity', kind: 'text', value: null, doc: ['najmniejsza czesc malych wsrod zbiorow maski, 0-1', 'null = 0.95 (compact: 0.5 przed EXCLUDE, quals i try: bez progu)'] },
            { name: 'min-count', kind: 'text', value: null, doc: ['ile co najmniej malych ma dac maska', 'null = 10 (compact: 0,5% malych)'], fits: v => !checked(v) },
            { name: 'max-masks', kind: 'text', value: 100, doc: ['najwiecej masek (build i compact: INCLUDE i EXCLUDE razem, najwyzej 255)'] },
            { name: 'max-large', kind: 'text', value: '5%', doc: ['ile duzych moze zostac w liscie: % alokacji objetych malych albo np. "200GB" (build, compact, check)'], fits: v => lists(v) || checked(v) },
            { name: 'time', kind: 'text', value: 600, doc: ['limit czasu w sekundach; potem wynik czesciowy (build, compact, quals)'], fits: v => lists(v) || combos(v) },
        ]],
    ['EXCLUDE', [
            { name: 'exclude', kind: 'flag', value: false, doc: ['maski EXCLUDE do znalezionych masek (zwykle szukanie i masks; build i compact dobieraja je same)'], fits: search },
            { name: 'exclude-min', kind: 'text', value: 2, doc: ['ile co najmniej duzych ma wylaczyc maska EXCLUDE'] },
            { name: 'exclude-gain', kind: 'text', value: null, doc: ['jaka czesc alokacji objetych duzych ma wylaczyc EXCLUDE; null = 0.5% (z exclude i compact)'], fits: v => !!v.compact || (search(v) && !!v.exclude) },
            { name: 'exclude-loss', kind: 'text', value: null, doc: ['jaka czesc objetych malych moga razem zabrac EXCLUDE', 'null = 1% (build, compact, check) albo 0% (exclude)'], fits: v => lists(v) || checked(v) || (search(v) && !!v.exclude) },
        ]],
    ['build: maska po masce', [
            { name: 'weights', kind: 'weights', value: null, doc: ['priorytety (build, check); 1 punkt = 1% malych przy small = 1'], fits: v => build(v) || checked(v) },
            { name: 'next', kind: 'text', value: null, doc: ['plik FILTLIST, do ktorego kazdy przebieg dopisuje kolejna maske dla zbiorow jeszcze nie objetych', 'null = cala lista od nowa'], fits: build },
            { name: 'steps', kind: 'text', value: 1, doc: ['z next: ile masek w jednym przebiegu; "max" = do konca'], fits: v => build(v) && v.next !== undefined && !v.ask },
            { name: 'beam', kind: 'text', value: 8, doc: ['ile wersji maski naraz; wiecej = dluzej'], fits: build },
            { name: 'rounds', kind: 'text', value: 2, doc: ['ile razy najwyzej druga runda, czyli maski budowane od nowa (nie z next)'], fits: v => build(v) && v.next === undefined },
            { name: 'ask', kind: 'flag', value: false, doc: ['pytanie po kazdej masce'], fits: build },
            { name: 'what-if', kind: 'flag', value: false, doc: ['takze wyniki dla zmienionych wag (7 razy dluzej; nie z next)'], fits: v => build(v) && v.next === undefined },
            { name: 'log', kind: 'text', value: null, doc: ['plik na dziennik krokow; null = na ekran'], fits: build },
        ]],
    ['compact', [
            { name: 'pick', kind: 'text', value: null, doc: ['punkt krzywej: najwyzej N masek albo "max"; null = najmniej masek z pokryciem od 95% najwiekszego'], fits: v => !!v.compact },
            { name: 'any-start', kind: 'flag', value: false, doc: ['INCLUDE moze zaczynac sie od ** i *'], fits: v => !!v.compact },
        ]],
    ['Ksztalt masek, quals i try', [
            { name: 'wild', kind: 'text', value: 3, doc: ['ile * i ** w masce (nie w build i check)'], fits: v => !build(v) && !checked(v) },
            { name: 'partial', kind: 'text', value: 3, doc: ['ile znakow stalych ma miec kwalifikator niepelny (ABC*), 2-7; 0 = tylko pelne (build, quals, try)'], fits: v => build(v) || combos(v) },
            { name: 'top', kind: 'text', value: 20, doc: ['wierszy w kazdej tabeli (quals)'], fits: combos },
        ]],
    ['Wyniki', [
            { name: 'verify', kind: 'text', value: null, doc: ['drugi CSV (np. nowszy) do sprawdzenia listy (build, compact)'], fits: lists },
            { name: 'out', kind: 'text', value: null, doc: ['CSV z maskami'] },
            { name: 'filtlist', kind: 'text', value: null, doc: ['FILTLIST do rutyny ACS, za kazdym razem od nowa (nie z next, quals, try)'], fits: v => !combos(v) && !(build(v) && v.next !== undefined) },
            { name: 'apply', kind: 'text', value: null, doc: ['z check: propozycje wprowadzane do filtlist i tests: "safe" = bez strat (null), "all", N = pierwsze N, 0 = zadnej'], fits: v => checked(v) && (v.filtlist !== undefined || v.tests !== undefined) },
            { name: 'tests', kind: 'text', value: null, doc: ['testy ISMF do masek, wejscie IEBUPDTE (nie z quals i try)'], fits: v => !combos(v) },
            { name: 'per-mask', kind: 'text', value: 1, doc: ['testow kazdego rodzaju na maske'] },
            { name: 'test-prefix', kind: 'text', value: 'ACM', doc: ['prefiks memberow testow, 1-4 litery'] },
        ]],
];
const FIELDS = GROUPS.flatMap(([, f]) => f);
const MODES = ['build', 'compact', 'check', 'quals', 'try'];
/** nazwy opcji w pliku (bez input to dokladnie opcje wiersza polecen) */
exports.CONFIG_NAMES = FIELDS.map(f => f.name);
/** Komentarze i przecinki przed nawiasem zamykajacym zamienione na spacje (te same pozycje). */
function plainJson(text) {
    const blank = (t) => t.replace(/[^\n]/g, ' ');
    return text.replace(/"(?:[^"\\\n]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, t => (t[0] === '"' ? t : blank(t)))
        .replace(/"(?:[^"\\\n]|\\.)*"|,(?=\s*[}\]])/g, t => (t[0] === '"' ? t : ' '));
}
/** Pola z pliku; null = nieustawione. */
function readConfig(file) {
    const text = plainJson(node_fs_1.default.readFileSync(file, 'utf-8').replace(/^\ufeff/, ' '));
    const fail = (msg) => new ConfigError(`${file}: ${msg}`);
    const SLASH = 'w sciezkach pisz / albo \\\\ zamiast \\';
    let data;
    try {
        data = JSON.parse(text);
    }
    catch (e) {
        const { message } = e;
        const at = /position (\d+)/.exec(message);
        const where = at ? ` (wiersz ${text.slice(0, Number(at[1])).split('\n').length})` : '';
        throw fail(`niepoprawny JSON${where}: ${message}${/escaped character/i.test(message) ? `; ${SLASH}` : ''}`);
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data))
        throw fail('oczekiwano obiektu { ... }');
    const out = {};
    for (const [name, v] of Object.entries(data)) {
        const f = FIELDS.find(x => x.name === name);
        if (!f)
            throw fail(`nieznane pole "${name}" (dozwolone: ${exports.CONFIG_NAMES.join(' ')})`);
        if (v === null)
            continue;
        // "C:\temp" to tabulator i "emp"
        if (typeof v === 'string' && /[\x00-\x1f]/.test(v))
            throw fail(`"${name}": niedozwolony znak; ${SLASH}`);
        if (f.kind === 'flag') {
            if (typeof v !== 'boolean')
                throw fail(`"${name}": oczekiwano true albo false`);
            out[name] = v;
        }
        else if (f.kind === 'weights' && typeof v === 'object' && !Array.isArray(v)) {
            const list = Object.entries(v).filter(([, x]) => x !== null);
            for (const [k, x] of list) {
                if (!Object.hasOwn(auto_build_1.POINTS, k))
                    throw fail(`weights: nieznana waga "${k}" (dozwolone: ${Object.keys(auto_build_1.POINTS).join(' ')})`);
                if (typeof x !== 'number' || x < 0)
                    throw fail(`weights: "${k}" - oczekiwano liczby od 0`);
            }
            out[name] = list.map(([k, x]) => `${k}=${x}`).join(' ');
        }
        else if (typeof v === 'string' || typeof v === 'number') {
            out[name] = String(v);
        }
        else {
            throw fail(`"${name}": oczekiwano ${f.kind === 'weights' ? 'obiektu z wagami' : 'tekstu albo liczby'}`);
        }
    }
    return out;
}
/**
 * Opcje z wiersza polecen i z pliku. Tryb podany w wierszu polecen zastepuje tryb z pliku; pola z pliku, ktore nie dotycza
 * trybu, odpadaja (skipped: ustawione inaczej niz domyslnie; all: razem z nimi, do zapisu). Wagi z wiersza polecen zmieniaja tylko podane.
 */
function mergeConfig(cli, file) {
    const ownMode = MODES.some(m => cli[m] !== undefined);
    const all = { ...file };
    if (ownMode)
        for (const m of MODES)
            delete all[m];
    for (const [k, v] of Object.entries(cli))
        if (v !== undefined)
            all[k] = k === 'weights' && file.weights ? `${file.weights} ${v}` : v;
    const out = { ...all };
    const skipped = [];
    for (const f of FIELDS) {
        if (all[f.name] === undefined || cli[f.name] !== undefined || !f.fits || f.fits(all))
            continue;
        delete out[f.name];
        // wartosc domyslna, jak w pliku zapisanym przez skrypt, nic nie znaczy; wagi sa tam zawsze
        if (!ownMode && f.kind !== 'weights' && String(all[f.name]) !== String(f.value))
            skipped.push(f.name);
    }
    return { values: out, all, skipped };
}
/** Plik ustawien: kazde pole z komentarzem; v = obecne wartosci, weights = obecne wagi. */
function configText(v, weights) {
    const out = ['// Ustawienia acs-masks-auto.cjs.  Uruchomienie: node acs-masks-auto.cjs --config ten_plik',
        '// Opcja w wierszu polecen ma pierwszenstwo przed plikiem. null = wartosc domyslna.',
        '// Pola, ktore nie dotycza trybu pracy, sa pomijane. W sciezkach pisz / albo \\\\ zamiast \\.', '{'];
    const value = (f) => {
        const x = v[f.name];
        if (x === undefined)
            return f.value;
        // liczby bez cudzyslowow
        return typeof x === 'string' && typeof f.value !== 'string' && String(Number(x)) === x && /^[0-9.]+$/.test(x) ? Number(x) : x;
    };
    const last = FIELDS[FIELDS.length - 1];
    for (const [title, fields] of GROUPS) {
        out.push(...(out[out.length - 1] === '{' ? [] : ['']), `  // ---- ${title}`);
        for (const f of fields) {
            out.push('', ...f.doc.map(d => `  // ${d}`));
            const end = f === last ? '' : ',';
            if (f.kind !== 'weights') {
                out.push(`  ${JSON.stringify(f.name)}: ${JSON.stringify(value(f))}${end}`);
                continue;
            }
            const keys = Object.keys(auto_build_1.POINTS);
            out.push(`  "${f.name}": {`);
            keys.forEach((k, i) => out.push(`    // ${WEIGHTS[k]} (domyslnie ${auto_build_1.POINTS[k]})`, `    "${k}": ${weights[k]}${i < keys.length - 1 ? ',' : ''}`));
            out.push(`  }${end}`);
        }
    }
    out.push('}');
    return out.join('\n') + '\n';
}
};

// ==================== src/dataset.ts
MODULES["./dataset"] = function (exports, require, module) {
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CsvReader = exports.CsvError = exports.DCOL_COLUMNS = void 0;
exports.pdDate = pdDate;
exports.julianToEpochDay = julianToEpochDay;
exports.dsorgName = dsorgName;
exports.recfmName = recfmName;
exports.parseCsv = parseCsv;
exports.buildDataSets = buildDataSets;
exports.stripGds = stripGds;
exports.readDataSets = readDataSets;
/**
 * CSV z joba ACMCSV (z/OS): rekordy 'D' (zbior na wolumenie) i 'A' (komponent VSAM -> klaster).
 * Separator ';', pierwszy wiersz naglowka zaczyna sie od 'T;'. Kolumny rekordu D - DCOL_COLUMNS.
 *
 * Zbior wielowolumenowy (kilka rekordow D) -> jeden zbior: przestrzen zsumowana, atrybuty z pierwszego
 * rekordu (najnizszy numer wolumenu). Sciezki 3390 jak w raports/jcl/DCRPTOVR:
 *   alokacja = ROUND(KB * 1024 / 56664), uzycie = W GORE(KB * 1024 / 56664).
 * Komponenty VSAM (.DATA/.INDEX) -> klaster z rekordu A (ACS widzi nazwe klastra), przestrzen zsumowana.
 */
const node_fs_1 = __importDefault(require("node:fs"));
const node_readline_1 = __importDefault(require("node:readline"));
exports.DCOL_COLUMNS = [
    'T', 'DSN', 'VOLSER', 'VOLSQ', 'DSORG', 'RECFM', 'LRECL', 'BLKSZ', 'NEXT', 'FLAG1', 'FLAG2', 'FLAG3', 'FLAG5',
    'ALLKB', 'USEKB', 'ALLKBX', 'USEKBX', 'CREDT', 'LSTRF', 'EXPDT', 'SC', 'MC', 'DC', 'SG', 'CJOB',
];
const TRACK_BYTES = 56664;
class CsvError extends Error {
}
exports.CsvError = CsvError;
const clean = (s) => (s ?? '').replace(/[\x00-\x1f]/g, '').trim();
function int(s, what, line) {
    const t = clean(s);
    if (t === '')
        return 0;
    if (!/^-?[0-9]+$/.test(t))
        throw new CsvError(`wiersz ${line}: ${what} "${t}" nie jest liczba`);
    return Number(t);
}
function hexByte(s, what, line) {
    const t = clean(s);
    if (t === '')
        return 0;
    if (!/^[0-9A-Fa-f]+$/.test(t))
        throw new CsvError(`wiersz ${line}: ${what} "${t}" nie jest HEX`);
    return parseInt(t, 16);
}
/** Data PD jako HEX (RRRRDDDF) -> RRRRDDD; 0 / niepoprawna -> null. */
function pdDate(hex) {
    const t = clean(hex).toUpperCase();
    const m = /^([0-9]{4})([0-9]{3})[0-9A-F]$/.exec(t);
    if (!m)
        return null;
    const year = Number(m[1]);
    const day = Number(m[2]);
    if (year === 0 || day < 1 || day > 366)
        return null;
    return m[1] + m[2];
}
/** RRRRDDD -> liczba dni od 1970-01-01 (UTC). */
function julianToEpochDay(j) {
    const year = Number(j.slice(0, 4));
    const day = Number(j.slice(4));
    return Math.floor(Date.UTC(year, 0, 1) / 86400000) + day - 1;
}
function dsorgName(hex) {
    const v = parseInt(hex.padEnd(4, '0').slice(0, 4), 16) || 0;
    const b0 = v >> 8;
    const b1 = v & 0xff;
    if (b1 & 0x08)
        return 'VS';
    if (b0 & 0x02)
        return 'PO';
    if (b0 & 0x40)
        return 'PS';
    if (b0 & 0x20)
        return 'DA';
    if (b0 & 0x80)
        return 'IS';
    return '';
}
function recfmName(b) {
    const kind = b >> 6;
    if (kind === 0)
        return '';
    let r = kind === 2 ? 'F' : kind === 1 ? 'V' : 'U';
    if (b & 0x10)
        r += 'B';
    if (b & 0x08)
        r += 'S';
    if (b & 0x04)
        r += 'A';
    if (b & 0x02)
        r += 'M';
    return r;
}
/** Znaki sterujace / nieprzeliczalne po transferze (bajty binarne w CSV). */
const BINARY = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\ufffd]/;
const OLD_JOB_HINT = 'CSV zawiera bajty binarne (np. NUL SOH) - pochodzi ze starej wersji joba ACMCSV,'
    + ' ktora zapisywala VOLSQ binarnie; uruchom ACMCSV ponownie (wersja z E_VOLSQ)';
/**
 * Parser CSV linia po linii (strumien): rekordy D i A zbierane w pamieci, tekst pliku nie.
 * Wartosci o malej liczbie roznych wartosci (klasy, wolumen, job) sa wspoldzielone, a nazwa zbioru kopiowana,
 * zeby obiekty nie trzymaly calej linii zrodlowej.
 */
class CsvReader {
    d = [];
    assoc = new Map();
    assocFlag = new Map();
    seenHeader = false;
    binVolsq = 0;
    /** bajty binarne w dotychczas wczytanych liniach (podpowiedz przy bledzie) */
    binarySeen = false;
    pool = new Map();
    lines = 0;
    intern(v) {
        const hit = this.pool.get(v);
        if (hit !== undefined)
            return hit;
        const copy = fresh(v);
        this.pool.set(copy, copy);
        return copy;
    }
    /** Jedna linia pliku (bez znaku konca linii); line - numer od 1. */
    line(raw, line) {
        this.lines = line;
        if (!this.binarySeen && BINARY.test(raw))
            this.binarySeen = true;
        const l = raw.replace(/\s+$/, '');
        if (l === '')
            return;
        const hint = this.binarySeen ? `\n  (${OLD_JOB_HINT})` : '';
        const f = l.split(';');
        const t = clean(f[0]);
        if (t === 'T') {
            const got = f.map(clean).join(';');
            if (got !== exports.DCOL_COLUMNS.join(';')) {
                throw new CsvError(`wiersz ${line}: inny naglowek niz oczekiwany (wersja joba ACMCSV?)\n`
                    + `  jest:    ${got}\n  oczek.:  ${exports.DCOL_COLUMNS.join(';')}`);
            }
            this.seenHeader = true;
            return;
        }
        if (t === 'A') {
            const comp = clean(f[1]);
            const cl = clean(f[2]);
            if (comp && cl)
                this.assoc.set(fresh(comp), fresh(cl));
            const fl = clean(f[3]);
            if (comp && /^[0-9A-Fa-f]{2}$/.test(fl))
                this.assocFlag.set(fresh(comp), parseInt(fl, 16));
            return;
        }
        if (t !== 'D')
            throw new CsvError(`wiersz ${line}: nieznany typ rekordu "${t}" (oczekiwano T, D, A)${hint}`);
        if (f.length < exports.DCOL_COLUMNS.length) {
            throw new CsvError(`wiersz ${line}: ${f.length} kolumn, oczekiwano ${exports.DCOL_COLUMNS.length}${hint}`);
        }
        const col = (name) => f[COL_INDEX[name]];
        const flag2 = hexByte(col('FLAG2'), 'FLAG2', line);
        const flag5 = hexByte(col('FLAG5'), 'FLAG5', line);
        // przestrzen: 63-bit, gdy wazna, inaczej 31-bit, gdy zwrocona, inaczej 0 (jak DCRPTOVR)
        const allocKb = flag5 & 0x80 ? int(col('ALLKBX'), 'ALLKBX', line)
            : flag2 & 0x08 ? int(col('ALLKB'), 'ALLKB', line) : 0;
        const usedKb = flag5 & 0x40 ? int(col('USEKBX'), 'USEKBX', line)
            : flag2 & 0x04 ? int(col('USEKB'), 'USEKB', line) : 0;
        // VOLSQ binarny (stara wersja ACMCSV): nieznany -> 0, kolejnosc wolumenow jak w DCOLLECT
        const vq = col('VOLSQ') ?? '';
        const volsq = BINARY.test(vq) ? (this.binVolsq++, 0) : int(vq, 'VOLSQ', line);
        const dsn = clean(col('DSN')).toUpperCase();
        if (!dsn)
            throw new CsvError(`wiersz ${line}: pusta nazwa zbioru`);
        const created = pdDate(col('CREDT'));
        const lastRef = pdDate(col('LSTRF'));
        const expdt = pdDate(col('EXPDT'));
        this.d.push({
            dsn: fresh(dsn),
            vol: this.intern(clean(col('VOLSER'))),
            volsq,
            dsorg: dsorgName(clean(col('DSORG'))),
            recfm: recfmName(hexByte(col('RECFM'), 'RECFM', line)),
            lrecl: int(col('LRECL'), 'LRECL', line),
            blksize: int(col('BLKSZ'), 'BLKSZ', line),
            extents: int(col('NEXT'), 'NEXT', line),
            allocKb,
            usedKb,
            created: created && this.intern(created),
            lastRef: lastRef && this.intern(lastRef),
            expdt: expdt && this.intern(expdt),
            sc: this.intern(clean(col('SC'))),
            mc: this.intern(clean(col('MC'))),
            dc: this.intern(clean(col('DC'))),
            sg: this.intern(clean(col('SG'))),
            flag1: hexByte(col('FLAG1'), 'FLAG1', line),
            flag3: hexByte(col('FLAG3'), 'FLAG3', line),
            createJob: this.intern(clean(col('CJOB'))),
        });
    }
    finish() {
        if (!this.seenHeader && this.d.length > 0) {
            throw new CsvError('brak wiersza naglowka (T;DSN;...) - plik nie pochodzi z joba ACMCSV?');
        }
        const warnings = this.binVolsq > 0
            ? [`${this.binVolsq} rekordow D z binarnym VOLSQ - pominiety (kolejnosc wolumenow jak w pliku). ${OLD_JOB_HINT}`]
            : [];
        this.pool.clear();
        return { d: this.d, assoc: this.assoc, assocFlag: this.assocFlag, warnings };
    }
}
exports.CsvReader = CsvReader;
const COL_INDEX = Object.fromEntries(exports.DCOL_COLUMNS.map((c, i) => [c, i]));
/** Kopia napisu niezalezna od linii, z ktorej pochodzi (V8 trzyma wycinki jako odwolania do calosci). */
function fresh(s) {
    return s.length === 0 ? '' : Buffer.from(s, 'utf8').toString('utf8');
}
/** CSV z napisu (testy, male pliki). */
function parseCsv(text) {
    const r = new CsvReader();
    let i = 0;
    let no = 0;
    while (i <= text.length) {
        let j = text.indexOf('\n', i);
        if (j < 0)
            j = text.length;
        const raw = text.slice(i, j);
        r.line(raw.endsWith('\r') ? raw.slice(0, -1) : raw, ++no);
        i = j + 1;
    }
    return r.finish();
}
const trkRound = (kb) => Math.floor((kb * 1024 + TRACK_BYTES / 2) / TRACK_BYTES);
const trkUp = (kb) => Math.floor((kb * 1024 + TRACK_BYTES - 1) / TRACK_BYTES);
/** Wspolna pusta lista komponentow (zbiory bez komponentow VSAM - wiekszosc). Nie modyfikowac. */
const NO_COMPONENTS = [];
/** Rekordy D -> zbiory (jeden na nazwe). Oproznia p.d (rekordy przechodza do zbiorow). */
function buildDataSets(p, opt) {
    const todayDay = Math.floor(Date.UTC(opt.today.getUTCFullYear(), opt.today.getUTCMonth(), opt.today.getUTCDate()) / 86400000);
    // nazwa -> rekord D (zbior na jednym wolumenie) albo lista rekordow; komponenty tylko dla klastrow VSAM
    // (duze CSV: bez obiektu i Set na kazdy zbior)
    const byName = new Map();
    const comps = new Map();
    for (const r of p.d) {
        const cluster = opt.vsamCluster ? p.assoc.get(r.dsn) : undefined;
        const name = cluster ?? r.dsn;
        const e = byName.get(name);
        if (e === undefined)
            byName.set(name, r);
        else if (Array.isArray(e))
            e.push(r);
        else
            byName.set(name, [e, r]);
        if (cluster) {
            let c = comps.get(name);
            if (!c)
                comps.set(name, c = new Set());
            c.add(r.dsn);
        }
    }
    // rekordy D sa juz w byName - lista nie jest dalej potrzebna
    p.d.length = 0;
    const out = [];
    for (const [dsn, e] of byName) {
        // zwalnianie rekordow D w trakcie budowania (duze CSV: nie trzymac rekordow i zbiorow naraz)
        byName.delete(dsn);
        const recs = Array.isArray(e) ? e.sort((a, b) => a.volsq - b.volsq) : [e];
        const components = comps.get(dsn);
        const f = recs[0];
        const allocKb = recs.reduce((s, r) => s + r.allocKb, 0);
        const usedKb = recs.reduce((s, r) => s + r.usedKb, 0);
        const allocTrk = trkRound(allocKb);
        const usedTrk = trkUp(usedKb);
        const quals = dsn.split('.');
        const volsers = recs.length === 1 ? [f.vol] : [...new Set(recs.map(r => r.vol))];
        const vsam = f.dsorg === 'VS' || components !== undefined;
        let aflag = 0;
        for (const r of recs)
            aflag |= p.assocFlag.get(r.dsn) ?? 0;
        const recorg = aflag & 0x80 ? 'KS' : aflag & 0x40 ? 'ES' : aflag & 0x20 ? 'RR' : aflag & 0x10 ? 'LS' : '';
        out.push({
            dsn,
            quals,
            hlq: quals[0],
            llq: quals[quals.length - 1],
            nqual: quals.length,
            vol: f.vol,
            vols: volsers.length,
            dsorg: vsam ? 'VS' : f.dsorg,
            recfm: f.recfm,
            lrecl: f.lrecl,
            blksize: f.blksize,
            extents: recs.reduce((s, r) => s + r.extents, 0),
            allocKb,
            usedKb,
            allocTrk,
            usedTrk,
            freeTrk: Math.max(0, allocTrk - usedTrk),
            created: f.created,
            lastRef: f.lastRef,
            expdt: f.expdt,
            ageDays: f.created ? todayDay - julianToEpochDay(f.created) : null,
            unrefDays: f.lastRef ? todayDay - julianToEpochDay(f.lastRef) : null,
            sc: f.sc,
            mc: f.mc,
            dc: f.dc,
            sg: f.sg,
            sms: (f.flag1 & 0x40) !== 0,
            temp: (f.flag1 & 0x20) !== 0,
            pdse: (f.flag1 & 0x10) !== 0,
            gds: (f.flag1 & 0x08) !== 0,
            ef: (f.flag3 & 0x40) !== 0,
            vsam,
            createJob: f.createJob,
            components: components ? [...components].sort() : NO_COMPONENTS,
            volsers,
            recDsn: f.dsn,
            recorg,
            large: (f.flag3 & 0x08) !== 0,
            hfs: (f.flag3 & 0x80) !== 0,
        });
    }
    out.sort((a, b) => (a.dsn < b.dsn ? -1 : a.dsn > b.dsn ? 1 : 0));
    return out;
}
const GDS_LLQ = /^G\d{4}V\d{2}$/;
/**
 * Nazwy generacji GDG takie, jakie widzi ACS w &DSN: bez ostatniego kwalifikatora GnnnnVnn (zmienia elementy listy;
 * nazwa z DCOLLECT zostaje w recDsn). Generacje jednej bazy maja potem te sama nazwe. Zwraca liczbe zmienionych.
 */
function stripGds(list) {
    let changed = 0;
    for (const ds of list) {
        if (!ds.gds || ds.nqual < 2 || !GDS_LLQ.test(ds.llq))
            continue;
        ds.quals = ds.quals.slice(0, -1);
        ds.dsn = ds.quals.join('.');
        ds.llq = ds.quals[ds.quals.length - 1];
        ds.nqual = ds.quals.length;
        changed++;
    }
    return changed;
}
/**
 * Wczytanie CSV strumieniowo: plik jest czytany porcjami (chunkSize) i przetwarzany linia po linii, wiec nie musi
 * sie zmiescic w pamieci jako tekst (limit napisu V8 to ok. 512 MB). W pamieci zostaja tylko rekordy D i A.
 */
async function readDataSets(file, opt = {}) {
    const size = node_fs_1.default.statSync(file).size;
    const stream = node_fs_1.default.createReadStream(file, { encoding: opt.encoding ?? 'utf-8', highWaterMark: opt.chunkSize ?? 1 << 20 });
    const rl = node_readline_1.default.createInterface({ input: stream, crlfDelay: Infinity });
    const reader = new CsvReader();
    const every = opt.progressEvery ?? 1_000_000;
    let no = 0;
    try {
        for await (const raw of rl) {
            reader.line(raw, ++no);
            if (opt.onProgress && no % every === 0)
                opt.onProgress(no, size ? stream.bytesRead / size : 1);
        }
    }
    finally {
        rl.close();
        stream.destroy();
    }
    const p = reader.finish();
    const dRecords = p.d.length; // przed buildDataSets (oproznia p.d)
    const dataSets = buildDataSets(p, {
        vsamCluster: opt.vsamCluster ?? p.assoc.size > 0,
        today: opt.today ?? new Date(),
    });
    return { dataSets, dRecords, assoc: p.assoc.size, lines: no, warnings: p.warnings };
}
};

// ==================== src/auto-read.ts
MODULES["./auto-read"] = function (exports, require, module) {
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BOOL = exports.STR = exports.NUM = void 0;
exports.readStore = readStore;
/**
 * CSV z joba ACMCSV -> kolumny liczb (bez obiektu na zbior). Znaczenie pol i laczenie rekordow jak w dataset.ts:
 * zbior wielowolumenowy = jeden wiersz (przestrzen zsumowana, atrybuty z najnizszego numeru wolumenu), komponenty
 * VSAM pod nazwa klastra (rekordy A), generacje GDG pod nazwa bez GnnnnVnn. Zapamietywane sa tylko kolumny
 * potrzebne do kryteriow.
 */
const node_fs_1 = __importDefault(require("node:fs"));
const auto_util_1 = require("./auto-util");
const dataset_1 = require("./dataset");
exports.NUM = ['allocTrk', 'usedTrk', 'freeTrk', 'allocKb', 'usedKb', 'extents', 'vols', 'nqual', 'lrecl',
    'blksize', 'ageDays', 'unrefDays'];
exports.STR = ['dsn', 'hlq', 'llq', 'vol', 'dsorg', 'recfm', 'sc', 'mc', 'dc', 'sg', 'createJob'];
exports.BOOL = ['sms', 'temp', 'pdse', 'gds', 'ef', 'vsam'];
const COL = Object.fromEntries(dataset_1.DCOL_COLUMNS.map((c, i) => [c, i]));
const NCOL = dataset_1.DCOL_COLUMNS.length;
const TRACK_BYTES = 56664;
const CHUNK = 1 << 23;
const HINT = '\n  (bajty binarne w CSV, np. NUL SOH: stara wersja joba ACMCSV - uruchom ACMCSV ponownie)';
/** Atrybuty zbioru (z rekordu o najnizszym numerze wolumenu) -> kolumna CSV. */
const ATTR_COLS = {
    flag1: COL.FLAG1, flag3: COL.FLAG3, dsorg: COL.DSORG, recfm: COL.RECFM, lrecl: COL.LRECL, blksize: COL.BLKSZ,
    created: COL.CREDT, lastRef: COL.LSTRF, vol: COL.VOLSER, sc: COL.SC, mc: COL.MC, dc: COL.DC, sg: COL.SG,
    createJob: COL.CJOB,
};
const HEX_ATTR = new Set(['flag1', 'flag3', 'recfm']);
const INT_ATTR = new Set(['lrecl', 'blksize']);
const DATE_ATTR = new Set(['created', 'lastRef']);
/** pole kryterium -> potrzebny atrybut (flag1 jest zawsze) */
const NEEDS = {
    lrecl: 'lrecl', blksize: 'blksize', ageDays: 'created', unrefDays: 'lastRef', vol: 'vol', vols: 'vol',
    dsorg: 'dsorg', vsam: 'dsorg', recfm: 'recfm', sc: 'sc', mc: 'mc', dc: 'dc', sg: 'sg', createJob: 'createJob',
    ef: 'flag3',
};
function readStore(file, fields, tick = () => { }, today = new Date(), chunk = CHUNK) {
    const has = (...f) => f.some(x => fields.has(x));
    const wantUsed = has('usedKb', 'usedTrk', 'freeTrk');
    const wantExt = has('extents');
    const wantVols = has('vols');
    const attrs = [...new Set(['flag1', ...[...fields].flatMap(f => NEEDS[f] ?? [])])];
    const attrCol = attrs.map(a => ATTR_COLS[a]);
    const kind = attrs.map(a => (HEX_ATTR.has(a) ? 0 : INT_ATTR.has(a) ? 1 : DATE_ATTR.has(a) ? 2 : 3));
    const volAt = attrs.indexOf('vol');
    const names = new auto_util_1.Interner();
    const values = new auto_util_1.Interner();
    let cap = 1 << 16;
    let allocKb = new Float64Array(cap);
    let usedKb = new Float64Array(wantUsed ? cap : 0);
    let extents = new Float64Array(wantExt ? cap : 0);
    let volsq = new Int32Array(cap);
    let ord = new Int32Array(cap);
    const attr = attrs.map(() => new Int32Array(cap));
    const at = (a) => attr[attrs.indexOf(a)];
    const ensure = (n) => {
        if (n <= cap)
            return;
        cap = Math.max(cap * 2, n);
        allocKb = (0, auto_util_1.grow)(allocKb, cap);
        volsq = (0, auto_util_1.grow)(volsq, cap);
        ord = (0, auto_util_1.grow)(ord, cap);
        if (wantUsed)
            usedKb = (0, auto_util_1.grow)(usedKb, cap);
        if (wantExt)
            extents = (0, auto_util_1.grow)(extents, cap);
        for (let i = 0; i < attr.length; i++)
            attr[i] = (0, auto_util_1.grow)(attr[i], cap);
    };
    /** wolumeny zbiorow z wiecej niz jednym rekordem (tylko dla pola vols) */
    const multi = new Map();
    const addVol = (row, v) => {
        let s = multi.get(row);
        if (!s)
            multi.set(row, s = new Set([attr[volAt][row]]));
        s.add(v);
    };
    // rekordy A: komponent -> klaster (przetwarzane po wczytaniu wszystkich D)
    const aNames = new auto_util_1.Interner();
    const aComp = new auto_util_1.IntList();
    const aClus = new auto_util_1.IntList();
    let buf = Buffer.allocUnsafe(chunk * 2);
    const fs0 = new Int32Array(NCOL);
    const fe0 = new Int32Array(NCOL);
    const scratch = new Int32Array(attrs.length);
    let lineNo = 0;
    let records = 0;
    let seenHeader = false;
    let binary = false;
    let binVolsq = 0;
    const isCtl = (b) => b < 32 || (b >= 0x7f && b <= 0x9f);
    const fail = (msg) => {
        throw new dataset_1.CsvError(`wiersz ${lineNo}: ${msg}${binary ? HINT : ''}`);
    };
    const raw = (c) => buf.toString('latin1', fs0[c], fe0[c]);
    const clean = (c) => raw(c).replace(/[\x00-\x1f]/g, '').trim();
    const int = (c) => {
        let v = 0;
        for (let i = fs0[c]; i < fe0[c]; i++) {
            const d = buf[i] - 48;
            if (d < 0 || d > 9)
                return slowInt(c);
            v = v * 10 + d;
        }
        return v;
    };
    const slowInt = (c) => {
        const t = clean(c);
        if (t === '')
            return 0;
        if (!/^-?[0-9]+$/.test(t))
            fail(`${dataset_1.DCOL_COLUMNS[c]} "${t}" nie jest liczba`);
        return Number(t);
    };
    const hex = (c) => {
        let v = 0;
        for (let i = fs0[c]; i < fe0[c]; i++) {
            const b = buf[i];
            const d = b >= 48 && b <= 57 ? b - 48 : b >= 65 && b <= 70 ? b - 55 : b >= 97 && b <= 102 ? b - 87 : -1;
            if (d < 0) {
                const t = clean(c);
                if (t === '')
                    return 0;
                if (!/^[0-9A-Fa-f]+$/.test(t))
                    fail(`${dataset_1.DCOL_COLUMNS[c]} "${t}" nie jest HEX`);
                return parseInt(t, 16);
            }
            v = v * 16 + d;
        }
        return v;
    };
    const dates = new Map();
    const date = (c) => {
        const t = raw(c);
        let d = dates.get(t);
        if (d === undefined) {
            const j = (0, dataset_1.pdDate)(t);
            dates.set(t, d = j ? (0, dataset_1.julianToEpochDay)(j) : -1);
        }
        return d;
    };
    /** pole w buforze bez spacji i znakow sterujacych; nazwa zbioru: wielkie litery */
    const squeeze = (c, upper) => {
        let w = fs0[c];
        for (let i = fs0[c]; i < fe0[c]; i++) {
            const b = buf[i];
            if (b > 32)
                buf[w++] = upper && b >= 97 && b <= 122 ? b - 32 : b;
        }
        fe0[c] = w;
    };
    const line = (s, e) => {
        while (e > s && buf[e - 1] <= 32)
            e--;
        if (e === s)
            return;
        let n = 0;
        let p = s;
        while (n < NCOL) {
            let i = p;
            while (i < e && buf[i] !== 59) {
                if (isCtl(buf[i]))
                    binary = true;
                i++;
            }
            fs0[n] = p;
            fe0[n] = i;
            n++;
            if (i >= e)
                break;
            p = i + 1;
        }
        const type = fe0[0] - fs0[0] === 1 ? buf[fs0[0]] : 0;
        if (type === 68)
            record(n, s, e);
        else if (type === 65) {
            if (n < 3)
                return;
            squeeze(1, true);
            squeeze(2, true);
            if (fe0[1] > fs0[1] && fe0[2] > fs0[2]) {
                aComp.push(aNames.add(buf, fs0[1], fe0[1]));
                aClus.push(aNames.add(buf, fs0[2], fe0[2]));
            }
        }
        else {
            const t = clean(0);
            if (t !== 'T')
                fail(`nieznany typ rekordu "${t.slice(0, 20)}" (oczekiwano T, D, A)`);
            const got = buf.toString('latin1', s, e).split(';').map(x => x.trim()).join(';');
            if (got !== dataset_1.DCOL_COLUMNS.join(';')) {
                fail(`inny naglowek niz oczekiwany (wersja joba ACMCSV?)\n  jest:    ${got}\n`
                    + `  oczek.:  ${dataset_1.DCOL_COLUMNS.join(';')}`);
            }
            seenHeader = true;
        }
    };
    const record = (n, s, e) => {
        // puste ostatnie pola: koniec linii moze byc obciety razem ze spacjami, ale nie ze srednikami
        if (n < NCOL)
            fail(`${buf.toString('latin1', s, e).split(';').length} kolumn, oczekiwano ${NCOL}`);
        const flag2 = hex(COL.FLAG2);
        const flag5 = hex(COL.FLAG5);
        const alloc = flag5 & 0x80 ? int(COL.ALLKBX) : flag2 & 0x08 ? int(COL.ALLKB) : 0;
        const used = !wantUsed ? 0 : flag5 & 0x40 ? int(COL.USEKBX) : flag2 & 0x04 ? int(COL.USEKB) : 0;
        let vq = 0;
        let vbin = false;
        for (let i = fs0[COL.VOLSQ]; i < fe0[COL.VOLSQ]; i++)
            if (isCtl(buf[i]))
                vbin = true;
        if (vbin)
            binVolsq++;
        else
            vq = int(COL.VOLSQ);
        squeeze(COL.DSN, true);
        const nameLen = fe0[COL.DSN] - fs0[COL.DSN];
        if (nameLen === 0)
            fail('pusta nazwa zbioru');
        if (nameLen > 255)
            fail(`nazwa zbioru dluzsza niz 255 znakow: ${raw(COL.DSN)}`);
        for (let k = 0; k < attrs.length; k++) {
            const c = attrCol[k];
            if (kind[k] === 0)
                scratch[k] = hex(c);
            else if (kind[k] === 1)
                scratch[k] = int(c);
            else if (kind[k] === 2)
                scratch[k] = date(c);
            else {
                squeeze(c, false);
                scratch[k] = values.add(buf, fs0[c], Math.min(fe0[c], fs0[c] + 255));
            }
        }
        const before = names.size;
        const row = names.add(buf, fs0[COL.DSN], fe0[COL.DSN]);
        const isNew = row === before;
        if (isNew)
            ensure(row + 1);
        else if (wantVols)
            addVol(row, scratch[volAt]);
        allocKb[row] += alloc;
        if (wantUsed)
            usedKb[row] += used;
        if (wantExt)
            extents[row] += int(COL.NEXT);
        if (isNew || vq < volsq[row]) {
            volsq[row] = vq;
            ord[row] = records;
            for (let k = 0; k < attrs.length; k++)
                attr[k][row] = scratch[k];
        }
        records++;
    };
    const fd = node_fs_1.default.openSync(file, 'r');
    try {
        const size = node_fs_1.default.fstatSync(fd).size;
        let keep = 0;
        let read = 0;
        let first = true;
        for (;;) {
            if (keep + chunk > buf.length) {
                const b = Buffer.allocUnsafe((keep + chunk) * 2);
                buf.copy(b, 0, 0, keep);
                buf = b;
            }
            const got = node_fs_1.default.readSync(fd, buf, keep, chunk, null);
            const end = keep + got;
            let s = 0;
            if (first && (end >= 3 || got === 0)) {
                if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf && end >= 3)
                    s = 3;
                first = false;
            }
            else if (first) {
                keep = end;
                continue;
            }
            for (;;) {
                const nl = buf.subarray(0, end).indexOf(10, s);
                if (nl < 0)
                    break;
                lineNo++;
                line(s, nl);
                s = nl + 1;
                if ((lineNo & 0x3fff) === 0)
                    tick(size ? (read - keep + s) / size : 1, `${(0, auto_util_1.thousands)(records)} rekordow`);
            }
            if (got === 0) {
                if (s < end) {
                    lineNo++;
                    line(s, end);
                }
                break;
            }
            read += got;
            buf.copyWithin(0, s, end);
            keep = end - s;
        }
    }
    finally {
        node_fs_1.default.closeSync(fd);
    }
    if (!seenHeader && records > 0) {
        throw new dataset_1.CsvError('brak wiersza naglowka (T;DSN;...) - plik nie pochodzi z joba ACMCSV?');
    }
    const warnings = binVolsq
        ? [`${binVolsq} rekordow D z binarnym VOLSQ - pominiety (kolejnosc wolumenow jak w pliku).${HINT}`] : [];
    // komponenty VSAM -> klaster (dla komponentu z kilkoma rekordami A liczy sie ostatni)
    const clusterOf = new Int32Array(aNames.size).fill(-1);
    for (let i = 0; i < aComp.n; i++)
        clusterOf[aComp.a[i]] = aClus.a[i];
    const recRows = names.size;
    let dead = new Uint8Array(recRows);
    const clusterRows = new Set();
    for (let comp = 0; comp < aNames.size; comp++) {
        const cl = clusterOf[comp];
        if (cl < 0 || cl === comp)
            continue;
        const src = names.find(aNames.pool, aNames.start[comp], aNames.start[comp] + aNames.len[comp]);
        if (src < 0 || src >= recRows)
            continue;
        const before = names.size;
        const dst = names.add(aNames.pool, aNames.start[cl], aNames.start[cl] + aNames.len[cl]);
        const isNew = dst === before;
        clusterRows.add(dst);
        ensure(dst + 1);
        if (dst >= dead.length)
            dead = (0, auto_util_1.grow)(dead, dst + 1);
        if (wantVols) {
            if (isNew)
                attr[volAt][dst] = attr[volAt][src];
            for (const v of multi.get(src) ?? [attr[volAt][src]])
                addVol(dst, v);
        }
        allocKb[dst] += allocKb[src];
        if (wantUsed)
            usedKb[dst] += usedKb[src];
        if (wantExt)
            extents[dst] += extents[src];
        if (isNew || volsq[src] < volsq[dst] || (volsq[src] === volsq[dst] && ord[src] < ord[dst])) {
            volsq[dst] = volsq[src];
            ord[dst] = ord[src];
            for (let k = 0; k < attrs.length; k++)
                attr[k][dst] = attr[k][src];
        }
        dead[src] = 1;
    }
    const rows = names.size;
    let sets = 0;
    for (let i = 0; i < rows; i++)
        if (!dead[i])
            sets++;
    names.freeze();
    // generacje GDG: nazwa bez GnnnnVnn (jak &DSN w ACS)
    const f1 = at('flag1');
    const { pool, start, len } = names;
    const digit = (p) => pool[p] >= 48 && pool[p] <= 57;
    for (let i = 0; i < rows; i++) {
        if (!(f1[i] & 0x08) || len[i] < 10)
            continue;
        const p = start[i] + len[i] - 9;
        if (pool[p] === 46 && pool[p + 1] === 71 && digit(p + 2) && digit(p + 3) && digit(p + 4) && digit(p + 5)
            && pool[p + 6] === 86 && digit(p + 7) && digit(p + 8))
            len[i] -= 9;
    }
    const todayDay = Math.floor(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) / 86400000);
    const allocTrk = (r) => Math.floor((allocKb[r] * 1024 + TRACK_BYTES / 2) / TRACK_BYTES);
    const usedTrk = (r) => Math.floor((usedKb[r] * 1024 + TRACK_BYTES - 1) / TRACK_BYTES);
    const of = (a) => {
        const col = at(a);
        return (r) => col[r];
    };
    const flag = (a, bit) => {
        const col = at(a);
        return (r) => (col[r] & bit) !== 0;
    };
    const days = (a) => {
        const col = at(a);
        return (r) => (col[r] < 0 ? null : todayDay - col[r]);
    };
    const dsorg = () => {
        const col = at('dsorg');
        const text = [];
        return (r) => (clusterRows.size && clusterRows.has(r) ? 'VS' : text[col[r]] ??= (0, dataset_1.dsorgName)(values.text(col[r])));
    };
    return {
        rows, sets, dead, names, allocKb, records, warnings,
        num(f) {
            switch (f) {
                case 'allocTrk': return allocTrk;
                case 'usedTrk': return usedTrk;
                case 'freeTrk': return r => Math.max(0, allocTrk(r) - usedTrk(r));
                case 'allocKb': return r => allocKb[r];
                case 'usedKb': return r => usedKb[r];
                case 'extents': return r => extents[r];
                case 'vols': return r => multi.get(r)?.size ?? 1;
                case 'nqual': return r => {
                    let n = 1;
                    for (let p = start[r]; p < start[r] + len[r]; p++)
                        if (pool[p] === 46)
                            n++;
                    return n;
                };
                case 'lrecl': return of('lrecl');
                case 'blksize': return of('blksize');
                case 'ageDays': return days('created');
                case 'unrefDays': return days('lastRef');
            }
        },
        str(f) {
            switch (f) {
                case 'dsn': return r => names.text(r);
                case 'hlq': return r => {
                    let e = start[r];
                    while (e < start[r] + len[r] && pool[e] !== 46)
                        e++;
                    return (0, auto_util_1.latin1)(pool, start[r], e);
                };
                case 'llq': return r => {
                    const e = start[r] + len[r];
                    let p = e;
                    while (p > start[r] && pool[p - 1] !== 46)
                        p--;
                    return (0, auto_util_1.latin1)(pool, p, e);
                };
                case 'dsorg': return dsorg();
                case 'recfm': {
                    const col = at('recfm');
                    return r => (0, dataset_1.recfmName)(col[r]);
                }
                default: {
                    const col = at(f);
                    return r => values.text(col[r]);
                }
            }
        },
        bool(f) {
            switch (f) {
                case 'sms': return flag('flag1', 0x40);
                case 'temp': return flag('flag1', 0x20);
                case 'pdse': return flag('flag1', 0x10);
                case 'gds': return flag('flag1', 0x08);
                case 'ef': return flag('flag3', 0x40);
                case 'vsam': {
                    const d = dsorg();
                    return r => d(r) === 'VS';
                }
            }
        },
        code(f) {
            return f === 'vol' || f === 'sc' || f === 'mc' || f === 'dc' || f === 'sg' || f === 'createJob' ? of(f) : null;
        },
    };
}
};

// ==================== src/auto.ts
MODULES["./auto"] = function (exports, require, module) {
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OPTIONS = void 0;
exports.parseConds = parseConds;
exports.parseHead = parseHead;
exports.search = search;
exports.check = check;
exports.auditList = auditList;
exports.quals = quals;
exports.compact = compact;
exports.build = build;
exports.report = report;
exports.freshReport = freshReport;
exports.toCsv = toCsv;
exports.checkReport = checkReport;
exports.checkCsv = checkCsv;
exports.excludeReport = excludeReport;
exports.auditReport = auditReport;
exports.auditCsv = auditCsv;
exports.qualsReport = qualsReport;
exports.qualsCsv = qualsCsv;
exports.compactReport = compactReport;
exports.compactCsv = compactCsv;
exports.journalText = journalText;
exports.buildReport = buildReport;
exports.nextReport = nextReport;
exports.readNext = readNext;
exports.parseWeights = parseWeights;
exports.main = main;
/**
 * Szukanie masek DSN wg kryteriow z CSV DCOLLECT (job ACMCSV) i sprawdzanie gotowej listy masek. Wersja jednoplikowa: acs-masks-auto.cjs (bez npm).
 *
 *   node acs-masks-auto.cjs DCOLLECT.CSV [opcje]
 *
 *   --scope "WARUNKI"  zbiory brane pod uwage                  (domyslnie "sms=true dsorg=PS")
 *   --when "WARUNKI"   kryterium: zbior "maly"; reszta = "duze" (domyslnie "allocTrk=315 usedTrk<=3")
 *   --prefix MASKA     poczatek kazdej maski, np. "ABC%.**": ABC%.**, ABC%.X.**, ABC%.**.LIST; liczone sa tylko zbiory
 *                      o tak zaczynajacych sie nazwach (% i * w kwalifikatorach; ** tylko na koncu, mozna pominac)
 *   --min-purity X     najmniejsza czystosc maski 0-1: male / (male + duze)      (domyslnie 0.95)
 *   --min-count N      ile malych, nieobjetych wczesniejszymi maskami, ma dodac maska (domyslnie 10)
 *   --max-masks N      najwiecej masek                                            (domyslnie 100)
 *   --wild N           ile *, ** (poza koncowym) i poczatek* moze miec maska       (domyslnie 3; mniej = szybciej)
 *   --unit MB|GB|TB    jednostka sumy alokacji                                   (domyslnie GB)
 *   --out PLIK         maski takze do pliku CSV (separator ;)
 *
 *   --exclude          maski EXCLUDE dla duzych zbiorow objetych maskami (najwyzej 255), jak najszersze: jeden kwalifikator
 *                      (**.DUMP.**, **.*DUMP*.**), dwa, a na koncu pelna maska
 *   --exclude-min N    ile duzych ma wylaczyc maska EXCLUDE                      (domyslnie 2)
 *   --exclude-gain P   jaka czesc alokacji objetych duzych ma wylaczyc           (domyslnie 0.5%)
 *   --exclude-loss P   jaka czesc objetych malych moga razem zabrac EXCLUDE      (domyslnie 0%, z --compact 1%)
 *   --filtlist PLIK    FILTLIST z INCLUDE (i EXCLUDE) do rutyny ACS
 *   --tests PLIK       testy ISMF do masek (wejscie IEBUPDTE, job ACMTLOAD): DSN i opis = maska; EXCLUDE maska;
 *                      BEZ MASKI - maska = nazwa, ktora do maski z * prawie pasuje (inna liczba kwalifikatorow)
 *   --per-mask N       testow kazdego rodzaju na maske (z **: najkrotsze i najdluzsze nazwy)  (domyslnie 1)
 *   --test-prefix P    prefiks memberow testow, 1-4 litery                       (domyslnie ACM)
 *
 *   --masks PLIK       sprawdza maski z pliku (po jednej w linii albo po przecinku; CSV z --out, FILTLIST): liczby dla kazdej
 *                      maski, pokrycie wszystkich razem, maski zbedne, pary nakladajace sie; potem szuka nowych masek
 *                      dla malych zbiorow, ktorych lista nie obejmuje (zbiory objete lista, male i duze, sa pominiete).
 *                      --prefix: poczatek nowych masek, zaweza tez zbiory, na ktorych sprawdzana jest lista.
 *
 *   --check PLIK       test calej FILTLIST (albo listy masek): ile malych i duzych obejmuje (zbiory, %, alokacja), co wnosza duze
 *                      (lista na samych duzych; lista, gdyby duzych nie bylo), pokrywanie sie masek i propozycje krotszej listy.
 *                      Propozycje to kolejne kroki: najpierw bez strat, potem kosztem malych albo duzych (--weights,
 *                      --max-large, --min-purity, --exclude-loss)
 *   --apply N          z --check: ktore propozycje wprowadzic do --filtlist i --tests: safe = bez strat (domyslnie), all,
 *                      N = pierwsze N, 0 = zadnej
 *
 *   --compact          FILTLIST z jak najmniejsza liczba masek (INCLUDE i EXCLUDE razem) przy jak najwiekszym pokryciu:
 *                      krzywa liczba masek -> pokrycie i wybrany punkt. Domyslnie --min-purity 0.5 (przed EXCLUDE)
 *                      i --min-count 0,5% malych (najmniej 10); INCLUDE zaczyna sie od kwalifikatora, nie od ** ani *
 *   --max-large P      ile duzych (alokacja) moze zostac w liscie: 5% alokacji objetych malych albo np. 200GB (domyslnie 5%)
 *   --pick N           punkt krzywej: najwyzej N masek; max = najwieksze pokrycie
 *                      (domyslnie najmniej masek z pokryciem od 95% najwiekszego)
 *   --any-start        INCLUDE moze zaczynac sie od ** i *
 *   --verify PLIK      sprawdza wybrany punkt na drugim CSV (np. nowszym), osobno dla nazw, ktorych w pierwszym nie bylo
 *
 *   --build            FILTLIST budowana po jednej masce z dwoch rankingow kwalifikatorow (male / duze), z dziennikiem krokow;
 *                      o wyborze decyduja punkty: 1 punkt = 1% malych. Domyslnie --min-purity 0.95 (po EXCLUDE), --min-count 10
 *   --weights WAGI     priorytety, np. "masks=1 large=4"; pozostale domyslne: small=1 large=2 masks=0.5 exclude=0.5 risk=0.1
 *                      percent=0.05 wild=0.02 start=2
 *                        small    za 1% objetych malych          large    za duze w liscie (1% alokacji wszystkich malych)
 *                        masks    za maske INCLUDE               exclude  za maske EXCLUDE
 *                        risk     za duze objete maskami, ktore zdejmuje dopiero EXCLUDE (1% alokacji malych)
 *                        percent  za kazdy %    wild  za kazda * i ** (bez koncowego .**)    start  za maske od * albo **
 *   --beam N           ile wersji maski naraz (wiecej = dluzej)                  (domyslnie 8)
 *   --rounds N         ile razy najwyzej druga runda (maski wyjmowane i budowane od nowa)  (domyslnie 2)
 *   --ask              pytanie po kazdej masce: przyjac, wybrac inna, odrzucic, wpisac wlasna, cofnac (bez drugiej rundy)
 *   --what-if          takze wyniki dla wag masks + exclude, large, start podzielonych i pomnozonych przez 2 (7 razy dluzej)
 *   --log PLIK         dziennik do pliku zamiast na ekran (z --next: dopisywany)
 *   --next PLIK        kolejna maska do FILTLIST z pliku: wczytuje ja (brak pliku = zaczyna od zera), dobiera maske dla malych
 *                      zbiorow, ktorych FILTLIST jeszcze nie obejmuje, i dopisuje INCLUDE (i EXCLUDE) do tego pliku;
 *                      poprzednia wersja zostaje w PLIK.bak. Masek z pliku nie zmienia; granice i punkty dotycza calej listy
 *   --steps N          z --next: ile masek w jednym przebiegu; max = do konca     (domyslnie 1)
 *                      Z --build takze: --max-large, --exclude-min, --exclude-loss (1%), --max-masks, --partial, --verify, --time
 *
 *   --quals N          zamiast masek: najczestsze kombinacje 1..N kwalifikatorow w malych zbiorach (N 1-4), osobna tabela
 *                      dla kazdej liczby; A + B = nazwy **.A.**.B.**, obok najwezsza maska z tymi samymi malymi.
 *                      Takze kwalifikatory niepelne: ABC* *ABC *ABC* AB%% D%%%%%%. Z --masks: tylko zbiory spoza listy
 *   --partial N        ile znakow stalych ma miec kwalifikator niepelny, 2-7; 0 = tylko pelne    (domyslnie 3)
 *   --top N            wierszy w kazdej tabeli                                   (domyslnie 20)
 *   --time SEK         limit czasu --quals i --compact; potem wynik czesciowy                     (domyslnie 600)
 *   --try LISTA        sprawdza podane kombinacje i ich skrocenia, np. "PROD+SYSOUT, LOGDAY, TMP*"
 *                      Z --quals i --try: --min-purity tylko, gdy podane (domyslnie bez progu); --out: CSV z maskami
 *
 *   --config PLIK      ustawienia z pliku JSON (z komentarzami); opcje z wiersza polecen maja pierwszenstwo, a pola, ktore nie
 *                      dotycza trybu pracy, sa pomijane. Plik CSV mozna podac w polu input
 *   --save-config PLIK zapisuje obecne ustawienia (plik i wiersz polecen) z komentarzem do kazdego pola; bez pliku CSV
 *                      na tym konczy, z plikiem pracuje dalej. Istniejacy plik zostaje jako PLIK.bak
 *
 * WARUNKI: pole, operator (= != < <= > >=), wartosc; kilka warunkow po spacji = wszystkie naraz (AND).
 *   Wartosc tekstowa po = / != moze byc maska: dsn=PROD.**  sg=SGEAV*
 * Pola liczbowe: allocTrk usedTrk freeTrk allocKb usedKb extents vols nqual lrecl blksize ageDays unrefDays
 *   tekstowe: dsn hlq llq vol dsorg recfm sc mc dc sg createJob    true / false: sms temp pdse gds ef vsam
 *
 * Postep: pasek na stderr (przekierowane do pliku: jedna linia na etap).
 * Generacje GDG maja nazwe bez GnnnnVnn - tak widzi ja ACS w &DSN. Zbior wielowolumenowy liczony raz.
 * Malych / Duzych GB = suma alokacji (1 GB = 1024 MB). Kod wyjscia: 0 - OK, 1 - blad.
 */
const node_fs_1 = __importDefault(require("node:fs"));
const node_util_1 = require("node:util");
const auto_build_1 = require("./auto-build");
const auto_acs_1 = require("./auto-acs");
const auto_check_1 = require("./auto-check");
const auto_audit_1 = require("./auto-audit");
const auto_compact_1 = require("./auto-compact");
const auto_mine_1 = require("./auto-mine");
const auto_config_1 = require("./auto-config");
const auto_quals_1 = require("./auto-quals");
const auto_read_1 = require("./auto-read");
const auto_tree_1 = require("./auto-tree");
const auto_util_1 = require("./auto-util");
const dataset_1 = require("./dataset");
const mask_1 = require("./mask");
const filtlist_1 = require("./filtlist");
const testcase_1 = require("./testcase");
/** Linia ze standardowego wejscia (synchronicznie: terminal i plik). */
function stdinLine() {
    const buf = Buffer.alloc(1);
    const out = [];
    for (;;) {
        let n = 0;
        try {
            n = node_fs_1.default.readSync(0, buf, 0, 1, null);
        }
        catch (e) {
            const { code } = e;
            if (code === 'EAGAIN') {
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
                continue;
            }
            if (code !== 'EOF')
                throw e;
        }
        if (n === 0)
            return out.length ? Buffer.from(out).toString('utf-8') : null;
        if (buf[0] === 10)
            return Buffer.from(out).toString('utf-8');
        out.push(buf[0]);
    }
}
const STDIO = { out: t => process.stdout.write(t), err: t => process.stderr.write(t), tty: process.stderr.isTTY, line: stdinLine };
const USAGE = 'Uzycie: node acs-masks-auto.cjs DCOLLECT.CSV [--scope "sms=true dsorg=PS"]\n'
    + '        [--when "allocTrk=315 usedTrk<=3"] [--prefix "ABC%.**"] [--min-purity 0.95]\n'
    + '        [--min-count 10] [--max-masks 100] [--wild 3] [--unit GB] [--out maski.csv]\n'
    + '        [--exclude [--exclude-min 2] [--exclude-gain 0.5%] [--exclude-loss 0%]]\n        [--filtlist filtlist.txt] [--tests ACMTEST [--per-mask 1] [--test-prefix ACM]]\n'
    + '   albo: node acs-masks-auto.cjs DCOLLECT.CSV --masks maski.txt [opcje jak wyzej]\n'
    + '         (sprawdza liste i szuka masek dla zbiorow, ktorych ona nie obejmuje)\n'
    + '   albo: node acs-masks-auto.cjs DCOLLECT.CSV --check filtlist.txt [--filtlist nowa.txt [--apply safe]]\n'
    + '         (co obejmuje cala FILTLIST, test na duzych, pokrywanie sie masek, propozycje)\n'
    + '   albo: node acs-masks-auto.cjs DCOLLECT.CSV --compact [--max-large 5%] [--pick N] [--any-start] [--verify NOWSZY.CSV]\n'
    + '         [--filtlist filtlist.txt] (najmniej masek INCLUDE i EXCLUDE, najwieksze pokrycie)\n'
    + '   albo: node acs-masks-auto.cjs DCOLLECT.CSV --build [--weights "masks=1 large=4"] [--ask] [--what-if] [--log dziennik.txt]\n'
    + '         [--verify NOWSZY.CSV] [--filtlist filtlist.txt] (maska po masce, priorytety jako wagi)\n'
    + '   albo: node acs-masks-auto.cjs DCOLLECT.CSV --build --next filtlist.txt [--steps 1] [opcje jak wyzej]\n'
    + '         (kazdy przebieg dopisuje do filtlist.txt kolejna maske dla zbiorow jeszcze nie objetych)\n'
    + '   albo: node acs-masks-auto.cjs DCOLLECT.CSV --quals 4 [--partial 3] [--top 20] [--time 600] [--try "PROD+SYSOUT, TMP*"]\n'
    + '         (najczestsze kombinacje kwalifikatorow; sprawdzanie kwalifikatorow niepelnych)\n'
    + '   albo: node acs-masks-auto.cjs --config ustawienia.json [DCOLLECT.CSV] [opcje]   (ustawienia z pliku)\n'
    + '         node acs-masks-auto.cjs --save-config ustawienia.json [opcje]             (zapis ustawien z opisem pol)\n'
    + `Pola liczbowe: ${auto_read_1.NUM.join(' ')}\n     tekstowe: ${auto_read_1.STR.join(' ')}\n     true / false: ${auto_read_1.BOOL.join(' ')}\n`
    + 'Operatory: = != < <= > >=; kilka warunkow po spacji = wszystkie naraz\n';
const HELP = USAGE + `
Przyklady (DC = DCOLLECT.CSV; w pliku .bat kazdy % podwojnie, w PowerShell apostrofy zamiast cudzyslowow):
  node acs-masks-auto.cjs DC --scope "sms=true dsorg=PS sg=SGEAV*"                 tylko zbiory z wybranych SG
  node acs-masks-auto.cjs DC --when "allocTrk>=315 usedTrk<15"                     inne kryterium malego zbioru
  node acs-masks-auto.cjs DC --when "unrefDays>365" --unit TB                      nieuzywane od roku
  node acs-masks-auto.cjs DC --prefix "ABC%.**"                                    kazda maska zaczyna sie od ABC%.
  node acs-masks-auto.cjs DC --wild 1                                              prostsze maski, szybciej
  node acs-masks-auto.cjs DC --min-purity 1 --min-count 50 --max-masks 20          malo masek, same czyste
  node acs-masks-auto.cjs DC --masks maski.txt --out wynik.csv                     sprawdzenie listy i czego jej brakuje
  node acs-masks-auto.cjs DC --min-purity 0.8 --exclude --filtlist f.txt           szersze maski i EXCLUDE
  node acs-masks-auto.cjs DC --masks f.txt --tests ACMTEST --per-mask 2            testy ISMF do FILTLIST
  node acs-masks-auto.cjs DC --check f.txt                                         test calej FILTLIST i propozycje
  node acs-masks-auto.cjs DC --check f.txt --filtlist nowa.txt                     FILTLIST po propozycjach bez strat
  node acs-masks-auto.cjs DC --check f.txt --filtlist nowa.txt --apply 7           po pierwszych 7 propozycjach
  node acs-masks-auto.cjs DC --compact --verify NOWSZY.CSV                         najmniej masek, sprawdzone na nowszych danych
  node acs-masks-auto.cjs DC --compact --max-large 200GB --pick 12 --filtlist f.txt
  node acs-masks-auto.cjs DC --build --log dziennik.txt --filtlist f.txt           maska po masce, z dziennikiem
  node acs-masks-auto.cjs DC --build --weights "masks=1 large=4"                   mniej masek, jeszcze mniej duzych
  node acs-masks-auto.cjs DC --build --what-if                                     co zmieni kazda waga
  node acs-masks-auto.cjs DC --build --ask                                         kazda maska do zatwierdzenia
  node acs-masks-auto.cjs DC --build --next f.txt                                  kolejna maska dopisana do f.txt
  node acs-masks-auto.cjs DC --build --next f.txt --steps 5 --log dziennik.txt     piec kolejnych masek
  node acs-masks-auto.cjs DC --build --weights "masks=1" --save-config u.json      zapis ustawien (i przebieg)
  node acs-masks-auto.cjs --config u.json                                          przebieg z zapisanych ustawien
  node acs-masks-auto.cjs DC --quals 4                                             najczestsze kombinacje 1-4 kwalifikatorow
  node acs-masks-auto.cjs DC --quals 2 --min-purity 0.95 --top 50                  tylko czyste, do 2 kwalifikatorow
  node acs-masks-auto.cjs DC --quals 3 --masks f.txt                               w zbiorach, ktorych lista nie obejmuje
  node acs-masks-auto.cjs DC --try "PROD+SYSOUT, LOGDAY, TMP*"                     te kombinacje i ich skrocenia
`;
class ArgError extends Error {
}
const isNum = (f) => auto_read_1.NUM.includes(f);
const isBool = (f) => auto_read_1.BOOL.includes(f);
/** "allocTrk=315 usedTrk<=3"; pole bez wartosci (brak daty) nie spelnia warunku. */
function parseConds(text, opt) {
    const list = text.trim().split(/\s+/).filter(Boolean).map((c) => {
        const m = /^([A-Za-z]+)(<=|>=|!=|=|<|>)(.+)$/.exec(c);
        if (!m)
            throw new ArgError(`--${opt}: niepoprawny warunek "${c}" (np. allocTrk=315, bez spacji w srodku)`);
        const [, name, op, value] = m;
        const field = [...auto_read_1.NUM, ...auto_read_1.STR, ...auto_read_1.BOOL].find(f => f.toLowerCase() === name.toLowerCase());
        if (!field)
            throw new ArgError(`--${opt}: nieznane pole "${name}"`);
        if (isNum(field)) {
            const want = Number(value.replace(',', '.'));
            if (!Number.isFinite(want))
                throw new ArgError(`--${opt}: "${c}" - wartosc nie jest liczba`);
            return { field, make: st => numTest(st.num(field), op, want) };
        }
        if (op !== '=' && op !== '!=')
            throw new ArgError(`--${opt}: "${c}" - dla pola ${field} tylko = albo !=`);
        const eq = op === '=';
        if (isBool(field)) {
            if (!/^(true|false)$/i.test(value))
                throw new ArgError(`--${opt}: "${c}" - wartosc true albo false`);
            const want = value.toLowerCase() === 'true';
            return {
                field,
                make: st => {
                    const get = st.bool(field);
                    return r => (get(r) === want) === eq;
                },
            };
        }
        const mask = /[*%]/.test(value) ? (0, mask_1.parseMask)(value) : null;
        const want = value.toUpperCase();
        const ok = (v) => (mask ? (0, mask_1.matches)(mask, v.toUpperCase()) : v.toUpperCase() === want) === eq;
        return { field, make: st => strTest(st, field, ok) };
    });
    return {
        fields: list.map(c => c.field),
        compile: st => {
            const tests = list.map(c => c.make(st));
            return r => {
                for (let i = 0; i < tests.length; i++)
                    if (!tests[i](r))
                        return false;
                return true;
            };
        },
    };
}
function numTest(get, op, want) {
    const cmp = {
        '=': v => v === want, '!=': v => v !== want, '<': v => v < want, '<=': v => v <= want,
        '>': v => v > want, '>=': v => v >= want,
    };
    const f = cmp[op];
    return r => {
        const v = get(r);
        return v !== null && f(v);
    };
}
function strTest(st, field, ok) {
    const get = st.str(field);
    const code = st.code(field);
    if (!code)
        return r => ok(get(r));
    // pole o powtarzajacych sie wartosciach: kazda wartosc porownywana raz
    const memo = [];
    return r => memo[code(r)] ??= ok(get(r));
}
/** "ABC%.**" -> kwalifikatory, od ktorych zaczyna sie kazda maska: ['ABC%']. */
function parseHead(text) {
    const { quals } = (0, mask_1.parseMask)(text);
    if (quals[quals.length - 1] === '**')
        quals.pop();
    if (quals.includes('**'))
        throw new ArgError(`--prefix: "${text}" - ** tylko na koncu`);
    return quals;
}
/** Czy nazwa zaczyna sie od kwalifikatorow pasujacych kolejno do head (na bajtach: miliony nazw). */
function headTest(names, head) {
    const masks = head.map(q => Buffer.from(q, 'latin1'));
    const { pool } = names;
    return row => {
        let b = names.start[row];
        const end = b + names.len[row];
        for (const m of masks) {
            if (b >= end)
                return false;
            let e = b;
            while (e < end && pool[e] !== 46)
                e++;
            if (!qualLike(m, pool, b, e))
                return false;
            b = e + 1;
        }
        return true;
    };
}
/** Kwalifikator maski (% = znak, * = zero lub wiecej znakow) wobec buf[s..e). */
function qualLike(m, buf, s, e) {
    let i = 0;
    let p = s;
    let star = -1;
    let from = 0;
    while (p < e) {
        if (i < m.length && m[i] === 42) {
            star = i++;
            from = p;
        }
        else if (i < m.length && (m[i] === 37 || m[i] === buf[p])) {
            i++;
            p++;
        }
        else if (star >= 0) {
            i = star + 1;
            p = ++from;
        }
        else {
            return false;
        }
    }
    while (i < m.length && m[i] === 42)
        i++;
    return i === m.length;
}
function num(v, name, min, max, int) {
    const x = Number(v.replace(',', '.'));
    if (v.trim() === '' || !Number.isFinite(x) || x < min || x > max || (int && !Number.isInteger(x))) {
        throw new ArgError(`--${name}: niepoprawna wartosc "${v}" (zakres ${min}-${max})`);
    }
    return x;
}
function search(file, scope, when, opt, bar, warn = () => { }) {
    const st = load(file, scope, when, bar, warn);
    const tick = bar.stage('Kryteria i nazwy');
    const { pos, neg } = classify(st, scope, when, opt.head, part => tick(0.1 * part));
    return { ...mineRows(st, pos, neg, opt, bar, (part, info) => tick(0.1 + 0.9 * part, info)), input: { names: st.names, allocKb: st.allocKb, pos, neg } };
}
function mineRows(st, pos, neg, opt, bar, tick) {
    const res = (0, auto_mine_1.mine)({ names: st.names, allocKb: st.allocKb, pos, neg }, opt, {
        prepare: part => tick(part, `malych: ${(0, auto_util_1.thousands)(pos.length)}`),
        search: sequences => {
            bar.done(`malych: ${(0, auto_util_1.thousands)(pos.length)}, duzych: ${(0, auto_util_1.thousands)(neg.length)}, roznych nazw: ${(0, auto_util_1.thousands)(sequences)}`);
            return bar.stage('Szukanie masek');
        },
        select: candidates => {
            bar.done(`sprawdzonych masek: ${(0, auto_util_1.thousands)(candidates)}`);
            return bar.stage('Wybor masek');
        },
    });
    bar.done(`wybrano: ${res.masks.length}`);
    return { inScope: pos.length + neg.length, small: pos.length, masks: res.masks, total: res.total, steps: res.steps };
}
/** Sprawdzenie gotowej listy masek, a potem szukanie masek dla zbiorow, ktorych lista nie obejmuje. */
function check(file, scope, when, masks, excludes, opt, bar, warn = () => { }) {
    const st = load(file, scope, when, bar, warn);
    const tick = bar.stage('Sprawdzanie masek');
    const { pos, neg } = classify(st, scope, when, opt.head, part => tick(0.2 * part));
    const input = { names: st.names, allocKb: st.allocKb, pos, neg };
    const list = (0, auto_check_1.checkMasks)(input, masks, excludes, part => tick(0.2 + 0.8 * part));
    bar.done(`masek: ${masks.length}, malych: ${(0, auto_util_1.thousands)(pos.length)}, duzych: ${(0, auto_util_1.thousands)(neg.length)}`);
    const fresh = mineRows(st, list.rest.pos, list.rest.neg, opt, bar, bar.stage('Nazwy spoza listy'));
    return { list, fresh, input };
}
/** Test calej listy. */
function auditList(file, scope, when, lists, opt, head, bar, warn = () => { }) {
    const st = load(file, scope, when, bar, warn);
    const tick = bar.stage('Sprawdzanie masek');
    const { pos, neg } = classify(st, scope, when, head, part => tick(0.2 * part));
    const input = { names: st.names, allocKb: st.allocKb, pos, neg };
    const list = (0, auto_check_1.checkMasks)(input, lists.include, lists.exclude, part => tick(0.2 + 0.8 * part));
    bar.done(`masek: ${lists.include.length + lists.exclude.length}, malych: ${(0, auto_util_1.thousands)(pos.length)}, duzych: ${(0, auto_util_1.thousands)(neg.length)}`);
    const result = (0, auto_audit_1.audit)(input, lists, opt, bar.stage('Propozycje'));
    bar.done(`bez strat: ${result.safe.length}, inne: ${result.trade.length}`);
    const after = [{ name: 'po propozycjach bez strat', fixes: result.safe }, { name: 'po wszystkich propozycjach', fixes: result.trade }]
        .filter(x => x.fixes.length).map(({ name, fixes }) => {
        const l = fixes[fixes.length - 1].lists;
        return { name, list: (0, auto_check_1.checkMasks)(input, l.include, l.exclude, () => { }) };
    });
    let largeKb = 0;
    for (const r of neg)
        largeKb += st.allocKb[r];
    return { list, result, largeKb, after, input };
}
/** o ile czesci wiecej malych musi dac szersza kombinacja, zeby byla obok szczegolowszej */
const MIN_GAIN = 0.02;
/** Najczestsze kombinacje kwalifikatorow malych zbiorow i sprawdzenie podanych. */
function quals(file, scope, when, q, opt, bar, warn = () => { }) {
    const st = load(file, scope, when, bar, warn);
    const tick = bar.stage('Kryteria');
    let { pos, neg } = classify(st, scope, when, opt.head, p => tick(p));
    bar.done(`malych: ${(0, auto_util_1.thousands)(pos.length)}, duzych: ${(0, auto_util_1.thousands)(neg.length)}`);
    let skipped = null;
    if (q.masks.length) {
        const before = { small: pos.length, large: neg.length };
        const { rest } = (0, auto_check_1.checkMasks)({ names: st.names, allocKb: st.allocKb, pos, neg }, q.masks, q.excludes, bar.stage('Lista masek'));
        ({ pos, neg } = rest);
        skipped = { small: before.small - pos.length, large: before.large - neg.length };
        bar.done(`spoza listy malych: ${(0, auto_util_1.thousands)(pos.length)}, duzych: ${(0, auto_util_1.thousands)(neg.length)}`);
    }
    const input = { names: st.names, allocKb: st.allocKb, pos, neg };
    let combos = null;
    if (q.quals) {
        combos = (0, auto_quals_1.findCombos)(input, { ...q.quals, partial: q.partial, minGain: MIN_GAIN, minCount: opt.minCount, minPurity: opt.minPurity, head: opt.head }, bar.stage('Kombinacje'));
        bar.done(`sprawdzonych: ${(0, auto_util_1.thousands)(combos.nodes)}`);
    }
    let tries = [];
    if (q.tries.length) {
        tries = (0, auto_quals_1.tryCombos)(input, q.tries, q.partial, opt.head ?? [], bar.stage('Podane kombinacje'));
        bar.done(`sprawdzonych: ${tries.reduce((s, t) => s + t.length, 0)}`);
    }
    return { skipped, small: pos.length, large: neg.length, combos, tries };
}
const DEFAULT_PART = 0.95;
/** Wynikowe maski na drugim pliku: wszystkie zbiory i te, ktorych nazw nie bylo w pierwszym. */
function verify(input, second, include, exclude) {
    const known = new auto_util_1.Interner();
    for (const rows of [input.pos, input.neg]) {
        for (let x = 0; x < rows.length; x++)
            known.add(input.names.pool, input.names.start[rows[x]], input.names.start[rows[x]] + input.names.len[rows[x]]);
    }
    const isNew = (r) => known.find(second.names.pool, second.names.start[r], second.names.start[r] + second.names.len[r]) < 0;
    return {
        small: second.pos.length, large: second.neg.length,
        list: (0, auto_check_1.checkMasks)(second, include, exclude, () => { }),
        fresh: (0, auto_check_1.checkMasks)({ ...second, pos: second.pos.filter(isNew), neg: second.neg.filter(isNew) }, include, exclude, () => { }),
    };
}
/** Krzywa --compact, wybrany punkt i jego sprawdzenie na drugim pliku. */
function compact(file, scope, when, c, opt, bar, warn = () => { }) {
    const read = (name, label) => {
        const st = load(name, scope, when, bar, warn);
        const tick = bar.stage(label);
        const { pos, neg } = classify(st, scope, when, opt.head, p => tick(p));
        bar.done(`malych: ${(0, auto_util_1.thousands)(pos.length)}, duzych: ${(0, auto_util_1.thousands)(neg.length)}`);
        return { names: st.names, allocKb: st.allocKb, pos, neg };
    };
    const input = read(file, 'Kryteria');
    const minCount = c.minCount ?? Math.max(10, Math.ceil(0.005 * input.pos.length));
    const result = (0, auto_compact_1.findCompact)(input, {
        minPurity: opt.minPurity, minCount, maxMasks: opt.maxMasks, maxWild: opt.maxWild, head: opt.head, anyStart: c.anyStart,
        maxLarge: c.maxLarge, loss: c.loss, exMin: c.exMin, exGain: c.exGain, seconds: c.seconds,
    }, {
        candidates: bar.stage('Maski'),
        excludes: n => {
            bar.done(`masek: ${(0, auto_util_1.thousands)(n)}`);
            return bar.stage('Nazwy EXCLUDE');
        },
        select: () => {
            bar.done();
            return bar.stage('Dobor listy');
        },
    });
    bar.done(`punktow krzywej: ${result.points.length}`);
    const { points } = result;
    const chosen = c.pick === null ? (0, auto_compact_1.defaultPoint)(points, DEFAULT_PART)
        : points.filter(p => p.include.length + p.exclude.length <= c.pick).pop() ?? null;
    if (points.length && !chosen)
        throw new ArgError(`--pick: najmniejszy punkt ma masek: ${points[0].include.length + points[0].exclude.length}`);
    const list = chosen && (0, auto_check_1.checkMasks)(input, chosen.include, chosen.exclude, () => { });
    const verified = chosen && c.verify !== undefined ? verify(input, read(c.verify, 'Kryteria'), chosen.include, chosen.exclude) : null;
    return { result, minCount, chosen, list, verified, input };
}
/** Zmiany wag w --what-if. */
const VARIANTS = [
    { name: 'masks, exclude', keys: ['masks', 'exclude'], by: 0.5 }, { name: 'masks, exclude', keys: ['masks', 'exclude'], by: 2 },
    { name: 'large', keys: ['large'], by: 0.5 }, { name: 'large', keys: ['large'], by: 2 },
    { name: 'start', keys: ['start'], by: 0.5 }, { name: 'start', keys: ['start'], by: 2 },
];
/** Lista budowana po jednej masce. */
function build(file, scope, when, o, extra, bar, io) {
    const read = (name) => {
        const st = load(name, scope, when, bar, io.err);
        const tick = bar.stage('Kryteria');
        const { pos, neg } = classify(st, scope, when, o.head, p => tick(p));
        bar.done(`malych: ${(0, auto_util_1.thousands)(pos.length)}, duzych: ${(0, auto_util_1.thousands)(neg.length)}`);
        return { names: st.names, allocKb: st.allocKb, pos, neg };
    };
    const input = read(file);
    const one = (label, opt, ask) => {
        const r = (0, auto_build_1.buildList)(input, opt, {
            names: bar.stage('Kwalifikatory'),
            build: () => {
                bar.done();
                const tick = bar.stage(label);
                // pytania zamiast paska
                if (ask)
                    bar.abort();
                return tick;
            },
        }, ask, extra.by);
        bar.done(`masek: ${r.include.length + r.exclude.length}, punkty: ${points(r.points)}`);
        return r;
    };
    const result = one('Budowanie', o, extra.ask ? (list, no, now, last) => askMask(list, no, now, last, input.pos.length, o, extra.unit, io) : undefined);
    const list = (0, auto_check_1.checkMasks)(input, result.include, result.exclude, () => { });
    const variants = extra.whatIf ? VARIANTS.map(v => {
        const weights = { ...o.weights };
        for (const k of v.keys)
            weights[k] *= v.by;
        const name = `${v.name}  x${String(v.by).replace('.', ',')}`;
        return { name, result: one(name, { ...o, weights }) };
    }) : [];
    const verified = extra.verify !== undefined && result.include.length ? verify(input, read(extra.verify), result.include, result.exclude) : null;
    return { result, list, verified, variants, input };
}
const points = (x) => `${x < 0 ? '' : '+'}${x.toFixed(2).replace('.', ',')}`;
/** --ask: jedno pytanie, powtarzane do poprawnej odpowiedzi. */
function askMask(list, no, now, last, small, o, u, io) {
    const out = [''];
    if (last)
        out.push(`Przyjeta: ${last.text}   punkty ${points(last.points)}`);
    out.push(`Lista: ${part(now.small, small)} malych (${now.small} z ${small}), duzych ${now.large} (${inUnit(now.largeKb, u)} ${u})`, '');
    const cap = 'kb' in o.maxLarge ? o.maxLarge.kb : o.maxLarge.part * now.smallKb;
    if (now.largeKb > cap + 1e-6)
        out.push('Uwaga: lista przekracza --max-large, wiec nie ma dalszych propozycji (c = cofnij ostatnia).', '');
    out.push(list.length ? `Maska ${no} - propozycje:` : `Maska ${no}: zadna nie daje punktow w tych granicach.`);
    list.forEach((p, i) => {
        out.push(`  ${i + 1}. ${p.text.padEnd(44)} nowych malych ${p.gain}, duzych ${p.large}, purity ${pct(p.small / (p.small + p.large))}, punkty ${points(p.points)}`);
        for (const e of p.exclude)
            out.push(`       EXCLUDE ${e}`);
    });
    io.err(`${out.join('\n')}\n`);
    for (;;) {
        io.err(`${list.length ? 'Enter = 1, numer = inna, n = odrzuc 1, ' : ''}maska = wpisana, c = cofnij ostatnia, k = koniec: `);
        const a = io.line?.()?.trim();
        if (a === undefined) {
            io.err('\n');
            return { stop: true };
        }
        if (a === '' && list.length)
            return { take: 0 };
        if (/^[0-9]+$/.test(a) && Number(a) >= 1 && Number(a) <= list.length)
            return { take: Number(a) - 1 };
        if (/^n$/i.test(a) && list.length)
            return { reject: true };
        if (/^c$/i.test(a))
            return { undo: true };
        if (/^k$/i.test(a))
            return { stop: true };
        try {
            if (!/[.*]/.test(a))
                throw new mask_1.MaskError('nieznana odpowiedz');
            const { text, quals } = (0, mask_1.parseMask)(a);
            const problem = (0, auto_acs_1.acsProblem)(text);
            if (problem)
                throw new mask_1.MaskError(problem);
            if (o.head?.some((h, i) => quals[i] !== h))
                throw new mask_1.MaskError(`maska nie zaczyna sie od ${o.head.join('.')}`);
            return { mask: text };
        }
        catch (e) {
            if (!(e instanceof mask_1.MaskError))
                throw e;
            io.err(`  ${e.message}\n`);
        }
    }
}
function load(file, scope, when, bar, warn) {
    const st = (0, auto_read_1.readStore)(file, new Set([...scope.fields, ...when.fields]), bar.stage('Czytanie CSV'));
    bar.done(`${(0, auto_util_1.thousands)(st.records)} rekordow, ${(0, auto_util_1.thousands)(st.sets)} zbiorow`);
    for (const w of st.warnings)
        warn(`Uwaga: ${w}\n`);
    return st;
}
/** Wiersze zbiorow w zakresie: male (kryterium) i duze. */
function classify(st, scope, when, head, tick) {
    const inScope = scope.compile(st);
    const small = when.compile(st);
    const inHead = head?.length ? headTest(st.names, head) : () => true;
    const kind = new Uint8Array(st.rows);
    let np = 0;
    let nn = 0;
    for (let r = 0; r < st.rows; r++) {
        if ((r & 0xffff) === 0)
            tick(r / st.rows);
        if (st.dead[r] || !inHead(r) || !inScope(r))
            continue;
        if (small(r)) {
            kind[r] = 1;
            np++;
        }
        else {
            kind[r] = 2;
            nn++;
        }
    }
    const pos = new Int32Array(np);
    const neg = new Int32Array(nn);
    for (let r = 0, p = 0, n = 0; r < st.rows; r++) {
        if (kind[r] === 1)
            pos[p++] = r;
        else if (kind[r] === 2)
            neg[n++] = r;
    }
    return { pos, neg };
}
const pct = (x) => `${(Math.floor(x * 1000) / 10).toFixed(1).replace('.', ',')}%`;
/** Jednostka sumy alokacji: dzielnik KB i liczba miejsc po przecinku. */
const UNITS = { MB: [1024, 0], GB: [1024 ** 2, 2], TB: [1024 ** 3, 3] };
const inUnit = (kb, u) => (kb / UNITS[u][0]).toFixed(UNITS[u][1]).replace('.', ',');
const line = (c) => c[0].padEnd(44) + c[1].padStart(9) + c[2].padStart(9) + c[3].padStart(9)
    + c.slice(4).map(x => x.padStart(12)).join('');
const cells = (m, u) => [m.text, String(m.small), String(m.large), pct(m.purity), inUnit(m.smallKb, u), inUnit(m.largeKb, u)];
const wide = (c) => c[0].padEnd(44) + c.slice(1).map(x => x.padStart(12)).join('');
const noPurity = (m, u) => cells(m, u).filter((_, i) => i !== 3);
const heads = (u) => ['Maska', 'Malych', 'Duzych', 'Purity', `Malych ${u}`, `Duzych ${u}`];
function report(r, u = 'GB') {
    const out = [`Zbiorow w zakresie: ${r.inScope}, malych: ${r.small}, duzych: ${r.inScope - r.small}`, '', ...found(r, u)];
    return out.join('\n') + '\n';
}
function found(r, u) {
    const row = (m) => line(cells(m, u));
    const out = [];
    if (r.masks.length) {
        out.push(line(heads(u)), ...r.masks.map(row), row(r.total), '');
        out.push(`Masek: ${r.masks.length}; obejmuja ${pct(r.total.small / r.small)} malych (${r.total.small} z ${r.small})`);
    }
    else {
        out.push('Brak masek dla tych progow (--min-purity, --min-count).');
    }
    return out;
}
/** Nowe maski, dla zbiorow nieobjetych lista. */
function freshReport(list, r, u = 'GB') {
    const out = ['', `Nowe maski - tylko dla zbiorow, ktorych nie obejmuje zadna maska z listy (malych: ${r.small}, duzych: ${r.inScope - r.small})`, ''];
    if (r.small === 0)
        out.push('Lista obejmuje wszystkie male zbiory.');
    else
        out.push(...found(r, u));
    if (r.masks.length) {
        // zbiory objete lista i nowymi maskami sa rozlaczne
        const small = list.total.small + r.total.small;
        const large = list.total.large + r.total.large;
        const kb = list.total.smallKb + r.total.smallKb;
        out.push(`Lista i nowe maski razem: ${part(small, list.small)} malych (${small} z ${list.small}), `
            + `${part(kb, list.smallKb)} ich alokacji, duzych ${large}, purity ${part(small, small + large)}`);
    }
    return out.join('\n') + '\n';
}
const csvHead = (u) => `maska;malych;duzych;purity;malych_${u};duzych_${u}`.toLowerCase();
const csvCells = (m, u) => [m.text, m.small, m.large, pct(m.purity).slice(0, -1), inUnit(m.smallKb, u), inUnit(m.largeKb, u)];
/** Z EXCLUDE: dodatkowa kolumna stan, zeby plik nadawal sie na liste --masks. */
function toCsv(r, u = 'GB', exclude = []) {
    const ex = exclude.length > 0;
    return [csvHead(u) + (ex ? ';stan' : ''), ...r.masks.map(m => [...csvCells(m, u), ...(ex ? [''] : [])].join(';')),
        ...exclude.map(m => [...csvCells(m, u), 'exclude'].join(';'))].join('\n') + '\n';
}
const MAX_PAIRS = 50;
const part = (a, b) => pct(b ? a / b : 0);
function checkReport(r, u = 'GB') {
    const out = [`Zbiorow w zakresie: ${r.small + r.large}, malych: ${r.small}, duzych: ${r.large}`, '',
        line([...heads(u), 'Tylko ta'])];
    for (const m of r.rows)
        out.push(line([...cells(m, u), String(m.only)]) + (m.state ? `   ${m.state}` : ''));
    out.push(line(cells(r.total, u)), '');
    out.push(`Masek: ${r.rows.length}; obejmuja ${part(r.total.small, r.small)} malych (${r.total.small} z ${r.small}), `
        + `${part(r.total.smallKb, r.smallKb)} ich alokacji (${inUnit(r.total.smallKb, u)} z ${inUnit(r.smallKb, u)} ${u})`, '');
    if (r.excludes.length) {
        out.push('EXCLUDE z listy - zbiory odebrane maskom (nie licza sie wyzej i nie dostaja nowych masek):', wide(heads(u).filter(h => h !== 'Purity')));
        for (const m of r.excludes)
            out.push(wide(noPurity(m, u)));
        out.push('');
    }
    const drop = r.rows.filter(m => m.state === 'usun');
    const instead = r.rows.filter(m => m.state === 'zamiast');
    const why = (m) => `  ${m.text.padEnd(44)}${m.note}`;
    out.push(`Maski zbedne: ${drop.length + instead.length}`);
    if (drop.length) {
        out.push('', 'usun - mozna usunac wszystkie naraz, pokrycie malych sie nie zmieni:', ...drop.map(why), `  Po usunieciu: masek ${r.rows.length - drop.length}, malych ${r.after.small}, duzych ${r.total.large} -> ${r.after.large}, `
            + `purity ${pct(r.total.purity)} -> ${pct(r.after.purity)}`);
    }
    if (instead.length)
        out.push('', 'zamiast - zbedne teraz, ale potrzebne po usunieciu powyzszych:', ...instead.map(why));
    out.push('', `Pary masek ze wspolnymi zbiorami: ${r.overlaps.length}`);
    if (r.overlaps.length) {
        out.push('', 'Maska 1'.padEnd(44) + ' ' + 'Maska 2'.padEnd(44) + 'Malych'.padStart(9) + 'Duzych'.padStart(9)
            + '% mal. 1'.padStart(10) + '% mal. 2'.padStart(10));
        for (const o of r.overlaps.slice(0, MAX_PAIRS)) {
            out.push(o.a.padEnd(44) + ' ' + o.b.padEnd(44) + String(o.small).padStart(9) + String(o.large).padStart(9)
                + pct(o.partA).padStart(10) + pct(o.partB).padStart(10));
        }
        if (r.overlaps.length > MAX_PAIRS)
            out.push(`... i jeszcze ${r.overlaps.length - MAX_PAIRS} par (mniej wspolnych zbiorow)`);
    }
    return out.join('\n') + '\n';
}
/** Maski z listy i nowe (stan "nowa"); pierwsza kolumna nadaje sie na nastepna liste. */
function checkCsv(list, fresh, u = 'GB', exclude = []) {
    return [`${csvHead(u)};tylko_ta;stan;uwagi`,
        ...list.rows.map(m => [...csvCells(m, u), m.only, m.state, m.note].join(';')),
        ...fresh.masks.map(m => [...csvCells(m, u), '', 'nowa', ''].join(';')),
        ...[...list.excludes, ...exclude].map(m => [...csvCells(m, u), '', 'exclude', ''].join(';'))].join('\n') + '\n';
}
function excludeReport(r, u = 'GB') {
    const out = ['', `EXCLUDE - duze zbiory objete maskami (${r.before.large})${r.total.small ? '' : ', bez zadnego malego'}`, ''];
    if (r.masks.length) {
        out.push(wide(['Maska EXCLUDE', 'Duzych', `Duzych ${u}`, ...(r.total.small ? ['Malych'] : [])]));
        for (const m of [...r.masks, r.total])
            out.push(wide([m.text, String(m.large), inUnit(m.largeKb, u), ...(r.total.small ? [String(m.small)] : [])]));
        out.push('', `Masek EXCLUDE: ${r.masks.length}; wylaczaja ${part(r.total.large, r.before.large)} duzych objetych maskami`);
        out.push(`Po EXCLUDE: malych ${r.total.small ? `${r.before.small} -> ` : ''}${r.after.small}, duzych ${r.before.large} -> ${r.after.large}, purity ${pct(r.before.purity)} -> ${pct(r.after.purity)}`);
    }
    else {
        out.push(r.before.large ? 'Brak masek EXCLUDE (--exclude-min, --exclude-gain; duze pod ta sama maska co male).' : 'Maski nie obejmuja duzych zbiorow - EXCLUDE niepotrzebny.');
    }
    return out.join('\n') + '\n';
}
const signed = (n) => `${n < 0 ? '-' : '+'}${Math.abs(n)}`;
const MAX_FIXES = 60;
const MAX_BLOCKED = 15;
/** Jedna propozycja: numer, co zrobic, dlaczego i skutek. */
function fixLines(f, no, list, u) {
    const change = [];
    if (f.in.small || f.out.small)
        change.push(`malych ${[f.in.small && signed(f.in.small), f.out.small && signed(-f.out.small)].filter(Boolean).join(' ')}`);
    if (f.in.large)
        change.push(`duzych +${f.in.large} (+${inUnit(f.in.largeKb, u)} ${u})`);
    if (f.out.large)
        change.push(`duzych -${f.out.large} (-${inUnit(f.out.largeKb, u)} ${u})`);
    const what = f.add.length === 0 ? `usun ${f.side} ${f.remove[0]}` : f.remove.length === 0 ? `dodaj ${f.side} ${f.add[0]}`
        : f.remove.length === 1 ? `zamien ${f.side} ${f.remove[0]}` : `scal ${f.side} ${f.add[0]}`;
    return [`${String(no).padStart(3)}. ${what}${f.note ? `   ${f.note}` : ''}`,
        `       ${change.join(', ') || 'pokrycie bez zmian'}; punkty ${points(f.points)}; lista: INCLUDE ${f.after.include}, EXCLUDE ${f.after.exclude}, `
            + `malych ${f.after.small} (${part(f.after.small, list.small)}), duzych ${f.after.large}`];
}
/** Raport --check. */
function auditReport(r, file, lists, o, u = 'GB') {
    const { list, result: a } = r;
    const b = a.before;
    const kbOf = (kb, all) => [inUnit(kb, u), part(kb, all)];
    const row5 = (c) => c[0].padEnd(34) + c.slice(1).map(x => x.padStart(12)).join('');
    const out = [`FILTLIST ${file}: INCLUDE ${b.include}, EXCLUDE ${b.exclude}`, '', row5(['', 'Zbiorow', '%', u, '%'])];
    const whole = (name, n, kb, get) => {
        const [inN, inKb] = get(b);
        const [exN, exKb] = get(b.lost);
        const line5 = (label, x, k) => out.push(row5([label, String(x), part(x, n), ...kbOf(k, kb)]));
        line5(`${name} w zakresie`, n, kb);
        line5('  objete filtlista', inN, inKb);
        line5('  wylaczone przez EXCLUDE', exN, exKb);
        line5('  poza INCLUDE', n - inN - exN, kb - inKb - exKb);
    };
    whole('Male', list.small, list.smallKb, c => [c.small, c.smallKb]);
    whole('Duze', list.large, r.largeKb, c => [c.large, c.largeKb]);
    const cap = 'kb' in o.maxLarge ? o.maxLarge.kb : o.maxLarge.part * b.smallKb;
    out.push('', `Purity: ${part(b.small, b.small + b.large)}; duze to ${part(b.largeKb, b.smallKb)} alokacji objetych malych`
        + ` (granica --max-large ${limitText(o.maxLarge, u)}: ${b.largeKb <= cap + 1e-6 ? 'miesci sie' : 'PRZEKROCZONA'})`, '');
    out.push(line([...heads(u), 'Tylko ta']));
    for (const m of list.rows)
        out.push(line([...cells(m, u), String(m.only)]));
    out.push(line(cells(list.total, u)));
    if (list.excludes.length) {
        out.push('', wide(['Maska EXCLUDE (wylacza)', 'Duzych', `Duzych ${u}`, 'Malych']));
        for (const m of list.excludes)
            out.push(wide([m.text, String(m.large), inUnit(m.largeKb, u), String(m.small)]));
    }
    // ---- 1
    out.push('', '1. TEST NA SAMYCH DUZYCH', '', `Z ${list.large} duzych filtlista obejmuje ${b.large} (${part(b.large, list.large)}), ${inUnit(b.largeKb, u)} ${u}; EXCLUDE zdejmuje ${b.lost.large} (${inUnit(b.lost.largeKb, u)} ${u}).`);
    const dirty = a.include.filter(x => x.all.large > 0).sort((x, y) => y.all.largeKb - x.all.largeKb || y.all.large - x.all.large);
    const nums = (x) => x[0].padEnd(44) + x.slice(1).map(y => y.padStart(13)).join('');
    if (dirty.length) {
        out.push(`Maski INCLUDE, ktore obejmuja duze: ${dirty.length} z ${a.include.length}. Kolumny "tylko ta" = co ubedzie po usunieciu samej maski.`, '', nums(['Maska', 'Duzych', `Duzych ${u}`, 'tylko ta', `tylko ta ${u}`, 'malych tylko', '% mal.']));
        for (const x of dirty)
            out.push(nums([x.text, String(x.all.large), inUnit(x.all.largeKb, u), String(x.only.large), inUnit(x.only.largeKb, u), String(x.only.small), part(x.only.small, list.small)]));
        out.push('', `Bez tych masek: INCLUDE ${b.include} -> ${a.pure.include}, malych ${b.small} -> ${a.pure.small} (${part(b.small, list.small)} -> ${part(a.pure.small, list.small)}), duzych ${b.large} -> ${a.pure.large}`);
    }
    else {
        out.push('Zadna maska INCLUDE nie obejmuje duzych (po EXCLUDE): na samych duzych lista jest pusta.');
    }
    const idle = a.exclude.filter(x => x.all.large === 0);
    if (idle.length)
        out.push('', `EXCLUDE, ktore na samych duzych nic nie robia: ${idle.map(x => x.text).join('  ')}`);
    const twice = a.exclude.filter(x => x.all.large > 0 && x.only.large === 0);
    if (twice.length)
        out.push('', `EXCLUDE, ktorych duze wylaczaja tez inne EXCLUDE: ${twice.map(x => x.text).join('  ')}`);
    // ---- 2
    const s = a.safe.length ? a.safe[a.safe.length - 1].after : b;
    out.push('', '2. TEST BEZ DUZYCH (te same male, duze odfiltrowane)', '', row5(['', 'INCLUDE', 'EXCLUDE', 'razem']), row5(['obecna lista', String(b.include), String(b.exclude), String(b.include + b.exclude)]), row5(['po propozycjach bez strat', String(s.include), String(s.exclude), String(s.include + s.exclude)]), row5(['to samo, gdyby duzych nie bylo', String(a.noLarge.include.length), '0', String(a.noLarge.include.length)]), '');
    const diff = s.include + s.exclude - a.noLarge.include.length;
    out.push(diff > 0 ? `Bez duzych lista zmniejsza sie o ${diff}: tyle masek jest potrzebnych tylko z powodu duzych.`
        : 'Bez duzych lista sie nie zmniejsza: jej dlugosc nie wynika z duzych.');
    const added = a.noLarge.include.filter(m => !lists.include.includes(m));
    if (added.length)
        out.push(`Maski, ktore by wtedy wystarczyly zamiast obecnych: ${added.join('  ')}`);
    if (a.blocked.length) {
        out.push('', 'Scalenia, ktorych nie przepuszczaja duze (od najtanszego: duze na oszczedzona maske):', '', nums(['Maska', 'mniej masek', '+malych', '+duzych', `+duzych ${u}`]) + '   zamiast');
        for (const x of a.blocked.slice(0, MAX_BLOCKED)) {
            out.push(nums([x.text, String(x.remove.length - 1), String(x.in.small), String(x.in.large), inUnit(x.in.largeKb, u)]) + `   ${x.remove.join('  ')}`);
        }
        if (a.blocked.length > MAX_BLOCKED)
            out.push(`... i jeszcze ${a.blocked.length - MAX_BLOCKED}`);
    }
    // ---- 3
    out.push('', '3. POKRYWANIE SIE MASEK (po EXCLUDE)', '', row5(['Zbior obejmuje masek INCLUDE', 'Malych', '% objetych', 'Duzych', '% objetych']));
    let more = 0;
    let deep = 0;
    a.depth.forEach((c, i) => {
        if (c.small + c.large)
            out.push(row5([`  ${i + 1}`, String(c.small), part(c.small, b.small), String(c.large), part(c.large, b.large)]));
        if (i > 0)
            more += c.small;
        deep += (i + 1) * c.small;
    });
    out.push('', `Male objete wiecej niz jedna maska: ${more} (${part(more, b.small)}); srednio masek na maly zbior: ${(b.small ? deep / b.small : 0).toFixed(2).replace('.', ',')}`);
    out.push(`Pary masek ze wspolnymi zbiorami: ${list.overlaps.length}`);
    if (list.overlaps.length) {
        out.push('', 'Maska 1'.padEnd(44) + ' ' + 'Maska 2'.padEnd(44) + 'Malych'.padStart(9) + 'Duzych'.padStart(9) + '% mal. 1'.padStart(10) + '% mal. 2'.padStart(10));
        for (const x of list.overlaps.slice(0, MAX_PAIRS)) {
            const rel = (0, auto_tree_1.within)(x.a.split('.'), x.b.split('.')) ? '1 zawiera sie w 2' : (0, auto_tree_1.within)(x.b.split('.'), x.a.split('.')) ? '2 zawiera sie w 1'
                : x.partA === 1 && x.partB === 1 ? 'te same male' : x.partA === 1 ? 'w danych 1 w 2' : x.partB === 1 ? 'w danych 2 w 1' : 'czesciowo';
            out.push(x.a.padEnd(44) + ' ' + x.b.padEnd(44) + String(x.small).padStart(9) + String(x.large).padStart(9) + pct(x.partA).padStart(10) + pct(x.partB).padStart(10) + `   ${rel}`);
        }
        if (list.overlaps.length > MAX_PAIRS)
            out.push(`... i jeszcze ${list.overlaps.length - MAX_PAIRS} par (mniej wspolnych zbiorow)`);
    }
    // ---- 4
    out.push('', '4. PROPOZYCJE (kolejne kroki, kazdy liczony po poprzednich)', '');
    const show = (fixes, from) => {
        fixes.slice(0, MAX_FIXES).forEach((f, i) => out.push(...fixLines(f, from + i, list, u)));
        if (fixes.length > MAX_FIXES)
            out.push(`... i jeszcze ${fixes.length - MAX_FIXES}`);
    };
    if (a.safe.length) {
        out.push('Bez strat: w tych danych nie wypada zaden objety maly i nie wchodzi zaden duzy', '');
        show(a.safe, 1);
    }
    else {
        out.push('Bez strat: brak.');
    }
    if (a.trade.length) {
        out.push('', `Kosztem malych albo duzych (oplacalne przy wagach: ${weightsText(o.weights)})`, '');
        show(a.trade, a.safe.length + 1);
    }
    else {
        out.push('', 'Kosztem malych albo duzych: brak oplacalnych przy tych wagach i granicach (--weights, --max-large, --min-purity).');
    }
    const last = (name, inc, exc, c) => wide([name, String(inc), String(exc), String(c.total.small), part(c.total.small, list.small),
        String(c.total.large), inUnit(c.total.largeKb, u), c.total.smallKb ? part(c.total.largeKb, c.total.smallKb) : '-']);
    out.push('', wide(['', 'INCLUDE', 'EXCLUDE', 'Malych', '% mal.', 'Duzych', `Duzych ${u}`, 'duze/male']), last('obecna lista', b.include, b.exclude, list));
    for (const x of r.after)
        out.push(last(x.name, x.list.rows.length, x.list.excludes.length, x.list));
    if (list.small > b.small)
        out.push('', `Nieobjete male: ${list.small - b.small}; kolejne maski dobiera --build --next ${file}`);
    return out.join('\n') + '\n';
}
/** Maski z listy; propozycja = numer kroku, ktory usuwa maske, i maska zamiast niej. */
function auditCsv(r, u = 'GB') {
    const fixes = [...r.result.safe, ...r.result.trade];
    const fix = (side, m) => {
        const i = fixes.findIndex(f => f.side === side && f.remove.includes(m));
        if (i < 0)
            return '';
        const f = fixes[i];
        return `${i + 1}: ${f.add.length === 0 ? 'usun' : f.remove.length > 1 ? `scal w ${f.add[0]}` : `zamien na ${f.add.join('  ')}`}${i < r.result.safe.length ? '' : ' (kosztem malych albo duzych)'}`;
    };
    return [`${csvHead(u)};tylko_ta;stan;propozycja`, ...r.list.rows.map(m => [...csvCells(m, u), m.only, '', fix('INCLUDE', m.text)].join(';')),
        ...r.list.excludes.map(m => [...csvCells(m, u), '', 'exclude', fix('EXCLUDE', m.text)].join(';'))].join('\n') + '\n';
}
const comboText = (c) => c.join(' + ');
const MAX_ALSO = 3;
function qualsReport(r, u = 'GB') {
    const out = [`Zbiorow w zakresie: ${r.small + r.large}, malych: ${r.small}, duzych: ${r.large}`
            + (r.skipped ? ` (pominiete, objete lista masek: malych ${r.skipped.small}, duzych ${r.skipped.large})` : '')];
    const row = (c) => c[0].padEnd(44) + c[1].padStart(9) + c[2].padStart(8) + c[3].padStart(9) + c[4].padStart(9)
        + c.slice(5, 7).map(x => x.padStart(12)).join('') + (c.length > 7 ? `   ${c[7].padEnd(44)}${c[8].padStart(9)}${c[9].padStart(9)}` : '');
    const nums = (c) => [String(c.small), part(c.small, r.small), String(c.large), pct(c.purity), inUnit(c.smallKb, u), inUnit(c.largeKb, u)];
    const head = ['Malych', '% mal.', 'Duzych', 'Purity', `Malych ${u}`, `Duzych ${u}`];
    r.combos?.tables.forEach((t, i) => {
        out.push('', `Kombinacje: kwalifikatorow ${i + 1}${t.length ? '' : ' - brak (--min-count, --min-purity)'}`);
        if (t.length === 0)
            return;
        out.push('', row(['Kombinacja', ...head, 'Najwezsza maska', 'Duzych', 'Purity']));
        for (const c of t) {
            out.push(row([comboText(c.quals), ...nums(c), c.mask?.text ?? '(ponad 44 znaki)', c.mask ? String(c.mask.large) : '', c.mask ? pct(c.mask.purity) : '']));
            const more = c.also.length - MAX_ALSO + c.more;
            if (c.also.length)
                out.push(`    te same male: ${c.also.slice(0, MAX_ALSO).map(comboText).join(';  ')}${more > 0 ? `  (i ${more} innych)` : ''}`);
        }
    });
    if (r.combos && r.combos.floor !== null) {
        out.push('', r.combos.floor > r.combos.small ? 'Uwaga: przerwano po czasie --time; tabele sa niepelne (mniej kwalifikatorow: --quals, --partial 0, wiekszy --min-count).'
            : `Uwaga: przerwano po czasie --time; w tabelach sa tylko kombinacje o co najmniej ${r.combos.floor} malych.`);
    }
    for (const t of r.tries) {
        out.push('', `Sprawdzenie: ${comboText(t[0].quals)}${t.length > 1 ? ' i skrocenia (od najwiekszej purity)' : ''}`, '', row(['Kombinacja', ...head, 'Maska', '+Malych', '+Duzych']));
        for (const x of t) {
            const more = (n) => (x.level ? `${n < 0 ? '' : '+'}${n}` : '');
            out.push(row([comboText(x.quals), ...nums(x), x.text.length > 44 ? '(ponad 44 znaki)' : x.text, more(x.small - t[0].small), more(x.large - t[0].large)]));
        }
    }
    return out.join('\n') + '\n';
}
/** Pierwsza kolumna (maska) nadaje sie na liste --masks. */
function qualsCsv(r, u = 'GB') {
    const out = [`${csvHead(u)};rodzaj;kwalifikatorow;kombinacja;proc_malych;komb_duzych;komb_purity;te_same_male`];
    for (const c of r.combos?.tables.flat() ?? []) {
        const m = c.mask ? csvCells(c.mask, u) : ['', c.small, '', '', inUnit(c.smallKb, u), ''];
        out.push([...m, 'kombinacja', c.quals.length, comboText(c.quals), part(c.small, r.small).slice(0, -1), c.large, pct(c.purity).slice(0, -1),
            c.also.map(comboText).join(', ')].join(';'));
    }
    for (const x of r.tries.flat()) {
        const m = csvCells(x, u);
        if (x.text.length > 44)
            m[0] = '';
        out.push([...m, x.level ? 'skrocenie' : 'podana', x.quals.length, comboText(x.quals), part(x.small, r.small).slice(0, -1), x.large, pct(x.purity).slice(0, -1), ''].join(';'));
    }
    return out.join('\n') + '\n';
}
const count = (p) => p.include.length + p.exclude.length;
const limitText = (l, u) => ('kb' in l ? `${inUnit(l.kb, u)} ${u}` : `${pctOf(l.part)} alokacji objetych malych`);
const pctOf = (x) => `${String(Math.round(x * 1e6) / 1e4).replace('.', ',')}%`;
function verifyReport(v, list, file, maxLarge, u) {
    const out = ['', `Sprawdzenie na drugim pliku: ${file}`, '', wide(['', 'Malych', 'objete', '% mal.', 'Duze w l.', `Duze ${u}`, 'duze/male'])];
    const sum = (name, l) => wide([name, String(l.small), String(l.total.small), part(l.total.small, l.small), String(l.total.large),
        inUnit(l.total.largeKb, u), l.total.smallKb ? part(l.total.largeKb, l.total.smallKb) : '-']);
    out.push(sum('pierwszy plik', list), sum('drugi plik', v.list), sum('w tym nazwy, ktorych w pierwszym nie bylo', v.fresh), '');
    const cap = 'kb' in maxLarge ? maxLarge.kb : maxLarge.part * v.list.total.smallKb;
    out.push(v.list.total.largeKb <= cap + 1e-6 ? 'Duze w drugim pliku mieszcza sie w granicy --max-large.'
        : `Uwaga: duze w drugim pliku przekraczaja granice --max-large (${inUnit(v.list.total.largeKb, u)} z ${inUnit(cap, u)} ${u}).`);
    const worse = v.list.rows.map((m, i) => ({ m, was: list.rows[i] })).filter(x => x.m.small + x.m.large > 0 && x.m.purity < x.was.purity - 0.05);
    if (worse.length) {
        out.push('', 'Maski o purity gorszej o ponad 5 punktow:');
        for (const x of worse)
            out.push(`  ${x.m.text.padEnd(44)} ${pct(x.was.purity)} -> ${pct(x.m.purity)}  (duzych ${x.m.large}, ${inUnit(x.m.largeKb, u)} ${u})`);
    }
    const none = v.list.rows.filter(m => m.small + m.large === 0);
    if (none.length)
        out.push('', `Maski bez zbiorow w drugim pliku: ${none.map(m => m.text).join('  ')}`);
    return out;
}
function compactReport(r, c, u = 'GB') {
    const { result: res, chosen, list, verified: v } = r;
    const out = [`Zbiorow w zakresie: ${res.small + res.large}, malych: ${res.small}, duzych: ${res.large}`,
        `Duze w liscie: do ${limitText(c.maxLarge, u)}   male stracone przez EXCLUDE: do ${pctOf(c.loss)}   INCLUDE daje malych: od ${r.minCount}`,
        ''];
    if (!chosen || !list) {
        out.push('Brak masek dla tych progow (--min-purity, --min-count, --max-large, --any-start).');
        return out.join('\n') + '\n';
    }
    if (res.stopped)
        out.push('Uwaga: przerwano po czasie --time; krzywa moze byc niepelna.', '');
    const row = (x) => [7, 9, 9, 9, 9, 12, 9, 12, 10, 10].map((w, i) => x[i].padStart(w)).join('') + (x[10] ?? '');
    out.push('Krzywa: liczba masek i pokrycie', '', row(['Masek', 'INCLUDE', 'EXCLUDE', 'Malych', '% mal.', `Malych ${u}`, 'Duzych', `Duzych ${u}`, 'duze/male', 'Stracone']));
    for (const p of res.points) {
        out.push(row([String(count(p)), String(p.include.length), String(p.exclude.length), String(p.small), part(p.small, res.small), inUnit(p.smallKb, u),
            String(p.large), inUnit(p.largeKb, u), part(p.largeKb, p.smallKb), String(p.lost), p === chosen ? '   <- wybrany' : '']));
    }
    out.push('', `Wybrany punkt: masek ${count(chosen)} (INCLUDE ${chosen.include.length}, EXCLUDE ${chosen.exclude.length}); inny: --pick N`, '', line([...heads(u), 'Tylko ta']));
    for (const m of list.rows)
        out.push(line([...cells(m, u), String(m.only)]));
    out.push(line(cells(list.total, u)), '', `Obejmuja ${part(list.total.small, list.small)} malych (${list.total.small} z ${list.small}), po EXCLUDE`);
    if (list.excludes.length) {
        out.push('', wide(['Maska EXCLUDE', 'Duzych', `Duzych ${u}`, 'Malych']));
        for (const m of list.excludes)
            out.push(wide([m.text, String(m.large), inUnit(m.largeKb, u), String(m.small)]));
    }
    if (v)
        out.push(...verifyReport(v, list, c.verify, c.maxLarge, u));
    return out.join('\n') + '\n';
}
/** old: ile pierwszych masek juz bylo; dalsze maja stan "nowa" */
function compactCsv(r, u = 'GB', old = Infinity) {
    return [`${csvHead(u)};tylko_ta;stan`, ...(r.list?.rows ?? []).map((m, i) => [...csvCells(m, u), m.only, i < old ? '' : 'nowa'].join(';')),
        ...(r.list?.excludes ?? []).map(m => [...csvCells(m, u), '', 'exclude'].join(';'))].join('\n') + '\n';
}
/** Dziennik: kroki kazdej maski z listy, potem zmiany listy po kolei. */
function journalText(r) {
    const out = ['Dziennik: jak powstala kazda maska (male / duze = objete maska, po jej EXCLUDE)'];
    r.include.forEach((text, i) => {
        if (i < r.old.include)
            return;
        const m = r.how[i];
        out.push('', `${i + 1}. ${text}${m?.exclude.length ? `   EXCLUDE ${m.exclude.join('  ')}` : ''}${m ? '' : '   (wpisana)'}`);
        for (const s of m?.steps ?? []) {
            out.push(`     ${s.text.padEnd(44)}${String(s.small).padStart(9)} /${String(s.large).padStart(8)}${pct(s.small + s.large ? s.small / (s.small + s.large) : 0).padStart(8)}   ${s.note}`);
        }
    });
    if (r.changes.length)
        out.push('', 'Zmiany listy po kolei', '', ...r.changes.map(c => `${points(c.points).padStart(9)}   ${c.text}`));
    return out.join('\n') + '\n';
}
const LABELS = {
    small: 'objete male', large: 'duze w liscie', masks: 'maski INCLUDE', exclude: 'maski EXCLUDE', risk: 'duze zdejmowane przez EXCLUDE',
    percent: 'znaki %', wild: '* i **', start: 'maski od * albo **',
};
const weightsText = (w) => Object.keys(auto_build_1.POINTS).map(k => `${k}=${w[k]}`).join(' ');
function buildReport(r, o, file, u = 'GB') {
    const { result: res, list } = r;
    const out = [`Zbiorow w zakresie: ${list.small + list.large}, malych: ${list.small}, duzych: ${list.large}`,
        `Duze w liscie: do ${limitText(o.maxLarge, u)}   male stracone przez EXCLUDE: do ${pctOf(o.loss)}`, `Wagi: ${weightsText(o.weights)}`, ''];
    if (res.stopped)
        out.push('Uwaga: przerwano po czasie --time; lista moze byc niepelna.', '');
    if (res.include.length === 0) {
        out.push('Brak masek dla tych progow i wag (--min-purity, --min-count, --max-large, --weights).');
        return out.join('\n') + '\n';
    }
    out.push(`Masek ${res.include.length + res.exclude.length} (INCLUDE ${res.include.length}, EXCLUDE ${res.exclude.length})`, '', line([...heads(u), 'Tylko ta']));
    for (const m of list.rows)
        out.push(line([...cells(m, u), String(m.only)]));
    out.push(line(cells(list.total, u)), '', `Obejmuja ${part(list.total.small, list.small)} malych (${list.total.small} z ${list.small}), po EXCLUDE; `
        + `duze ${part(list.total.largeKb, list.total.smallKb)} alokacji objetych malych`);
    if (list.excludes.length) {
        out.push('', wide(['Maska EXCLUDE', 'Duzych', `Duzych ${u}`, 'Malych']));
        for (const m of list.excludes)
            out.push(wide([m.text, String(m.large), inUnit(m.largeKb, u), String(m.small)]));
    }
    out.push('', 'Punkty (1 punkt = 1% malych przy small=1)', '');
    for (const k of Object.keys(auto_build_1.POINTS))
        out.push(LABELS[k].padEnd(34) + `${k}=${o.weights[k]}`.padEnd(14) + points(res.parts[k]).padStart(10));
    out.push('RAZEM'.padEnd(48) + points(res.points).padStart(10));
    if (r.variants.length) {
        const row = (x) => x[0].padEnd(30) + x.slice(1).map(y => y.padStart(10)).join('');
        const of = (name, v) => row([name, String(v.include.length), String(v.exclude.length), part(v.totals.small, list.small), part(v.totals.largeKb, v.totals.smallKb),
            String(v.include.filter(m => m.startsWith('*')).length)]);
        out.push('', 'Co zmieni waga', '', row(['Wagi', 'INCLUDE', 'EXCLUDE', '% mal.', 'duze/male', 'od **']), of('obecne', res));
        for (const v of r.variants)
            out.push(of(v.name, v.result));
    }
    if (r.verified && file !== undefined)
        out.push(...verifyReport(r.verified, list, file, o.maxLarge, u));
    return out.join('\n') + '\n';
}
/** Raport jednego przebiegu --next: co doszlo do FILTLIST i co zostalo. */
function nextReport(r, o, next, file, u = 'GB') {
    const { result: res, list } = r;
    const { old, before: was, totals: now } = res;
    const out = [`Zbiorow w zakresie: ${list.small + list.large}, malych: ${list.small}, duzych: ${list.large}`,
        `Duze w liscie: do ${limitText(o.maxLarge, u)}   male stracone przez EXCLUDE: do ${pctOf(o.loss)}`, `Wagi: ${weightsText(o.weights)}`, ''];
    if (res.stopped)
        out.push('Uwaga: przerwano po czasie --time.', '');
    const fresh = list.rows.slice(old.include);
    const freshEx = list.excludes.slice(old.exclude);
    if (fresh.length) {
        out.push(fresh.length === 1 ? 'Nowa maska (liczby po EXCLUDE)' : `Nowe maski: ${fresh.length} (liczby po EXCLUDE)`, '', line([...heads(u), 'Tylko ta']));
        for (const m of fresh)
            out.push(line([...cells(m, u), String(m.only)]));
        out.push('');
    }
    if (freshEx.length) {
        out.push(wide(['Nowy EXCLUDE', 'Duzych', `Duzych ${u}`, 'Malych']));
        for (const m of freshEx)
            out.push(wide([m.text, String(m.large), inUnit(m.largeKb, u), String(m.small)]));
        out.push('');
    }
    if (!fresh.length) {
        const full = res.include.length + res.exclude.length >= o.maxMasks;
        out.push(full ? `Brak miejsca na kolejna maske: lista ma juz ${res.include.length + res.exclude.length} (--max-masks).`
            : 'Brak kolejnej maski dla tych progow i wag. Wiecej da mniejsza waga masks albo start, mniejsze --min-count albo wieksze --max-large.', '');
    }
    out.push(wide([`FILTLIST ${next}`, 'INCLUDE', 'EXCLUDE', 'Malych', '% mal.', 'Duzych', `Duzych ${u}`, 'duze/male']));
    const row = (name, inc, exc, t) => wide([name, String(inc), String(exc), String(t.small), part(t.small, list.small),
        String(t.large), inUnit(t.largeKb, u), t.smallKb ? part(t.largeKb, t.smallKb) : '-']);
    out.push(row('przed', old.include, old.exclude, was), row('po', res.include.length, res.exclude.length, now), '');
    out.push(`Zostalo nieobjetych malych: ${res.left.small}${res.left.dead ? `, w tym wylaczonych przez EXCLUDE: ${res.left.dead}` : ''}`);
    if (now.lost)
        out.push(`Male objete INCLUDE, ale wylaczone przez EXCLUDE: ${now.lost}`);
    const cap = 'kb' in o.maxLarge ? o.maxLarge.kb : o.maxLarge.part * now.smallKb;
    if (now.largeKb > cap + 1e-6) {
        out.push('', `Uwaga: duze w liscie przekraczaja --max-large (${inUnit(now.largeKb, u)} z ${inUnit(cap, u)} ${u}); do tego czasu nowe maski nie moga dodac duzych.`);
    }
    if (r.verified && file !== undefined)
        out.push(...verifyReport(r.verified, list, file, o.maxLarge, u));
    return out.join('\n') + '\n';
}
function readNext(file) {
    let text = '';
    try {
        text = node_fs_1.default.readFileSync(file, 'latin1').replace(/^\xef\xbb\xbf/, '');
    }
    catch (e) {
        if (e.code !== 'ENOENT')
            throw e;
    }
    const clean = text.replace(/\/\*[\s\S]*?\*\//g, c => c.replace(/[^\n]/g, ' '));
    if (!clean.trim())
        return { name: 'MALE', lead: text.trim() ? `${text.trimEnd()}\n` : '', include: [], exclude: [], warnings: [] };
    const start = /(^|\s)(FILTLIST|INCLUDE\s*\()/i.exec(clean);
    if (!start || !/(^|\s)INCLUDE\s*\(/i.test(clean))
        throw new ArgError(`--next: ${file} to nie FILTLIST z INCLUDE(...)`);
    const names = [...clean.matchAll(/(?:^|\s)FILTLIST\s+([^\s(]+)/gi)].map(m => m[1].toUpperCase());
    if (names.length > 1)
        throw new ArgError(`--next: ${file} - jedna FILTLIST w pliku (jest ${names.length})`);
    const list = (0, auto_check_1.parseMaskList)(text, file);
    const at = start.index + start[1].length;
    const lead = text.slice(0, at).trimEnd();
    const warnings = list.warnings.slice();
    if (text.slice(at).includes('/*'))
        warnings.push(`${file}: komentarze wewnatrz i za FILTLIST nie zostana przepisane`);
    return { name: names[0] ?? 'MALE', lead: lead ? `${lead}\n` : '', include: list.masks, exclude: list.excludes, warnings };
}
/** "masks=1 large=4" (takze po przecinku) */
function parseWeights(text) {
    const w = { ...auto_build_1.POINTS };
    for (const x of text.trim().split(/[\s,]+(?=[a-zA-Z])/).filter(Boolean)) {
        const m = /^([a-z]+)=([0-9.,]+)$/i.exec(x);
        const k = m?.[1].toLowerCase();
        if (!m || !Object.hasOwn(auto_build_1.POINTS, k))
            throw new ArgError(`--weights: "${x}" - dozwolone: ${Object.keys(auto_build_1.POINTS).join(' ')} (np. masks=1)`);
        w[k] = num(m[2], 'weights', 0, 1e6, false);
    }
    if (w.small === 0)
        throw new ArgError('--weights: small musi byc wieksze od 0');
    return w;
}
/** "5%" -> 0.05; sama liczba tez znaczy procent */
function percent(v, name) {
    return num(v.trim().replace(/%$/, ''), name, 0, 100, false) / 100;
}
function largeLimit(v) {
    const m = /^([0-9.,]+)\s*(MB|GB|TB)$/i.exec(v.trim());
    if (m)
        return { kb: num(m[1], 'max-large', 0, 1e12, false) * UNITS[m[2].toUpperCase()][0] };
    if (!/^[0-9.,]+%?$/.test(v.trim()))
        throw new ArgError(`--max-large: niepoprawna wartosc "${v}" (np. 5% albo 200GB)`);
    return { part: num(v.trim().replace(/%$/, ''), 'max-large', 0, 10000, false) / 100 };
}
const text = { type: 'string' };
const flag = { type: 'boolean' };
exports.OPTIONS = {
    scope: text, when: text, prefix: text, 'min-purity': text, 'min-count': text, 'max-masks': text, wild: text, masks: text, quals: text, partial: text,
    top: text, time: text, try: text, unit: text, out: { type: 'string', short: 'o' }, exclude: flag, 'exclude-min': text, 'exclude-gain': text,
    'exclude-loss': text, compact: flag, 'max-large': text, pick: text, 'any-start': flag, verify: text, build: flag, weights: text, beam: text, rounds: text,
    ask: flag, 'what-if': flag, log: text, next: text, steps: text, check: text, apply: text, filtlist: text, tests: text, 'per-mask': text, 'test-prefix': text,
    config: text, 'save-config': text, help: { type: 'boolean', short: 'h' },
};
const DEFAULTS = {
    scope: 'sms=true dsorg=PS', when: 'allocTrk=315 usedTrk<=3', 'max-masks': '100', unit: 'GB', 'exclude-min': '2', 'per-mask': '1', 'test-prefix': 'ACM',
    exclude: false, compact: false, 'any-start': false, build: false, ask: false, 'what-if': false,
};
function main(argv, io = STDIO) {
    let bar = null;
    const progress = (stages) => bar = new auto_util_1.Progress(stages, io.err, io.tty ?? false, () => process.stderr.columns || 80);
    try {
        const { values: cli, positionals: given } = (0, node_util_1.parseArgs)({
            args: argv,
            allowPositionals: true,
            options: exports.OPTIONS,
        });
        if (cli.help) {
            io.out(HELP);
            return 0;
        }
        const { config, 'save-config': saveConfig, help: _help, ...own } = cli;
        const merged = (0, auto_config_1.mergeConfig)(own, config === undefined ? {} : (0, auto_config_1.readConfig)(config));
        if (merged.skipped.length)
            io.err(`Uwaga: ${config}: pominiete, nie dotycza tego trybu: ${merged.skipped.join(' ')}\n`);
        const { input, ...set } = merged.values;
        const o = { ...DEFAULTS, ...set };
        const positionals = given.length || input === undefined ? given : [input];
        if (positionals.length > 1 || (positionals.length === 0 && saveConfig === undefined)) {
            io.err(USAGE);
            return 1;
        }
        if (saveConfig !== undefined) {
            if (node_fs_1.default.existsSync(saveConfig))
                node_fs_1.default.copyFileSync(saveConfig, `${saveConfig}.bak`);
            node_fs_1.default.writeFileSync(saveConfig, (0, auto_config_1.configText)({ ...merged.all, input: positionals[0] }, parseWeights(String(merged.all.weights ?? ''))));
            io.err(`Zapisano: ${saveConfig}\n`);
            // bez pliku w wierszu polecen: sam zapis
            if (given.length === 0)
                return 0;
        }
        const scope = parseConds(o.scope, 'scope');
        const when = parseConds(o.when, 'when');
        const combos = o.quals !== undefined || o.try !== undefined;
        const opt = {
            minPurity: num(o['min-purity'] ?? (combos ? '0' : o.compact ? '0.5' : '0.95'), 'min-purity', 0, 1, false),
            minCount: num(o['min-count'] ?? '10', 'min-count', 1, 1e9, true),
            maxMasks: num(o['max-masks'], 'max-masks', 1, 1e6, true),
            maxWild: num(o.wild ?? '3', 'wild', 0, 9, true),
            head: o.prefix === undefined ? [] : parseHead(o.prefix),
        };
        const unit = o.unit.toUpperCase();
        if (!Object.hasOwn(UNITS, unit))
            throw new ArgError(`--unit: "${o.unit}" - dozwolone: ${Object.keys(UNITS).join(' ')}`);
        const excludeMin = num(o['exclude-min'], 'exclude-min', 1, 1e9, true);
        const perMask = num(o['per-mask'], 'per-mask', 1, 1000, true);
        (0, testcase_1.memberNames)(o['test-prefix'], 0);
        const save = (file, text, info = '') => {
            if (file === undefined)
                return;
            node_fs_1.default.writeFileSync(file, text);
            io.err(`Zapisano: ${file}${info}\n`);
        };
        const exGain = percent(o['exclude-gain'] ?? '0.5', 'exclude-gain');
        const loss = percent(o['exclude-loss'] ?? (o.compact || o.build || o.check !== undefined ? '1' : '0'), 'exclude-loss');
        const onlyBuild = ['ask', 'what-if'].find(x => o[x]) ?? ['beam', 'rounds', 'log', 'next', 'weights'].find(x => o[x] !== undefined);
        const checked = o.check !== undefined;
        if (onlyBuild && !o.build && !(checked && onlyBuild === 'weights'))
            throw new ArgError(`--${onlyBuild}: tylko z --build${onlyBuild === 'weights' ? ' albo --check' : ''}`);
        if (o.steps !== undefined && o.next === undefined)
            throw new ArgError('--steps: tylko z --next');
        if (o.next !== undefined) {
            if (o.filtlist !== undefined)
                throw new ArgError('--filtlist: nie z --next (maski trafiaja do pliku z --next)');
            if (o['what-if'])
                throw new ArgError('--what-if: nie z --next');
            if (o.rounds !== undefined)
                throw new ArgError('--rounds: nie z --next (masek z listy skrypt nie zmienia)');
            if (o.ask && o.steps !== undefined)
                throw new ArgError('--steps: nie z --ask');
        }
        if (o.apply !== undefined && (!checked || (o.filtlist === undefined && o.tests === undefined)))
            throw new ArgError('--apply: tylko z --check i --filtlist albo --tests');
        if (checked) {
            const other = ['build', 'compact', 'exclude', 'any-start'].find(x => o[x])
                ?? ['masks', 'quals', 'try', 'partial', 'top', 'time', 'pick', 'wild', 'min-count', 'exclude-gain', 'verify'].find(x => o[x] !== undefined);
            if (other)
                throw new ArgError(`--${other}: nie z --check`);
        }
        else if (o.build) {
            const other = ['compact', 'exclude', 'any-start'].find(x => o[x])
                ?? ['masks', 'quals', 'try', 'top', 'pick', 'wild', 'exclude-gain'].find(x => o[x] !== undefined);
            if (other)
                throw new ArgError(`--${other}: nie z --build`);
            if (o.ask && o['what-if'])
                throw new ArgError('--what-if: nie z --ask');
        }
        else if (o.compact) {
            const other = o.exclude ? 'exclude' : ['masks', 'quals', 'try', 'partial', 'top'].find(x => o[x] !== undefined);
            if (other)
                throw new ArgError(`--${other}: nie z --compact`);
        }
        else {
            const lone = o['any-start'] ? 'any-start' : ['max-large', 'pick', 'verify'].find(x => o[x] !== undefined);
            if (lone)
                throw new ArgError(`--${lone}: tylko z --compact${lone === 'max-large' || lone === 'verify' ? ' albo --build' : ''}${lone === 'max-large' ? ', --check' : ''}`);
            const ex = ['exclude-gain', 'exclude-loss'].find(x => o[x] !== undefined);
            if (ex && !o.exclude)
                throw new ArgError(`--${ex}: tylko z --exclude, --compact${ex === 'exclude-loss' ? ', --build, --check' : ''}`);
        }
        const partial = num(o.partial ?? '3', 'partial', 0, 7, true);
        if (partial === 1)
            throw new ArgError('--partial: 2-7 albo 0 (tylko pelne kwalifikatory)');
        if (!combos) {
            const lone = o.top !== undefined ? 'top' : o.partial !== undefined && !o.build ? 'partial' : null;
            if (lone)
                throw new ArgError(`--${lone}: tylko z --quals albo --try${lone === 'partial' ? ' albo --build' : ''}`);
            if (o.time !== undefined && !o.compact && !o.build)
                throw new ArgError('--time: tylko z --quals, --compact albo --build');
        }
        else {
            const other = o.exclude ? 'exclude' : ['filtlist', 'tests'].find(x => o[x] !== undefined);
            if (other)
                throw new ArgError(`--${other}: nie z --quals i --try (wybrane maski zapisz w pliku i podaj w --masks)`);
            const q = {
                quals: o.quals === undefined ? null
                    : { maxQuals: num(o.quals, 'quals', 1, 4, true), top: num(o.top ?? '20', 'top', 1, 10000, true), seconds: num(o.time ?? '600', 'time', 1, 1e6, true) },
                partial, tries: o.try === undefined ? [] : (0, auto_quals_1.parseTries)(o.try), masks: [], excludes: [],
            };
            if (o.try !== undefined && q.tries.length === 0)
                throw new ArgError('--try: brak kombinacji');
            if (o.masks !== undefined) {
                const list = (0, auto_check_1.parseMaskList)(node_fs_1.default.readFileSync(o.masks, 'latin1').replace(/^\xef\xbb\xbf/, ''), o.masks);
                for (const w of list.warnings)
                    io.err(`Uwaga: ${w}\n`);
                Object.assign(q, { masks: list.masks, excludes: list.excludes });
            }
            const r = quals(positionals[0], scope, when, q, opt, progress(2 + Number(q.masks.length > 0) + Number(q.quals !== null) + Number(q.tries.length > 0)), io.err);
            io.out(`Zakres: ${o.scope}   kryterium: ${o.when}${opt.head.length ? `   poczatek nazw: ${opt.head.join('.')}` : ''}`
                + `${opt.minPurity > 0 ? `   min. purity: ${pct(opt.minPurity)}` : ''}   min. zbiorow: ${opt.minCount}\n`);
            io.out(qualsReport(r, unit));
            save(o.out, qualsCsv(r, unit));
            return 0;
        }
        const extra = Number(o.exclude) + Number(o.tests !== undefined);
        /** EXCLUDE, FILTLIST i testy do masek; wynik: nowe maski EXCLUDE */
        const finish = (p, input, include, old, name = 'MALE') => {
            let added = [];
            if (o.exclude) {
                const tick = p.stage('EXCLUDE');
                const e = (0, auto_acs_1.findExcludes)(input, include, old, { minCount: excludeMin, maxWild: opt.maxWild, head: opt.head, gain: exGain, loss }, tick);
                p.done(`masek EXCLUDE: ${e.masks.length}`);
                io.out(excludeReport(e, unit));
                added = e.masks;
            }
            const exclude = [...old, ...added.map(m => m.text)];
            if (o.tests !== undefined) {
                const tests = (0, auto_acs_1.maskTests)(input, include, exclude, perMask, o['test-prefix'], p.stage('Testy'));
                p.done(`testow: ${tests.length}`);
                if (tests.length)
                    save(o.tests, (0, auto_acs_1.testFile)(tests), ` (testow: ${tests.length}, ${tests[0].member} - ${tests[tests.length - 1].member})`);
                else
                    io.err(`Brak testow - ${o.tests} nie zapisano\n`);
            }
            if (o.filtlist !== undefined) {
                const good = (m) => {
                    const why = (0, auto_acs_1.acsProblem)(m);
                    if (why)
                        io.err(`Uwaga: pominieta w FILTLIST: ${m} (${why})\n`);
                    return !why;
                };
                const inc = include.filter(good);
                const exc = exclude.filter(good);
                if (inc.length)
                    save(o.filtlist, (0, auto_acs_1.filtlistText)(name, inc, exc).join('\n') + '\n', ` (INCLUDE: ${inc.length}, EXCLUDE: ${exc.length})`);
                else
                    io.err(`Brak masek - ${o.filtlist} nie zapisano\n`);
            }
            return added;
        };
        if (checked) {
            const source = node_fs_1.default.readFileSync(o.check, 'latin1').replace(/^\xef\xbb\xbf/, '');
            const list = (0, auto_check_1.parseMaskList)(source, o.check);
            for (const w of list.warnings)
                io.err(`Uwaga: ${w}\n`);
            const lists = { include: list.masks, exclude: list.excludes };
            const a = { weights: parseWeights(o.weights ?? ''), maxLarge: largeLimit(o['max-large'] ?? '5%'), minPurity: opt.minPurity, loss, head: opt.head.length };
            const p = progress(3 + Number(o.tests !== undefined));
            const r = auditList(positionals[0], scope, when, lists, a, opt.head, p, io.err);
            const fixes = [...r.result.safe, ...r.result.trade];
            const apply = o.apply === undefined || o.apply === 'safe' ? r.result.safe.length : o.apply === 'all' ? fixes.length : num(o.apply, 'apply', 0, 1e6, true);
            if (apply > fixes.length)
                throw new ArgError(`--apply: propozycji jest ${fixes.length}`);
            io.out(`Zakres: ${o.scope}   kryterium: ${o.when}${opt.head.length ? `   poczatek nazw: ${opt.head.join('.')}` : ''}\n`);
            io.out(auditReport(r, o.check, lists, a, unit));
            if (o.filtlist !== undefined || o.tests !== undefined) {
                const now = apply ? fixes[apply - 1].lists : lists;
                // FILTLIST zapisywana w to samo miejsce: poprzednia wersja zostaje
                if (o.filtlist !== undefined && node_fs_1.default.existsSync(o.filtlist))
                    node_fs_1.default.copyFileSync(o.filtlist, `${o.filtlist}.bak`);
                const names = [...source.replace(/\/\*[\s\S]*?\*\//g, ' ').matchAll(/(?:^|\s)FILTLIST\s+([^\s(]+)/gi)].map(m => m[1].toUpperCase());
                io.err(`Wprowadzone propozycje: ${apply} z ${fixes.length}\n`);
                finish(p, r.input, now.include, now.exclude, names.length === 1 ? names[0] : 'MALE');
            }
            save(o.out, auditCsv(r, unit));
            return 0;
        }
        if (o.build) {
            if (o.verify !== undefined)
                node_fs_1.default.accessSync(o.verify);
            const b = {
                weights: parseWeights(o.weights ?? ''), minPurity: opt.minPurity, minCount: opt.minCount, maxMasks: Math.min(opt.maxMasks, filtlist_1.MAX_LIST),
                maxLarge: largeLimit(o['max-large'] ?? '5%'), loss, exMin: excludeMin, partial, beam: num(o.beam ?? '8', 'beam', 1, 1000, true),
                rounds: num(o.rounds ?? '2', 'rounds', 0, 100, true), head: opt.head, seconds: num(o.time ?? '600', 'time', 1, 1e6, true),
            };
            const p = progress(4 + 2 * VARIANTS.length * Number(o['what-if']) + 2 * Number(o.verify !== undefined) + Number(o.tests !== undefined));
            if (o.next !== undefined) {
                const { next } = o;
                const list = readNext(next);
                for (const w of list.warnings)
                    io.err(`Uwaga: ${w}\n`);
                b.base = { include: list.include, exclude: list.exclude };
                const steps = o.steps === 'max' ? Infinity : num(o.steps ?? '1', 'steps', 1, 1e6, true);
                let written = false;
                /** po kazdej masce, zeby przerwany przebieg nic nie stracil */
                const write = (x) => {
                    if (!written && node_fs_1.default.existsSync(next))
                        node_fs_1.default.copyFileSync(next, `${next}.bak`);
                    written = true;
                    node_fs_1.default.writeFileSync(next, list.lead + (0, auto_acs_1.filtlistText)(list.name, x.include, x.exclude).join('\n') + '\n', 'latin1');
                };
                const r = build(positionals[0], scope, when, b, { verify: o.verify, whatIf: false, ask: o.ask, unit, by: o.ask ? undefined : { steps, done: write } }, p, io);
                const { result } = r;
                const changed = result.include.length > list.include.length || result.exclude.length > list.exclude.length;
                if (o.ask && changed)
                    write(result);
                io.out(`Zakres: ${o.scope}   kryterium: ${o.when}${opt.head.length ? `   poczatek masek: ${opt.head.join('.')}` : ''}   min. purity: ${pct(opt.minPurity)}\n`);
                io.out(nextReport(r, b, next, o.verify, unit));
                if (changed) {
                    const journal = journalText(result);
                    if (o.log === undefined)
                        io.out(`\n${journal}`);
                    else
                        node_fs_1.default.appendFileSync(o.log, `${journal}\n`);
                }
                if (result.include.length)
                    finish(p, r.input, result.include, result.exclude);
                save(o.out, compactCsv(r, unit, result.old.include));
                io.err(changed ? `Zapisano: ${next} (INCLUDE: ${result.include.length}, EXCLUDE: ${result.exclude.length})${node_fs_1.default.existsSync(`${next}.bak`) && list.include.length ? `, poprzednia wersja: ${next}.bak` : ''}\n`
                    : `${next}: bez zmian\n`);
                return 0;
            }
            const r = build(positionals[0], scope, when, b, { verify: o.verify, whatIf: o['what-if'], ask: o.ask, unit }, p, io);
            io.out(`Zakres: ${o.scope}   kryterium: ${o.when}${opt.head.length ? `   poczatek masek: ${opt.head.join('.')}` : ''}   min. purity: ${pct(opt.minPurity)}\n`);
            io.out(buildReport(r, b, o.verify, unit));
            const journal = journalText(r.result);
            if (o.log === undefined)
                io.out(`\n${journal}`);
            else
                save(o.log, journal);
            const ok = (l) => l.filter(m => !(0, auto_acs_1.acsProblem)(m));
            if (ok(r.result.include).length && o.filtlist === undefined)
                io.out(`\n${(0, auto_acs_1.filtlistText)('MALE', ok(r.result.include), ok(r.result.exclude)).join('\n')}\n`);
            if (r.result.include.length)
                finish(p, r.input, r.result.include, r.result.exclude);
            save(o.out, compactCsv(r, unit));
            return 0;
        }
        if (o.compact) {
            if (o.verify !== undefined)
                node_fs_1.default.accessSync(o.verify);
            const c = {
                minCount: o['min-count'] === undefined ? null : opt.minCount, exMin: excludeMin, exGain, loss, anyStart: o['any-start'],
                maxLarge: largeLimit(o['max-large'] ?? '5%'), seconds: num(o.time ?? '600', 'time', 1, 1e6, true),
                pick: o.pick === undefined ? null : o.pick === 'max' ? Infinity : num(o.pick, 'pick', 1, 1e6, true), verify: o.verify,
            };
            const p = progress(5 + 2 * Number(o.verify !== undefined) + Number(o.tests !== undefined));
            const r = compact(positionals[0], scope, when, c, { ...opt, maxMasks: Math.min(opt.maxMasks, filtlist_1.MAX_LIST) }, p, io.err);
            io.out(`Zakres: ${o.scope}   kryterium: ${o.when}${opt.head.length ? `   poczatek masek: ${opt.head.join('.')}` : ''}   min. purity przed EXCLUDE: ${pct(opt.minPurity)}\n`);
            io.out(compactReport(r, c, unit));
            if (r.chosen && o.filtlist === undefined)
                io.out(`\n${(0, auto_acs_1.filtlistText)('MALE', r.chosen.include.filter(m => !(0, auto_acs_1.acsProblem)(m)), r.chosen.exclude.filter(m => !(0, auto_acs_1.acsProblem)(m))).join('\n')}\n`);
            if (r.chosen)
                finish(p, r.input, r.chosen.include, r.chosen.exclude);
            save(o.out, compactCsv(r, unit));
            return 0;
        }
        if (o.masks !== undefined) {
            const list = (0, auto_check_1.parseMaskList)(node_fs_1.default.readFileSync(o.masks, 'latin1').replace(/^\xef\xbb\xbf/, ''), o.masks);
            for (const w of list.warnings)
                io.err(`Uwaga: ${w}\n`);
            const p = progress(5 + extra);
            const c = check(positionals[0], scope, when, list.masks, list.excludes, opt, p, io.err);
            io.out(`Zakres: ${o.scope}   kryterium: ${o.when}${opt.head.length ? `   poczatek masek: ${opt.head.join('.')}` : ''}   maski: ${o.masks}   min. purity: ${pct(opt.minPurity)}, min. zbiorow: ${opt.minCount}\n`);
            io.out(checkReport(c.list, unit));
            io.out(freshReport(c.list, c.fresh, unit));
            const added = finish(p, c.input, [...list.masks, ...c.fresh.masks.map(m => m.text)], list.excludes);
            save(o.out, checkCsv(c.list, c.fresh, unit, added));
            return 0;
        }
        const p = progress(4 + extra);
        const r = search(positionals[0], scope, when, opt, p, io.err);
        const start = opt.head.length ? `   poczatek masek: ${opt.head.join('.')}` : '';
        io.out(`Zakres: ${o.scope}   kryterium: ${o.when}${start}   min. purity: ${pct(opt.minPurity)}, min. zbiorow: ${opt.minCount}\n`);
        io.out(report(r, unit));
        const added = finish(p, r.input, r.masks.map(m => m.text), []);
        save(o.out, toCsv(r, unit, added));
        return 0;
    }
    catch (err) {
        bar?.abort();
        const e = err;
        if (e instanceof ArgError || e instanceof dataset_1.CsvError || e instanceof mask_1.MaskError || e instanceof auto_check_1.MaskListError
            || e instanceof testcase_1.TestCaseError || e instanceof auto_config_1.ConfigError) {
            io.err(`Blad: ${e.message}\n`);
        }
        else if (e.code?.startsWith('ERR_PARSE_ARGS')) {
            io.err(`${e.message}\n${USAGE}`);
        }
        else if (e.code && e.path) {
            io.err(`Blad: ${e.path}: ${e.code === 'ENOENT' ? 'brak pliku albo katalogu' : e.code}\n`);
        }
        else {
            throw err;
        }
        return 1;
    }
}
if (require.main === module)
    process.exitCode = main(process.argv.slice(2));
};

module.exports = load("./auto");
