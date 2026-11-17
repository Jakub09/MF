/**
 * Lekser jezyka rutyn ACS (z/OS DFSMSdfp Storage Administration, rozdz. "Writing ACS routines").
 *
 * - komentarze: od "/" + "*" do "*" + "/", bez zagniezdzania
 * - literal w apostrofach ('' = apostrof); kontynuacja literalu na nastepnej linii: ostatni niepusty znak
 *   linii "+" (pomija spacje wiodace nastepnej linii) albo "-" (zachowuje je)
 * - poza literalem "+" / "-" na koncu linii to opcjonalny znak kontynuacji - pomijany
 * - zmienna i nazwa FILTLIST: &NAZWA; "&&" = AND, "|" = OR
 * - porownania: = EQ, ¬= ^= NE, > GT, < LT, >= GE, <= LE, ¬> ^> NG, ¬< ^< NL
 * - liczba z opcjonalnym KB / MB (200KB, 10 MB)
 * - maska / slowo: ciag bez apostrofow (SYS1.**, TSO*, IMS%%%, slowa kluczowe)
 *
 * Lekser nie rzuca wyjatkow: bledy trafiaja do listy diagnostyk, a analiza idzie dalej (edytor).
 * Pozycje: linia i kolumna od 0 (jak w LSP / VS Code), offset w tekscie.
 */

export interface Pos {
    line: number;
    col: number;
    offset: number;
}

export interface Range {
    start: Pos;
    end: Pos;
}

export type Severity = 'error' | 'warning' | 'info' | 'hint';

export interface Diagnostic {
    range: Range;
    severity: Severity;
    /** staly kod, np. ACS101 */
    code: string;
    message: string;
}

export type TokKind = 'word' | 'var' | 'literal' | 'number' | 'op' | 'lparen' | 'rparen' | 'comma' | 'semi' | 'eof';

/** Operator kanoniczny: porownania i logiczne. */
export type Op = 'EQ' | 'NE' | 'GT' | 'LT' | 'GE' | 'LE' | 'AND' | 'OR';

export interface Token {
    kind: TokKind;
    /** tekst zrodlowy */
    raw: string;
    /**
     * word: wielkimi literami; var: nazwa bez & wielkimi literami; literal: tresc bez apostrofow;
     * number: cyfry; op: operator kanoniczny
     */
    value: string;
    /** number: przyrostek KB / MB */
    unit?: 'KB' | 'MB';
    range: Range;
}

export interface LexResult {
    tokens: Token[];
    comments: Range[];
    diagnostics: Diagnostic[];
    /** czy wykryto numery sekwencyjne w kol. 73-80 (pominiete) */
    sequenceNumbers: boolean;
}

/** Slowa-operatory (porownania i logiczne). */
export const WORD_OPS: Record<string, Op> = {
    EQ: 'EQ', NE: 'NE', GT: 'GT', LT: 'LT', GE: 'GE', LE: 'LE', NG: 'LE', NL: 'GE', AND: 'AND', OR: 'OR',
};

const WORD_CHAR = /[A-Za-z0-9$@#*%._]/;

/** Offsety poczatkow linii. */
export function lineStarts(text: string): number[] {
    const out = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) out.push(i + 1);
    return out;
}

export function posAt(starts: number[], offset: number): Pos {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= offset) lo = mid;
        else hi = mid - 1;
    }
    return { line: lo, col: offset - starts[lo], offset };
}

/**
 * Numery sekwencyjne: gdy sa linie dluzsze niz 72 znaki i kazda z nich ma w kol. 73-80 osiem cyfr,
 * kolumny te sa zastepowane spacjami (offsety bez zmian).
 */
function maskSequenceNumbers(text: string): { text: string; found: boolean } {
    const lines = text.split('\n');
    let long = 0;
    for (const l of lines) {
        const s = l.replace(/\r$/, '');
        if (s.length <= 72) continue;
        if (s.length > 80 || !/^\d{8}$/.test(s.slice(72).padEnd(8, 'x'))) return { text, found: false };
        long++;
    }
    if (long === 0) return { text, found: false };
    return {
        text: lines.map(l => {
            const cr = l.endsWith('\r') ? '\r' : '';
            const s = cr ? l.slice(0, -1) : l;
            return (s.length > 72 ? s.slice(0, 72) + ' '.repeat(s.length - 72) : s) + cr;
        }).join('\n'),
        found: true,
    };
}

