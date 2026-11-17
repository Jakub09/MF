/**
 * Parser rutyn ACS -> drzewo (ast.ts). Nie rzuca wyjatkow: bledy skladni trafiaja do Program.diagnostics,
 * a analiza jest kontynuowana od nastepnej instrukcji (potrzebne w edytorze).
 *
 * Skladnia (z/OS 3.2 DFSMSdfp Storage Administration, "Writing ACS routines"):
 *   PROC [n] [&]DATACLAS|STORCLAS|MGMTCLAS|STORGRP ... END
 *   FILTLIST nazwa [INCLUDE(lista)] [EXCLUDE(lista)]
 *   SET &zmienna =|EQ wartosc[,wartosc...]
 *   IF warunek THEN instrukcja [ELSE instrukcja]
 *   SELECT [(zmienna)] WHEN (warunek|wartosc) [instrukcja] ... [OTHERWISE [instrukcja]] END
 *   DO instrukcje END, EXIT [CODE(n)], WRITE 'tekst' [&zmienna ...], LOGWRITES
 * Warunek: porownania laczone AND (&&) / OR (|). ACS nie ma priorytetu AND przed OR - wyrazenie bez
 * nawiasow jest liczone od lewej do prawej, dlatego drzewo jest lewostronne.
 */
import {
    Bool, Cmp, CmpOp, Expr, FiltEntry, Filtlist, IfStmt, Literal, Operand, Program, Routine, ROUTINE_NAMES,
    SelectStmt, Stmt, VarRef, When,
} from './ast';
import { Diagnostic, lex, Range, Severity, Token, WORD_OPS } from './lexer';

const STMT_START = new Set(['FILTLIST', 'SET', 'DO', 'IF', 'SELECT', 'EXIT', 'WRITE', 'LOGWRITES']);
const STMT_END = new Set(['END', 'WHEN', 'OTHERWISE', 'ELSE', 'THEN']);
export const KEYWORDS = ['PROC', 'FILTLIST', 'INCLUDE', 'EXCLUDE', 'SET', 'DO', 'IF', 'THEN', 'ELSE', 'SELECT', 'WHEN',
    'OTHERWISE', 'EXIT', 'CODE', 'WRITE', 'LOGWRITES', 'END'];
/** Najwieksza liczba poziomow zagniezdzenia instrukcji. */
export const MAX_NESTING = 32;

