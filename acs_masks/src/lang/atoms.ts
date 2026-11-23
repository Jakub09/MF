/**
 * Warunki elementarne ("atomy") z rutyn ACS: kazde porownanie z IF / WHEN, sprowadzone do postaci
 * kanonicznej (zmienna po lewej; NE -> EQ, GE -> LT, GT -> LE - negacja dzieli zbiory tak samo).
 * Zbiory z tym samym wektorem wartosci atomow przechodza przez rutyny ta sama sciezka, wiec jeden
 * reprezentant na wektor pokrywa cala logike rutyn (dla zmiennych znanych z DCOLLECT).
 *
 * Ziarnistosc porownan z FILTLIST:
 *   list  - jeden atom na liste (rutyna widzi tylko "pasuje / nie pasuje do listy")
 *   entry - jeden atom na pozycje listy (widac, ktora maska zlapala zbior; wiecej grup)
 * FILTLIST jest rozpoznawana po zawartosci, nie po nazwie: ta sama nazwa ze zmieniona lista (stara i nowa
 * wersja rutyny) daje dwa atomy, wiec zbiory objete zmiana trafiaja do osobnej grupy.
 */
import { allCmps, CmpOp, Operand, VarRef } from 'acs-routines/lang/ast';
import type { Env } from './env';
import { evalNorm, Lists, normalize } from './eval';
import type { Loaded } from './load';
import { VARS } from 'acs-routines/lang/vars';

export interface Atom {
    key: string;
    /** postac czytelna, np. &DSN = &NONSMS */
    text: string;
    /** miejsca uzycia: SC:12 */
    where: string[];
    /** zmienne ACS, od ktorych zalezy */
    vars: string[];
    test: (env: Env) => boolean;
}

const CANON: Record<CmpOp, CmpOp> = { EQ: 'EQ', NE: 'EQ', LT: 'LT', GE: 'LT', LE: 'LE', GT: 'LE' };
const SIGN: Record<string, string> = { EQ: '=', LT: '<', LE: '<=' };

const subjText = (v: VarRef) => `&${v.name}${v.index === undefined ? '' : `(${typeof v.index === 'number' ? v.index : '&' + v.index})`}`;

export function extractAtoms(routines: Loaded[], granularity: 'list' | 'entry'): Atom[] {
    const byKey = new Map<string, Atom>();
    const add = (key: string, text: string, where: string, vars: string[], test: Atom['test']) => {
        let a = byKey.get(key);
        if (!a) byKey.set(key, a = { key, text, where: [], vars, test });
        if (!a.where.includes(where)) a.where.push(where);
    };
    for (const r of routines) {
        const lists: Lists = r.lists;
        for (const c of allCmps(r.program)) {
            const n = normalize(c);
            if (!n) continue;
            const where = `${r.label}:${c.range.start.line + 1}`;
            const s = subjText(n.subject);
            const op = CANON[n.op];
            const o: Operand = n.other;
            const mk = (other: Operand, cop: CmpOp = op) => (env: Env) => evalNorm(n.subject, cop, other, env, lists);
            if (o.kind === 'var') {
                const f = VARS.has(o.name) ? undefined : lists.get(o.name);
                if (!f) {
                    if (VARS.has(o.name)) add(`${s} ${op} ${subjText(o)}`, `${s} ${SIGN[op]} ${subjText(o)}`, where, [n.subject.name, o.name], mk(o));
                    continue;
                }
                if (granularity === 'list') {
                    const content = `{${f.include.map(e => e.kind[0] + e.text).sort().join(',')}|${f.exclude.map(e => e.kind[0] + e.text).sort().join(',')}}`;
                    add(`${s} IN ${content}`, `${s} = &${f.name}`, where, [n.subject.name], mk(o, 'EQ'));
                } else {
                    for (const e of [...f.include, ...f.exclude]) {
                        const other: Operand = e.kind === 'literal'
                            ? { kind: 'literal', value: e.text, range: e.range } : { kind: 'mask', text: e.text, range: e.range };
                        const t = e.kind === 'literal' ? `'${e.text}'` : e.text;
                        add(`${s} EQ ${t}`, `${s} = ${t}`, `${where} &${f.name}`, [n.subject.name], mk(other, 'EQ'));
                    }
                }
            } else if (o.kind === 'literal') {
                add(`${s} ${op} '${o.value}'`, `${s} ${SIGN[op]} '${o.value}'`, where, [n.subject.name], mk(o));
            } else if (o.kind === 'mask') {
                add(`${s} EQ ${o.text}`, `${s} = ${o.text}`, where, [n.subject.name], mk(o, 'EQ'));
            } else {
                const numeric = VARS.get(n.subject.name)!.type !== 'char';
                const t = numeric ? `${o.unit === 'MB' ? o.value * 1024 : o.value}${o.unit ? 'KB' : ''}` : o.text;
                const cop = numeric ? op : 'EQ';
                add(`${s} ${cop} ${t}`, `${s} ${SIGN[cop]} ${numeric ? `${o.value}${o.unit ?? ''}` : o.text}`, where, [n.subject.name], mk(o, cop));
            }
        }
    }
    return [...byKey.values()];
}

/** Zmienne z nazwa zbioru - z nich pochodza maski i kwalifikatory do opisu testu. */
const NAME_VARS = new Set(['DSN', 'HLQ', 'LLQ']);

/**
 * Maski i kwalifikatory z rutyn, do ktorych pasuje nazwa zbioru (opis testu ISMF): porownania &DSN / &HLQ / &LLQ /
 * &DSN(n) z maska, literalem albo FILTLIST, prawdziwe dla zbioru (w postaci "="). Z FILTLIST - pozycje INCLUDE,
 * ktore pasuja (gdy zbior nie jest wylaczony przez EXCLUDE). Kolejnosc zrodla, bez powtorzen.
 */
export function nameMasks(routines: Loaded[], env: Env): string[] {
    const out: string[] = [];
    const add = (t: string) => {
        if (!out.includes(t)) out.push(t);
    };
    for (const r of routines) {
        for (const c of allCmps(r.program)) {
            const n = normalize(c);
            if (!n || !NAME_VARS.has(n.subject.name)) continue;
            const o = n.other;
            if (o.kind === 'var') {
                const f = VARS.has(o.name) ? undefined : r.lists.get(o.name);
                if (!f || !evalNorm(n.subject, 'EQ', o, env, r.lists)) continue;
                for (const e of f.include) {
                    const op: Operand = e.kind === 'literal'
                        ? { kind: 'literal', value: e.text, range: e.range } : { kind: 'mask', text: e.text, range: e.range };
                    if (evalNorm(n.subject, 'EQ', op, env, r.lists)) add(e.text);
                }
            } else if ((o.kind === 'literal' || o.kind === 'mask') && evalNorm(n.subject, 'EQ', o, env, r.lists)) {
                add(o.kind === 'literal' ? o.value : o.text);
            }
        }
    }
    return out;
}
