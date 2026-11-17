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
import readline from 'node:readline';

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
    /** wolumeny zbioru w kolejnosci numerow wolumenu */
    volsers: string[];
    /** pierwszy rekord D zbioru: nazwa z DCOLLECT (dla klastra VSAM - komponent) i wolumen */
    recDsn: string;
    /** VSAM wg rekordu A: KS, ES, RR, LS albo '' */
    recorg: string;
    /** large format (DCDGT64K) */
    large: boolean;
    /** plik systemu plikow POSIX (DCDPDSEX) */
    hfs: boolean;
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
    /** komponent VSAM -> DCAFLAG1 */
    assocFlag: Map<string, number>;
    /** ostrzezenia dla uzytkownika (np. CSV ze starej wersji joba) */
    warnings: string[];
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
export class CsvReader {
    private d: RawD[] = [];
    private assoc = new Map<string, string>();
    private assocFlag = new Map<string, number>();
    private seenHeader = false;
    private binVolsq = 0;
    /** bajty binarne w dotychczas wczytanych liniach (podpowiedz przy bledzie) */
    private binarySeen = false;
    private pool = new Map<string, string>();
    lines = 0;

    private intern(v: string): string {
        const hit = this.pool.get(v);
        if (hit !== undefined) return hit;
        const copy = fresh(v);
        this.pool.set(copy, copy);
        return copy;
    }

    /** Jedna linia pliku (bez znaku konca linii); line - numer od 1. */
    line(raw: string, line: number): void {
        this.lines = line;
        if (!this.binarySeen && BINARY.test(raw)) this.binarySeen = true;
        const l = raw.replace(/\s+$/, '');
        if (l === '') return;
        const hint = this.binarySeen ? `\n  (${OLD_JOB_HINT})` : '';
        const f = l.split(';');
        const t = clean(f[0]);
        if (t === 'T') {
            const got = f.map(clean).join(';');
            if (got !== DCOL_COLUMNS.join(';')) {
                throw new CsvError(`wiersz ${line}: inny naglowek niz oczekiwany (wersja joba ACMCSV?)\n`
                    + `  jest:    ${got}\n  oczek.:  ${DCOL_COLUMNS.join(';')}`);
            }
            this.seenHeader = true;
            return;
        }
        if (t === 'A') {
            const comp = clean(f[1]);
            const cl = clean(f[2]);
            if (comp && cl) this.assoc.set(fresh(comp), fresh(cl));
            const fl = clean(f[3]);
            if (comp && /^[0-9A-Fa-f]{2}$/.test(fl)) this.assocFlag.set(fresh(comp), parseInt(fl, 16));
            return;
        }
        if (t !== 'D') throw new CsvError(`wiersz ${line}: nieznany typ rekordu "${t}" (oczekiwano T, D, A)${hint}`);
        if (f.length < DCOL_COLUMNS.length) {
            throw new CsvError(`wiersz ${line}: ${f.length} kolumn, oczekiwano ${DCOL_COLUMNS.length}${hint}`);
        }
        const col = (name: (typeof DCOL_COLUMNS)[number]) => f[COL_INDEX[name]];
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
        if (!dsn) throw new CsvError(`wiersz ${line}: pusta nazwa zbioru`);
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

    finish(): ParsedCsv {
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

const COL_INDEX = Object.fromEntries(DCOL_COLUMNS.map((c, i) => [c, i])) as Record<(typeof DCOL_COLUMNS)[number], number>;

/** Kopia napisu niezalezna od linii, z ktorej pochodzi (V8 trzyma wycinki jako odwolania do calosci). */
function fresh(s: string): string {
    return s.length === 0 ? '' : Buffer.from(s, 'utf8').toString('utf8');
}

/** CSV z napisu (testy, male pliki). */
export function parseCsv(text: string): ParsedCsv {
    const r = new CsvReader();
    let i = 0;
    let no = 0;
    while (i <= text.length) {
        let j = text.indexOf('\n', i);
        if (j < 0) j = text.length;
        const raw = text.slice(i, j);
        r.line(raw.endsWith('\r') ? raw.slice(0, -1) : raw, ++no);
        i = j + 1;
    }
    return r.finish();
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
        // zwalnianie rekordow D w trakcie budowania (duze CSV: nie trzymac rekordow i zbiorow naraz)
        byName.delete(dsn);
        const recs = [...e.recs].sort((a, b) => a.volsq - b.volsq);
        const f = recs[0];
        const allocKb = recs.reduce((s, r) => s + r.allocKb, 0);
        const usedKb = recs.reduce((s, r) => s + r.usedKb, 0);
        const allocTrk = trkRound(allocKb);
        const usedTrk = trkUp(usedKb);
        const quals = dsn.split('.');
        const vsam = f.dsorg === 'VS' || e.components.size > 0;
        let aflag = 0;
        for (const r of recs) aflag |= p.assocFlag.get(r.dsn) ?? 0;
        const recorg = aflag & 0x80 ? 'KS' : aflag & 0x40 ? 'ES' : aflag & 0x20 ? 'RR' : aflag & 0x10 ? 'LS' : '';
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
            volsers: [...new Set(recs.map(r => r.vol))],
            recDsn: f.dsn,
            recorg,
            large: (f.flag3 & 0x08) !== 0,
            hfs: (f.flag3 & 0x80) !== 0,
        });
    }
    out.sort((a, b) => (a.dsn < b.dsn ? -1 : a.dsn > b.dsn ? 1 : 0));
    return out;
}

export interface ReadOptions extends Partial<BuildOptions> {
    encoding?: BufferEncoding;
    /** wielkosc porcji czytanej z pliku (domyslnie 1 MB) */
    chunkSize?: number;
    /** postep: liczba linii i czesc pliku 0-1, wywolywany co progressEvery linii */
    onProgress?: (lines: number, fraction: number) => void;
    progressEvery?: number;
}

/**
 * Wczytanie CSV strumieniowo: plik jest czytany porcjami (chunkSize) i przetwarzany linia po linii, wiec nie musi
 * sie zmiescic w pamieci jako tekst (limit napisu V8 to ok. 512 MB). W pamieci zostaja tylko rekordy D i A.
 */
export async function readDataSets(file: string, opt: ReadOptions = {}): Promise<{
    dataSets: DataSet[];
    dRecords: number;
    assoc: number;
    lines: number;
    warnings: string[];
}> {
    const size = fs.statSync(file).size;
    const stream = fs.createReadStream(file, { encoding: opt.encoding ?? 'utf-8', highWaterMark: opt.chunkSize ?? 1 << 20 });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const reader = new CsvReader();
    const every = opt.progressEvery ?? 1_000_000;
    let no = 0;
    try {
        for await (const raw of rl) {
            reader.line(raw, ++no);
            if (opt.onProgress && no % every === 0) opt.onProgress(no, size ? stream.bytesRead / size : 1);
        }
    } finally {
        rl.close();
        stream.destroy();
    }
    const p = reader.finish();
    const dRecords = p.d.length;
    const dataSets = buildDataSets(p, {
        vsamCluster: opt.vsamCluster ?? p.assoc.size > 0,
        today: opt.today ?? new Date(),
    });
    return { dataSets, dRecords, assoc: p.assoc.size, lines: no, warnings: p.warnings };
}
