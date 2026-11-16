/**
 * Karty dla joba ACMREPR (z/OS): kazda maska -> IFTHEN ustawiajacy 'Y' w wektorze masek rekordu.
 * Zbiory o tym samym wektorze (i atrybutach) tworza grupe - jeden test NaviQuest.
 *
 * Membery (FB 80, kolumny 1-71):
 *   ACMCARD - karty IFTHEN (wstawiane w INREC kroku NRM1 miedzy karty stale)
 *   ACMSYMV - symbole zalezne od liczby masek (dlugosci wektora): A_VEC, A_VECD, B_*, G_*
 *   ACMLIST - lista: numer maski (kolumna w wektorze), regula, rodzaj, maska - do odczytu raportow
 *
 * Uklad rekordu DSX/DSK - musi byc zgodny z sym/ACMREPR.TXT (test: test/dfsort.test.ts):
 *   A_NQ 240 (2, ZD), A_Q01..A_Q22 od 242 co 8, A_Q99 (LLQ) 418, A_CNT 470 (15), wektor od 485.
 *
 * Obslugiwane maski (inne -> blad): kwalifikatory literalne, z '%', samo '*', prefiks z '*' na koncu (ABC*);
 * najwyzej jedno '**', po nim najwyzej jeden kwalifikator (LLQ). Takie maski tworzy src/mine.ts.
 */
import type { RuleResult } from './engine';
import { parseMask } from './mask';

export const LAYOUT = {
    nq: 240,
    q01: 242,
    q99: 418,
    cnt: 470,
    vec: 485,
    /** stala czesc rekordu (1-484) */
    fixedLen: 484,
    /** KON1: A_KEYA (8) + A_KCLS (90) */
    keyFixed: 98,
} as const;

export const CARD_MAX_COL = 71;
const VECD_MAX = 100;

export class CardError extends Error {}

const pad8 = (s: string) => s.padEnd(8, ' ');

/** Warunki DFSORT dla kwalifikatora maski na polu od kolumny p (8 znakow). */
export function qualConds(tok: string, p: number): string[] {
    if (tok === '*') return [];
    if (!/[*%]/.test(tok)) return [`${p},8,CH,EQ,C'${pad8(tok)}'`];
    if (/^[^*%]+\*$/.test(tok)) {
        const pre = tok.slice(0, -1);
        return [`${p},${pre.length},CH,EQ,C'${pre}'`];
    }
    if (!tok.includes('*')) {
        const out: string[] = [];
        const re = /[^%]+/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(tok))) out.push(`${p + m.index},${m[0].length},CH,EQ,C'${m[0]}'`);
        const len = tok.length;
        // dlugosc: ostatni znak niepusty (gdy '%'), nastepny pusty (kwalifikatory bez spacji w srodku)
        if (tok.endsWith('%')) out.push(`${p + len - 1},1,CH,NE,C' '`);
        if (len < 8) out.push(`${p + len},1,CH,EQ,C' '`);
        return out;
    }
    throw new CardError(`kwalifikator "${tok}" - w jobie ACMREPR obslugiwane: literal, %, samo *, ABC*`);
}

/** Warunki dla calej maski (pozycje wg LAYOUT). */
export function maskConds(text: string): string[] {
    const q = parseMask(text).quals;
    const star = q.indexOf('**');
    const qpos = (i: number) => LAYOUT.q01 + i * 8;
    const nq = (op: string, n: number) => `${LAYOUT.nq},2,ZD,${op},+${n}`;
    if (star < 0) {
        if (q.length > 22) throw new CardError(`maska ${text}: wiecej niz 22 kwalifikatory`);
        return [nq('EQ', q.length), ...q.flatMap((t, i) => qualConds(t, qpos(i)))];
    }
    if (q.indexOf('**', star + 1) >= 0) throw new CardError(`maska ${text}: wiecej niz jedno "**"`);
    const before = q.slice(0, star);
    const after = q.slice(star + 1);
    if (after.length > 1) throw new CardError(`maska ${text}: po "**" najwyzej jeden kwalifikator (LLQ)`);
    const conds: string[] = [];
    const min = before.length + after.length;
    if (min > 0) conds.push(nq('GE', min));
    conds.push(...before.flatMap((t, i) => qualConds(t, qpos(i))));
    if (after.length) conds.push(...qualConds(after[0], LAYOUT.q99));
    return conds;
}

/**
 * Sklada karte z czesci (kazda konczy sie przecinkiem) w linie <= CARD_MAX_COL; czesc za dluga na linie
 * dzielona po przecinkach poza apostrofami. Kazda linia konczy sie ',' (kontynuacja DFSORT).
 */
export function wrapCard(parts: string[], indent = 2, contIndent = 4): string[] {
    const atoms: string[] = [];
    for (const part of parts) {
        if (contIndent + part.length <= CARD_MAX_COL) {
            atoms.push(part);
            continue;
        }
        let cur = '';
        let inQ = false;
        for (const ch of part) {
            cur += ch;
            if (ch === "'") inQ = !inQ;
            if (ch === ',' && !inQ) {
                atoms.push(cur);
                cur = '';
            }
        }
        if (cur) atoms.push(cur);
    }
    const lines: string[] = [];
    let line = ' '.repeat(indent);
    for (const a of atoms) {
        if (line.trim() && line.length + a.length > CARD_MAX_COL) {
            lines.push(line);
            line = ' '.repeat(contIndent);
        }
        line += a;
    }
    lines.push(line);
    for (const l of lines) {
        if (l.length > CARD_MAX_COL) throw new CardError(`linia karty za dluga (${l.length}): ${l}`);
    }
    return lines;
}

