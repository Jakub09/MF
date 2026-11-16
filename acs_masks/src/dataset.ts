/**
 * CSV z joba ACMCSV (z/OS): rekordy 'D' (zbior na wolumenie) i 'A' (komponent VSAM -> klaster).
 * Separator ';', pierwszy wiersz naglowka zaczyna sie od 'T;'. Kolumny rekordu D - DCOL_COLUMNS.
 *
 * Zbior wielowolumenowy (kilka rekordow D) -> jeden zbior: przestrzen zsumowana, atrybuty z pierwszego
 * rekordu (najnizszy numer wolumenu). Sciezki 3390 jak w raports/jcl/DCRPTOVR:
 *   alokacja = ROUND(KB * 1024 / 56664), uzycie = W GORE(KB * 1024 / 56664).
 * Komponenty VSAM (.DATA/.INDEX) -> klaster z rekordu A (ACS widzi nazwe klastra), przestrzen zsumowana.
 */
import fs from 'node:fs';

export const DCOL_COLUMNS = [
    'T', 'DSN', 'VOLSER', 'VOLSQ', 'DSORG', 'RECFM', 'LRECL', 'BLKSZ', 'NEXT', 'FLAG1', 'FLAG2', 'FLAG3', 'FLAG5',
    'ALLKB', 'USEKB', 'ALLKBX', 'USEKBX', 'CREDT', 'LSTRF', 'EXPDT', 'SC', 'MC', 'DC', 'SG', 'CJOB',
] as const;

const TRACK_BYTES = 56664;

export interface DataSet {
    dsn: string;
    quals: string[];
    hlq: string;
    llq: string;
    nqual: number;
    vol: string;
    vols: number;
    /** PS, PO, DA, IS, VS albo '' (nieznana) */
    dsorg: string;
    /** np. FB, VB, VBS, FBA, U; '' dla VSAM */
    recfm: string;
    lrecl: number;
    blksize: number;
    extents: number;
    allocKb: number;
    usedKb: number;
    allocTrk: number;
    usedTrk: number;
    freeTrk: number;
    /** RRRRDDD albo null */
    created: string | null;
    lastRef: string | null;
    expdt: string | null;
    /** dni od utworzenia / ostatniego uzycia do daty odniesienia (null - brak daty) */
    ageDays: number | null;
    unrefDays: number | null;
    sc: string;
    mc: string;
    dc: string;
    sg: string;
    sms: boolean;
    temp: boolean;
    pdse: boolean;
    gds: boolean;
    ef: boolean;
    vsam: boolean;
    /** job, ktory utworzyl zbior */
    createJob: string;
    /** nazwy komponentow VSAM zlaczonych w ten klaster */
    components: string[];
}

export class CsvError extends Error {}

interface RawD {
    dsn: string;
    vol: string;
    volsq: number;
    dsorg: string;
    recfm: string;
    lrecl: number;
    blksize: number;
    extents: number;
    allocKb: number;
    usedKb: number;
    created: string | null;
    lastRef: string | null;
    expdt: string | null;
    sc: string;
    mc: string;
    dc: string;
    sg: string;
    flag1: number;
    flag3: number;
    createJob: string;
}

const clean = (s: string | undefined): string => (s ?? '').replace(/[\x00-\x1f]/g, '').trim();

function int(s: string | undefined, what: string, line: number): number {
    const t = clean(s);
    if (t === '') return 0;
    if (!/^-?[0-9]+$/.test(t)) throw new CsvError(`wiersz ${line}: ${what} "${t}" nie jest liczba`);
    return Number(t);
}

function hexByte(s: string | undefined, what: string, line: number): number {
    const t = clean(s);
    if (t === '') return 0;
    if (!/^[0-9A-Fa-f]+$/.test(t)) throw new CsvError(`wiersz ${line}: ${what} "${t}" nie jest HEX`);
    return parseInt(t, 16);
}

/** Data PD jako HEX (RRRRDDDF) -> RRRRDDD; 0 / niepoprawna -> null. */
export function pdDate(hex: string | undefined): string | null {
    const t = clean(hex).toUpperCase();
    const m = /^([0-9]{4})([0-9]{3})[0-9A-F]$/.exec(t);
    if (!m) return null;
    const year = Number(m[1]);
    const day = Number(m[2]);
    if (year === 0 || day < 1 || day > 366) return null;
    return m[1] + m[2];
}

