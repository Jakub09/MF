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

// ==================== src/auto-check.ts
MODULES["./auto-check"] = function (exports, require, module) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MaskTree = exports.MaskListError = void 0;
exports.parseMaskList = parseMaskList;
exports.within = within;
exports.checkMasks = checkMasks;
const auto_util_1 = require("./auto-util");
const mask_1 = require("./mask");
const DOT = 46;
const PCT = 37;
const STAR = 42;
/** krawedz '**' w drzewie masek (wzorce kwalifikatorow maja numery od 1) */
const ANY_QUALS = 0;
/** ile masek wymienia powod zbednosci */
const MAX_NOTE = 4;
class MaskListError extends Error {
}
exports.MaskListError = MaskListError;
/**
 * Lista masek z pliku: po jednej w linii albo po przecinku (wnetrze INCLUDE), w CSV pierwsza kolumna (plik z --out).
 * Pelna nazwa moze byc w apostrofach; komentarze jak w ACS. Powtorzone maski sa pomijane z ostrzezeniem.
 */
function parseMaskList(text, file) {
    const masks = [];
    const warnings = [];
    const seen = new Set();
    // komentarz zamieniony na same konce linii, zeby zgadzaly sie numery wierszy
    const clean = text.replace(/^﻿/, '').replace(/\/\*[\s\S]*?\*\//g, c => c.replace(/[^\n]/g, ' '));
    clean.split(/\r?\n/).forEach((line, i) => {
        const fail = (msg) => new MaskListError(`${file}, wiersz ${i + 1}: ${msg}`);
        const csv = line.includes(';');
        if (/^T;DSN;/i.test(line))
            throw fail('to CSV z DCOLLECT, a nie lista masek');
        const items = csv ? [line.split(';')[0]] : line.split(/[\s,]+/);
        for (const item of items.map(x => x.trim()).filter(Boolean)) {
            if (csv && item.toLowerCase() === 'maska')
                continue;
            const quoted = /^'(.*)'$/.exec(item);
            if (quoted && /[*%]/.test(quoted[1]))
                throw fail(`${item} - w apostrofach to pelna nazwa; maske podaj bez apostrofow`);
            let mask;
            try {
                mask = (0, mask_1.parseMask)(quoted ? quoted[1] : item).text;
            }
            catch (e) {
                throw fail(e.message);
            }
            if (/^[0-9]/.test(mask))
                throw fail(`"${mask}" - nazwa zbioru nie zaczyna sie cyfra`);
            if (seen.has(mask))
                warnings.push(`${file}, wiersz ${i + 1}: maska ${mask} powtorzona`);
            else
                masks.push(mask);
            seen.add(mask);
        }
    });
    if (masks.length === 0)
        throw new MaskListError(`${file}: brak masek`);
    return { masks, warnings };
}
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
function checkMasks(input, masks, tick) {
    const { names, allocKb, pos, neg } = input;
    const quals = masks.map(m => (0, mask_1.parseMask)(m).quals);
    const tree = new MaskTree(quals);
    // ---- grupy zbiorow o tym samym zestawie masek
    const single = [];
    const multi = new Map();
    const empty = (ids) => ({ ids, small: 0, large: 0, smallKb: 0, largeKb: 0 });
    const groupOf = (row) => {
        const s = names.start[row];
        const ids = tree.match(names.pool, s, s + names.len[row]);
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
        const g = groupOf(pos[x]);
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
        const g = groupOf(neg[x]);
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
        return cand.filter(b => b !== m && within(quals[m], quals[b]));
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

// ==================== src/auto-mine.ts
MODULES["./auto-mine"] = function (exports, require, module) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mine = mine;
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
const auto_util_1 = require("./auto-util");
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
function mine(input, opt, stages) {
    const { names, allocKb, pos, neg } = input;
    const { pool } = names;
    const min = opt.minCount;
    const np = pos.length;
    const headText = (opt.head ?? []).join('.');
    const skip = opt.head?.length ?? 0;
    /** ile kwalifikatorow (za head) musi miec nazwa dla masek prefiks.**.LLQ; bez head: *.**.LLQ, czyli dwa */
    const minL = skip ? 1 : 2;
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
    const off = new Int32Array(np + 1);
    const qList = new auto_util_1.IntList();
    let maxQ = 0;
    for (let i = 0; i < np; i++) {
        const s = rest(pos[i]);
        const e = names.start[pos[i]] + names.len[pos[i]];
        let b = s;
        for (let p = s; p <= e; p++) {
            if (p < e && pool[p] !== DOT)
                continue;
            qList.push(quals.add(pool, b, p));
            b = p + 1;
        }
        off[i + 1] = qList.n;
        if (off[i + 1] - off[i] > maxQ)
            maxQ = off[i + 1] - off[i];
        if ((i & 0xffff) === 0)
            stages.candidates(0.1 * (i / np));
    }
    const q = qList.a;
    // ---- wzorce z %: tylko takie, do ktorych pasuje co najmniej min kwalifikatorow malych zbiorow
    const occ = new Int32Array(quals.size);
    for (let j = 0; j < qList.n; j++)
        occ[q[j]]++;
    const pat = buildPatterns(quals, occ, min, part => stages.candidates(0.1 + 0.2 * part));
    const { gen, patOff, patList } = pat;
    // ---- kandydaci
    const fam = new auto_util_1.IntList();
    const ca = new auto_util_1.IntList();
    const cb = new auto_util_1.IntList();
    const cpos = new auto_util_1.IntList();
    const addCand = (f, a, b, n) => {
        fam.push(f);
        ca.push(a);
        cb.push(b);
        cpos.push(n);
        return fam.n - 1;
    };
    /** wezly drzewa prefiksow (tylko czeste); 0 = korzen */
    const parent = new auto_util_1.IntList();
    const nodeQual = new auto_util_1.IntList();
    parent.push(-1);
    nodeQual.push(-1);
    const child = new auto_util_1.PairMap();
    const mapL = new auto_util_1.PairMap();
    const mapPD = new auto_util_1.PairMap();
    const mapED = new auto_util_1.PairMap();
    const mapLD = new auto_util_1.PairMap();
    /** wezel prefiksu po kwalifikatorze j zbioru i: nd[off[i] + j]; -1 = prefiks rzadki */
    const nd = new Int32Array(qList.n).fill(-1);
    const headAt = (i, j) => (j === 0 ? 0 : nd[off[i] + j - 1]);
    const levels = maxQ * 3 + 1;
    let levelNo = 0;
    const level = (i, n) => stages.candidates(0.3 + 0.7 * ((levelNo + i / Math.max(1, n)) / levels));
    const nextLevel = () => void levelNo++;
    if (skip) {
        let exact = 0;
        for (let i = 0; i < np; i++)
            if (off[i] === off[i + 1])
                exact++;
        if (np >= min)
            addCand(P, 0, 0, np);
        if (exact >= min)
            addCand(E, 0, 0, exact);
    }
    // P i E: prefiksy poziomami
    {
        let alive = new Int32Array(np);
        for (let i = 0; i < np; i++)
            alive[i] = i;
        let n = np;
        for (let j = 0; j < maxQ; j++, nextLevel()) {
            const tmp = new auto_util_1.PairMap();
            let cnt = new Int32Array(1 << 10);
            const at = new Int32Array(n);
            let m = 0;
            for (let x = 0; x < n; x++) {
                const i = alive[x];
                if (off[i] + j >= off[i + 1])
                    continue;
                const c = tmp.index(headAt(i, j), q[off[i] + j]);
                if (c >= cnt.length)
                    cnt = (0, auto_util_1.grow)(cnt, c + 1);
                cnt[c]++;
                at[m] = c;
                alive[m++] = i;
                if ((x & 0xffff) === 0)
                    level(x, n);
            }
            const node = new Int32Array(tmp.size).fill(-1);
            const exact = new Int32Array(tmp.size);
            n = 0;
            for (let x = 0; x < m; x++) {
                const i = alive[x];
                const c = at[x];
                if (cnt[c] < min)
                    continue;
                if (node[c] < 0) {
                    node[c] = parent.n;
                    child.set(headAt(i, j), q[off[i] + j], parent.n);
                    parent.push(headAt(i, j));
                    nodeQual.push(q[off[i] + j]);
                    addCand(P, node[c], 0, cnt[c]);
                }
                nd[off[i] + j] = node[c];
                if (off[i] + j + 1 === off[i + 1])
                    exact[c]++;
                else
                    alive[n++] = i;
            }
            for (let c = 0; c < node.length; c++)
                if (exact[c] >= min)
                    addCand(E, node[c], 0, exact[c]);
        }
    }
    const nodes = parent.n;
    const has = new Uint8Array(nodes);
    // L: prefiks.**.LLQ - coraz dluzszy prefiks, dopoki para (prefiks, LLQ) jest czesta
    {
        let alive = new Int32Array(np);
        let n = 0;
        for (let i = 0; i < np; i++)
            if (off[i + 1] - off[i] >= minL)
                alive[n++] = i;
        for (let k = 0; k < maxQ && n > 0; k++, nextLevel()) {
            const tmp = new auto_util_1.PairMap();
            let cnt = new Int32Array(1 << 10);
            const at = new Int32Array(n);
            let m = 0;
            for (let x = 0; x < n; x++) {
                const i = alive[x];
                if (k > off[i + 1] - off[i] - 1)
                    continue;
                const node = headAt(i, k);
                if (node < 0)
                    continue;
                const c = tmp.index(node, q[off[i + 1] - 1]);
                if (c >= cnt.length)
                    cnt = (0, auto_util_1.grow)(cnt, c + 1);
                cnt[c]++;
                at[m] = c;
                alive[m++] = i;
                if ((x & 0xffff) === 0)
                    level(x, n);
            }
            n = 0;
            const done = new Uint8Array(tmp.size);
            for (let x = 0; x < m; x++) {
                const c = at[x];
                if (cnt[c] < min)
                    continue;
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
    const registered = (fill, f, map, bit) => {
        const reg = new auto_util_1.PairMap();
        let cnt = new Int32Array(1 << 10);
        fill(reg, c => {
            if (c >= cnt.length)
                cnt = (0, auto_util_1.grow)(cnt, c + 1);
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
                    if (last ? at + 1 !== off[i + 1] : at >= off[i + 1])
                        continue;
                    const g = gen[q[at]];
                    if (g >= 0 && headAt(i, j) >= 0)
                        reg.index(headAt(i, j), g);
                }
                if (reg.size === 0)
                    return;
                for (let i = 0; i < np; i++) {
                    if ((i & 0xffff) === 0)
                        level(i, np);
                    const at = off[i] + j;
                    if (last ? at + 1 !== off[i + 1] : at >= off[i + 1])
                        continue;
                    const head = headAt(i, j);
                    if (head < 0)
                        continue;
                    for (let y = patOff[q[at]]; y < patOff[q[at] + 1]; y++) {
                        const c = reg.get(head, patList[y]);
                        if (c >= 0)
                            count(c);
                    }
                }
            }, last ? ED : PD, last ? mapED : mapPD, last ? HAS_ED : HAS_PD);
        }
    }
    // LD: jak L, z wzorcem LLQ; pary (zbior, wzorzec), dopoki czeste
    {
        let ai = new auto_util_1.IntList();
        let ap = new auto_util_1.IntList();
        for (let i = 0; i < np; i++) {
            if (off[i + 1] - off[i] < minL)
                continue;
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
                    if (off[i + 1] - off[i] < minL || k > off[i + 1] - off[i] - 1)
                        continue;
                    const g = gen[q[off[i + 1] - 1]];
                    if (g >= 0 && headAt(i, k) >= 0)
                        reg.index(headAt(i, k), g);
                }
                for (let x = 0; x < n; x++) {
                    if ((x & 0xffff) === 0)
                        level(x, n);
                    const i = ai.a[x];
                    if (k > off[i + 1] - off[i] - 1 || headAt(i, k) < 0)
                        continue;
                    const c = reg.get(headAt(i, k), ap.a[x]);
                    if (c >= 0)
                        count(c);
                }
            }, LD, mapLD, HAS_LD);
            const bi = new auto_util_1.IntList();
            const bp = new auto_util_1.IntList();
            for (let x = 0; x < n; x++) {
                const i = ai.a[x];
                if (k > off[i + 1] - off[i] - 1 || headAt(i, k) < 0 || mapLD.get(headAt(i, k), ap.a[x]) < 0)
                    continue;
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
        if (fam.a[c] === P)
            candP[ca.a[c]] = c;
        else if (fam.a[c] === E)
            candE[ca.a[c]] = c;
    }
    // ---- wszystkie maski pasujace do nazwy -> out[0..n)
    let out = new Int32Array(1 << 12);
    let outN = 0;
    const emit = (c) => {
        if (c < 0)
            return;
        if (outN === out.length)
            out = (0, auto_util_1.grow)(out, outN + 1);
        out[outN++] = c;
    };
    const qs = new Int32Array(MAX_QUALS);
    const qe = new Int32Array(MAX_QUALS);
    const found = new auto_util_1.IntList();
    const llqP = new auto_util_1.IntList();
    const patternsOf = (id, s, e, into) => {
        into.n = 0;
        if (id < 0)
            pat.match(pool, s, e, into);
        else
            for (let y = patOff[id]; y < patOff[id + 1]; y++)
                into.push(patList[y]);
    };
    const matching = (row) => {
        outN = 0;
        const s = rest(row);
        const e = names.start[row] + names.len[row];
        let n = 0;
        let b = s;
        for (let p = s; p <= e; p++) {
            if (p < e && pool[p] !== DOT)
                continue;
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
            if (!llqReady)
                patternsOf(llq, qs[n - 1], qe[n - 1], llqP);
            llqReady = true;
        };
        let head = 0;
        for (let j = 0; j < n; j++) {
            const h = has[head];
            const last = j === n - 1;
            if (n >= minL) {
                if (h & HAS_L && llq >= 0)
                    emit(mapL.get(head, llq));
                if (h & HAS_LD) {
                    llqPatterns();
                    for (let y = 0; y < llqP.n; y++)
                        emit(mapLD.get(head, llqP.a[y]));
                }
            }
            const id = last ? llq : quals.find(pool, qs[j], qe[j]);
            if (h & HAS_PD) {
                patternsOf(id, qs[j], qe[j], found);
                for (let y = 0; y < found.n; y++)
                    emit(mapPD.get(head, found.a[y]));
            }
            if (last && h & HAS_ED) {
                llqPatterns();
                for (let y = 0; y < llqP.n; y++)
                    emit(mapED.get(head, llqP.a[y]));
            }
            if (id < 0)
                return;
            head = child.get(head, id);
            if (head < 0)
                return;
            emit(candP[head]);
            if (last)
                emit(candE[head]);
        }
    };
    // ---- zbiory duze
    const tickNeg = stages.negatives(nc);
    const cneg = new Int32Array(nc);
    const cnegKb = new Float64Array(nc);
    for (let x = 0; x < neg.length; x++) {
        if ((x & 0x3fff) === 0)
            tickNeg(x / neg.length);
        matching(neg[x]);
        const kb = allocKb[neg[x]];
        for (let y = 0; y < outN; y++) {
            cneg[out[y]]++;
            cnegKb[out[y]] += kb;
        }
    }
    // ---- kandydaci z wystarczajaca czystoscia: listy malych zbiorow
    const tickSel = stages.select();
    const purity = (c) => cpos.a[c] / (cpos.a[c] + cneg[c]);
    const slot = new Int32Array(nc).fill(-1);
    const good = [];
    for (let c = 0; c < nc; c++) {
        if (purity(c) < opt.minPurity)
            continue;
        slot[c] = good.length;
        good.push(c);
    }
    const lo = new Float64Array(good.length + 1);
    good.forEach((c, g) => { lo[g + 1] = lo[g] + cpos.a[c]; });
    const list = new Int32Array(lo[good.length]);
    const fill = lo.slice();
    for (let i = 0; i < np; i++) {
        if ((i & 0x3fff) === 0)
            tickSel(0.6 * (i / np));
        matching(pos[i]);
        for (let y = 0; y < outN; y++) {
            const g = slot[out[y]];
            if (g >= 0)
                list[fill[g]++] = i;
        }
    }
    // ---- wybor zachlanny (kolejnosc i remisy jak w mine.ts)
    const path = (node) => {
        const parts = [];
        for (let x = node; x > 0; x = parent.a[x])
            parts.push(quals.text(nodeQual.a[x]));
        if (skip)
            parts.push(headText);
        return parts.reverse().join('.');
    };
    const texts = new Array(good.length);
    const textOf = (g) => texts[g] ??= (() => {
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
    const literal = (t) => t.replace(/[*%.]/g, '').length;
    const stars = (t) => t.replace(/[^*]/g, '').length;
    const gain = new Int32Array(good.length);
    const better = (x, y) => {
        if (gain[x] !== gain[y])
            return gain[x] > gain[y];
        const cx = good[x];
        const cy = good[y];
        const px = purity(cx);
        const py = purity(cy);
        if (px !== py)
            return px > py;
        if (cneg[cx] !== cneg[cy])
            return cneg[cx] < cneg[cy];
        const tx = textOf(x);
        const ty = textOf(y);
        const d = literal(ty) - literal(tx) || stars(tx) - stars(ty) || tx.length - ty.length;
        return d !== 0 ? d < 0 : tx < ty;
    };
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
        gain[g] = cpos.a[good[g]];
        heap[hn] = g;
        up(hn++);
    }
    const covered = new Uint8Array(np);
    const chosen = [];
    let pops = 0;
    while (hn > 0 && chosen.length < opt.maxMasks) {
        if ((pops++ & 0xff) === 0) {
            tickSel(0.6 + 0.4 * Math.max(chosen.length / opt.maxMasks, 1 - hn / good.length), `masek: ${chosen.length}`);
        }
        const g = heap[0];
        let now = 0;
        for (let x = lo[g]; x < lo[g + 1]; x++)
            if (!covered[list[x]])
                now++;
        if (now === gain[g] && now >= min) {
            for (let x = lo[g]; x < lo[g + 1]; x++)
                covered[list[x]] = 1;
            chosen.push(g);
            now = 0;
        }
        if (now < min) {
            heap[0] = heap[--hn];
        }
        else {
            gain[g] = now;
        }
        if (hn > 0)
            down(0);
    }
    // maski zbedne: wszystkie ich zbiory obejmuja inne wybrane (od ostatnio wybranych)
    const cover = new Int32Array(np);
    for (const g of chosen)
        for (let x = lo[g]; x < lo[g + 1]; x++)
            cover[list[x]]++;
    const keep = chosen.map(() => true);
    for (let j = chosen.length - 1; j >= 0; j--) {
        const g = chosen[j];
        let redundant = true;
        for (let x = lo[g]; x < lo[g + 1] && redundant; x++)
            if (cover[list[x]] < 2)
                redundant = false;
        if (!redundant)
            continue;
        keep[j] = false;
        for (let x = lo[g]; x < lo[g + 1]; x++)
            cover[list[x]]--;
    }
    const final = chosen.filter((_, j) => keep[j]);
    const total = { text: 'RAZEM', small: 0, large: 0, purity: 0, smallKb: 0, largeKb: 0 };
    for (let i = 0; i < np; i++) {
        if (!cover[i])
            continue;
        total.small++;
        total.smallKb += allocKb[pos[i]];
    }
    const isFinal = new Uint8Array(nc);
    let anyNeg = false;
    for (const g of final) {
        isFinal[good[g]] = 1;
        if (cneg[good[g]])
            anyNeg = true;
    }
    if (anyNeg) {
        for (let x = 0; x < neg.length; x++) {
            if ((x & 0x3fff) === 0)
                tickSel(0.99);
            matching(neg[x]);
            let hit = false;
            for (let y = 0; y < outN && !hit; y++)
                if (isFinal[out[y]])
                    hit = true;
            if (!hit)
                continue;
            total.large++;
            total.largeKb += allocKb[neg[x]];
        }
    }
    total.purity = total.small ? total.small / (total.small + total.large) : 0;
    const masks = final.map((g) => {
        const c = good[g];
        let kb = 0;
        for (let x = lo[g]; x < lo[g + 1]; x++)
            kb += allocKb[pos[list[x]]];
        return { text: textOf(g), small: cpos.a[c], large: cneg[c], purity: purity(c), smallKb: kb, largeKb: cnegKb[c] };
    });
    return { masks, total, candidates: nc };
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
    const isDigit = (b) => b >= 48 && b <= 57;
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
            if (!isDigit(b))
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
                if (isDigit(b))
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
                if (isDigit(pool[p]))
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
exports.parseConds = parseConds;
exports.parseHead = parseHead;
exports.search = search;
exports.check = check;
exports.report = report;
exports.freshReport = freshReport;
exports.toCsv = toCsv;
exports.checkReport = checkReport;
exports.checkCsv = checkCsv;
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
 *   --unit MB|GB|TB    jednostka sumy alokacji                                   (domyslnie GB)
 *   --out PLIK         maski takze do pliku CSV (separator ;)
 *
 *   --masks PLIK       sprawdza maski z pliku (po jednej w linii albo po przecinku; CSV z --out tez): liczby dla kazdej
 *                      maski, pokrycie wszystkich razem, maski zbedne, pary nakladajace sie; potem szuka nowych masek
 *                      dla malych zbiorow, ktorych lista nie obejmuje (zbiory objete lista, male i duze, sa pominiete).
 *                      --prefix: poczatek nowych masek, zaweza tez zbiory, na ktorych sprawdzana jest lista.
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
const auto_check_1 = require("./auto-check");
const auto_mine_1 = require("./auto-mine");
const auto_read_1 = require("./auto-read");
const auto_util_1 = require("./auto-util");
const dataset_1 = require("./dataset");
const mask_1 = require("./mask");
const STDIO = { out: t => process.stdout.write(t), err: t => process.stderr.write(t), tty: process.stderr.isTTY };
const USAGE = 'Uzycie: node acs-masks-auto.cjs DCOLLECT.CSV [--scope "sms=true dsorg=PS"]\n'
    + '        [--when "allocTrk=315 usedTrk<=3"] [--prefix "ABC%.**"] [--min-purity 0.95]\n'
    + '        [--min-count 10] [--max-masks 100] [--unit GB] [--out maski.csv]\n'
    + '   albo: node acs-masks-auto.cjs DCOLLECT.CSV --masks maski.txt [opcje jak wyzej]\n'
    + '         (sprawdza liste i szuka masek dla zbiorow, ktorych ona nie obejmuje)\n'
    + `Pola liczbowe: ${auto_read_1.NUM.join(' ')}\n     tekstowe: ${auto_read_1.STR.join(' ')}\n     true / false: ${auto_read_1.BOOL.join(' ')}\n`
    + 'Operatory: = != < <= > >=; kilka warunkow po spacji = wszystkie naraz\n';
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
    const tick = bar.stage('Kryteria i maski');
    const { pos, neg } = classify(st, scope, when, opt.head, part => tick(0.1 * part));
    return mineRows(st, pos, neg, opt, bar, (part, info) => tick(0.1 + 0.9 * part, info));
}
function mineRows(st, pos, neg, opt, bar, tick) {
    const res = (0, auto_mine_1.mine)({ names: st.names, allocKb: st.allocKb, pos, neg }, opt, {
        candidates: part => tick(part, `malych: ${(0, auto_util_1.thousands)(pos.length)}`),
        negatives: candidates => {
            bar.done(`malych: ${(0, auto_util_1.thousands)(pos.length)}, masek do sprawdzenia: ${(0, auto_util_1.thousands)(candidates)}`);
            return bar.stage('Zbiory duze');
        },
        select: () => {
            bar.done(`duzych: ${(0, auto_util_1.thousands)(neg.length)}`);
            return bar.stage('Wybor masek');
        },
    });
    bar.done(`wybrano: ${res.masks.length}`);
    return { inScope: pos.length + neg.length, small: pos.length, masks: res.masks, total: res.total };
}
/** Sprawdzenie gotowej listy masek, a potem szukanie masek dla zbiorow, ktorych lista nie obejmuje. */
function check(file, scope, when, masks, opt, bar, warn = () => { }) {
    const st = load(file, scope, when, bar, warn);
    const tick = bar.stage('Sprawdzanie masek');
    const { pos, neg } = classify(st, scope, when, opt.head, part => tick(0.2 * part));
    const list = (0, auto_check_1.checkMasks)({ names: st.names, allocKb: st.allocKb, pos, neg }, masks, part => tick(0.2 + 0.8 * part));
    bar.done(`masek: ${masks.length}, malych: ${(0, auto_util_1.thousands)(pos.length)}, duzych: ${(0, auto_util_1.thousands)(neg.length)}`);
    const fresh = mineRows(st, list.rest.pos, list.rest.neg, opt, bar, bar.stage('Nowe maski'));
    return { list, fresh };
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
function toCsv(r, u = 'GB') {
    return [csvHead(u), ...r.masks.map(m => csvCells(m, u).join(';'))].join('\n') + '\n';
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
function checkCsv(list, fresh, u = 'GB') {
    return [`${csvHead(u)};tylko_ta;stan;uwagi`,
        ...list.rows.map(m => [...csvCells(m, u), m.only, m.state, m.note].join(';')),
        ...fresh.masks.map(m => [...csvCells(m, u), '', 'nowa', ''].join(';'))].join('\n') + '\n';
}
function main(argv, io = STDIO) {
    let bar = null;
    const progress = (stages) => bar = new auto_util_1.Progress(stages, io.err, io.tty ?? false, () => process.stderr.columns || 80);
    try {
        const { values: o, positionals } = (0, node_util_1.parseArgs)({
            args: argv,
            allowPositionals: true,
            options: {
                scope: { type: 'string', default: 'sms=true dsorg=PS' },
                when: { type: 'string', default: 'allocTrk=315 usedTrk<=3' },
                prefix: { type: 'string' },
                'min-purity': { type: 'string', default: '0.95' },
                'min-count': { type: 'string', default: '10' },
                'max-masks': { type: 'string', default: '100' },
                masks: { type: 'string' },
                unit: { type: 'string', default: 'GB' },
                out: { type: 'string', short: 'o' },
                help: { type: 'boolean', short: 'h', default: false },
            },
        });
        if (o.help) {
            io.out(USAGE);
            return 0;
        }
        if (positionals.length !== 1) {
            io.err(USAGE);
            return 1;
        }
        const scope = parseConds(o.scope, 'scope');
        const when = parseConds(o.when, 'when');
        const opt = {
            minPurity: num(o['min-purity'], 'min-purity', 0, 1, false),
            minCount: num(o['min-count'], 'min-count', 1, 1e9, true),
            maxMasks: num(o['max-masks'], 'max-masks', 1, 1e6, true),
            head: o.prefix === undefined ? [] : parseHead(o.prefix),
        };
        const unit = o.unit.toUpperCase();
        if (!Object.hasOwn(UNITS, unit))
            throw new ArgError(`--unit: "${o.unit}" - dozwolone: ${Object.keys(UNITS).join(' ')}`);
        const save = (text) => {
            if (!o.out)
                return;
            node_fs_1.default.writeFileSync(o.out, text);
            io.err(`Zapisano: ${o.out}\n`);
        };
        if (o.masks !== undefined) {
            const list = (0, auto_check_1.parseMaskList)(node_fs_1.default.readFileSync(o.masks, 'latin1').replace(/^\xef\xbb\xbf/, ''), o.masks);
            for (const w of list.warnings)
                io.err(`Uwaga: ${w}\n`);
            const c = check(positionals[0], scope, when, list.masks, opt, progress(5), io.err);
            io.out(`Zakres: ${o.scope}   kryterium: ${o.when}${opt.head.length ? `   poczatek masek: ${opt.head.join('.')}` : ''}   maski: ${o.masks}   min. purity: ${pct(opt.minPurity)}, min. zbiorow: ${opt.minCount}\n`);
            io.out(checkReport(c.list, unit));
            io.out(freshReport(c.list, c.fresh, unit));
            save(checkCsv(c.list, c.fresh, unit));
            return 0;
        }
        const r = search(positionals[0], scope, when, opt, progress(4), io.err);
        const start = opt.head.length ? `   poczatek masek: ${opt.head.join('.')}` : '';
        io.out(`Zakres: ${o.scope}   kryterium: ${o.when}${start}   min. purity: ${pct(opt.minPurity)}, min. zbiorow: ${opt.minCount}\n`);
        io.out(report(r, unit));
        save(toCsv(r, unit));
        return 0;
    }
    catch (err) {
        bar?.abort();
        const e = err;
        if (e instanceof ArgError || e instanceof dataset_1.CsvError || e instanceof mask_1.MaskError || e instanceof auto_check_1.MaskListError) {
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
