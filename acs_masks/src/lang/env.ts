/**
 * Wartosci zmiennych ACS dla zbioru z DCOLLECT (CSV z joba ACMCSV).
 *
 * Z DCOLLECT da sie wyliczyc tylko czesc zmiennych (kolumna "source" w vars.ts). Pozostale (&JOB, &PGM,
 * &USER, &UNIT, &XMODE...) maja wartosc stala z opcji "vars" - domyslnie pusta, &ACSENVIR = 'ALLOC'.
 * Wartosc "@pole" w "vars" bierze pole zbioru, np. { "JOB": "@createJob" }.
 *
 * Przyblizenia (do weryfikacji z NaviQuest):
 *  - &DSN zbioru GDS: bez ostatniego kwalifikatora GnnnnVnn (ACS dostaje nazwe bez numeru generacji)
 *  - &SIZE i &MAXSIZE: alokacja (albo uzycie) z DCOLLECT w KB; wtorna alokacja nie jest znana
 *  - &DSNTYPE: HFS, LIBRARY (PDSE), PDS, EXR (extended format), LARGE albo pusta
 *  - &ANYVOL / &ALLVOL: wolumeny, na ktorych zbior lezy (opcja volumes: 'none' = puste)
 *  - &RECORG: z flag rekordu A (bez FS - zFS)
 */
import type { DataSet } from '../dataset';
import { VARS } from 'acs-routines/lang/vars';

export type Value = string | number | string[];

export interface EnvOptions {
    /** &SIZE / &MAXSIZE: alokacja czy uzycie */
    size: 'alloc' | 'used';
    /** &ANYVOL / &ALLVOL / &NVOL: z DCOLLECT czy puste (alokacja bez wskazania wolumenu) */
    volumes: 'dcollect' | 'none';
    /** usuwac GnnnnVnn z nazwy GDS */
    gdsStrip: boolean;
    /** data odniesienia (&DATE, &DAYOFWEEK, &RETPD) */
    today: Date;
    /** stale wartosci zmiennych albo "@pole" zbioru */
    vars: Record<string, string>;
}

export const DEFAULT_ENV: Omit<EnvOptions, 'today'> = { size: 'alloc', volumes: 'dcollect', gdsStrip: true, vars: {} };

export interface Env {
    ds: DataSet;
    /** kwalifikatory &DSN */
    quals: string[];
    values: Record<string, Value>;
}

const GDS_LLQ = /^G\d{4}V\d{2}$/;
const DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const DSORGS = new Set(['PS', 'PO', 'DA', 'VS']);

function julian(d: Date): string {
    const start = Date.UTC(d.getUTCFullYear(), 0, 1);
    const day = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - start) / 86400000) + 1;
    return `${d.getUTCFullYear()}${String(day).padStart(3, '0')}`;
}

const julianDay = (j: string) => Math.floor(Date.UTC(Number(j.slice(0, 4)), 0, 1) / 86400000) + Number(j.slice(4)) - 1;

/** Stale czesci srodowiska (wspolne dla wszystkich zbiorow). */
export interface EnvBase {
    opt: EnvOptions;
    date: string;
    todayDay: number;
    dayOfWeek: string;
    consts: [string, string][];
    fields: [string, keyof DataSet][];
}

export function envBase(opt: EnvOptions): EnvBase {
    const consts: [string, string][] = [];
    const fields: [string, keyof DataSet][] = [];
    for (const [k, val] of Object.entries(opt.vars)) {
        const name = k.replace(/^&/, '').toUpperCase();
        if (!VARS.has(name)) throw new Error(`vars: nieznana zmienna ACS &${name}`);
        if (val.startsWith('@')) fields.push([name, val.slice(1) as keyof DataSet]);
        else consts.push([name, val.toUpperCase()]);
    }
    const date = julian(opt.today);
    return { opt, date, todayDay: julianDay(date), dayOfWeek: DAYS[opt.today.getUTCDay()], consts, fields };
}

const typed = (name: string, val: string): Value => (VARS.get(name)!.type === 'char' ? val : Number(val) || 0);

export function makeEnv(ds: DataSet, base: EnvBase): Env {
    const opt = base.opt;
    let quals = ds.quals;
    if (opt.gdsStrip && ds.gds && quals.length > 1 && GDS_LLQ.test(ds.llq)) quals = quals.slice(0, -1);
    const kb = opt.size === 'alloc' ? ds.allocKb : ds.usedKb;
    const never = ds.expdt === '1999365' || ds.expdt === '1999366';
    const vols = opt.volumes === 'dcollect' && ds.volsers.length ? ds.volsers : [''];
    const values: Record<string, Value> = {
        ACSENVIR: 'ALLOC',
        DSN: quals.join('.'),
        HLQ: quals[0] ?? '',
        LLQ: quals[quals.length - 1] ?? '',
        NQUAL: quals.length,
        DSORG: DSORGS.has(ds.dsorg) ? ds.dsorg : '',
        RECORG: ds.recorg,
        DSNTYPE: ds.hfs ? 'HFS' : ds.pdse ? 'LIBRARY' : ds.dsorg === 'PO' ? 'PDS' : ds.ef ? 'EXR' : ds.large ? 'LARGE' : '',
        DSTYPE: ds.gds ? 'GDS' : ds.temp ? 'TEMP' : 'PERM',
        SIZE: kb,
        MAXSIZE: kb,
        BLKSIZE: ds.blksize,
        EXPDT: ds.expdt ?? '',
        RETPD: ds.expdt && !never ? Math.max(0, julianDay(ds.expdt) - base.todayDay) : 0,
        NVOL: opt.volumes === 'dcollect' ? ds.vols : 0,
        ANYVOL: vols,
        ALLVOL: vols,
        DATACLAS: ds.dc,
        STORCLAS: ds.sc,
        MGMTCLAS: ds.mc,
        STORGRP: ds.sg,
        DATE: base.date,
        DAYOFWEEK: base.dayOfWeek,
        TIME: '00:00',
    };
    for (const [name, val] of base.consts) values[name] = typed(name, val);
    for (const [name, field] of base.fields) {
        const raw = ds[field];
        values[name] = typed(name, raw === null || raw === undefined ? '' : String(raw).toUpperCase());
    }
    return { ds, quals, values };
}

/** Wartosc zmiennej; brak danych = '' (zmienna znakowa) albo 0 (liczbowa). */
export function getVar(env: Env, name: string, index?: number | string): Value {
    if (index !== undefined && (name === 'DSN')) {
        const i = typeof index === 'number' ? index : env.quals.length;
        return env.quals[i - 1] ?? '';
    }
    const val = env.values[name];
    if (val !== undefined) return val;
    return VARS.get(name)?.type === 'char' ? '' : 0;
}

/** Zmienne z danymi z DCOLLECT (pozostale sa stale dla wszystkich zbiorow). */
export const DERIVED = new Set(['DSN', 'HLQ', 'LLQ', 'NQUAL', 'DSORG', 'RECORG', 'DSNTYPE', 'DSTYPE', 'SIZE', 'MAXSIZE',
    'BLKSIZE', 'EXPDT', 'RETPD', 'NVOL', 'ANYVOL', 'ALLVOL', 'DATACLAS', 'STORCLAS', 'MGMTCLAS', 'STORGRP']);
