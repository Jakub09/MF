import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import { describe, it } from 'node:test';
import { analyze, completionsAt, definitionAt, foldingRanges, hoverAt, referencesAt, renameAt, symbols } from '../src/lang/service';
import { VAR_LIST } from '../src/lang/vars';

const ROOT = path.join(__dirname, '..');
const SRC = `PROC STORCLAS
  /* komentarz
     na dwie linie */
  FILTLIST NONSMS INCLUDE(SYS1.**,USER%%.**)
                  EXCLUDE('SYS1.TRACE')
  IF &DSN = &NONSMS THEN
    DO
      SET &STORCLAS = ''
      EXIT
    END
  SELECT
    WHEN (&HLQ = 'PROD' AND &SIZE >= 500MB)
      SET &STORCLAS = 'SCBIG'
    WHEN (&DSN ^= &NONSMS)
      SET &STORCLAS = 'SCSTD'
    OTHERWISE
      SET &STORCLAS = 'SCX'
  END
END
`;

/** Pozycja (linia, kolumna) pierwszego wystapienia tekstu, z przesunieciem. */
function at(text: string, nth = 0, delta = 0): [number, number] {
    let idx = -1;
    for (let i = 0; i <= nth; i++) idx = SRC.indexOf(text, idx + 1);
    assert.ok(idx >= 0, text);
    const before = SRC.slice(0, idx + delta);
    const line = before.split('\n').length - 1;
    return [line, idx + delta - (before.lastIndexOf('\n') + 1)];
}

describe('uslugi edytora', () => {
    const a = analyze(SRC);

    it('bez diagnostyk dla poprawnej rutyny', () => {
        assert.deepEqual(a.diagnostics, []);
    });

    it('konspekt: PROC, FILTLIST, IF, SELECT z WHEN', () => {
        const [root] = symbols(a);
        assert.equal(root.name, 'PROC STORCLAS');
        assert.deepEqual(root.children.map(c => c.name), ['NONSMS', 'IF &DSN = &NONSMS', 'SELECT']);
        assert.equal(root.children[0].detail, 'FILTLIST: INCLUDE 2, EXCLUDE 1');
        const sel = root.children[2];
        assert.deepEqual(sel.children.map(c => c.name), ["WHEN (&HLQ = 'PROD' AND &SIZE >= 500MB)", 'WHEN (&DSN ^= &NONSMS)', 'OTHERWISE']);
        assert.equal(sel.children[0].detail, "SET &STORCLAS = 'SCBIG'");
        assert.equal(root.children[1].detail, "SET &STORCLAS = ''");
    });

    it('definicja i odwolania FILTLIST', () => {
        const def = definitionAt(a, ...at('&NONSMS', 0, 3));
        assert.deepEqual([def?.start.line, def?.start.col], [3, 11]);
        assert.equal(definitionAt(a, ...at('&HLQ', 0, 2)), null);
        const refs = referencesAt(a, ...at('&NONSMS', 1, 2), true);
        assert.deepEqual(refs.map(r => r.start.line), [3, 5, 13]);
        assert.ok(refs.every(r => SRC.slice(r.start.offset, r.end.offset) === 'NONSMS'));
        assert.equal(referencesAt(a, ...at('&NONSMS', 1, 2), false).length, 2);
        assert.equal(referencesAt(a, ...at('&DSN', 0, 2), true).length, 2);
    });

    it('zmiana nazwy FILTLIST', () => {
        const r = renameAt(a, ...at('NONSMS', 0, 1), 'poza_sms');
        assert.ok('edits' in r);
        assert.equal(r.name, 'POZA_SMS');
        assert.equal(r.edits.length, 3);
        assert.ok('error' in renameAt(a, ...at('&HLQ', 0, 2), 'X'));
        assert.ok('error' in renameAt(a, ...at('NONSMS', 0, 1), 'HLQ'));
        assert.ok('error' in renameAt(a, ...at('NONSMS', 0, 1), 'A-B'));
    });

    it('podpowiedzi: zmienna, FILTLIST, slowo kluczowe', () => {
        const v = hoverAt(a, ...at('&SIZE', 0, 2));
        assert.match(v!.markdown, /\*\*&SIZE\*\*.*KB \/ MB/s);
        assert.match(v!.markdown, /Symulacja na DCOLLECT/);
        const f = hoverAt(a, ...at('&NONSMS', 0, 2));
        assert.match(f!.markdown, /FILTLIST NONSMS.*INCLUDE \(2\).*`SYS1\.\*\*`.*EXCLUDE \(1\)/s);
        assert.match(hoverAt(a, ...at('SELECT', 0, 1))!.markdown, /pierwszy prawdziwy WHEN/);
        assert.match(hoverAt(a, ...at('AND', 0, 1))!.markdown, /od lewej do prawej/);
        assert.equal(hoverAt(a, ...at('komentarz', 0, 1)), null);
    });

    it('uzupelnianie: po &, wartosci wyliczeniowe, slowa kluczowe', () => {
        const src = "PROC STORGRP\nFILTLIST L INCLUDE(A*)\nIF &\nIF &DSORG = 'P\nSE\n/* & */\nEND";
        const b = analyze(src);
        const vars = completionsAt(b, 2, 4);
        assert.equal(vars[0].label, '&L');
        assert.ok(vars.some(c => c.label === '&DSN') && vars.every(c => c.replaceFrom === 3));
        assert.ok(!vars.some(c => c.label === '&JOB'), '&JOB niedozwolona w STORGRP');
        assert.deepEqual(completionsAt(b, 3, 14).map(c => c.label), ['PS', 'PO', 'VS', 'DA']);
        assert.equal(completionsAt(b, 3, 14)[0].replaceFrom, 13);
        const kw = completionsAt(b, 4, 2);
        assert.ok(kw.some(c => c.label === 'SELECT' && c.kind === 'snippet') && kw.some(c => c.label === 'SET' && c.kind === 'keyword'));
        assert.deepEqual(completionsAt(b, 5, 4), []);
    });

    it('zwijanie: komentarz, FILTLIST, IF, DO, SELECT, WHEN', () => {
        const f = foldingRanges(a).map(x => `${x.startLine}-${x.endLine}${x.comment ? 'c' : ''}`);
        assert.deepEqual(f, ['1-2c', '3-4', '5-9', '6-9', '10-17', '11-12', '13-14']);
    });

    it('analiza zrodla z bledami nie rzuca wyjatku', () => {
        for (const bad of ['', 'PROC', 'PROC STORCLAS\nIF', "PROC X\nSELECT\nWHEN (\nEND", 'FILTLIST', "WRITE 'a", 'SELECT (&X) WHEN']) {
            const b = analyze(bad);
            symbols(b);
            foldingRanges(b);
            hoverAt(b, 0, 1);
            completionsAt(b, 0, 0);
        }
    });
});

