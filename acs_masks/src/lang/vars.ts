/**
 * Katalog zmiennych ACS (z/OS 3.2 DFSMSdfp Storage Administration, "Read-write variables",
 * "Read-only variables", "Special functions", "Constraints when using read-only variables").
 */
import type { Routine } from './ast';

export type VarType = 'char' | 'num' | 'size';

export interface VarInfo {
    name: string;
    type: VarType;
    /** najwieksza dlugosc wartosci znakowej */
    max?: number;
    desc: string;
    /** dozwolone wartosci (zmienne wyliczeniowe) */
    values?: string[];
    /** funkcja indeksowania: kwalifikator, pole rozliczeniowe, pozycja USER_ACSVAR, pole MSPARM */
    index?: 'qual' | 'acct' | 'uservar' | 'msparm';
    /** zmienna do ustawiania (SET) w danej rutynie */
    rw?: Routine;
    /** &ANYVOL / &ALLVOL: wiele wartosci */
    multi?: 'any' | 'all';
    /** nie wolno porownywac z maska (wg "Data set mask rules") */
    noMask?: boolean;
    /** niedozwolona w rutynie storage group */
    notInSg?: boolean;
    /** nazwa zbioru - maska ze znaczeniem kropek i ** */
    dsnLike?: boolean;
    /** skad wartosc w symulacji na danych DCOLLECT; brak = stala z konfiguracji (domyslnie pusta) */
    source?: string;
}

const v = (name: string, type: VarType, max: number | undefined, desc: string, extra: Partial<VarInfo> = {}): VarInfo =>
    ({ name, type, max, desc, ...extra });

