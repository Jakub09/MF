/**
 * Przykladowe rutyny ACS z wynikow regul: jedna rutyna na typ (DATACLAS, STORCLAS, MGMTCLAS, STORGRP).
 *
 * FILTLIST ma limit 255 pozycji na liste INCLUDE / EXCLUDE i nie moze odwolywac sie do innej FILTLIST
 * (z/OS DFSMSdfp Storage Administration; IBM Ideas ZOS-I-3752), wiec:
 *   <REGULA>_1, _2...   INCLUDE(maski)                 - po 255
 *   <REGULA>_X1, _X2... INCLUDE(maski wylaczone)        - po 255
 *   WHEN ((&DSN = &R_1 OR &DSN = &R_2) AND &DSN NE &R_X1 ...)
 * Kolejnosc WHEN = kolejnosc regul w konfiguracji (wygrywa pierwsza pasujaca).
 * Tekst: FB 80, kolumny 1-71, wielkie litery, znaki bezpieczne dla EBCDIC.
 */
import type { RuleResult } from './engine';
import { Routine, ROUTINES } from './rules';

export const ACS_MAX_COL = 71;
const MAX_LIST = 255;

/** Nazwy memberow (na z/OS) dla rutyn. */
export const ROUTINE_MEMBER: Record<Routine, string> = {
    DATACLAS: 'ACMDC',
    STORCLAS: 'ACMSC',
    MGMTCLAS: 'ACMMC',
    STORGRP: 'ACMSG',
};

const ROUTINE_VAR: Record<Routine, string> = {
    DATACLAS: '&DATACLAS',
    STORCLAS: '&STORCLAS',
    MGMTCLAS: '&MGMTCLAS',
    STORGRP: '&STORGRP',
};

function chunks<T>(a: T[], n: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
    return out;
}

