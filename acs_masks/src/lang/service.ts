/**
 * Funkcje edytora dla rutyn ACS - czysta logika bez zaleznosci od VS Code (testowalna w node --test).
 * Rozszerzenie (vscode/src/extension.ts) tylko tlumaczy typy. Pozycje: linia i kolumna od 0.
 */
import { allVarRefs, Expr, Filtlist, Program, Stmt, VarRef, walkStmts } from './ast';
import { check, CheckOptions, filtlistMap } from './check';
import { Diagnostic, lex, lineStarts, Pos, posAt, Range, Token } from './lexer';
import { KEYWORDS, parse } from './parser';
import { VAR_LIST, VarInfo, VARS } from './vars';

export interface Analysis {
    source: string;
    program: Program;
    lists: Map<string, Filtlist>;
    diagnostics: Diagnostic[];
    tokens: Token[];
    refs: VarRef[];
    starts: number[];
}

export function analyze(source: string, opt: CheckOptions = {}): Analysis {
    const program = parse(source);
    return {
        source,
        program,
        lists: filtlistMap(program),
        diagnostics: check(program, source, opt),
        tokens: lex(source).tokens,
        refs: allVarRefs(program),
        starts: lineStarts(source),
    };
}

export const offsetAt = (a: Analysis, line: number, col: number) => (a.starts[line] ?? a.source.length) + col;
const inside = (r: Range, off: number) => r.start.offset <= off && off <= r.end.offset;

// --- konspekt

export interface SymbolNode {
    name: string;
    detail: string;
    kind: 'routine' | 'filtlist' | 'select' | 'when' | 'otherwise' | 'if' | 'do';
    range: Range;
    selectionRange: Range;
    children: SymbolNode[];
}

const squash = (s: string, max = 60) => {
    const t = s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
};

export function symbols(a: Analysis): SymbolNode[] {
    const text = (r: Range) => a.source.slice(r.start.offset, r.end.offset);
    const head = (r: Range): Range => ({ start: r.start, end: posAt(a.starts, Math.min(r.end.offset, a.starts[r.start.line + 1] ?? r.end.offset)) });
    const exprText = (e: Expr | null) => (e ? squash(text(e.range)) : '?');
    /** krotki opis akcji: pierwszy SET / EXIT */
    const action = (stmts: Stmt[]): string => {
        let out = '';
        walkStmts(stmts, s => {
            if (out) return;
            if (s.kind === 'set') out = squash(text(s.range), 40);
            else if (s.kind === 'exit') out = s.code ? `EXIT CODE(${s.code})` : 'EXIT';
        });
        return out;
    };
    const conv = (stmts: Stmt[]): SymbolNode[] => {
        const out: SymbolNode[] = [];
        for (const s of stmts) {
            if (s.kind === 'filtlist') {
                out.push({
                    name: s.name || '?', detail: `FILTLIST: INCLUDE ${s.include.length}, EXCLUDE ${s.exclude.length}`,
                    kind: 'filtlist', range: s.range, selectionRange: s.nameRange, children: [],
                });
            } else if (s.kind === 'select') {
                const children: SymbolNode[] = s.whens.map(w => ({
                    name: `WHEN (${s.subject && w.cond?.kind === 'cmp' ? squash(text(w.cond.right.range)) : exprText(w.cond)})`,
                    detail: action(w.body), kind: 'when' as const, range: w.range, selectionRange: head(w.range), children: conv(w.body),
                }));
                if (s.otherwise) {
                    const r = s.otherwise.length ? { start: s.otherwise[0].range.start, end: s.otherwise[s.otherwise.length - 1].range.end } : s.range;
                    children.push({ name: 'OTHERWISE', detail: action(s.otherwise), kind: 'otherwise', range: r, selectionRange: head(r), children: conv(s.otherwise) });
                }
                out.push({
                    name: s.subject ? `SELECT (&${s.subject.name})` : 'SELECT', detail: `${s.whens.length} WHEN`,
                    kind: 'select', range: s.range, selectionRange: head(s.range), children,
                });
            } else if (s.kind === 'if') {
                const children = [...(s.then ? conv([s.then]) : []), ...(s.else ? conv([s.else]) : [])];
                out.push({
                    name: `IF ${exprText(s.cond)}`, detail: action(s.then ? [s.then] : []), kind: 'if',
                    range: s.range, selectionRange: head(s.range), children,
                });
            } else if (s.kind === 'do') out.push(...conv(s.body));
        }
        return out;
    };
    const body = conv(a.program.body);
    if (!a.program.routine) return body;
    return [{
        name: `PROC ${a.program.routine}`, detail: '', kind: 'routine', range: a.program.range,
        selectionRange: a.program.procRange ?? head(a.program.range), children: body,
    }];
}

