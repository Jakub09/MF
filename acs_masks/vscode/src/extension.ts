/**
 * Rozszerzenie VS Code dla rutyn ACS (DFSMS): diagnostyka, konspekt, definicje i odwolania FILTLIST,
 * opisy zmiennych, uzupelnianie, zwijanie, zmiana nazwy FILTLIST. Cala logika jest w src/lang/service.ts
 * (ten sam parser co w poleceniach acs-masks check / repr / sim) - tu tylko tlumaczenie typow VS Code.
 * Bez serwera LSP: dostawcy sa rejestrowani bezposrednio przez API rozszerzen.
 */
import * as vscode from 'vscode';
import type { Diagnostic as AcsDiagnostic, Range as AcsRange } from '../../src/lang/lexer';
import {
    Analysis, analyze, completionsAt, definitionAt, foldingRanges, hoverAt, referencesAt, renameAt, SymbolNode, symbols,
} from '../../src/lang/service';

const LANG = 'acs';

const cache = new Map<string, { version: number; maxCol: number; analysis: Analysis }>();

function maxColumn(doc: vscode.TextDocument): number {
    return vscode.workspace.getConfiguration('acs', doc.uri).get<number>('maxColumn', 80);
}

function analysisOf(doc: vscode.TextDocument): Analysis {
    const key = doc.uri.toString();
    const maxCol = maxColumn(doc);
    const hit = cache.get(key);
    if (hit && hit.version === doc.version && hit.maxCol === maxCol) return hit.analysis;
    const analysis = analyze(doc.getText(), { maxCol });
    cache.set(key, { version: doc.version, maxCol, analysis });
    return analysis;
}

const range = (r: AcsRange) => new vscode.Range(r.start.line, r.start.col, r.end.line, r.end.col);

const SEVERITY: Record<AcsDiagnostic['severity'], vscode.DiagnosticSeverity> = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    info: vscode.DiagnosticSeverity.Information,
    hint: vscode.DiagnosticSeverity.Hint,
};

const SYMBOL_KIND: Record<SymbolNode['kind'], vscode.SymbolKind> = {
    routine: vscode.SymbolKind.Function,
    filtlist: vscode.SymbolKind.Array,
    select: vscode.SymbolKind.Struct,
    when: vscode.SymbolKind.EnumMember,
    otherwise: vscode.SymbolKind.EnumMember,
    if: vscode.SymbolKind.Boolean,
    do: vscode.SymbolKind.Namespace,
};

function toSymbol(s: SymbolNode): vscode.DocumentSymbol {
    const full = range(s.range);
    const sel = range(s.selectionRange);
    const out = new vscode.DocumentSymbol(s.name, s.detail, SYMBOL_KIND[s.kind], full, full.contains(sel) ? sel : full);
    out.children = s.children.map(toSymbol);
    return out;
}

