/** Drzewo skladniowe rutyny ACS. Kazdy wezel ma zakres w zrodle (edytor, komunikaty). */
import type { Diagnostic, Op, Range } from './lexer';

export type Routine = 'DATACLAS' | 'STORCLAS' | 'MGMTCLAS' | 'STORGRP';
export const ROUTINE_NAMES: Routine[] = ['DATACLAS', 'STORCLAS', 'MGMTCLAS', 'STORGRP'];

export type CmpOp = Exclude<Op, 'AND' | 'OR'>;

/** Odwolanie &NAZWA: zmienna ACS albo FILTLIST (rozstrzyga sprawdzanie / wykonanie). */
export interface VarRef {
    kind: 'var';
    name: string;
    /** indeks: liczba albo zmienna (&DSN(&NQUAL)) */
    index?: number | string;
    range: Range;
}

export interface Literal {
    kind: 'literal';
    value: string;
    range: Range;
}

/** Maska albo slowo bez apostrofow (SYS1.**, TSO*, 3390). */
export interface MaskConst {
    kind: 'mask';
    text: string;
    range: Range;
}

export interface NumberConst {
    kind: 'number';
    value: number;
    /** cyfry jak w zrodle (porownanie ze zmienna znakowa: &UNIT = 3390) */
    text: string;
    unit?: 'KB' | 'MB';
    range: Range;
}

export type Operand = VarRef | Literal | MaskConst | NumberConst;

export interface Cmp {
    kind: 'cmp';
    /** numer porownania w rutynie (od 0), staly dla danego zrodla */
    id: number;
    left: Operand;
    op: CmpOp;
    right: Operand;
    range: Range;
}

export interface Bool {
    kind: 'bool';
    op: 'AND' | 'OR';
    left: Expr;
    right: Expr;
    /** wyrazenie bylo w nawiasach */
    paren?: boolean;
    range: Range;
}

export type Expr = Cmp | Bool;

export interface FiltEntry {
    kind: 'literal' | 'mask';
    text: string;
    range: Range;
}

export interface Filtlist {
    kind: 'filtlist';
    name: string;
    nameRange: Range;
    include: FiltEntry[];
    exclude: FiltEntry[];
    range: Range;
}

export interface SetStmt {
    kind: 'set';
    target: VarRef | null;
    values: (Literal | VarRef)[];
    range: Range;
}

export interface IfStmt {
    kind: 'if';
    /** numer decyzji w rutynie (sciezka wykonania) */
    id: number;
    cond: Expr | null;
    then: Stmt | null;
    else: Stmt | null;
    hasElse: boolean;
    range: Range;
}

export interface When {
    /** SELECT bez zmiennej: warunek; SELECT (zmienna): porownanie zmienna = wartosc */
    cond: Expr | null;
    body: Stmt[];
    range: Range;
}

export interface SelectStmt {
    kind: 'select';
    id: number;
    subject: VarRef | null;
    whens: When[];
    otherwise: Stmt[] | null;
    range: Range;
}

export interface DoStmt {
    kind: 'do';
    body: Stmt[];
    range: Range;
}

export interface ExitStmt {
    kind: 'exit';
    code: number;
    range: Range;
}

export interface WriteStmt {
    kind: 'write';
    parts: (Literal | VarRef)[];
    range: Range;
}

export interface LogWritesStmt {
    kind: 'logwrites';
    range: Range;
}

export type Stmt = SetStmt | IfStmt | SelectStmt | DoStmt | ExitStmt | WriteStmt | LogWritesStmt | Filtlist;

export interface Program {
    routine: Routine | null;
    /** zakres nazwy rutyny w instrukcji PROC */
    procRange: Range | null;
    body: Stmt[];
    filtlists: Filtlist[];
    /** liczba porownan (Cmp.id) i decyzji (IfStmt.id / SelectStmt.id) */
    cmpCount: number;
    decisionCount: number;
    comments: Range[];
    diagnostics: Diagnostic[];
    range: Range;
    sequenceNumbers: boolean;
}

/** Przejscie po instrukcjach (w glab), w kolejnosci zrodla. */
export function walkStmts(stmts: Stmt[], fn: (s: Stmt, depth: number) => void, depth = 0): void {
    for (const s of stmts) {
        fn(s, depth);
        if (s.kind === 'do') walkStmts(s.body, fn, depth + 1);
        else if (s.kind === 'if') {
            if (s.then) walkStmts([s.then], fn, depth + 1);
            if (s.else) walkStmts([s.else], fn, depth + 1);
        } else if (s.kind === 'select') {
            for (const w of s.whens) walkStmts(w.body, fn, depth + 1);
            if (s.otherwise) walkStmts(s.otherwise, fn, depth + 1);
        }
    }
}

export function walkExpr(e: Expr | null, fn: (c: Cmp) => void): void {
    if (!e) return;
    if (e.kind === 'cmp') fn(e);
    else {
        walkExpr(e.left, fn);
        walkExpr(e.right, fn);
    }
}

/** Wszystkie porownania rutyny w kolejnosci zrodla. */
export function allCmps(p: Program): Cmp[] {
    const out: Cmp[] = [];
    walkStmts(p.body, s => {
        if (s.kind === 'if') walkExpr(s.cond, c => out.push(c));
        else if (s.kind === 'select') for (const w of s.whens) walkExpr(w.cond, c => out.push(c));
    });
    return out;
}

/** Wszystkie odwolania &NAZWA (porownania, SET, WRITE, SELECT) w kolejnosci zrodla. */
export function allVarRefs(p: Program): VarRef[] {
    const out: VarRef[] = [];
    const operand = (o: Operand | null) => {
        if (o && o.kind === 'var') out.push(o);
    };
    walkStmts(p.body, s => {
        if (s.kind === 'if') {
            walkExpr(s.cond, c => {
                operand(c.left);
                operand(c.right);
            });
        } else if (s.kind === 'select') {
            // SELECT (zmienna): lewa strona porownan WHEN to ta sama zmienna - raz
            if (s.subject) out.push(s.subject);
            for (const w of s.whens) {
                walkExpr(w.cond, c => {
                    if (c.left !== s.subject) operand(c.left);
                    operand(c.right);
                });
            }
        } else if (s.kind === 'set') {
            operand(s.target);
            s.values.forEach(operand);
        } else if (s.kind === 'write') s.parts.forEach(operand);
    });
    return out;
}
