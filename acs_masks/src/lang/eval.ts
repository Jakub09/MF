/**
 * Ocena porownan i warunkow ACS dla srodowiska zbioru (env.ts).
 *
 * Reguly ("Comparison rules", "Special functions"):
 *  - jedna strona to zmienna, druga: stala, zmienna albo FILTLIST; zmienna moze stac po prawej
 *  - FILTLIST: prawda, gdy wartosc pasuje do INCLUDE i nie pasuje do EXCLUDE (EXCLUDE ma pierwszenstwo)
 *  - &ANYVOL: prawda, gdy ktorykolwiek wolumen spelnia porownanie; &ALLVOL: gdy wszystkie
 *  - liczby porownywane liczbowo (&SIZE / &MAXSIZE w KB: 1 MB = 1024 KB), znaki w porzadku EBCDIC
 *  - AND / OR: drzewo z parsera jest lewostronne (ACS liczy od lewej do prawej)
 */
import type { Cmp, CmpOp, Expr, FiltEntry, Filtlist, Operand, VarRef } from 'acs-routines/lang/ast';
import { Env, getVar, Value } from './env';
import { compareChar, dsnMatch, simpleMatch } from 'acs-routines/lang/match';
import { VARS } from 'acs-routines/lang/vars';

export type Lists = Map<string, Filtlist>;

const FLIP: Record<CmpOp, CmpOp> = { EQ: 'EQ', NE: 'NE', GT: 'LT', LT: 'GT', GE: 'LE', LE: 'GE' };

function applyOp(op: CmpOp, d: number): boolean {
    switch (op) {
        case 'EQ': return d === 0;
        case 'NE': return d !== 0;
        case 'GT': return d > 0;
        case 'LT': return d < 0;
        case 'GE': return d >= 0;
        default: return d <= 0;
    }
}

/** Czy pozycja FILTLIST pasuje do wartosci (quals - kwalifikatory, gdy wartosc jest nazwa zbioru). */
export function entryMatch(e: FiltEntry, value: string, quals: string[] | null): boolean {
    if (e.kind === 'literal') return compareChar(e.text, value) === 0;
    return quals ? dsnMatch(e.text, quals) : simpleMatch(e.text, value);
}

export function listMatch(f: Filtlist, value: string, quals: string[] | null): boolean {
    for (const e of f.exclude) if (entryMatch(e, value, quals)) return false;
    for (const e of f.include) if (entryMatch(e, value, quals)) return true;
    return false;
}

/** Zmienna po lewej stronie porownania: zwraca porownanie znormalizowane albo null (brak zmiennej). */
export function normalize(c: Cmp): { subject: VarRef; op: CmpOp; other: Operand } | null {
    const isVar = (o: Operand): o is VarRef => o.kind === 'var' && VARS.has(o.name);
    if (isVar(c.left)) return { subject: c.left, op: c.op, other: c.right };
    if (isVar(c.right)) return { subject: c.right, op: FLIP[c.op], other: c.left };
    return null;
}

const eqOp = (op: CmpOp, m: boolean) => (op === 'EQ' ? m : op === 'NE' ? !m : false);

function single(sv: string | number, quals: string[] | null, op: CmpOp, other: Operand, env: Env, lists: Lists): boolean {
    switch (other.kind) {
        case 'var': {
            const f = VARS.has(other.name) ? undefined : lists.get(other.name);
            if (f) return eqOp(op, listMatch(f, String(sv), quals));
            if (!VARS.has(other.name)) return false;
            const ov = getVar(env, other.name, other.index);
            const o = Array.isArray(ov) ? ov[0] ?? '' : ov;
            if (typeof sv === 'number' && typeof o === 'number') return applyOp(op, sv - o);
            return applyOp(op, compareChar(String(sv), String(o)));
        }
        case 'literal':
            return applyOp(op, compareChar(String(sv), other.value));
        case 'mask':
            if (typeof sv === 'number') return false;
            return eqOp(op, quals ? dsnMatch(other.text, quals) : simpleMatch(other.text, sv));
        default:
            if (typeof sv === 'number') return applyOp(op, sv - (other.unit === 'MB' ? other.value * 1024 : other.value));
            // zmienna znakowa i slowo z samych cyfr (&UNIT = 3390): jak maska
            return eqOp(op, simpleMatch(other.text, sv));
    }
}

export function evalCmp(c: Cmp, env: Env, lists: Lists): boolean {
    const n = normalize(c);
    if (!n) return false;
    return evalNorm(n.subject, n.op, n.other, env, lists);
}

export function evalNorm(subject: VarRef, op: CmpOp, other: Operand, env: Env, lists: Lists): boolean {
    const info = VARS.get(subject.name)!;
    const value: Value = getVar(env, subject.name, subject.index);
    if (Array.isArray(value)) {
        const test = (x: string) => single(x, null, op, other, env, lists);
        return info.multi === 'all' ? value.every(test) : value.some(test);
    }
    // nazwa zbioru bez indeksu: maski ze znaczeniem kropek i **
    const quals = info.dsnLike && subject.index === undefined
        ? (subject.name === 'DSN' ? env.quals : String(value).split('.').filter(Boolean)) : null;
    return single(value, quals, op, other, env, lists);
}

export function evalExpr(e: Expr | null, env: Env, lists: Lists): boolean {
    if (!e) return false;
    if (e.kind === 'cmp') return evalCmp(e, env, lists);
    return e.op === 'AND'
        ? evalExpr(e.left, env, lists) && evalExpr(e.right, env, lists)
        : evalExpr(e.left, env, lists) || evalExpr(e.right, env, lists);
}
