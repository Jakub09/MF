/** Raport tekstowy (UTF-8, PC) i pliki CSV z listami zbiorow. */
import type { DataSet } from './dataset';
import type { RunResult } from './engine';

const pct = (x: number) => `${(x * 100).toFixed(1).replace('.', ',')}%`;
const n = (x: number) => x.toLocaleString('pl-PL');

export function textReport(res: RunResult, opts: { csv: string; config: string; stamp: string; top: number }): string {
    const out: string[] = [];
    out.push(`acs-masks ${opts.stamp}`);
    out.push(`CSV: ${opts.csv}   konfiguracja: ${opts.config}`);
    out.push(`Zbiorow: ${n(res.total)}, w zakresie (scope): ${n(res.inScope)}`);
    out.push('');
    for (const r of res.rules) {
        const t = r.tuning;
        out.push(`=== Regula ${r.rule.name} -> ${r.rule.routine} = ${[r.rule.value].flat().join(',')}`);
        if (r.rule.description) out.push(`    ${r.rule.description}`);
        out.push(`    Progi: czystosc >= ${pct(t.minPurity)}, min. zbiorow na maske ${t.minCount}, `
            + `maks. masek ${t.maxMasks}, maski z %: ${t.digitMasks ? 'tak' : 'nie'}, `
            + `pelne nazwy niepokrytych: ${t.literals ? 'tak' : 'nie'}, nadmiarowe do EXCLUDE: `
            + `${t.excludeFalsePositives ? 'tak' : 'nie'}`);
        out.push(`    Zbiorow w regule: ${n(r.universe)}`
            + (r.excludedByMask ? ` (wylaczonych maskami exclude: ${n(r.excludedByMask)})` : ''));
        out.push(`    Spelnia kryterium: ${n(r.positives)}, pokrytych maskami: ${n(r.covered)}`
            + (r.positives ? ` (${pct(r.covered / r.positives)})` : '')
            + `, niepokrytych: ${n(r.uncovered.length)}`);
        out.push(`    Nadmiarowych (objete maska, nie spelniaja kryterium): ${n(r.falsePositives.length)}`
            + (r.falsePositivesBeforeExclude !== r.falsePositives.length
                ? ` (przed EXCLUDE: ${n(r.falsePositivesBeforeExclude)})` : ''));
        const generic = r.masks.filter(m => !m.literal);
        const literals = r.masks.length - generic.length;
        out.push(`    Masek: ${generic.length}` + (literals ? `, pelnych nazw: ${literals}` : '')
            + `, wylaczen (EXCLUDE): ${r.excludes.length}`);
        if (generic.length) {
            out.push('');
            out.push('      Nr  Maska                                         Spelnia  Nadmiar  Czystosc   Nowych');
            generic.forEach((m, i) => out.push(`    ${String(i + 1).padStart(4)}  ${m.text.padEnd(44)} `
                + `${String(m.pos).padStart(8)} ${String(m.neg).padStart(8)} ${pct(m.purity).padStart(9)} `
                + `${String(m.gain).padStart(8)}`));
        }
        listTop(out, 'Niepokryte (spelniaja kryterium, bez maski)', r.uncovered, opts.top);
        listTop(out, 'Nadmiarowe (objete maska, nie spelniaja kryterium)', r.falsePositives, opts.top);
        out.push('');
    }
    if (res.overlaps.length) {
        out.push(`=== Zbiory objete wiecej niz jedna regula tej samej rutyny: ${n(res.overlaps.length)}`);
        out.push('    (w ACS wygrywa pierwsza regula w kolejnosci z konfiguracji)');
        for (const o of res.overlaps.slice(0, opts.top)) out.push(`    ${o.dsn.padEnd(44)} ${o.rules.join(', ')}`);
        if (res.overlaps.length > opts.top) out.push(`    ... i ${n(res.overlaps.length - opts.top)} wiecej`);
        out.push('');
    }
    return out.join('\n') + '\n';
}

function listTop(out: string[], title: string, list: DataSet[], top: number): void {
    if (!list.length) return;
    out.push('');
    out.push(`    ${title}: ${n(list.length)}${list.length > top ? ` (pierwsze ${top}, reszta w plikach CSV)` : ''}`);
    for (const ds of list.slice(0, top)) {
        out.push(`      ${ds.dsn.padEnd(44)} alok ${String(ds.allocTrk).padStart(7)} TRK, uzyw `
            + `${String(ds.usedTrk).padStart(7)} TRK, ${ds.dsorg || '?'} ${ds.sc || '-'}/${ds.mc || '-'}/${ds.dc || '-'}`);
    }
}

const CSV_COLS: (keyof DataSet)[] = [
    'dsn', 'vol', 'vols', 'dsorg', 'recfm', 'lrecl', 'allocTrk', 'usedTrk', 'allocKb', 'usedKb', 'created',
    'lastRef', 'sc', 'mc', 'dc', 'sg', 'createJob',
];

export function dataSetsCsv(list: DataSet[]): string {
    const rows = [CSV_COLS.join(';'), ...list.map(ds => CSV_COLS.map(c => String(ds[c] ?? '')).join(';'))];
    return rows.join('\n') + '\n';
}

export function masksCsv(res: RunResult): string {
    const rows = ['regula;rodzaj;maska;spelnia;nadmiar;czystosc;nowych'];
    for (const r of res.rules) {
        for (const m of r.masks) {
            rows.push([r.rule.name, m.literal ? 'pelna' : 'maska', m.text, m.pos, m.neg, m.purity.toFixed(4), m.gain]
                .join(';'));
        }
        for (const x of r.excludes) rows.push([r.rule.name, 'exclude', x, '', '', '', ''].join(';'));
    }
    return rows.join('\n') + '\n';
}