/** RRRRDDD -> liczba dni od 1970-01-01 (UTC). */
export function julianToEpochDay(j: string): number {
    const year = Number(j.slice(0, 4));
    const day = Number(j.slice(4));
    return Math.floor(Date.UTC(year, 0, 1) / 86400000) + day - 1;
}

export function dsorgName(hex: string): string {
    const v = parseInt(hex.padEnd(4, '0').slice(0, 4), 16) || 0;
    const b0 = v >> 8;
    const b1 = v & 0xff;
    if (b1 & 0x08) return 'VS';
    if (b0 & 0x02) return 'PO';
    if (b0 & 0x40) return 'PS';
    if (b0 & 0x20) return 'DA';
    if (b0 & 0x80) return 'IS';
    return '';
}

export function recfmName(b: number): string {
    const kind = b >> 6;
    if (kind === 0) return '';
    let r = kind === 2 ? 'F' : kind === 1 ? 'V' : 'U';
    if (b & 0x10) r += 'B';
    if (b & 0x08) r += 'S';
    if (b & 0x04) r += 'A';
    if (b & 0x02) r += 'M';
    return r;
}


export interface ParsedCsv {
    d: RawD[];
    /** komponent VSAM -> klaster */
    assoc: Map<string, string>;
    /** ostrzezenia dla uzytkownika (np. CSV ze starej wersji joba) */
    warnings: string[];
}

/** Znaki sterujace / nieprzeliczalne po transferze (bajty binarne w CSV). */
const BINARY = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\ufffd]/;
const OLD_JOB_HINT = 'CSV zawiera bajty binarne (np. NUL SOH) - pochodzi ze starej wersji joba ACMCSV,'
    + ' ktora zapisywala VOLSQ binarnie; uruchom ACMCSV ponownie (wersja z E_VOLSQ)';

export function parseCsv(text: string): ParsedCsv {
    const d: RawD[] = [];
    const assoc = new Map<string, string>();
    const lines = text.split(/\r?\n/);
    let seenHeader = false;
    let binVolsq = 0;
    const hint = BINARY.test(text) ? `\n  (${OLD_JOB_HINT})` : '';
    lines.forEach((raw, i) => {
        const line = i + 1;
        const l = raw.replace(/\s+$/, '');
        if (l === '') return;
        const f = l.split(';');
        const t = clean(f[0]);
        if (t === 'T') {
            const got = f.map(clean).join(';');
            if (got !== DCOL_COLUMNS.join(';')) {
                throw new CsvError(`wiersz ${line}: inny naglowek niz oczekiwany (wersja joba ACMCSV?)\n`
                    + `  jest:    ${got}\n  oczek.:  ${DCOL_COLUMNS.join(';')}`);
            }
            seenHeader = true;
            return;
        }
        if (t === 'A') {
            const comp = clean(f[1]);
            const cl = clean(f[2]);
            if (comp && cl) assoc.set(comp, cl);
            return;
        }
        if (t !== 'D') throw new CsvError(`wiersz ${line}: nieznany typ rekordu "${t}" (oczekiwano T, D, A)${hint}`);
        if (f.length < DCOL_COLUMNS.length) {
            throw new CsvError(`wiersz ${line}: ${f.length} kolumn, oczekiwano ${DCOL_COLUMNS.length}${hint}`);
        }
        const col = (name: (typeof DCOL_COLUMNS)[number]) => f[DCOL_COLUMNS.indexOf(name)];
        const flag2 = hexByte(col('FLAG2'), 'FLAG2', line);
        const flag5 = hexByte(col('FLAG5'), 'FLAG5', line);
        // przestrzen: 63-bit, gdy wazna, inaczej 31-bit, gdy zwrocona, inaczej 0 (jak DCRPTOVR)
        const allocKb = flag5 & 0x80 ? int(col('ALLKBX'), 'ALLKBX', line)
            : flag2 & 0x08 ? int(col('ALLKB'), 'ALLKB', line) : 0;
        const usedKb = flag5 & 0x40 ? int(col('USEKBX'), 'USEKBX', line)
            : flag2 & 0x04 ? int(col('USEKB'), 'USEKB', line) : 0;
        // VOLSQ binarny (stara wersja ACMCSV): nieznany -> 0, kolejnosc wolumenow jak w DCOLLECT
        const vq = col('VOLSQ') ?? '';
        const volsq = BINARY.test(vq) ? (binVolsq++, 0) : int(vq, 'VOLSQ', line);
        const dsn = clean(col('DSN')).toUpperCase();
        if (!dsn) throw new CsvError(`wiersz ${line}: pusta nazwa zbioru`);
        d.push({
            dsn,
            vol: clean(col('VOLSER')),
            volsq,
            dsorg: dsorgName(clean(col('DSORG'))),
            recfm: recfmName(hexByte(col('RECFM'), 'RECFM', line)),
            lrecl: int(col('LRECL'), 'LRECL', line),
            blksize: int(col('BLKSZ'), 'BLKSZ', line),
            extents: int(col('NEXT'), 'NEXT', line),
            allocKb,
            usedKb,
            created: pdDate(col('CREDT')),
            lastRef: pdDate(col('LSTRF')),
            expdt: pdDate(col('EXPDT')),
            sc: clean(col('SC')),
            mc: clean(col('MC')),
            dc: clean(col('DC')),
            sg: clean(col('SG')),
            flag1: hexByte(col('FLAG1'), 'FLAG1', line),
            flag3: hexByte(col('FLAG3'), 'FLAG3', line),
            createJob: clean(col('CJOB')),
        });
    });
    if (!seenHeader && d.length > 0) {
        throw new CsvError('brak wiersza naglowka (T;DSN;...) - plik nie pochodzi z joba ACMCSV?');
    }
    const warnings = binVolsq > 0
        ? [`${binVolsq} rekordow D z binarnym VOLSQ - pominiety (kolejnosc wolumenow jak w pliku). ${OLD_JOB_HINT}`]
        : [];
    return { d, assoc, warnings };
}