describe('rozszerzenie VS Code', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vscode/package.json'), 'utf-8'));
    const grammar = JSON.parse(fs.readFileSync(path.join(ROOT, 'vscode/syntaxes/acs.tmLanguage.json'), 'utf-8'));

    it('manifest: jezyk, gramatyka i konfiguracja wskazuja istniejace pliki', () => {
        const lang = pkg.contributes.languages[0];
        assert.equal(lang.id, 'acs');
        assert.ok(fs.existsSync(path.join(ROOT, 'vscode', lang.configuration)));
        assert.ok(fs.existsSync(path.join(ROOT, 'vscode', pkg.contributes.grammars[0].path)));
        assert.equal(pkg.contributes.grammars[0].scopeName, grammar.scopeName);
        assert.ok(new RegExp(lang.firstLine).test('PROC 1 &STORCLAS'));
        assert.ok(new RegExp(lang.firstLine).test('/* RUTYNA */ PROC STORGRP'));
        assert.ok(!new RegExp(lang.firstLine).test('//JOB1 JOB'));
    });

    it('gramatyka: wszystkie zmienne z katalogu, wzorce dzialaja na przykladach', () => {
        const pats = grammar.repository.variables.patterns.map((p: { match: string }) => p.match).join(' ');
        for (const v of VAR_LIST) assert.ok(pats.includes(v.name), v.name);
        // przyblizenie Oniguruma w JS: (?i) na poczatku -> flaga i
        const re = (m: string) => new RegExp(m.replace(/^\(\?i\)/, ''), 'ig');
        const all = (m: string, s: string) => [...s.matchAll(re(m))].map(x => x[0]);
        const r = grammar.repository;
        assert.deepEqual(all(r.keywords.patterns[0].match, 'IF &A = END* THEN DO END'), ['IF', 'THEN', 'DO', 'END']);
        assert.deepEqual(all(r.operators.match, '&A ¬= 1 && &B ^> 2 | &C >= 3'), ['¬=', '&&', '^>', '|', '>=']);
        assert.deepEqual(all(r.mask.match, 'IF &DSN = SYS1.** OR &HLQ = TSO* OR &V = IMS%%% OR &X = PROD'), ['SYS1.**', 'TSO*', 'IMS%%%']);
        assert.deepEqual(all(r.numbers.match, '&SIZE > 10 MB AND &NQUAL = 3 AND &U = 33*'), ['10 MB', '3']);
        assert.deepEqual(all(r.variables.patterns[1].match, '&DSN &DSNTYPE &DSN_VERSION &MOJA'), ['&DSN', '&DSNTYPE', '&DSN_VERSION']);
    });

    it('aktywacja z atrapa API: diagnostyki i dostawcy', async () => {
        const main = path.join(ROOT, 'vscode', pkg.main);
        if (!fs.existsSync(main)) return; // bez npm run vscode:build - pomin
        class Range {
            constructor(readonly sl: number, readonly sc: number, readonly el: number, readonly ec: number) {}
            contains(o: Range | { line: number; character: number }): boolean {
                if ('line' in o) return (o.line > this.sl || (o.line === this.sl && o.character >= this.sc)) && (o.line < this.el || (o.line === this.el && o.character <= this.ec));
                return this.contains({ line: o.sl, character: o.sc }) && this.contains({ line: o.el, character: o.ec });
            }
        }
        const providers: Record<string, any> = {};
        const diag = new Map<string, any[]>();
        const Plain = class { constructor(...args: unknown[]) { Object.assign(this, { args }); } };
        const reg = (name: string) => (_lang: string, p: unknown) => {
            providers[name] = p;
            return { dispose() {} };
        };
        const doc = { uri: { toString: () => 'mem:a' }, languageId: 'acs', version: 1, getText: () => SRC.replace("'SCX'", "'1ZLA'") };
        const mock = {
            Range, Diagnostic: class { constructor(readonly range: Range, readonly message: string, readonly severity: number) {} },
            DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 }, DiagnosticTag: { Unnecessary: 1 },
            SymbolKind: new Proxy({}, { get: () => 1 }), CompletionItemKind: new Proxy({}, { get: () => 1 }), FoldingRangeKind: { Comment: 1 },
            DocumentSymbol: class { children: unknown[] = []; constructor(readonly name: string, readonly detail: string) {} },
            Location: Plain, DocumentHighlight: Plain, Hover: Plain, MarkdownString: Plain, CompletionItem: Plain, SnippetString: Plain,
            FoldingRange: Plain, WorkspaceEdit: class { edits: unknown[] = []; replace(...e: unknown[]) { this.edits.push(e); } },
            languages: {
                createDiagnosticCollection: () => ({ set: (u: any, d: any[]) => diag.set(u.toString(), d), delete: (u: any) => diag.delete(u.toString()), dispose() {} }),
                registerDocumentSymbolProvider: reg('symbols'), registerDefinitionProvider: reg('definition'),
                registerReferenceProvider: reg('references'), registerDocumentHighlightProvider: reg('highlight'),
                registerHoverProvider: reg('hover'), registerCompletionItemProvider: reg('completion'),
                registerFoldingRangeProvider: reg('folding'), registerRenameProvider: reg('rename'),
            },
            workspace: {
                textDocuments: [doc], getConfiguration: () => ({ get: (_k: string, d: unknown) => d }),
                onDidOpenTextDocument: () => ({ dispose() {} }), onDidChangeTextDocument: () => ({ dispose() {} }),
                onDidCloseTextDocument: () => ({ dispose() {} }), onDidChangeConfiguration: () => ({ dispose() {} }),
            },
        };
        const M = Module as unknown as { _load: (req: string, ...rest: unknown[]) => unknown };
        const orig = M._load;
        M._load = (req, ...rest) => (req === 'vscode' ? mock : orig(req, ...rest));
        try {
            const ext = require(main);
            ext.activate({ subscriptions: [] });
            const d = diag.get('mem:a')!;
            assert.equal(d.length, 1);
            assert.equal(d[0].code, 'ACS211');
            assert.equal(d[0].range.sl, 16);
            assert.equal(providers.symbols.provideDocumentSymbols(doc)[0].name, 'PROC STORCLAS');
            const [l, c] = at('&NONSMS', 0, 3);
            assert.ok(providers.definition.provideDefinition(doc, { line: l, character: c }));
            assert.equal(providers.references.provideReferences(doc, { line: l, character: c }, { includeDeclaration: true }).length, 3);
            assert.ok(providers.hover.provideHover(doc, { line: l, character: c }));
            assert.ok(providers.completion.provideCompletionItems(doc, { line: 11, character: 4 }).length > 10);
            assert.equal(providers.folding.provideFoldingRanges(doc).length, 7);
            assert.ok(providers.rename.prepareRename(doc, { line: l, character: c }));
            assert.equal(providers.rename.provideRenameEdits(doc, { line: l, character: c }, 'NOWA').edits.length, 3);
            assert.throws(() => providers.rename.prepareRename(doc, { line: 11, character: 12 }));
            ext.deactivate();
        } finally {
            M._load = orig;
        }
    });
});