// --- definicje, odwolania, zmiana nazwy

/** Nazwa FILTLIST pod kursorem (definicja albo odwolanie). */
function filtlistAt(a: Analysis, off: number): { name: string; range: Range } | null {
    for (const f of a.program.filtlists) if (f.name && inside(f.nameRange, off)) return { name: f.name, range: f.nameRange };
    for (const r of a.refs) if (inside(r.range, off) && !VARS.has(r.name) && a.lists.has(r.name)) return { name: r.name, range: r.range };
    return null;
}

export function definitionAt(a: Analysis, line: number, col: number): Range | null {
    const f = filtlistAt(a, offsetAt(a, line, col));
    return f ? a.lists.get(f.name)!.nameRange : null;
}

/** Zakresy samej nazwy (bez &) - do podswietlenia i zmiany nazwy. */
function nameRanges(a: Analysis, name: string, withDecl: boolean): Range[] {
    const out: Range[] = [];
    const bare = (r: Range): Range => (a.source[r.start.offset] === '&'
        ? { start: posAt(a.starts, r.start.offset + 1), end: posAt(a.starts, r.start.offset + 1 + name.length) }
        : { start: r.start, end: posAt(a.starts, r.start.offset + name.length) });
    if (withDecl) for (const f of a.program.filtlists) if (f.name === name) out.push(bare(f.nameRange));
    for (const r of a.refs) if (r.name === name && !VARS.has(r.name)) out.push(bare(r.range));
    return out;
}

export function referencesAt(a: Analysis, line: number, col: number, withDecl: boolean): Range[] {
    const off = offsetAt(a, line, col);
    const f = filtlistAt(a, off);
    if (f) return nameRanges(a, f.name, withDecl);
    // zmienna ACS: wszystkie uzycia
    const v = a.refs.find(r => inside(r.range, off) && VARS.has(r.name));
    return v ? a.refs.filter(r => r.name === v.name).map(r => r.range) : [];
}