export interface BuildOptions {
    /** komponenty VSAM -> klaster (domyslnie tak, gdy w CSV sa rekordy A) */
    vsamCluster: boolean;
    /** data odniesienia dla ageDays/unrefDays (domyslnie dzis) */
    today: Date;
}

const trkRound = (kb: number) => Math.floor((kb * 1024 + TRACK_BYTES / 2) / TRACK_BYTES);
const trkUp = (kb: number) => Math.floor((kb * 1024 + TRACK_BYTES - 1) / TRACK_BYTES);

/** Rekordy D -> zbiory (jeden na nazwe). */
export function buildDataSets(p: ParsedCsv, opt: BuildOptions): DataSet[] {
    const todayDay = Math.floor(Date.UTC(opt.today.getUTCFullYear(), opt.today.getUTCMonth(),
        opt.today.getUTCDate()) / 86400000);
    const byName = new Map<string, { recs: RawD[]; components: Set<string> }>();
    for (const r of p.d) {
        const cluster = opt.vsamCluster ? p.assoc.get(r.dsn) : undefined;
        const name = cluster ?? r.dsn;
        let e = byName.get(name);
        if (!e) byName.set(name, e = { recs: [], components: new Set() });
        e.recs.push(r);
        if (cluster) e.components.add(r.dsn);
    }
    const out: DataSet[] = [];
    for (const [dsn, e] of byName) {
        const recs = [...e.recs].sort((a, b) => a.volsq - b.volsq);
        const f = recs[0];
        const allocKb = recs.reduce((s, r) => s + r.allocKb, 0);
        const usedKb = recs.reduce((s, r) => s + r.usedKb, 0);
        const allocTrk = trkRound(allocKb);
        const usedTrk = trkUp(usedKb);
        const quals = dsn.split('.');
        const vsam = f.dsorg === 'VS' || e.components.size > 0;
        out.push({
            dsn,
            quals,
            hlq: quals[0],
            llq: quals[quals.length - 1],
            nqual: quals.length,
            vol: f.vol,
            vols: new Set(recs.map(r => r.vol)).size,
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
            components: [...e.components].sort(),
        });
    }
    out.sort((a, b) => (a.dsn < b.dsn ? -1 : a.dsn > b.dsn ? 1 : 0));
    return out;
}

export function readDataSets(file: string, opt: Partial<BuildOptions> & { encoding?: BufferEncoding } = {}): {
    dataSets: DataSet[];
    dRecords: number;
    assoc: number;
    warnings: string[];
} {
    const text = fs.readFileSync(file, opt.encoding ?? 'utf-8');
    const p = parseCsv(text);
    const dataSets = buildDataSets(p, {
        vsamCluster: opt.vsamCluster ?? p.assoc.size > 0,
        today: opt.today ?? new Date(),
    });
    return { dataSets, dRecords: p.d.length, assoc: p.assoc.size, warnings: p.warnings };
}
