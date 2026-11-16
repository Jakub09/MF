/** Budowanie CSV jak z joba ACMCSV (do testow). */
import { DCOL_COLUMNS } from '../src/dataset';

export interface DOpts {
    dsn: string;
    vol?: string;
    volsq?: number;
    dsorg?: string;
    recfm?: string;
    lrecl?: number;
    blk?: number;
    ext?: number;
    f1?: string;
    f2?: string;
    f3?: string;
    f5?: string;
    allkb?: number;
    usekb?: number;
    allx?: number;
    usex?: number;
    cre?: string;
    lst?: string;
    exp?: string;
    sc?: string;
    mc?: string;
    dc?: string;
    sg?: string;
    job?: string;
}

export const HEADER = DCOL_COLUMNS.join(';');

/** Linia D; domyslnie PS FB 80, SMS, przestrzen 31-bit zwrocona (FLAG2 X'0C'). */
export function dline(o: DOpts): string {
    return [
        'D', o.dsn, o.vol ?? 'VOL001', String(o.volsq ?? 1).padStart(2, '0'), o.dsorg ?? '4000', o.recfm ?? '90',
        o.lrecl ?? 80, o.blk ?? 27920, o.ext ?? 1, o.f1 ?? '40', o.f2 ?? '0C', o.f3 ?? '00', o.f5 ?? '00',
        o.allkb ?? 0, o.usekb ?? 0, o.allx ?? 0, o.usex ?? 0, o.cre ?? '2024100F', o.lst ?? '2026300F',
        o.exp ?? '0000000F', o.sc ?? 'SCSTD', o.mc ?? 'MCSTD', o.dc ?? 'DCSTD', o.sg ?? 'SG1', o.job ?? 'JOB1',
    ].join(';');
}

/** KB dajace dokladnie n sciezek alokacji (ROUND). */
export const kbForTrk = (n: number) => Math.ceil(n * 56664 / 1024);

export function csv(lines: string[]): string {
    return [HEADER, ...lines].join('\n') + '\n';
}

/** Prosty deterministyczny generator liczb losowych (testy powtarzalne). */
export function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0x100000000;
    };
}