export function activate(context: vscode.ExtensionContext): void {
    const diagnostics = vscode.languages.createDiagnosticCollection(LANG);
    context.subscriptions.push(diagnostics);

    const refresh = (doc: vscode.TextDocument) => {
        if (doc.languageId !== LANG) {
            diagnostics.delete(doc.uri);
            return;
        }
        diagnostics.set(doc.uri, analysisOf(doc).diagnostics.map(d => {
            const out = new vscode.Diagnostic(range(d.range), d.message, SEVERITY[d.severity]);
            out.code = d.code;
            out.source = 'acs';
            if (d.code === 'ACS260' || d.code === 'ACS207') out.tags = [vscode.DiagnosticTag.Unnecessary];
            return out;
        }));
    };

    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const schedule = (doc: vscode.TextDocument) => {
        const key = doc.uri.toString();
        const t = timers.get(key);
        if (t) clearTimeout(t);
        timers.set(key, setTimeout(() => {
            timers.delete(key);
            refresh(doc);
        }, 200));
    };

    vscode.workspace.textDocuments.forEach(refresh);
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(refresh),
        vscode.workspace.onDidChangeTextDocument(e => schedule(e.document)),
        vscode.workspace.onDidCloseTextDocument(doc => {
            cache.delete(doc.uri.toString());
            diagnostics.delete(doc.uri);
        }),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('acs')) vscode.workspace.textDocuments.forEach(refresh);
        }),

        vscode.languages.registerDocumentSymbolProvider(LANG, {
            provideDocumentSymbols: doc => symbols(analysisOf(doc)).map(toSymbol),
        }),

        vscode.languages.registerDefinitionProvider(LANG, {
            provideDefinition(doc, pos) {
                const r = definitionAt(analysisOf(doc), pos.line, pos.character);
                return r ? new vscode.Location(doc.uri, range(r)) : undefined;
            },
        }),

        vscode.languages.registerReferenceProvider(LANG, {
            provideReferences: (doc, pos, ctx) => referencesAt(analysisOf(doc), pos.line, pos.character, ctx.includeDeclaration)
                .map(r => new vscode.Location(doc.uri, range(r))),
        }),

        vscode.languages.registerDocumentHighlightProvider(LANG, {
            provideDocumentHighlights: (doc, pos) => referencesAt(analysisOf(doc), pos.line, pos.character, true)
                .map(r => new vscode.DocumentHighlight(range(r))),
        }),

        vscode.languages.registerHoverProvider(LANG, {
            provideHover(doc, pos) {
                const h = hoverAt(analysisOf(doc), pos.line, pos.character);
                return h ? new vscode.Hover(new vscode.MarkdownString(h.markdown), range(h.range)) : undefined;
            },
        }),

        vscode.languages.registerCompletionItemProvider(LANG, {
            provideCompletionItems(doc, pos) {
                return completionsAt(analysisOf(doc), pos.line, pos.character).map((c, i) => {
                    const kind = c.kind === 'variable' ? vscode.CompletionItemKind.Variable
                        : c.kind === 'filtlist' ? vscode.CompletionItemKind.Constant
                            : c.kind === 'value' ? vscode.CompletionItemKind.EnumMember
                                : c.kind === 'snippet' ? vscode.CompletionItemKind.Snippet : vscode.CompletionItemKind.Keyword;
                    const item = new vscode.CompletionItem(c.label, kind);
                    item.detail = c.detail;
                    if (c.doc) item.documentation = new vscode.MarkdownString(c.doc);
                    item.insertText = c.kind === 'snippet' ? new vscode.SnippetString(c.insert) : c.insert;
                    item.range = new vscode.Range(pos.line, c.replaceFrom, pos.line, pos.character);
                    item.filterText = c.label;
                    // FILTLIST przed zmiennymi, kolejnosc jak z uslugi
                    item.sortText = String(i).padStart(4, '0');
                    return item;
                });
            },
        }, '&', "'"),

        vscode.languages.registerFoldingRangeProvider(LANG, {
            provideFoldingRanges: doc => foldingRanges(analysisOf(doc))
                .map(f => new vscode.FoldingRange(f.startLine, f.endLine, f.comment ? vscode.FoldingRangeKind.Comment : undefined)),
        }),

        vscode.languages.registerRenameProvider(LANG, {
            prepareRename(doc, pos) {
                const a = analysisOf(doc);
                const refs = definitionAt(a, pos.line, pos.character);
                if (!refs) throw new Error('Zmienic nazwe mozna tylko dla FILTLIST.');
                const all = referencesAt(a, pos.line, pos.character, true);
                const here = all.find(r => range(r).contains(pos));
                return here ? range(here) : undefined;
            },
            provideRenameEdits(doc, pos, newName) {
                const r = renameAt(analysisOf(doc), pos.line, pos.character, newName);
                if ('error' in r) throw new Error(r.error);
                const edit = new vscode.WorkspaceEdit();
                for (const e of r.edits) edit.replace(doc.uri, range(e), r.name);
                return edit;
            },
        }),
    );
}

export function deactivate(): void {
    cache.clear();
}
