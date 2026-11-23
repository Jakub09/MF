/**
 * CSV z joba ACMCSV -> kolumny liczb (bez obiektu na zbior). Znaczenie pol i laczenie rekordow jak w dataset.ts:
 * zbior wielowolumenowy = jeden wiersz (przestrzen zsumowana, atrybuty z najnizszego numeru wolumenu), komponenty
 * VSAM pod nazwa klastra (rekordy A), generacje GDG pod nazwa bez GnnnnVnn. Zapamietywane sa tylko kolumny
 * potrzebne do kryteriow.
 */
import fs from 'node:fs';
import { grow, Interner, IntList, latin1, thousands, Tick } from './auto-util';
import { CsvError, DCOL_COLUMNS, dsorgName, julianToEpochDay, pdDate, recfmName } from './dataset';

export const NUM = ['allocTrk', 'usedTrk', 'freeTrk', 'allocKb', 'usedKb', 'extents', 'vols', 'nqual', 'lrecl',
    'blksize', 'ageDays', 'unrefDays'] as const;
export const STR = ['dsn', 'hlq', 'llq', 'vol', 'dsorg', 'recfm', 'sc', 'mc', 'dc', 'sg', 'createJob'] as const;
export const BOOL = ['sms', 'temp', 'pdse', 'gds', 'ef', 'vsam'] as const;
export type NumField = (typeof NUM)[number];
export type StrField = (typeof STR)[number];
export type BoolField = (typeof BOOL)[number];
export type Field = NumField | StrField | BoolField;

const COL = Object.fromEntries(DCOL_COLUMNS.map((c, i) => [c, i])) as Record<(typeof DCOL_COLUMNS)[number], number>;
const NCOL = DCOL_COLUMNS.length;
const TRACK_BYTES = 56664;
const CHUNK = 1 << 23;
const HINT = '\n  (bajty binarne w CSV, np. NUL SOH: stara wersja joba ACMCSV - uruchom ACMCSV ponownie)';

/** Atrybuty zbioru (z rekordu o najnizszym numerze wolumenu) -> kolumna CSV. */
const ATTR_COLS = {
    flag1: COL.FLAG1, flag3: COL.FLAG3, dsorg: COL.DSORG, recfm: COL.RECFM, lrecl: COL.LRECL, blksize: COL.BLKSZ,
    created: COL.CREDT, lastRef: COL.LSTRF, vol: COL.VOLSER, sc: COL.SC, mc: COL.MC, dc: COL.DC, sg: COL.SG,
    createJob: COL.CJOB,
} as const;
type Attr = keyof typeof ATTR_COLS;
const HEX_ATTR = new Set<Attr>(['flag1', 'flag3', 'recfm']);
const INT_ATTR = new Set<Attr>(['lrecl', 'blksize']);
const DATE_ATTR = new Set<Attr>(['created', 'lastRef']);
/** pole kryterium -> potrzebny atrybut (flag1 jest zawsze) */
const NEEDS: Partial<Record<Field, Attr>> = {
    lrecl: 'lrecl', blksize: 'blksize', ageDays: 'created', unrefDays: 'lastRef', vol: 'vol', vols: 'vol',
    dsorg: 'dsorg', vsam: 'dsorg', recfm: 'recfm', sc: 'sc', mc: 'mc', dc: 'dc', sg: 'sg', createJob: 'createJob',
    ef: 'flag3',
};

export interface Store {
    /** liczba wierszy i zbiorow; dead[i] = 1: wiersz (komponent VSAM) dolaczony do klastra */
    rows: number;
    sets: number;
    dead: Uint8Array;
    /** nazwy: numer ciagu = numer wiersza (GDG juz bez GnnnnVnn) */
    names: Interner;
    allocKb: Float64Array;
    records: number;
    warnings: string[];
    num(field: NumField): (row: number) => number | null;
    str(field: StrField): (row: number) => string;
    bool(field: BoolField): (row: number) => boolean;
    /** numer wartosci pola (ten sam numer = ta sama wartosc) albo null, gdy pole nie ma numerow */
    code(field: StrField): ((row: number) => number) | null;
}