export function parse(source: string): Program {
    const lx = lex(source);
    const toks = lx.tokens;
    const diagnostics: Diagnostic[] = [...lx.diagnostics];
    const filtlists: Filtlist[] = [];
    let p = 0;
    let cmpCount = 0;
    let decisionCount = 0;

    const cur = () => toks[p];
    const isWord = (w: string, t: Token = cur()) => t.kind === 'word' && t.value === w;
    const span = (a: Range, b: Range): Range => ({ start: a.start, end: b.end });
    const prevEnd = () => toks[Math.max(0, p - 1)].range;
    const err = (range: Range, code: string, message: string, severity: Severity = 'error') =>
        diagnostics.push({ range, severity, code, message });
    const show = (t: Token) => (t.kind === 'eof' ? 'koniec pliku' : `"${t.raw}"`);

    /** Pomija tokeny do poczatku nastepnej instrukcji. */
    function sync(): void {
        while (cur().kind !== 'eof') {
            const t = cur();
            if (t.kind === 'word' && (STMT_START.has(t.value) || STMT_END.has(t.value))) return;
            p++;
        }
    }

    function expect(kind: Token['kind'], what: string): Token | null {
        if (cur().kind === kind) return toks[p++];
        err(cur().range, 'ACS101', `oczekiwano ${what}, jest ${show(cur())}`);
        return null;
    }

    function parseVar(): VarRef {
        const t = toks[p++];
        const v: VarRef = { kind: 'var', name: t.value, range: t.range };
        // indeks tylko bezposrednio po nazwie: &DSN(3), &DSN(&NQUAL)
        const lp = cur();
        if (lp.kind === 'lparen' && lp.range.start.offset === t.range.end.offset) {
            const it = toks[p + 1];
            const rp = toks[p + 2];
            if ((it.kind === 'number' || it.kind === 'var') && rp.kind === 'rparen') {
                v.index = it.kind === 'number' ? Number(it.value) : it.value;
                v.range = span(t.range, rp.range);
                p += 3;
            } else {
                err(lp.range, 'ACS102', 'niepoprawny indeks zmiennej (liczba albo &NQUAL / &MEMNQUAL)');
            }
        }
        return v;
    }

    function parseOperand(): Operand | null {
        const t = cur();
        if (t.kind === 'var') return parseVar();
        if (t.kind === 'literal') {
            p++;
            return { kind: 'literal', value: t.value, range: t.range };
        }
        if (t.kind === 'number') {
            p++;
            return { kind: 'number', value: Number(t.value), text: t.value, unit: t.unit, range: t.range };
        }
        if (t.kind === 'word' && !(t.value in WORD_OPS) && !STMT_START.has(t.value) && !STMT_END.has(t.value)) {
            p++;
            return { kind: 'mask', text: t.value, range: t.range };
        }
        err(t.range, 'ACS103', `oczekiwano zmiennej, literalu, liczby albo maski, jest ${show(t)}`);
        return null;
    }

    function cmpOp(): CmpOp | null {
        const t = cur();
        const op = t.kind === 'op' ? t.value : t.kind === 'word' ? WORD_OPS[t.value] : undefined;
        if (!op || op === 'AND' || op === 'OR') return null;
        p++;
        return op as CmpOp;
    }

    function boolOp(): 'AND' | 'OR' | null {
        const t = cur();
        const op = t.kind === 'op' ? t.value : t.kind === 'word' ? WORD_OPS[t.value] : undefined;
        if (op !== 'AND' && op !== 'OR') return null;
        p++;
        return op;
    }

    function parseTerm(): Expr | null {
        if (cur().kind === 'lparen') {
            p++;
            const e = parseExpr();
            expect('rparen', '")"');
            if (e?.kind === 'bool') e.paren = true;
            return e;
        }
        const left = parseOperand();
        if (!left) return null;
        const opTok = cur();
        const op = cmpOp();
        if (!op) {
            err(opTok.range, 'ACS104', `oczekiwano operatora porownania (= EQ NE GT LT GE LE NG NL), jest ${show(opTok)}`);
            return null;
        }
        const right = parseOperand();
        if (!right) return null;
        return { kind: 'cmp', id: cmpCount++, left, op, right, range: span(left.range, right.range) };
    }

    function parseExpr(): Expr | null {
        let left = parseTerm();
        if (!left) return null;
        for (;;) {
            const op = boolOp();
            if (!op) return left;
            const right = parseTerm();
            if (!right) return left;
            const node: Bool = { kind: 'bool', op, left, right, range: span(left.range, right.range) };
            left = node;
        }
    }

    function parseList(): FiltEntry[] {
        const out: FiltEntry[] = [];
        if (!expect('lparen', '"("')) return out;
        while (cur().kind !== 'rparen' && cur().kind !== 'eof') {
            const t = cur();
            if (t.kind === 'literal') out.push({ kind: 'literal', text: t.value, range: t.range });
            else if (t.kind === 'number') out.push({ kind: 'mask', text: t.raw.replace(/\s+/g, '').toUpperCase(), range: t.range });
            else if (t.kind === 'word' && !STMT_START.has(t.value) && !STMT_END.has(t.value)) {
                out.push({ kind: 'mask', text: t.value, range: t.range });
            } else {
                err(t.range, 'ACS105', `w liscie FILTLIST oczekiwano literalu albo maski, jest ${show(t)}`);
                if (t.kind === 'word') return out;
                p++;
                continue;
            }
            p++;
            if (cur().kind === 'comma') {
                p++;
                if (cur().kind === 'rparen') err(cur().range, 'ACS106', 'przecinek przed ")" - brak pozycji listy');
            } else if (cur().kind !== 'rparen') {
                err(cur().range, 'ACS107', `oczekiwano "," albo ")", jest ${show(cur())}`);
                if (cur().kind === 'word' && (STMT_START.has(cur().value) || STMT_END.has(cur().value))) return out;
            }
        }
        expect('rparen', '")"');
        return out;
    }

    function parseFiltlist(): Filtlist {
        const kw = toks[p++];
        const nt = cur();
        let name = '';
        let nameRange = nt.range;
        if (nt.kind === 'var' || (nt.kind === 'word' && nt.value !== 'INCLUDE' && nt.value !== 'EXCLUDE')) {
            name = nt.value;
            p++;
        } else {
            err(nt.range, 'ACS108', `oczekiwano nazwy FILTLIST, jest ${show(nt)}`);
            nameRange = kw.range;
        }
        const f: Filtlist = { kind: 'filtlist', name, nameRange, include: [], exclude: [], range: kw.range };
        const seen = new Set<string>();
        while (isWord('INCLUDE') || isWord('EXCLUDE')) {
            const k = toks[p++];
            if (seen.has(k.value)) err(k.range, 'ACS109', `${k.value} podane drugi raz w tej samej FILTLIST`);
            seen.add(k.value);
            const list = parseList();
            if (k.value === 'INCLUDE') f.include.push(...list);
            else f.exclude.push(...list);
        }
        if (seen.size === 0) err(span(kw.range, nameRange), 'ACS110', 'FILTLIST wymaga INCLUDE(...) albo EXCLUDE(...)');
        f.range = span(kw.range, prevEnd());
        filtlists.push(f);
        return f;
    }

    /** Akcja po THEN / ELSE: jedna instrukcja. */
    function parseClause(after: Token, depth: number): Stmt | null {
        const t = cur();
        if (t.kind === 'word' && STMT_START.has(t.value)) return parseStatement(depth);
        err(after.range, 'ACS111', `po ${after.value} wymagana instrukcja (pusta akcja: DO END)`);
        return null;
    }

    function parseIf(depth: number): IfStmt {
        const kw = toks[p++];
        const node: IfStmt = { kind: 'if', id: decisionCount++, cond: null, then: null, else: null, hasElse: false, range: kw.range };
        node.cond = parseExpr();
        if (!node.cond) sync();
        if (isWord('THEN')) {
            const th = toks[p++];
            node.then = parseClause(th, depth + 1);
        } else {
            err(cur().range, 'ACS112', `po warunku IF oczekiwano THEN, jest ${show(cur())}`);
        }
        if (isWord('ELSE')) {
            const el = toks[p++];
            node.hasElse = true;
            node.else = parseClause(el, depth + 1);
        }
        node.range = span(kw.range, prevEnd());
        return node;
    }

    /** Akcja WHEN / OTHERWISE: instrukcje do nastepnego WHEN / OTHERWISE / END. */
    function parseAction(depth: number, what: string): Stmt[] {
        const body: Stmt[] = [];
        while (cur().kind === 'word' && STMT_START.has(cur().value)) {
            const start = cur();
            const s = parseStatement(depth);
            if (s) {
                if (body.length === 1) {
                    err(start.range, 'ACS113',
                        `kilka instrukcji po ${what}: wg dokumentacji akcja to jedna instrukcja - uzyj DO ... END`, 'warning');
                }
                body.push(s);
            }
        }
        return body;
    }

    function parseSelect(depth: number): SelectStmt {
        const kw = toks[p++];
        const node: SelectStmt = { kind: 'select', id: decisionCount++, subject: null, whens: [], otherwise: null, range: kw.range };
        if (cur().kind === 'lparen') {
            p++;
            if (cur().kind === 'var') node.subject = parseVar();
            else err(cur().range, 'ACS114', `w SELECT (...) oczekiwano zmiennej, jest ${show(cur())}`);
            expect('rparen', '")"');
        }
        for (;;) {
            if (isWord('WHEN')) {
                const w = toks[p++];
                if (node.otherwise) err(w.range, 'ACS115', 'WHEN po OTHERWISE');
                const when: When = { cond: null, body: [], range: w.range };
                if (expect('lparen', '"(" po WHEN')) {
                    if (node.subject) {
                        const value = parseOperand();
                        if (value) {
                            const c: Cmp = { kind: 'cmp', id: cmpCount++, left: node.subject, op: 'EQ', right: value, range: value.range };
                            when.cond = c;
                        }
                    } else {
                        when.cond = parseExpr();
                    }
                    if (cur().kind === 'rparen') p++;
                    else {
                        err(cur().range, 'ACS101', `oczekiwano ")", jest ${show(cur())}`);
                        sync();
                    }
                } else {
                    sync();
                }
                when.body = parseAction(depth + 1, 'WHEN');
                when.range = span(w.range, prevEnd());
                node.whens.push(when);
                continue;
            }
            if (isWord('OTHERWISE')) {
                const o = toks[p++];
                if (node.otherwise) err(o.range, 'ACS116', 'drugie OTHERWISE w tym samym SELECT');
                node.otherwise = [...(node.otherwise ?? []), ...parseAction(depth + 1, 'OTHERWISE')];
                continue;
            }
            break;
        }
        if (node.whens.length === 0) err(kw.range, 'ACS117', 'SELECT wymaga co najmniej jednego WHEN');
        if (isWord('END')) p++;
        else err(cur().range, 'ACS118', `oczekiwano WHEN, OTHERWISE albo END konczacego SELECT, jest ${show(cur())}`);
        node.range = span(kw.range, prevEnd());
        return node;
    }

    function parseStatement(depth: number): Stmt | null {
        const t = cur();
        if (depth === MAX_NESTING + 1) err(t.range, 'ACS119', `wiecej niz ${MAX_NESTING} poziomy zagniezdzenia instrukcji`);
        switch (t.value) {
            case 'FILTLIST':
                return parseFiltlist();
            case 'IF':
                return parseIf(depth);
            case 'SELECT':
                return parseSelect(depth);
            case 'DO': {
                p++;
                const body = parseBlock(depth + 1);
                if (isWord('END')) p++;
                else err(cur().range, 'ACS120', `oczekiwano END konczacego DO, jest ${show(cur())}`);
                return { kind: 'do', body, range: span(t.range, prevEnd()) };
            }
            case 'SET': {
                p++;
                let target: VarRef | null = null;
                if (cur().kind === 'var') target = parseVar();
                else err(cur().range, 'ACS121', `po SET oczekiwano zmiennej (&DATACLAS, &STORCLAS, &MGMTCLAS, &STORGRP), jest ${show(cur())}`);
                const eq = cur();
                if ((eq.kind === 'op' && eq.value === 'EQ') || isWord('EQ')) p++;
                else err(eq.range, 'ACS122', `w SET oczekiwano = albo EQ, jest ${show(eq)}`);
                const values: (Literal | VarRef)[] = [];
                for (;;) {
                    const v = cur();
                    if (v.kind === 'literal') {
                        p++;
                        values.push({ kind: 'literal', value: v.value, range: v.range });
                    } else if (v.kind === 'var') values.push(parseVar());
                    else {
                        err(v.range, 'ACS123', `wartosc SET: nazwa w apostrofach albo &DEF_..., jest ${show(v)}`);
                        break;
                    }
                    if (cur().kind !== 'comma') break;
                    p++;
                }
                if (cur().kind === 'semi') p++;
                return { kind: 'set', target, values, range: span(t.range, prevEnd()) };
            }
            case 'EXIT': {
                p++;
                let code = 0;
                if (isWord('CODE')) {
                    p++;
                    if (expect('lparen', '"(" po CODE')) {
                        const n = cur();
                        if (n.kind === 'number' && !n.unit) {
                            code = Number(n.value);
                            p++;
                        } else err(n.range, 'ACS124', `kod EXIT: liczba, jest ${show(n)}`);
                        expect('rparen', '")"');
                    }
                }
                if (cur().kind === 'semi') p++;
                return { kind: 'exit', code, range: span(t.range, prevEnd()) };
            }
            case 'WRITE': {
                p++;
                const parts: (Literal | VarRef)[] = [];
                while (cur().kind === 'literal' || cur().kind === 'var') {
                    const v = cur();
                    if (v.kind === 'literal') {
                        p++;
                        parts.push({ kind: 'literal', value: v.value, range: v.range });
                    } else parts.push(parseVar());
                }
                if (parts.length === 0) err(cur().range, 'ACS125', `po WRITE oczekiwano tekstu w apostrofach, jest ${show(cur())}`);
                if (cur().kind === 'semi') p++;
                return { kind: 'write', parts, range: span(t.range, prevEnd()) };
            }
            case 'LOGWRITES':
                p++;
                return { kind: 'logwrites', range: t.range };
            default:
                return null;
        }
    }

    /** Instrukcje do END (albo konca pliku). */
    function parseBlock(depth: number): Stmt[] {
        const body: Stmt[] = [];
        for (;;) {
            const t = cur();
            if (t.kind === 'eof' || isWord('END')) return body;
            if (t.kind === 'semi') {
                p++;
                continue;
            }
            if (t.kind === 'word' && STMT_START.has(t.value)) {
                const before = p;
                const s = parseStatement(depth);
                if (s) body.push(s);
                if (p === before) p++;
                continue;
            }
            if (t.kind === 'word' && STMT_END.has(t.value)) {
                err(t.range, 'ACS126', `${t.value} bez pasujacej instrukcji`);
                p++;
                continue;
            }
            err(t.range, 'ACS127', `oczekiwano instrukcji (FILTLIST, SET, IF, SELECT, DO, EXIT, WRITE), jest ${show(t)}`);
            p++;
            sync();
        }
    }

    // --- PROC ... END
    let routine: Routine | null = null;
    let procRange: Range | null = null;
    const first = cur();
    if (isWord('PROC')) {
        p++;
        if (cur().kind === 'number') p++;
        const r = cur();
        if ((r.kind === 'word' || r.kind === 'var') && (ROUTINE_NAMES as string[]).includes(r.value)) {
            routine = r.value as Routine;
            procRange = r.range;
            p++;
        } else {
            err(r.range, 'ACS128', `po PROC oczekiwano DATACLAS, STORCLAS, MGMTCLAS albo STORGRP, jest ${show(r)}`);
            if (r.kind === 'word' && !STMT_START.has(r.value) && !STMT_END.has(r.value)) p++;
            else if (r.kind === 'var') p++;
        }
    } else if (first.kind !== 'eof') {
        err(first.range, 'ACS129', `rutyna musi zaczynac sie od PROC, jest ${show(first)}`);
    }
    const body = parseBlock(1);
    if (isWord('END')) {
        p++;
        while (cur().kind === 'semi') p++;
        if (cur().kind !== 'eof') {
            err(cur().range, 'ACS130', `tekst po END konczacym rutyne (${show(cur())}) - nadmiarowy END albo brak DO / SELECT`);
        }
    } else if (first.kind !== 'eof') {
        err(cur().range, 'ACS131', 'brak END konczacego rutyne (PROC ... END)');
    }
    const last = toks[toks.length - 1];
    return {
        routine,
        procRange,
        body,
        filtlists,
        cmpCount,
        decisionCount,
        comments: lx.comments,
        diagnostics,
        range: { start: toks[0].range.start, end: last.range.end },
        sequenceNumbers: lx.sequenceNumbers,
    };
}