const LIST: VarInfo[] = [
    v('DATACLAS', 'char', 8, 'Klasa danych (ustawiana w rutynie DATACLAS).', { rw: 'DATACLAS', source: 'wynik rutyny DC albo DCOLLECT' }),
    v('STORCLAS', 'char', 8, 'Klasa pamieci (ustawiana w rutynie STORCLAS).', { rw: 'STORCLAS', source: 'wynik rutyny SC albo DCOLLECT' }),
    v('MGMTCLAS', 'char', 8, 'Klasa zarzadzania (ustawiana w rutynie MGMTCLAS).', { rw: 'MGMTCLAS', source: 'wynik rutyny MC albo DCOLLECT' }),
    v('STORGRP', 'char', 8, 'Grupa pamieci, do 15 nazw (ustawiana tylko w rutynie STORGRP).', { rw: 'STORGRP', source: 'DCOLLECT' }),
    v('ACCT_JOB', 'char', 142, 'Informacje rozliczeniowe z karty JOB; &ACCT_JOB(n) = pole n (1-71).', { index: 'acct', notInSg: true }),
    v('ACCT_STEP', 'char', 142, 'Informacje rozliczeniowe z karty EXEC; &ACCT_STEP(n) = pole n (1-71).', { index: 'acct', notInSg: true }),
    v('ACSENVIR', 'char', 8, 'Srodowisko wywolania rutyny.', {
        noMask: true, source: 'stala (domyslnie ALLOC)',
        values: ['ALLOC', 'ALLOCTST', 'CHANGE', 'CONVERT', 'CTRANS', 'RECALL', 'RECOVER', 'RENAME', 'RMMPOOL', 'RMMVRS', 'SPMGCLTR', 'STORE'],
    }),
    v('ACSENVR2', 'char', 8, 'Podsrodowisko wywolania (wartosci &ACSENVIR, FLASHCPY albo puste).'),
    v('ALLVOL', 'char', 6, 'Numery wolumenow; porownanie prawdziwe, gdy WSZYSTKIE wolumeny spelniaja warunek. Z VOL=REF: REF=SD / REF=ST / REF=NS.',
        { multi: 'all', source: 'wolumeny zbioru z DCOLLECT' }),
    v('ANYVOL', 'char', 6, 'Numery wolumenow; porownanie prawdziwe, gdy KTORYKOLWIEK wolumen spelnia warunek. Z VOL=REF: REF=SD / REF=ST / REF=NS.',
        { multi: 'any', source: 'wolumeny zbioru z DCOLLECT' }),
    v('APPLIC', 'char', 8, 'Aplikacja wlasciciela zasobu (RACF, ACSDEFAULTS=YES).'),
    v('BLKSIZE', 'num', undefined, 'Rozmiar bloku z DD / alokacji dynamicznej.', { source: 'BLKSIZE z DCOLLECT' }),
    v('DATE', 'char', 7, 'Data wywolania rutyny, RRRRDDD.', { source: 'data odniesienia (--today)' }),
    v('DAYOFWEEK', 'char', 9, 'Dzien tygodnia (czas lokalny).', {
        values: ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'], source: 'data odniesienia (--today)',
    }),
    v('DB2SSID', 'char', 4, 'SSID podsystemu Db2 zwiazanego z OAM.'),
    v('DD', 'char', 8, 'Nazwa DD zbioru.', { notInSg: true }),
    v('DEF_DATACLAS', 'char', 8, 'Domyslna klasa danych wlasciciela zasobu (RACF, ACSDEFAULTS=YES).'),
    v('DEF_MGMTCLAS', 'char', 8, 'Domyslna klasa zarzadzania wlasciciela zasobu (RACF).'),
    v('DEF_STORCLAS', 'char', 8, 'Domyslna klasa pamieci wlasciciela zasobu (RACF).'),
    v('DSKEYLBL', 'char', 64, 'Etykieta klucza szyfrowania zbioru.'),
    v('DSN', 'char', 44, 'Nazwa zbioru (dla VSAM nazwa klastra; numer generacji GDS jest usuwany). &DSN(n) = kwalifikator n, &DSN(&NQUAL) = ostatni.',
        { index: 'qual', dsnLike: true, source: 'nazwa z DCOLLECT (klaster z rekordu A, GDS bez GnnnnVnn)' }),
    v('DSNTYPE', 'char', 7, 'Typ nazwy zbioru.', {
        noMask: true, values: ['BASIC', 'EXC', 'EXR', 'HFS', 'LARGE', 'LIBRARY', 'PDS'],
        source: 'przyblizenie z flag DCOLLECT: LIBRARY (PDSE), PDS, EXR (extended format), LARGE',
    }),
    v('DSN_VERSION', 'num', undefined, 'Wersja zbioru (PDSE / extended format): 0, 1, 2.'),
    v('DSORG', 'char', 2, 'Organizacja zbioru.', { noMask: true, values: ['PS', 'PO', 'VS', 'DA'], source: 'DSORG z DCOLLECT' }),
    v('DSOWNER', 'char', 8, 'Uzytkownik albo grupa - wlasciciel zbioru (RACF).'),
    v('DSTYPE', 'char', 8, 'Rodzaj zbioru.', { noMask: true, values: ['GDS', 'PERM', 'TEMP'], source: 'flagi GDS / TEMP z DCOLLECT, inaczej PERM' }),
    v('EATTR', 'char', 4, 'Atrybuty rozszerzone: OPT, NO albo puste.', { values: ['OPT', 'NO'] }),
    v('EXPDT', 'char', 7, 'Data wygasniecia RRRRDDD (1999365 / 1999366 = nigdy).', { source: 'EXPDT z DCOLLECT' }),
    v('FILENUM', 'num', undefined, 'Numer zbioru na tasmie (LABEL).'),
    v('GROUP', 'char', 8, 'Grupa RACF uzytkownika.'),
    v('HLQ', 'char', 8, 'Pierwszy kwalifikator nazwy zbioru.', { source: 'nazwa z DCOLLECT' }),
    v('JOB', 'char', 8, 'Nazwa joba, zadania startowanego albo uzytkownika TSO.', { notInSg: true, source: 'stala; opcjonalnie job tworzacy z DCOLLECT (@createJob)' }),
    v('LABEL', 'char', 3, 'Rodzaj etykiety tasmy (NL, AL, SL, NSL, SUL, AUL, BLP, LTM).', {
        noMask: true, values: ['NL', 'AL', 'SL', 'NSL', 'SUL', 'AUL', 'BLP', 'LTM'],
    }),
    v('LIBNAME', 'char', 8, 'Nazwa biblioteki tasmowej.'),
    v('LLQ', 'char', 8, 'Ostatni kwalifikator nazwy zbioru.', { source: 'nazwa z DCOLLECT' }),
    v('MAXGENS', 'num', undefined, 'Najwieksza liczba generacji memberow PDSE.'),
    v('MAXSIZE', 'size', undefined, 'Najwiekszy rozmiar nowego zbioru (KB / MB): pierwotna + wtorne alokacje.',
        { source: 'przyblizenie: alokacja z DCOLLECT (wtorna alokacja nieznana)' }),
    v('MEMHLQ', 'char', 8, 'Pierwszy kwalifikator nazwy obiektu (OAM).'),
    v('MEMLLQ', 'char', 8, 'Ostatni kwalifikator nazwy obiektu (OAM).'),
    v('MEMN', 'char', 44, 'Nazwa obiektu (OAM); &MEMN(n) = kwalifikator n.', { index: 'qual', dsnLike: true }),
    v('MEMNQUAL', 'num', undefined, 'Liczba kwalifikatorow nazwy obiektu (OAM).'),
    v('MSPDEST', 'char', 44, 'Miejsce docelowe tasmy (format nazwy zbioru).', { dsnLike: true }),
    v('MSPARM', 'char', 142, 'Parametry systemu tasm wirtualnych; &MSPARM(n) = pole n.', { index: 'msparm' }),
    v('MSPOLICY', 'char', 8, 'Polityka zarzadzania tasma.'),
    v('MSPOOL', 'char', 8, 'Pula tasm.'),
    v('MSVGP', 'char', 8, 'Grupa wolumenow MSS.', { notInSg: true }),
    v('NQUAL', 'num', undefined, 'Liczba kwalifikatorow nazwy zbioru (do 22).', { source: 'nazwa z DCOLLECT' }),
    v('NVOL', 'num', undefined, 'Liczba wolumenow (najwieksza z: volume count, unit count, liczba VOL=SER).', { source: 'liczba wolumenow zbioru z DCOLLECT' }),
    v('PGM', 'char', 8, 'Nazwa wykonywanego programu.', { notInSg: true }),
    v('RECORG', 'char', 2, 'Organizacja rekordow VSAM.', { noMask: true, values: ['KS', 'ES', 'RR', 'LS', 'FS'], source: 'flagi rekordu A z DCOLLECT' }),
    v('RETPD', 'num', undefined, 'Okres przechowywania w dniach (liczony z &EXPDT).', { source: 'EXPDT z DCOLLECT minus data odniesienia' }),
    v('SECLABL', 'char', 8, 'Etykieta bezpieczenstwa (RACF SECLABEL).'),
    v('SECOND_QTY', 'num', undefined, 'Wtorna alokacja z JCL / AMS (razem ze &SPACE_TYPE).'),
    v('SIZE', 'size', undefined, 'Rozmiar: pierwotna alokacja nowego zbioru albo przestrzen uzyta w istniejacym (KB / MB).',
        { source: 'alokacja z DCOLLECT (albo uzycie - opcja)' }),
    v('SPACE_TYPE', 'char', 3, 'Jednostka alokacji z JCL / AMS.', { values: ['TRK', 'CYL', 'K', 'M', 'U', 'BLK'] }),
    v('STEP', 'char', 8, 'Nazwa kroku joba.'),
    v('SYSNAME', 'char', 8, 'Nazwa systemu, na ktorym dziala rutyna.'),
    v('SYSPLEX', 'char', 8, 'Nazwa sysplexu.'),
    v('TIME', 'char', 5, 'Czas lokalny wywolania, GG:MM.'),
    v('UNIT', 'char', 8, 'Nazwa generyczna urzadzenia (3390, SYSDA...).'),
    v('USER', 'char', 8, 'Identyfikator uzytkownika alokujacego zbior.'),
    v('USER_ACSVAR', 'char', 8, 'Zmienna instalacji z IGDSMSxx (USER_ACSVAR); &USER_ACSVAR(n), n = 1-3.', { index: 'uservar' }),
    v('XMODE', 'char', 8, 'Tryb wykonania.', { noMask: true, notInSg: true, values: ['BATCH', 'TSO', 'TASK'] }),
];

export const VARS: ReadonlyMap<string, VarInfo> = new Map(LIST.map(x => [x.name, x]));
export const VAR_LIST: readonly VarInfo[] = LIST;

/** Zmienna ustawiana przez rutyne danego typu. */
export const RW_OF: Record<Routine, string> = {
    DATACLAS: 'DATACLAS', STORCLAS: 'STORCLAS', MGMTCLAS: 'MGMTCLAS', STORGRP: 'STORGRP',
};

/** Wartosci RACF, ktore wolno przypisac w SET. */
export const DEF_OF: Partial<Record<Routine, string>> = {
    DATACLAS: 'DEF_DATACLAS', STORCLAS: 'DEF_STORCLAS', MGMTCLAS: 'DEF_MGMTCLAS',
};
