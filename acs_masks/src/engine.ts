/**
 * Przebieg dla wszystkich regul: zbiory w zakresie -> pozytywne (kryterium) / negatywne -> maski -> wynik.
 * Zbiory objete maskami "exclude" reguly sa poza regula (ACS je wylaczy), wiec nie licza sie ani jako
 * pozytywne, ani jako negatywne.
 */
import type { DataSet } from './dataset';
import { Mask, matches, parseMask } from './mask';
import { buildCandidates, MaskIndex, purity, selectMasks } from './mine';
import { Config, evalCond, Rule, Tuning, tuningFor } from './rules';

export interface MaskStat {
    text: string;
    /** zbiory spelniajace kryterium objete maska */
    pos: number;
    /** zbiory niespelniajace kryterium objete maska */
    neg: number;
    purity: number;
    /** zbiory pokryte jako pierwsze (kolejnosc wyboru) */
    gain: number;
    literal: boolean;
}

export interface RuleResult {
    rule: Rule;
    tuning: Tuning;
    /** zbiory w zakresie reguly (po scope i exclude) */
    universe: number;
    /** zbiory wylaczone maskami exclude */
    excludedByMask: number;
    positives: number;
    masks: MaskStat[];
    /** maski exclude z konfiguracji + (excludeFalsePositives) pelne nazwy zbiorow nadmiarowych */
    excludes: string[];
    covered: number;
    uncovered: DataSet[];
    /** objete maskami, a niespelniajace kryterium (po wylaczeniu excludes) */
    falsePositives: DataSet[];
    /** nadmiarowe przed dopisaniem do EXCLUDE (gdy excludeFalsePositives) */
    falsePositivesBeforeExclude: number;
    /** czy zbior trafia do reguly wg wynikowych list (INCLUDE i nie EXCLUDE) - szybko, przez indeks */
    hits: (ds: DataSet) => boolean;
}

export interface RunResult {
    total: number;
    inScope: number;
    rules: RuleResult[];
    /** zbiory objete FILTLIST wiecej niz jednej reguly tej samej rutyny (wygrywa pierwsza w SELECT) */
    overlaps: { dsn: string; rules: string[] }[];
}

export function runRules(all: DataSet[], cfg: Config, override: Partial<Tuning> = {}): RunResult {
    const scoped = cfg.scope ? all.filter(ds => evalCond(cfg.scope!, ds)) : all;
    const rules = cfg.rules.map(rule => runRule(scoped, cfg, rule, override));
    return { total: all.length, inScope: scoped.length, rules, overlaps: findOverlaps(scoped, rules) };
}

function runRule(scoped: DataSet[], cfg: Config, rule: Rule, override: Partial<Tuning>): RuleResult {
    const tuning = tuningFor(cfg, rule, override);
    const userExcl = (rule.exclude ?? []).map(parseMask);
    const inRule = userExcl.length ? scoped.filter(ds => !userExcl.some(m => matches(m, ds.dsn))) : scoped;
    const pos: DataSet[] = [];
    const neg: DataSet[] = [];
    for (const ds of inRule) (evalCond(rule.when, ds) ? pos : neg).push(ds);

    const idx = buildCandidates(pos.map(d => d.quals), neg.map(d => d.quals), tuning.digitMasks);
    const chosen = selectMasks(idx, pos.length, tuning);
    const masks: MaskStat[] = chosen.map(s => ({
        text: s.cand.text,
        pos: s.cand.pos.length,
        neg: s.cand.neg,
        purity: purity(s.cand),
        gain: s.gain,
        literal: false,
    }));

    const covered = new Uint8Array(pos.length);
    for (const s of chosen) for (const i of s.cand.pos) covered[i] = 1;
    let uncovered = pos.filter((_, i) => !covered[i]);
    if (tuning.literals) {
        for (const ds of uncovered) {
            masks.push({ text: ds.dsn, pos: 1, neg: 0, purity: 1, gain: 1, literal: true });
        }
        uncovered = [];
    }

    // nadmiarowe: negatywne objete wybranymi maskami (indeks tylko z wybranych)
    const sel = new MaskIndex(tuning.digitMasks);
    const selTexts = new Set(chosen.map(s => s.cand.text));
    for (const ds of pos) sel.addFrom(ds.quals);
    const fp = neg.filter(ds => sel.matching(ds.quals).some(c => selTexts.has(c.text)));

    const excludes = [...userExcl.map(m => m.text)];
    let falsePositives = fp;
    const fpSet = new Set<string>();
    if (tuning.excludeFalsePositives && fp.length) {
        excludes.push(...fp.map(ds => ds.dsn));
        for (const ds of fp) fpSet.add(ds.dsn);
        falsePositives = [];
    }
    const literalSet = new Set(masks.filter(m => m.literal).map(m => m.text));
    const hits = (ds: DataSet): boolean =>
        (literalSet.has(ds.dsn) || sel.matching(ds.quals).some(c => selTexts.has(c.text)))
        && !fpSet.has(ds.dsn) && !userExcl.some(m => matches(m, ds.dsn));
    return {
        rule,
        tuning,
        universe: inRule.length,
        excludedByMask: scoped.length - inRule.length,
        positives: pos.length,
        masks,
        excludes,
        covered: pos.length - uncovered.length,
        uncovered,
        falsePositives,
        falsePositivesBeforeExclude: fp.length,
        hits,
    };
}

/** Pelne listy FILTLIST reguly (do ACS i do joba ACMREPR). */
export function ruleLists(r: RuleResult): { include: Mask[]; exclude: Mask[] } {
    return { include: r.masks.map(m => parseMask(m.text)), exclude: r.excludes.map(parseMask) };
}

function findOverlaps(scoped: DataSet[], rules: RuleResult[]): { dsn: string; rules: string[] }[] {
    const byRoutine = new Map<string, RuleResult[]>();
    for (const r of rules) {
        const l = byRoutine.get(r.rule.routine) ?? [];
        l.push(r);
        byRoutine.set(r.rule.routine, l);
    }
    const out: { dsn: string; rules: string[] }[] = [];
    for (const group of byRoutine.values()) {
        if (group.length < 2) continue;
        for (const ds of scoped) {
            const hit = group.filter(r => r.hits(ds)).map(r => r.rule.name);
            if (hit.length > 1) out.push({ dsn: ds.dsn, rules: hit });
        }
    }
    return out;
}