export function readStore(file: string, fields: ReadonlySet<Field>, tick: Tick = () => {}, today = new Date(),
    chunk = CHUNK): Store {
    const has = (...f: Field[]) => f.some(x => fields.has(x));
    const wantUsed = has('usedKb', 'usedTrk', 'freeTrk');
    const wantExt = has('extents');
    const wantVols = has('vols');
    const attrs = [...new Set<Attr>(['flag1', ...[...fields].flatMap(f => NEEDS[f] ?? [])])];
    const attrCol = attrs.map(a => ATTR_COLS[a]);
    const kind = attrs.map(a => (HEX_ATTR.has(a) ? 0 : INT_ATTR.has(a) ? 1 : DATE_ATTR.has(a) ? 2 : 3));
    const volAt = attrs.indexOf('vol');

    const names = new Interner();
    const values = new Interner();
    let cap = 1 << 16;
    let allocKb = new Float64Array(cap);
    let usedKb = new Float64Array(wantUsed ? cap : 0);
    let extents = new Float64Array(wantExt ? cap : 0);
    let volsq = new Int32Array(cap);
    let ord = new Int32Array(cap);
    const attr = attrs.map(() => new Int32Array(cap));
    const at = (a: Attr): Int32Array => attr[attrs.indexOf(a)];
    const ensure = (n: number) => {
        if (n <= cap) return;
        cap = Math.max(cap * 2, n);
        allocKb = grow(allocKb, cap);
        volsq = grow(volsq, cap);
        ord = grow(ord, cap);
        if (wantUsed) usedKb = grow(usedKb, cap);
        if (wantExt) extents = grow(extents, cap);
        for (let i = 0; i < attr.length; i++) attr[i] = grow(attr[i], cap);
    };
    /** wolumeny zbiorow z wiecej niz jednym rekordem (tylko dla pola vols) */
    const multi = new Map<number, Set<number>>();
    const addVol = (row: number, v: number) => {
        let s = multi.get(row);
        if (!s) multi.set(row, s = new Set([attr[volAt][row]]));
        s.add(v);
    };

    // rekordy A: komponent -> klaster (przetwarzane po wczytaniu wszystkich D)
    const aNames = new Interner();
    const aComp = new IntList();
    const aClus = new IntList();

    let buf = Buffer.allocUnsafe(chunk * 2);
    const fs0 = new Int32Array(NCOL);
    const fe0 = new Int32Array(NCOL);
    const scratch = new Int32Array(attrs.length);
    let lineNo = 0;
    let records = 0;
    let seenHeader = false;
    let binary = false;
    let binVolsq = 0;

    const isCtl = (b: number) => b < 32 || (b >= 0x7f && b <= 0x9f);
    const fail = (msg: string): never => {
        throw new CsvError(`wiersz ${lineNo}: ${msg}${binary ? HINT : ''}`);
    };
    const raw = (c: number) => buf.toString('latin1', fs0[c], fe0[c]);
    const clean = (c: number) => raw(c).replace(/[\x00-\x1f]/g, '').trim();
    const int = (c: number): number => {
        let v = 0;
        for (let i = fs0[c]; i < fe0[c]; i++) {
            const d = buf[i] - 48;
            if (d < 0 || d > 9) return slowInt(c);
            v = v * 10 + d;
        }
        return v;
    };
    const slowInt = (c: number): number => {
        const t = clean(c);
        if (t === '') return 0;
        if (!/^-?[0-9]+$/.test(t)) fail(`${DCOL_COLUMNS[c]} "${t}" nie jest liczba`);
        return Number(t);
    };
    const hex = (c: number): number => {
        let v = 0;
        for (let i = fs0[c]; i < fe0[c]; i++) {
            const b = buf[i];
            const d = b >= 48 && b <= 57 ? b - 48 : b >= 65 && b <= 70 ? b - 55 : b >= 97 && b <= 102 ? b - 87 : -1;
            if (d < 0) {
                const t = clean(c);
                if (t === '') return 0;
                if (!/^[0-9A-Fa-f]+$/.test(t)) fail(`${DCOL_COLUMNS[c]} "${t}" nie jest HEX`);
                return parseInt(t, 16);
            }
            v = v * 16 + d;
        }
        return v;
    };
    const dates = new Map<string, number>();
    const date = (c: number): number => {
        const t = raw(c);
        let d = dates.get(t);
        if (d === undefined) {
            const j = pdDate(t);
            dates.set(t, d = j ? julianToEpochDay(j) : -1);
        }
        return d;
    };
    /** pole w buforze bez spacji i znakow sterujacych; nazwa zbioru: wielkie litery */
    const squeeze = (c: number, upper: boolean): void => {
        let w = fs0[c];
        for (let i = fs0[c]; i < fe0[c]; i++) {
            const b = buf[i];
            if (b > 32) buf[w++] = upper && b >= 97 && b <= 122 ? b - 32 : b;
        }
        fe0[c] = w;
    };

    const line = (s: number, e: number): void => {
        while (e > s && buf[e - 1] <= 32) e--;
        if (e === s) return;
        let n = 0;
        let p = s;
        while (n < NCOL) {
            let i = p;
            while (i < e && buf[i] !== 59) {
                if (isCtl(buf[i])) binary = true;
                i++;
            }
            fs0[n] = p;
            fe0[n] = i;
            n++;
            if (i >= e) break;
            p = i + 1;
        }
        const type = fe0[0] - fs0[0] === 1 ? buf[fs0[0]] : 0;
        if (type === 68) record(n, s, e);
        else if (type === 65) {
            if (n < 3) return;
            squeeze(1, true);
            squeeze(2, true);
            if (fe0[1] > fs0[1] && fe0[2] > fs0[2]) {
                aComp.push(aNames.add(buf, fs0[1], fe0[1]));
                aClus.push(aNames.add(buf, fs0[2], fe0[2]));
            }
        } else {
            const t = clean(0);
            if (t !== 'T') fail(`nieznany typ rekordu "${t.slice(0, 20)}" (oczekiwano T, D, A)`);
            const got = buf.toString('latin1', s, e).split(';').map(x => x.trim()).join(';');
            if (got !== DCOL_COLUMNS.join(';')) {
                fail(`inny naglowek niz oczekiwany (wersja joba ACMCSV?)\n  jest:    ${got}\n`
                    + `  oczek.:  ${DCOL_COLUMNS.join(';')}`);
            }
            seenHeader = true;
        }
    };
    const record = (n: number, s: number, e: number): void => {
        // puste ostatnie pola: koniec linii moze byc obciety razem ze spacjami, ale nie ze srednikami
        if (n < NCOL) fail(`${buf.toString('latin1', s, e).split(';').length} kolumn, oczekiwano ${NCOL}`);
        const flag2 = hex(COL.FLAG2);
        const flag5 = hex(COL.FLAG5);
        const alloc = flag5 & 0x80 ? int(COL.ALLKBX) : flag2 & 0x08 ? int(COL.ALLKB) : 0;
        const used = !wantUsed ? 0 : flag5 & 0x40 ? int(COL.USEKBX) : flag2 & 0x04 ? int(COL.USEKB) : 0;
        let vq = 0;
        let vbin = false;
        for (let i = fs0[COL.VOLSQ]; i < fe0[COL.VOLSQ]; i++) if (isCtl(buf[i])) vbin = true;
        if (vbin) binVolsq++;
        else vq = int(COL.VOLSQ);
        squeeze(COL.DSN, true);
        const nameLen = fe0[COL.DSN] - fs0[COL.DSN];
        if (nameLen === 0) fail('pusta nazwa zbioru');
        if (nameLen > 255) fail(`nazwa zbioru dluzsza niz 255 znakow: ${raw(COL.DSN)}`);
        for (let k = 0; k < attrs.length; k++) {
            const c = attrCol[k];
            if (kind[k] === 0) scratch[k] = hex(c);
            else if (kind[k] === 1) scratch[k] = int(c);
            else if (kind[k] === 2) scratch[k] = date(c);
            else {
                squeeze(c, false);
                scratch[k] = values.add(buf, fs0[c], Math.min(fe0[c], fs0[c] + 255));
            }
        }
        const before = names.size;
        const row = names.add(buf, fs0[COL.DSN], fe0[COL.DSN]);
        const isNew = row === before;
        if (isNew) ensure(row + 1);
        else if (wantVols) addVol(row, scratch[volAt]);
        allocKb[row] += alloc;
        if (wantUsed) usedKb[row] += used;
        if (wantExt) extents[row] += int(COL.NEXT);
        if (isNew || vq < volsq[row]) {
            volsq[row] = vq;
            ord[row] = records;
            for (let k = 0; k < attrs.length; k++) attr[k][row] = scratch[k];
        }
        records++;
    };

    const fd = fs.openSync(file, 'r');
    try {
        const size = fs.fstatSync(fd).size;
        let keep = 0;
        let read = 0;
        let first = true;
        for (;;) {
            if (keep + chunk > buf.length) {
                const b = Buffer.allocUnsafe((keep + chunk) * 2);
                buf.copy(b, 0, 0, keep);
                buf = b;
            }
            const got = fs.readSync(fd, buf, keep, chunk, null);
            const end = keep + got;
            let s = 0;
            if (first && (end >= 3 || got === 0)) {
                if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf && end >= 3) s = 3;
                first = false;
            } else if (first) {
                keep = end;
                continue;
            }
            for (;;) {
                const nl = buf.subarray(0, end).indexOf(10, s);
                if (nl < 0) break;
                lineNo++;
                line(s, nl);
                s = nl + 1;
                if ((lineNo & 0x3fff) === 0) tick(size ? (read - keep + s) / size : 1, `${thousands(records)} rekordow`);
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
    } finally {
        fs.closeSync(fd);
    }
    if (!seenHeader && records > 0) {
        throw new CsvError('brak wiersza naglowka (T;DSN;...) - plik nie pochodzi z joba ACMCSV?');
    }
    const warnings = binVolsq
        ? [`${binVolsq} rekordow D z binarnym VOLSQ - pominiety (kolejnosc wolumenow jak w pliku).${HINT}`] : [];

    // komponenty VSAM -> klaster (dla komponentu z kilkoma rekordami A liczy sie ostatni)
    const clusterOf = new Int32Array(aNames.size).fill(-1);
    for (let i = 0; i < aComp.n; i++) clusterOf[aComp.a[i]] = aClus.a[i];
    const recRows = names.size;
    let dead = new Uint8Array(recRows);
    const clusterRows = new Set<number>();
    for (let comp = 0; comp < aNames.size; comp++) {
        const cl = clusterOf[comp];
        if (cl < 0 || cl === comp) continue;
        const src = names.find(aNames.pool, aNames.start[comp], aNames.start[comp] + aNames.len[comp]);
        if (src < 0 || src >= recRows) continue;
        const before = names.size;
        const dst = names.add(aNames.pool, aNames.start[cl], aNames.start[cl] + aNames.len[cl]);
        const isNew = dst === before;
        clusterRows.add(dst);
        ensure(dst + 1);
        if (dst >= dead.length) dead = grow(dead, dst + 1);
        if (wantVols) {
            if (isNew) attr[volAt][dst] = attr[volAt][src];
            for (const v of multi.get(src) ?? [attr[volAt][src]]) addVol(dst, v);
        }
        allocKb[dst] += allocKb[src];
        if (wantUsed) usedKb[dst] += usedKb[src];
        if (wantExt) extents[dst] += extents[src];
        if (isNew || volsq[src] < volsq[dst] || (volsq[src] === volsq[dst] && ord[src] < ord[dst])) {
            volsq[dst] = volsq[src];
            ord[dst] = ord[src];
            for (let k = 0; k < attrs.length; k++) attr[k][dst] = attr[k][src];
        }
        dead[src] = 1;
    }
    const rows = names.size;
    let sets = 0;
    for (let i = 0; i < rows; i++) if (!dead[i]) sets++;
    names.freeze();

    // generacje GDG: nazwa bez GnnnnVnn (jak &DSN w ACS)
    const f1 = at('flag1');
    const { pool, start, len } = names;
    const digit = (p: number) => pool[p] >= 48 && pool[p] <= 57;
    for (let i = 0; i < rows; i++) {
        if (!(f1[i] & 0x08) || len[i] < 10) continue;
        const p = start[i] + len[i] - 9;
        if (pool[p] === 46 && pool[p + 1] === 71 && digit(p + 2) && digit(p + 3) && digit(p + 4) && digit(p + 5)
            && pool[p + 6] === 86 && digit(p + 7) && digit(p + 8)) len[i] -= 9;
    }

    const todayDay = Math.floor(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) / 86400000);
    const allocTrk = (r: number) => Math.floor((allocKb[r] * 1024 + TRACK_BYTES / 2) / TRACK_BYTES);
    const usedTrk = (r: number) => Math.floor((usedKb[r] * 1024 + TRACK_BYTES - 1) / TRACK_BYTES);
    const of = (a: Attr) => {
        const col = at(a);
        return (r: number) => col[r];
    };
    const flag = (a: Attr, bit: number) => {
        const col = at(a);
        return (r: number) => (col[r] & bit) !== 0;
    };
    const days = (a: Attr) => {
        const col = at(a);
        return (r: number) => (col[r] < 0 ? null : todayDay - col[r]);
    };
    const dsorg = () => {
        const col = at('dsorg');
        const text: string[] = [];
        return (r: number) => (clusterRows.size && clusterRows.has(r) ? 'VS' : text[col[r]] ??= dsorgName(values.text(col[r])));
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
                    for (let p = start[r]; p < start[r] + len[r]; p++) if (pool[p] === 46) n++;
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
                    while (e < start[r] + len[r] && pool[e] !== 46) e++;
                    return latin1(pool, start[r], e);
                };
                case 'llq': return r => {
                    const e = start[r] + len[r];
                    let p = e;
                    while (p > start[r] && pool[p - 1] !== 46) p--;
                    return latin1(pool, p, e);
                };
                case 'dsorg': return dsorg();
                case 'recfm': {
                    const col = at('recfm');
                    return r => recfmName(col[r]);
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