export function renameAt(a: Analysis, line: number, col: number, newName: string): { edits: Range[]; name: string } | { error: string } {
    const f = filtlistAt(a, offsetAt(a, line, col));
    if (!f) return { error: 'zmienic nazwe mozna tylko dla FILTLIST' };
    const name = newName.replace(/^&/, '').toUpperCase();
    if (name.length > 31 || !/^[A-Z0-9$@#][A-Z0-9$@#_]*$/.test(name)) return { error: 'nazwa FILTLIST: do 31 znakow alfanumerycznych i _' };
    if (VARS.has(name)) return { error: `${name} jest nazwa zmiennej ACS` };
    if (a.lists.has(name) && name !== f.name) return { error: `FILTLIST ${name} juz istnieje` };
    return { edits: nameRanges(a, f.name, true), name };
}

// --- podpowiedz po najechaniu

const KEYWORD_DOC: Record<string, string> = {
    PROC: '`PROC [n] DATACLAS|STORCLAS|MGMTCLAS|STORGRP` - poczatek rutyny; konczy ja `END`.',
    FILTLIST: '`FILTLIST nazwa INCLUDE(lista) EXCLUDE(lista)` - lista literalow i masek (do 255 pozycji w kazdej). EXCLUDE ma pierwszenstwo. Lista nie moze odwolywac sie do innej FILTLIST.',
    SET: '`SET &zmienna = \'NAZWA\'` - ustawia zmienna rutyny. `&STORGRP` przyjmuje do 15 nazw po przecinku, pozostale takze `\'\'` (pusta) i `&DEF_...`.',
    SELECT: '`SELECT [(zmienna)] WHEN (...) akcja ... [OTHERWISE akcja] END` - wykonywany jest pierwszy prawdziwy WHEN.',
    WHEN: 'Galaz `SELECT`: warunek w nawiasach i jedna akcja (kilka instrukcji: `DO ... END`).',
    OTHERWISE: 'Akcja `SELECT`, gdy zaden WHEN nie jest prawdziwy.',
    IF: '`IF warunek THEN akcja [ELSE akcja]`. Pusta akcja: `DO END`.',
    DO: '`DO instrukcje END` - grupa instrukcji.',
    EXIT: '`EXIT [CODE(n)]` - koniec rutyny. Kod rozny od zera odrzuca alokacje i pomija nastepne rutyny.',
    WRITE: '`WRITE \'tekst\' [&zmienna]` - komunikat dla uzytkownika (do 110 znakow; najwyzej 5 komunikatow na alokacje).',
    LOGWRITES: '`LOGWRITES` - zapis komunikatow WRITE do LOGREC (wymaga ACS_LOGWRITES w IGDSMSxx).',
    AND: 'Uwaga: ACS nie daje pierwszenstwa AND przed OR - wyrazenie bez nawiasow jest liczone od lewej do prawej.',
    OR: 'Uwaga: ACS nie daje pierwszenstwa AND przed OR - wyrazenie bez nawiasow jest liczone od lewej do prawej.',
    NG: '`NG` (`¬>`) - nie wieksze, czyli mniejsze lub rowne.',
    NL: '`NL` (`¬<`) - nie mniejsze, czyli wieksze lub rowne.',
};

function varDoc(v: VarInfo): string {
    const type = v.type === 'char' ? `znakowa${v.max ? `, do ${v.max} znakow` : ''}` : v.type === 'size' ? 'liczbowa z jednostka KB / MB' : 'liczbowa';
    const lines = [`**&${v.name}** - ${v.rw ? `ustawiana w rutynie ${v.rw}` : 'tylko do odczytu'} (${type})`, '', v.desc];
    if (v.values) lines.push('', `Wartosci: ${v.values.map(x => `\`${x}\``).join(', ')}${v.type === 'char' ? ' albo pusta' : ''}`);
    if (v.noMask) lines.push('', 'Nie mozna porownywac z maska - tylko z literalem w apostrofach.');
    if (v.notInSg) lines.push('', 'Niedozwolona w rutynie STORGRP.');
    lines.push('', v.source ? `Symulacja na DCOLLECT: ${v.source}.` : 'Brak danych w DCOLLECT - w symulacji wartosc stala (`--var`).');
    return lines.join('\n');
}

function listDoc(f: Filtlist): string {
    const show = (label: string, es: Filtlist['include']) => (es.length
        ? [`${label} (${es.length}): ${es.slice(0, 12).map(e => `\`${e.kind === 'literal' ? `'${e.text}'` : e.text}\``).join(', ')}${es.length > 12 ? ', …' : ''}`]
        : []);
    return [`**FILTLIST ${f.name}** (linia ${f.range.start.line + 1})`, '', ...show('INCLUDE', f.include), '', ...show('EXCLUDE', f.exclude)].join('\n');
}

export function hoverAt(a: Analysis, line: number, col: number): { range: Range; markdown: string } | null {
    const off = offsetAt(a, line, col);
    const t = a.tokens.find(x => x.kind !== 'eof' && inside(x.range, off));
    if (!t) return null;
    if (t.kind === 'var') {
        const v = VARS.get(t.value);
        if (v) return { range: t.range, markdown: varDoc(v) };
        const f = a.lists.get(t.value);
        return f ? { range: t.range, markdown: listDoc(f) } : null;
    }
    if (t.kind === 'word') {
        const f = a.program.filtlists.find(x => x.name === t.value && inside(x.nameRange, off));
        if (f) return { range: t.range, markdown: listDoc(f) };
        const doc = KEYWORD_DOC[t.value];
        if (doc) return { range: t.range, markdown: doc };
    }
    return null;
}

// --- uzupelnianie

export interface Completion {
    label: string;
    kind: 'variable' | 'filtlist' | 'keyword' | 'value' | 'snippet';
    detail: string;
    doc: string;
    /** tekst do wstawienia (snippet: skladnia VS Code) */
    insert: string;
    /** kolumna poczatku zastepowanego tekstu w biezacej linii */
    replaceFrom: number;
}

const SNIPPETS: [string, string, string][] = [
    ['SELECT', 'SELECT ... WHEN ... OTHERWISE ... END', 'SELECT\n  WHEN (${1:&DSN = ${2:MASKA}})\n    SET ${3:&STORCLAS} = \'${4:NAZWA}\'\n  OTHERWISE\n    SET ${3:&STORCLAS} = \'${5:NAZWA}\'\nEND'],
    ['IF', 'IF ... THEN DO ... END', 'IF ${1:&HLQ = \'${2:X}\'} THEN\n  DO\n    $0\n  END'],
    ['FILTLIST', 'FILTLIST nazwa INCLUDE(...) EXCLUDE(...)', 'FILTLIST ${1:NAZWA} INCLUDE(${2:MASKA})\n         ${3:EXCLUDE(${4:MASKA})}'],
    ['WHEN', 'WHEN (...) SET ...', 'WHEN (${1:&DSN = ${2:MASKA}})\n  SET ${3:&STORCLAS} = \'${4:NAZWA}\''],
];

export function completionsAt(a: Analysis, line: number, col: number): Completion[] {
    const start = a.starts[line] ?? a.source.length;
    const before = a.source.slice(start, start + col);
    // w komentarzu - nic
    const off = start + col;
    if (a.program.comments.some(c => c.start.offset < off && off < c.end.offset)) return [];
    const mv = /&([A-Za-z0-9_$@#]*)$/.exec(before);
    if (mv) {
        const from = col - mv[0].length;
        const out: Completion[] = [...a.lists.values()].map(f => ({
            label: `&${f.name}`, kind: 'filtlist' as const, detail: `FILTLIST (INCLUDE ${f.include.length}, EXCLUDE ${f.exclude.length})`,
            doc: listDoc(f), insert: `&${f.name}`, replaceFrom: from,
        }));
        for (const v of VAR_LIST) {
            if (v.rw && a.program.routine && v.name === 'STORGRP' && a.program.routine !== 'STORGRP') continue;
            if (v.notInSg && a.program.routine === 'STORGRP') continue;
            out.push({ label: `&${v.name}`, kind: 'variable', detail: v.desc, doc: varDoc(v), insert: `&${v.name}`, replaceFrom: from });
        }
        return out;
    }
    // wartosc zmiennej wyliczeniowej: &DSORG = 'P
    const ml = /&([A-Za-z0-9_$@#]+)\s*(?:=|¬=|\^=|\bEQ\b|\bNE\b)\s*'([A-Za-z0-9]*)$/i.exec(before);
    if (ml) {
        const v = VARS.get(ml[1].toUpperCase());
        if (v?.values) {
            return v.values.map(x => ({ label: x, kind: 'value' as const, detail: `wartosc &${v.name}`, doc: '', insert: x, replaceFrom: col - ml[2].length }));
        }
        return [];
    }
    // w literale - nic
    if ((before.replace(/''/g, '').match(/'/g) ?? []).length % 2 === 1) return [];
    const mw = /[A-Za-z]*$/.exec(before)!;
    const from = col - mw[0].length;
    return [
        ...SNIPPETS.map(([label, detail, insert]) => ({ label, kind: 'snippet' as const, detail, doc: '', insert, replaceFrom: from })),
        ...KEYWORDS.map(k => ({ label: k, kind: 'keyword' as const, detail: '', doc: KEYWORD_DOC[k] ?? '', insert: k, replaceFrom: from })),
        ...['AND', 'OR', 'EQ', 'NE', 'GT', 'LT', 'GE', 'LE', 'NG', 'NL', 'KB', 'MB'].map(k => ({
            label: k, kind: 'keyword' as const, detail: 'operator', doc: KEYWORD_DOC[k] ?? '', insert: k, replaceFrom: from,
        })),
    ];
}

// --- zwijanie

export interface Fold {
    startLine: number;
    endLine: number;
    comment?: boolean;
}

export function foldingRanges(a: Analysis): Fold[] {
    const out: Fold[] = [];
    const add = (r: Range, comment = false) => {
        if (r.end.line > r.start.line) out.push({ startLine: r.start.line, endLine: r.end.line, comment: comment || undefined });
    };
    for (const c of a.program.comments) add(c, true);
    walkStmts(a.program.body, s => {
        if (s.kind === 'select') {
            add(s.range);
            for (const w of s.whens) add(w.range);
        } else if (s.kind === 'do' || s.kind === 'if' || s.kind === 'filtlist') add(s.range);
    });
    return out;
}

export type { Pos, Range };