/** Pozycja listy FILTLIST: maska bez apostrofow; nazwa z '-' / '{' w apostrofach. */
function entry(text: string): string {
    return /[-{]/.test(text) && !/[*%]/.test(text) ? `'${text}'` : text;
}

/** FILTLIST z zawijaniem do ACS_MAX_COL; kazda linia poza ostatnia konczy sie przecinkiem. */
export function filtlist(name: string, items: string[]): string[] {
    const head = `  FILTLIST ${name} INCLUDE(`;
    const indent = ' '.repeat(head.length);
    const lines: string[] = [];
    let cur = head;
    items.forEach((it, i) => {
        const piece = entry(it) + (i < items.length - 1 ? ',' : ')');
        if (cur.length + piece.length > ACS_MAX_COL && cur !== head && cur !== indent) {
            lines.push(cur);
            cur = indent;
        }
        cur += piece;
    });
    lines.push(cur);
    return lines;
}

/**
 * Tekst do pliku z/OS: bez polskich znakow, wielkie litery, tylko znaki bezpieczne dla IBM-1047
 * (bez [ ] \ ! ^ ~ ` i znakow spoza ASCII).
 */
export function zosText(s: string): string {
    return s.replace(/[łŁ]/g, 'L').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
        .replace(/[^\x20-\x7e]|[[\]\\!^~`]/g, '?');
}

/** Komentarz ACS zawiniety do kolumny 71. */
function comment(text: string, indent = 0): string[] {
    const width = ACS_MAX_COL - indent - 6;
    const words = zosText(text).replace(/\*\//g, '* /').split(/\s+/).filter(Boolean);
    const out: string[] = [];
    let cur = '';
    for (const w of words) {
        if (cur && cur.length + 1 + w.length > width) {
            out.push(cur);
            cur = w;
        } else {
            cur = cur ? `${cur} ${w}` : w;
        }
    }
    if (cur) out.push(cur);
    return out.map(l => `${' '.repeat(indent)}/* ${l.padEnd(width)} */`);
}

/** Wyrazenie zawiniete po spacjach do kolumny 71 (ACS: wolny format). */
function wrapExpr(prefix: string, expr: string, contIndent: number): string[] {
    const out: string[] = [];
    let cur = prefix;
    for (const tok of expr.split(' ')) {
        if (cur.length + 1 + tok.length > ACS_MAX_COL && cur.trim().length > 0 && cur !== prefix) {
            out.push(cur);
            cur = ' '.repeat(contIndent) + tok;
        } else {
            cur = cur.endsWith('(') || cur === prefix ? cur + tok : `${cur} ${tok}`;
        }
    }
    out.push(cur);
    return out;
}

const pct = (x: number) => (x * 100).toFixed(1).replace('.', ',');

export function generateRoutine(routine: Routine, results: RuleResult[], otherwise: string | string[] | undefined,
    stamp: string): string[] {
    const lines: string[] = [];
    const v = ROUTINE_VAR[routine];
    lines.push(...comment(`PRZYKLADOWA RUTYNA ${routine} - WYGENEROWANO ACS-MASKS ${stamp}`));
    lines.push(...comment('MASKI DOBRANE Z DCOLLECT WG KRYTERIOW REGUL. PRZED UZYCIEM SPRAWDZ I PRZETESTUJ'
        + ' (NAVIQUEST, JOBY ACMREPR I ACSTGEN).'));
    lines.push(`PROC ${routine}`);
    lines.push('');
    const whens: string[][] = [];
    for (const r of results) {
        const name = r.rule.name.toUpperCase();
        const inc = r.masks.map(m => m.text);
        const exc = r.excludes;
        lines.push(...comment(`REGULA ${name}${r.rule.description ? ': ' + r.rule.description : ''}`, 2));
        lines.push(...comment(`ZBIOROW WG KRYTERIUM ${r.positives}, POKRYTYCH ${r.covered}, NIEPOKRYTYCH `
            + `${r.uncovered.length}, NADMIAROWYCH ${r.falsePositives.length}; MASEK ${inc.length}, `
            + `WYLACZEN ${exc.length}; CZYSTOSC MIN. ${pct(r.tuning.minPurity)}%`, 2));
        if (inc.length === 0) {
            lines.push(...comment('BRAK MASEK - REGULA POMINIETA', 2));
            lines.push('');
            continue;
        }
        const incNames = chunks(inc, MAX_LIST).map((c, i) => {
            const n = `${name}_${i + 1}`;
            lines.push(...filtlist(n, c));
            return n;
        });
        const excNames = chunks(exc, MAX_LIST).map((c, i) => {
            const n = `${name}_X${i + 1}`;
            lines.push(...filtlist(n, c));
            return n;
        });
        lines.push('');
        const incExpr = incNames.map(n => `&DSN = &${n}`).join(' OR ');
        const parts = [incNames.length > 1 ? `(${incExpr})` : incExpr, ...excNames.map(n => `&DSN NE &${n}`)];
        if (r.rule.acsCondition) parts.push(`(${zosText(r.rule.acsCondition)})`);
        const values = (Array.isArray(r.rule.value) ? r.rule.value : [r.rule.value]).map(x => `'${x}'`).join(',');
        whens.push([
            ...comment(`REGULA ${name}`, 4),
            ...wrapExpr('    WHEN (', `${parts.join(' AND ')})`, 10),
            `      SET ${v} = ${values}`,
        ]);
    }
    lines.push('  SELECT');
    for (const w of whens) lines.push(...w);
    if (otherwise !== undefined) {
        const values = (Array.isArray(otherwise) ? otherwise : [otherwise]).map(x => `'${x}'`).join(',');
        lines.push('    OTHERWISE');
        lines.push(`      SET ${v} = ${values}`);
    }
    lines.push('  END');
    lines.push('END');
    for (const l of lines) {
        if (l.length > ACS_MAX_COL) throw new Error(`linia ACS dluzsza niz ${ACS_MAX_COL}: ${l}`);
    }
    return lines;
}

/** Rutyny dla typow uzytych w regulach (kolejnosc: DC, SC, MC, SG). */
export function generateRoutines(results: RuleResult[], otherwise: Partial<Record<Routine, string | string[]>> = {},
    stamp: string): { routine: Routine; member: string; lines: string[] }[] {
    return ROUTINES.filter(rt => results.some(r => r.rule.routine === rt)).map(rt => {
        const rs = results.filter(r => r.rule.routine === rt);
        const withMasks = rs.some(r => r.masks.length > 0);
        const lines = generateRoutine(rt, rs, otherwise[rt], stamp);
        if (!withMasks) lines.splice(2, 0, ...comment('UWAGA: ZADNA REGULA NIE MA MASEK'));
        return { routine: rt, member: ROUTINE_MEMBER[rt], lines };
    });
}
