/**
 * Kontrola semantyczna rutyny ACS (ponad skladnie z parser.ts): zmienne, FILTLIST, typy porownan, SET,
 * limity. Reguly wg z/OS 3.2 DFSMSdfp Storage Administration, "Writing ACS routines"; kazda diagnostyka
 * ma staly kod ACSnnn (0xx lekser, 1xx parser, 2xx semantyka).
 */
import { allVarRefs, Cmp, Expr, Filtlist, Operand, Program, Stmt, VarRef, walkStmts } from './ast';
import { Diagnostic, lex, Range, Severity } from './lexer';
import { maskProblem } from './match';
import { KEYWORDS } from './parser';
import { DEF_OF, RW_OF, VarInfo, VARS } from './vars';

export interface CheckOptions {
    /** najdluzsza dozwolona linia zrodla (domyslnie 80 - rekord FB 80) */
    maxCol?: number;
}

export type RefKind = 'variable' | 'filtlist' | 'unknown';

/** FILTLIST wg nazwy (pierwsza definicja). */
export function filtlistMap(p: Program): Map<string, Filtlist> {
    const m = new Map<string, Filtlist>();
    for (const f of p.filtlists) if (f.name && !m.has(f.name)) m.set(f.name, f);
    return m;
}

export function refKind(p: Program, ref: VarRef, lists = filtlistMap(p)): RefKind {
    if (VARS.has(ref.name)) return 'variable';
    return lists.has(ref.name) ? 'filtlist' : 'unknown';
}