export interface VecMask {
    /** kolumna w wektorze (1..N) */
    no: number;
    text: string;
    /** reguly i rola maski: R_1 (INCLUDE) / R_X (EXCLUDE) */
    uses: string[];
}

/** Maski wszystkich regul (bez powtorzen), w kolejnosci regul. */
export function vectorMasks(results: RuleResult[]): VecMask[] {
    const byText = new Map<string, VecMask>();
    const add = (text: string, use: string) => {
        let v = byText.get(text);
        if (!v) byText.set(text, v = { no: byText.size + 1, text, uses: [] });
        if (!v.uses.includes(use)) v.uses.push(use);
    };
    for (const r of results) {
        for (const m of r.masks) add(m.text, `${r.rule.name} INCLUDE`);
        for (const x of r.excludes) add(x, `${r.rule.name} EXCLUDE`);
    }
    return [...byText.values()];
}

export function generateCards(masks: VecMask[]): string[] {
    if (masks.length === 0) throw new CardError('brak masek - nie ma czego wstawic do ACMREPR');
    const n = masks.length;
    const lines: string[] = [];
    // komentarzy nie wolno wstawiac w srodek INREC - opis jest w ACMLIST
    // pierwsza karta: znak za wektorem - wszystkie rekordy maja te sama dlugosc (LAYOUT.vec + n)
    lines.push(...wrapCard([`IFTHEN=(WHEN=(1,44,CH,NE,C' '),`, `OVERLAY=(${LAYOUT.vec + n}:C'.'),HIT=NEXT),`]));
    for (const m of masks) {
        let conds: string[];
        try {
            conds = maskConds(m.text);
        } catch (err) {
            throw new CardError(`maska nr ${m.no} ${m.text} (${m.uses.join(', ')}): ${(err as Error).message}`);
        }
        if (conds.length === 0) conds = [`1,44,CH,NE,C' '`];
        const col = LAYOUT.vec + m.no - 1;
        const parts = conds.map((c, i) => (i === 0 ? 'IFTHEN=(WHEN=(' : 'AND,') + c
            + (i === conds.length - 1 ? '),' : ','));
        lines.push(...wrapCard([...parts, `OVERLAY=(${col}:C'Y'),HIT=NEXT),`]));
    }
    return lines;
}

export function generateSymbols(n: number, stamp: string): string[] {
    const vecd = Math.min(n, VECD_MAX);
    const kf = LAYOUT.keyFixed;
    const bCls = kf + n + 1;
    const bCnt = bCls + 90;
    const bAll = bCnt + 14;
    const sym = [
        '**********************************************************************',
        `* SYMBOLE ZALEZNE OD LICZBY MASEK - WYGENEROWANO ACS-MASKS ${stamp}`.padEnd(69) + '*',
        `* LICZBA MASEK (DLUGOSC WEKTORA): ${n}`.padEnd(69) + '*',
        '**********************************************************************',
        '* DSX/DSK: WEKTOR MASEK (Y = ZBIOR PASUJE DO MASKI NR = KOLUMNA),',
        `* ZA WEKTOREM ZNAK '.' (KOL. ${LAYOUT.vec + n}) - REKORDY ROWNEJ DLUGOSCI`,
        `A_VEC,${LAYOUT.vec},${n}`,
        `A_VECD,${LAYOUT.vec},${vecd},CH            DO RAPORTOW (POCZATEK WEKTORA)`,
        '* KCL/KRPT: KLUCZ (DSORG..ROZMIAR, KLASY KLUCZA, WEKTOR) + KLASY',
        `B_KEY,1,${kf + n}`,
        `B_DSORG,1,2`,
        `B_FLGS,3,4,CH`,
        `B_EXPC,7,1,CH`,
        `B_SIZB,8,1,CH`,
        `B_VECD,${kf + 1},${vecd},CH`,
        `B_CLS,${bCls},90,CH`,
        `B_SC8,${bCls},8,CH`,
        `B_MC8,${bCls + 30},8,CH`,
        `B_DC8,${bCls + 60},8,CH`,
        `B_CNT,${bCnt},15,ZD`,
        `B_ALL,1,${bAll}`,
        '* KBAD: B_ALL + LICZBA KOMBINACJI KLAS',
        `B_NCMB,${bAll + 1},15,ZD`,
        '* GRUPY (JOINKEYS DSK X REPC, PRZED OUTREC)',
        'G_DSN,1,44,CH',
        'G_REP,45,44,CH',
        'G_CNT,89,15,ZD',
        `G_VECD,104,${vecd},CH`,
    ];
    return sym;
}

export function generateList(masks: VecMask[], stamp: string): string[] {
    const out = [
        `* MASKI W WEKTORZE JOBA ACMREPR - WYGENEROWANO ACS-MASKS ${stamp}`,
        '* KOL = KOLUMNA W WEKTORZE (RAPORTY RPTG/RPTK, GRUPY), Y = ZBIOR PASUJE',
        '*  KOL MASKA                                        REGULA / LISTA',
    ];
    for (const m of masks) {
        const uses = m.uses.join(', ');
        const line = `${String(m.no).padStart(5)} ${m.text.padEnd(44)} ${uses}`;
        out.push(line.length > 71 ? line.slice(0, 68) + '...' : line);
    }
    return out;
}