export function lex(source: string): LexResult {
    const masked = maskSequenceNumbers(source);
    const text = masked.text;
    const starts = lineStarts(text);
    const tokens: Token[] = [];
    const comments: Range[] = [];
    const diagnostics: Diagnostic[] = [];
    const n = text.length;
    let i = 0;

    const range = (a: number, b: number): Range => ({ start: posAt(starts, a), end: posAt(starts, b) });
    const diag = (a: number, b: number, code: string, message: string, severity: Severity = 'error') =>
        diagnostics.push({ range: range(a, b), severity, code, message });
    const push = (kind: TokKind, a: number, b: number, value: string, unit?: 'KB' | 'MB') =>
        tokens.push({ kind, raw: source.slice(a, b), value, unit, range: range(a, b) });
    /** czy od pozycji p do konca linii sa tylko biale znaki */
    const restBlank = (p: number) => {
        for (; p < n && text[p] !== '\n'; p++) if (text[p] !== ' ' && text[p] !== '\r' && text[p] !== '\t') return false;
        return true;
    };

    while (i < n) {
        const c = text[i];
        if (c === ' ' || c === '\n' || c === '\r') {
            i++;
            continue;
        }
        if (c === '\t') {
            diag(i, i + 1, 'ACS001', 'tabulator w zrodle rutyny ACS (uzyj spacji)', 'warning');
            i++;
            continue;
        }
        if (c === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            const b = end < 0 ? n : end + 2;
            if (end < 0) diag(i, Math.min(n, i + 2), 'ACS002', 'niezamkniety komentarz (brak */)');
            comments.push(range(i, b));
            i = b;
            continue;
        }
        if (c === "'") {
            const a = i;
            let value = '';
            let segStart = 0;
            let closed = false;
            i++;
            while (i < n) {
                const ch = text[i];
                if (ch === "'") {
                    if (text[i + 1] === "'") {
                        value += "'";
                        i += 2;
                        continue;
                    }
                    i++;
                    closed = true;
                    break;
                }
                if (ch === '\n') {
                    const seg = value.slice(segStart).replace(/[ \r\t]+$/, '');
                    const last = seg[seg.length - 1];
                    if (last !== '+' && last !== '-') break;
                    value = value.slice(0, segStart) + seg.slice(0, -1);
                    i++;
                    if (last === '+') while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
                    segStart = value.length;
                    continue;
                }
                value += ch;
                i++;
            }
            if (!closed) {
                value = value.replace(/\r$/, '');
                diag(a, i, 'ACS003', 'niezamkniety literal (brak apostrofu; kontynuacja wymaga + albo - na koncu linii)');
            }
            if (value.length > 255) diag(a, i, 'ACS004', `literal dluzszy niz 255 znakow (${value.length})`);
            push('literal', a, i, value);
            continue;
        }
        if (c === '&') {
            if (text[i + 1] === '&') {
                push('op', i, i + 2, 'AND');
                i += 2;
                continue;
            }
            let j = i + 1;
            while (j < n && /[A-Za-z0-9_$@#]/.test(text[j])) j++;
            if (j === i + 1) {
                diag(i, i + 1, 'ACS005', 'po & oczekiwano nazwy zmiennej albo FILTLIST');
                i++;
                continue;
            }
            push('var', i, j, source.slice(i + 1, j).toUpperCase());
            i = j;
            continue;
        }
        if (c === '|') {
            push('op', i, i + 1, 'OR');
            i++;
            continue;
        }
        if (c === '¬' || c === '^') {
            const nx = text[i + 1];
            const op = nx === '=' ? 'NE' : nx === '>' ? 'LE' : nx === '<' ? 'GE' : null;
            if (!op) {
                diag(i, i + 1, 'ACS006', `po "${c}" oczekiwano =, > albo <`);
                i++;
                continue;
            }
            push('op', i, i + 2, op);
            i += 2;
            continue;
        }
        if (c === '>' || c === '<') {
            if (text[i + 1] === '=') {
                push('op', i, i + 2, c === '>' ? 'GE' : 'LE');
                i += 2;
            } else {
                push('op', i, i + 1, c === '>' ? 'GT' : 'LT');
                i++;
            }
            continue;
        }
        if (c === '=') {
            push('op', i, i + 1, 'EQ');
            i++;
            continue;
        }
        if (c === '(' || c === ')' || c === ',' || c === ';') {
            push(c === '(' ? 'lparen' : c === ')' ? 'rparen' : c === ',' ? 'comma' : 'semi', i, i + 1, c);
            i++;
            continue;
        }
        if (c === '+' || c === '-') {
            // poza literalem: opcjonalny znak kontynuacji na koncu linii
            if (!restBlank(i + 1)) diag(i, i + 1, 'ACS007', `znak "${c}" dozwolony tylko jako kontynuacja na koncu linii`);
            i++;
            continue;
        }
        if (WORD_CHAR.test(c)) {
            let j = i;
            while (j < n && WORD_CHAR.test(text[j])) j++;
            const raw = source.slice(i, j);
            const up = raw.toUpperCase();
            const m = /^(\d+)(KB|MB)?$/.exec(up);
            if (m) {
                let unit = m[2] as 'KB' | 'MB' | undefined;
                let end = j;
                if (!unit) {
                    // "200 KB": przyrostek po spacjach w tej samej linii
                    let k = j;
                    while (k < n && text[k] === ' ') k++;
                    const u = text.slice(k, k + 2).toUpperCase();
                    if ((u === 'KB' || u === 'MB') && !(k + 2 < n && WORD_CHAR.test(text[k + 2]))) {
                        unit = u;
                        end = k + 2;
                    }
                }
                push('number', i, end, m[1], unit);
                i = end;
                continue;
            }
            push('word', i, j, up);
            i = j;
            continue;
        }
        diag(i, i + 1, 'ACS008', `niedozwolony znak "${c}"`);
        i++;
    }
    tokens.push({ kind: 'eof', raw: '', value: '', range: range(n, n) });
    return { tokens, comments, diagnostics, sequenceNumbers: masked.found };
}