const NAME = /^[A-Z$@#][A-Z0-9$@#]{0,7}$/;

export function check(p: Program, source: string, opt: CheckOptions = {}): Diagnostic[] {
    const out: Diagnostic[] = [...p.diagnostics];
    const add = (range: Range, code: string, message: string, severity: Severity = 'error') =>
        out.push({ range, severity, code, message });
    const lists = filtlistMap(p);
    const used = new Set<string>();
    const sg = p.routine === 'STORGRP';

    // --- zrodlo: dlugosc linii, znaki, wielkosc liter
    const maxCol = opt.maxCol ?? 80;
    let offset = 0;
    source.split('\n').forEach((raw, line) => {
        const l = raw.replace(/\r$/, '');
        if (l.length > maxCol) {
            add({ start: { line, col: maxCol, offset: offset + maxCol }, end: { line, col: l.length, offset: offset + l.length } },
                'ACS250', `linia dluzsza niz ${maxCol} znakow (${l.length})`, 'warning');
        }
        const m = /[^\x20-\x7e¬\t]/.exec(l);
        if (m) {
            add({ start: { line, col: m.index, offset: offset + m.index }, end: { line, col: m.index + 1, offset: offset + m.index + 1 } },
                'ACS251', `znak "${m[0]}" spoza zestawu bezpiecznego dla z/OS (IBM-1047)`, 'warning');
        }
        offset += raw.length + 1;
    });
    for (const t of lex(source).tokens) {
        if (t.kind === 'var' && t.raw !== t.raw.toUpperCase()) {
            add(t.range, 'ACS252', 'nazwy zmiennych ACS sa wrazliwe na wielkosc liter - pisz wielkimi literami', 'warning');
        } else if (t.kind === 'word' && t.raw !== t.value && KEYWORDS.includes(t.value)) {
            add(t.range, 'ACS252', `slowo kluczowe ${t.value} pisz wielkimi literami`, 'warning');
        }
    }

    // --- FILTLIST
    const seen = new Map<string, Filtlist>();
    for (const f of p.filtlists) {
        if (!f.name) continue;
        if (seen.has(f.name)) add(f.nameRange, 'ACS203', `FILTLIST ${f.name} zdefiniowana drugi raz`);
        else seen.set(f.name, f);
        if (VARS.has(f.name)) add(f.nameRange, 'ACS204', `nazwa FILTLIST ${f.name} jest nazwa zmiennej ACS`);
        if (f.name.length > 31 || !/^[A-Z0-9$@#][A-Z0-9$@#_]*$/.test(f.name)) {
            add(f.nameRange, 'ACS205', 'nazwa FILTLIST: do 31 znakow alfanumerycznych i _, nie zaczyna sie od _');
        }
        for (const [what, list] of [['INCLUDE', f.include], ['EXCLUDE', f.exclude]] as const) {
            if (list.length > 255) add(list[255].range, 'ACS206', `${what} ma ${list.length} pozycji - limit to 255`);
            const dup = new Set<string>();
            for (const e of list) {
                const key = `${e.kind}:${e.text}`;
                if (dup.has(key)) add(e.range, 'ACS209', `pozycja ${e.text} powtorzona w ${what}`, 'hint');
                dup.add(key);
                if (e.kind === 'mask') {
                    const pr = maskProblem(e.text, e.text.includes('.'));
                    if (pr) add(e.range, 'ACS208', `maska ${e.text}: ${pr}`);
                } else if (e.text.length > 44) {
                    add(e.range, 'ACS226', `literal dluzszy niz 44 znaki (${e.text.length})`, 'warning');
                }
            }
        }
    }

    // --- odwolania &NAZWA
    const refInfo = (r: VarRef): VarInfo | null => {
        const kind = refKind(p, r, lists);
        if (kind === 'unknown') {
            add(r.range, 'ACS201', `nieznana zmienna albo FILTLIST &${r.name}`);
            return null;
        }
        if (kind === 'filtlist') {
            used.add(r.name);
            const def = lists.get(r.name)!;
            if (def.range.start.offset > r.range.start.offset) {
                add(r.range, 'ACS202', `FILTLIST ${r.name} uzyta przed definicja (linia ${def.range.start.line + 1})`);
            }
            if (r.index !== undefined) add(r.range, 'ACS228', 'FILTLIST nie ma indeksu');
            return null;
        }
        const info = VARS.get(r.name)!;
        if (sg && info.notInSg) add(r.range, 'ACS229', `&${r.name} niedozwolona w rutynie STORGRP`);
        if (info.name === 'STORGRP' && p.routine && !sg) add(r.range, 'ACS230', `&STORGRP niedozwolona w rutynie ${p.routine}`);
        if (r.index !== undefined) {
            const i = r.index;
            if (!info.index) add(r.range, 'ACS228', `&${r.name} nie ma funkcji indeksowania`);
            else if (typeof i === 'string') {
                if (info.index !== 'qual' || (i !== 'NQUAL' && i !== 'MEMNQUAL')) {
                    add(r.range, 'ACS228', 'indeks: liczba albo &NQUAL / &MEMNQUAL (tylko dla &DSN / &MEMN)');
                }
            } else {
                const max = info.index === 'qual' ? 22 : info.index === 'uservar' ? 3 : 71;
                if (i < 1 || i > max) add(r.range, 'ACS228', `indeks &${r.name} poza zakresem 1-${max}`);
            }
        }
        return info;
    };

    const checkCmp = (c: Cmp) => {
        const l = c.left;
        const r = c.right;
        const lk = l.kind === 'var' ? refKind(p, l, lists) : null;
        const rk = r.kind === 'var' ? refKind(p, r, lists) : null;
        const li = l.kind === 'var' ? refInfo(l) : null;
        const ri = r.kind === 'var' ? refInfo(r) : null;
        if (lk === 'unknown' || rk === 'unknown') return;
        if (!li && !ri) {
            add(c.range, 'ACS220', 'porownanie wymaga zmiennej ACS po jednej ze stron');
            return;
        }
        if (li && ri) {
            if ((li.type === 'char') !== (ri.type === 'char')) {
                add(c.range, 'ACS221', `porownanie zmiennej znakowej z liczbowa (&${li.name}, &${ri.name})`);
            }
            return;
        }
        const info = (li ?? ri)!;
        const other: Operand = li ? r : l;
        const eqOnly = c.op === 'EQ' || c.op === 'NE';
        if (other.kind === 'var') {
            // FILTLIST
            if (info.type !== 'char') add(c.range, 'ACS225', `FILTLIST zawiera literaly - nie mozna porownac z liczbowa &${info.name}`);
            if (!eqOnly) add(c.range, 'ACS223', 'z FILTLIST dozwolone tylko = (EQ) i ¬= (NE)');
        } else if (other.kind === 'literal') {
            if (info.type !== 'char') add(other.range, 'ACS221', `&${info.name} jest liczbowa - porownanie z literalem`);
            else {
                if (info.max && other.value.length > info.max) {
                    add(other.range, 'ACS226', `literal dluzszy niz najwieksza dlugosc &${info.name} (${info.max})`);
                }
                if (info.values && other.value !== '' && !info.values.includes(other.value)) {
                    add(other.range, 'ACS227',
                        `'${other.value}' nie jest znana wartoscia &${info.name} (${info.values.join(', ')})`, 'warning');
                }
            }
        } else if (other.kind === 'number') {
            if (info.type === 'size' && !other.unit) add(other.range, 'ACS222', `&${info.name} wymaga jednostki KB albo MB`);
            if (info.type !== 'size' && other.unit) add(other.range, 'ACS221', `jednostka ${other.unit} tylko dla &SIZE i &MAXSIZE`);
            if (info.type === 'char' && !eqOnly) add(c.range, 'ACS223', 'z maska dozwolone tylko = (EQ) i ¬= (NE)');
        } else {
            if (info.type !== 'char') add(other.range, 'ACS221', `&${info.name} jest liczbowa - porownanie z maska`);
            else {
                if (!eqOnly) add(c.range, 'ACS223', 'z maska dozwolone tylko = (EQ) i ¬= (NE)');
                if (info.noMask) add(other.range, 'ACS224', `&${info.name} nie mozna porownywac z maska - uzyj literalu w apostrofach`, 'warning');
                const pr = maskProblem(other.text, !!info.dsnLike);
                if (pr) add(other.range, 'ACS208', `maska ${other.text}: ${pr}`);
            }
        }
    };

    const checkExpr = (e: Expr | null) => {
        if (!e) return;
        if (e.kind === 'cmp') {
            checkCmp(e);
            return;
        }
        // drzewo lewostronne: lewe dziecko bez nawiasow z innym operatorem = mieszanie AND i OR
        if (e.left.kind === 'bool' && e.left.op !== e.op && !e.left.paren) {
            add(e.range, 'ACS240', 'AND i OR bez nawiasow: ACS liczy od lewej do prawej (bez priorytetu AND) - dodaj nawiasy', 'info');
        }
        checkExpr(e.left);
        checkExpr(e.right);
    };

    const checkBlock = (stmts: Stmt[]) => {
        let exited: Stmt | null = null;
        for (const s of stmts) {
            if (exited && s.kind !== 'filtlist') {
                add(s.range, 'ACS260', 'instrukcja nieosiagalna (po EXIT)', 'hint');
                break;
            }
            if (s.kind === 'exit') exited = s;
        }
    };

    checkBlock(p.body);
    walkStmts(p.body, s => {
        switch (s.kind) {
            case 'if':
                checkExpr(s.cond);
                break;
            case 'select':
                if (s.subject) refInfo(s.subject);
                for (const w of s.whens) {
                    if (s.subject && w.cond?.kind === 'cmp') {
                        // lewa strona = zmienna SELECT (juz sprawdzona) - sprawdz tylko wartosc
                        const c = w.cond;
                        const kind = refKind(p, s.subject, lists);
                        if (kind === 'variable') {
                            const saved = out.length;
                            checkCmp(c);
                            // usun powtorzone diagnostyki zmiennej SELECT
                            for (let i = out.length - 1; i >= saved; i--) {
                                if (out[i].range === s.subject.range) out.splice(i, 1);
                            }
                        }
                    } else checkExpr(w.cond);
                    checkBlock(w.body);
                }
                if (s.otherwise) checkBlock(s.otherwise);
                break;
            case 'do':
                checkBlock(s.body);
                break;
            case 'set': {
                if (!s.target) break;
                const want = p.routine ? RW_OF[p.routine] : null;
                const info = VARS.get(s.target.name);
                if (!info?.rw) add(s.target.range, 'ACS210', `SET moze ustawic tylko &DATACLAS, &STORCLAS, &MGMTCLAS albo &STORGRP`);
                else if (want && s.target.name !== want) {
                    add(s.target.range, 'ACS210', `rutyna ${p.routine} moze ustawic tylko &${want}`);
                }
                if (s.values.length > 1 && s.target.name !== 'STORGRP') {
                    add(s.range, 'ACS211', 'lista wartosci tylko dla &STORGRP');
                }
                if (s.values.length > 15) add(s.values[15].range, 'ACS211', `&STORGRP: najwyzej 15 nazw (jest ${s.values.length})`);
                for (const val of s.values) {
                    if (val.kind === 'var') {
                        const def = p.routine ? DEF_OF[p.routine] : undefined;
                        if (!VARS.has(val.name)) add(val.range, 'ACS201', `nieznana zmienna &${val.name}`);
                        else if (val.name !== def) {
                            add(val.range, 'ACS211', def
                                ? `w SET mozna przypisac tylko nazwe w apostrofach albo &${def}`
                                : 'w rutynie STORGRP mozna przypisac tylko nazwy w apostrofach');
                        }
                    } else if (val.value === '') {
                        if (s.target.name === 'STORGRP') add(val.range, 'ACS211', '&STORGRP nie moze dostac wartosci pustej');
                    } else if (!NAME.test(val.value)) {
                        add(val.range, 'ACS211', `'${val.value}': nazwa 1-8 znakow (litery, cyfry, $ @ #), nie zaczyna sie cyfra`);
                    }
                }
                break;
            }
            case 'write': {
                let len = 0;
                for (const part of s.parts) {
                    if (part.kind === 'literal') len += part.value.length;
                    else {
                        const info = refInfo(part);
                        if (info?.multi) add(part.range, 'ACS241', `&${part.name} nie mozna uzyc w WRITE`);
                        len += info?.max ?? 8;
                    }
                }
                if (len > 110) add(s.range, 'ACS241', `komunikat WRITE moze miec do 110 znakow (tekst i zmienne; jest ok. ${len})`, 'warning');
                break;
            }
            default:
                break;
        }
    });

    for (const r of allVarRefs(p)) if (lists.has(r.name) && !VARS.has(r.name)) used.add(r.name);
    for (const f of seen.values()) {
        if (!used.has(f.name)) add(f.nameRange, 'ACS207', `FILTLIST ${f.name} nie jest uzywana`, 'hint');
    }
    if (p.routine) {
        const want = RW_OF[p.routine];
        let sets = false;
        walkStmts(p.body, s => {
            if (s.kind === 'set' && s.target?.name === want) sets = true;
        });
        if (!sets && p.procRange) add(p.procRange, 'ACS261', `rutyna nie ustawia &${want} (brak SET)`, 'info');
    }
    out.sort((a, b) => a.range.start.offset - b.range.start.offset || a.code.localeCompare(b.code));
    return out;
}
