import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { check, journalText, main as autoMain, parseConds, parseHead, parseWeights, search, SearchResult } from '../src/auto';
import { Answer, BuildOptions, Builder, buildList, enough, makeSpace, Pattern, POINTS, Points, Proposal, shapeCost, Space } from '../src/auto-build';
import { acsProblem, filtlistText, findExcludes, maskTests } from '../src/auto-acs';
import { parseMaskList } from '../src/auto-check';
import { MaskRow } from '../src/auto-mine';
import { CompactOptions, defaultPoint, findCompact, Point } from '../src/auto-compact';
import { pickExcludes } from '../src/auto-exclude';
import { findCombos, narrower, parseTries, QualOptions, shorten, tryCombos } from '../src/auto-quals';
import { MaskTree, within } from '../src/auto-tree';
import { BOOL, Field, NUM, readStore, STR } from '../src/auto-read';
import { Interner, PairMap, Progress } from '../src/auto-util';
import { main } from '../src/cli';
import { DataSet, readDataSets, stripGds } from '../src/dataset';
import { digitMask, matches, parseMask } from '../src/mask';
import { sampleCsv } from '../tools/gen-sample';
import { csv, dline, kbForTrk, rng } from './helpers';

const ROOT = path.join(__dirname, '..');
const NAME = 'acs-masks-auto.cjs';
let dir: string;
let config: string;

/** Plik uruchamiany z katalogu poza projektem (bez node_modules i package.json). */
function auto(argv: string[]) {
    const r = spawnSync(process.execPath, [path.join(dir, NAME), ...argv], { cwd: dir, encoding: 'utf-8' });
    return { code: r.status, out: r.stdout, err: r.stderr };
}
async function full(argv: string[]) {
    let out = '';
    let err = '';
    const code = await main(argv, { out: t => void (out += t), err: t => void (err += t) });
    return { code, out, err };
}
const write = (name: string, text: string) => {
    fs.writeFileSync(path.join(dir, name), text);
    return path.join(dir, name);
};
const rowsOf = (file: string) => fs.readFileSync(path.join(dir, file), 'utf-8').trim().split('\n').slice(1).map(l => l.split(';'));

before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-auto-'));
    fs.copyFileSync(path.join(ROOT, NAME), path.join(dir, NAME));
    write('P.CSV', sampleCsv(2000));
    config = write('c.json', JSON.stringify({
        minPurity: 0.95,
        minCount: 10,
        maxMasks: 100,
        scope: { all: [{ field: 'sms', op: 'eq', value: true }, { field: 'dsorg', op: 'eq', value: 'PS' }] },
        rules: [{
            name: 'MALE315', routine: 'STORGRP', value: 'SG1',
            when: { all: [{ field: 'allocTrk', op: 'eq', value: 315 }, { field: 'usedTrk', op: 'le', value: 3 }] },
        }],
    }));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('szukanie masek - jeden plik', () => {
    it('plik jest aktualny wobec src/ i nie ma zaleznosci', async () => {
        const { buildStandalone } = await import(pathToFileURL(path.join(ROOT, 'tools/standalone.mjs')).href);
        const text = fs.readFileSync(path.join(ROOT, NAME), 'utf-8');
        assert.equal(text, buildStandalone(), 'uruchom: npm run standalone');
        const specs = [...text.matchAll(/require\("([^"]+)"\)/g)].map(m => m[1]);
        assert.ok(specs.every(s => s.startsWith('node:') || s.startsWith('./')), specs.join(' '));
    });

    it('GDG pod nazwa bazy', () => {
        write('G.CSV', csv(Array.from({ length: 12 }, (_, i) => dline({
            dsn: `APP.DAY.LOG.G${String(i + 1).padStart(4, '0')}V00`, f1: '48', allkb: kbForTrk(315), usekb: 40,
        }))));
        const r = auto(['G.CSV', '--out', 'm.csv']);
        assert.equal(r.code, 0, r.err);
        assert.deepEqual(rowsOf('m.csv').map(x => x.slice(0, 3)), [['APP.DAY.LOG', '12', '0']]);
    });

    it('warunki: operatory, maska, wielkosc liter', () => {
        const file = write('W.CSV', csv([dline({ dsn: 'PROD.A.B', sg: 'SGEAV1', allkb: kbForTrk(315), usekb: 100, cre: '0000000F' })]));
        const ok = (t: string) => {
            const c = parseConds(t, 'when');
            return c.compile(readStore(file, new Set(c.fields)))(0);
        };
        for (const t of ['', 'allocTrk=315', 'alloctrk>=315 usedtrk<3', 'usedTrk!=3', 'dsn=PROD.**', 'dsn=prod.a.b',
            'dsn!=TEST.**', 'sg=SGEAV*', 'sg=sgeav1', 'sms=TRUE', 'sms!=false', 'hlq=PROD', 'llq=B', 'nqual=3',
            'dsorg=PS', 'recfm=FB', 'vsam=false', 'freeTrk=313', 'vols=1']) assert.ok(ok(t), t);
        for (const t of ['allocTrk>315', 'allocTrk=315 usedTrk>2', 'dsn=PROD.*', 'sms=false', 'ageDays>=0', 'ageDays!=1',
            'llq=A', 'dsorg!=PS']) assert.ok(!ok(t), t);
    });

    it('bledy: komunikat i kod 1, bez stosu wywolan', () => {
        for (const a of [[], ['P.CSV', 'X'], ['BRAK.CSV'], ['P.CSV', '--when', 'allocTrk 315'], ['P.CSV', '--when', 'alok=1'],
            ['P.CSV', '--when', 'allocTrk=x'], ['P.CSV', '--when', 'dsn<A'], ['P.CSV', '--scope', 'sms=tak'],
            ['P.CSV', '--scope', 'dsn=A**.B'], ['P.CSV', '--min-purity', '95'], ['P.CSV', '--min-count', '1.5'],
            ['P.CSV', '--nieznana'], ['P.CSV', '--prefix', 'A.**.B'], ['P.CSV', '--prefix', 'A..B'],
            ['P.CSV', '--prefix', 'ZADLUGIQUAL.**'], ['P.CSV', '--prefix', ''], ['P.CSV', '--out', 'brak/m.csv'], [config]]) {
            const r = auto(a);
            assert.equal(r.code, 1, a.join(' '));
            assert.ok(r.err.length > 0);
            assert.doesNotMatch(r.err, /^\s+at /m, a.join(' '));
        }
        const r = auto(['P.CSV', '--min-count', '100000']);
        assert.equal(r.code, 0);
        assert.match(r.out, /Brak masek/);
    });
});

describe('GDG w acs-masks --config: nazwa bez GnnnnVnn', () => {
    const small = { allkb: kbForTrk(315), usekb: 40 };
    const big = { allkb: kbForTrk(5000), usekb: kbForTrk(4000) };
    const gen = (base: string, n: number, o: object) => Array.from({ length: n }, (_, i) =>
        dline({ dsn: `${base}.G${String(i + 1).padStart(4, '0')}V00`, f1: '48', ...o }));
    const run = async (lines: string[], opts: string[] = []) => {
        const out = path.join(dir, 'g');
        const r = await full([write('G.CSV', csv(lines)), '-c', config, '--out', out, ...opts]);
        assert.equal(r.code, 0, r.err);
        const rows = fs.readFileSync(path.join(out, 'maski.csv'), 'utf-8').trim().split('\n').slice(1).map(l => l.split(';'));
        fs.rmSync(out, { recursive: true });
        return { ...r, rows };
    };

    it('maska trafia w nazwe bazy; keep - nazwa z DCOLLECT', async () => {
        const lines = [...gen('APP.DAY.LOG', 20, small), ...gen('APP.DAY.ARCH', 20, big)];
        const s = await run(lines);
        assert.equal(s.rows.length, 1);
        assert.match(s.rows[0][2], /LOG$/);
        assert.deepEqual(s.rows[0].slice(3, 5), ['20', '0']);
        assert.match(s.err, /GDG: 40 generacji/);
        const k = await run(lines, ['--gds', 'keep']);
        assert.doesNotMatch(k.err, /GDG/);
        assert.match(k.rows[0][2], /^APP\.DAY\.LOG\./);
    });

    it('zwykly zbior z LLQ jak GnnnnVnn zostaje', async () => {
        const s = await run(Array.from({ length: 12 }, (_, i) => dline({ dsn: `APP.X${i}.G0001V00`, ...small })));
        assert.doesNotMatch(s.err, /GDG/);
    });

    it('mieszane generacje: pelna nazwa nie omija czystosci, EXCLUDE nie wylacza zbiorow z kryterium', async () => {
        const lines = [...gen('APP.MIX', 4, small),
            ...gen('APP.MIX', 12, big).slice(4)];
        const s = await run(lines, ['--literals']);
        assert.equal(s.rows.length, 0);
        const x = await run(lines, ['--min-purity', '0.2', '--min-count', '2', '--exclude-fp']);
        assert.equal(x.rows.filter(r => r[1] === 'exclude').length, 0);
        assert.match(x.out, /Nadmiarowych .*: 8/);
    });
});

/** Losowy CSV: malo roznych kwalifikatorow (duzo kolizji), cyfry, GDG, wiele wolumenow, VSAM z rekordami A. */
function randomCsv(seed: number, count: number, eol = '\n', pad = 0): string {
    const r = rng(seed);
    const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)];
    const qual = () => pick([
        () => pick(['A', 'B', 'PROD', 'LIST', '#G', '$X', 'A{', 'X-1']),
        () => pick(['A', 'B', 'AB', 'D']) + Math.floor(r() * 10 ** pick([1, 2, 3])),
        () => pick(['A1B', 'AXB', 'A2B', 'A12', 'AX2', 'AXX', 'A1X']),
        () => `T${pick(['1', '2', 'X'])}${pick(['1', '2', 'Y'])}${pick(['1', 'Z'])}`,
    ])();
    const size = () => (r() < 0.5 ? { allkb: kbForTrk(315), usekb: pick([40, 160, 200]) } : { allkb: kbForTrk(pick([15, 315, 900])), usekb: kbForTrk(12) });
    const attrs = () => ({
        sc: pick(['SC1', 'SC2', '']), mc: pick(['MC1', '']), sg: pick(['SG1', 'SGEAV1']), job: pick(['JOB1', 'JOB2']),
        cre: pick(['2024100F', '0000000F', '2025001F']), lst: pick(['2026300F', '0000000F']), recfm: pick(['90', '50', 'C0']),
        lrecl: pick([80, 133]), ext: 1 + Math.floor(r() * 5), f3: pick(['00', '40']), vol: `VOL00${Math.floor(r() * 9)}`,
    });
    const d: string[] = [];
    const a: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < count; i++) {
        const dsn = Array.from({ length: 1 + Math.floor(r() * 4) }, qual).join('.');
        if (seen.has(dsn)) continue;
        seen.add(dsn);
        const k = r();
        if (k < 0.1) {
            for (const c of ['DATA', 'INDEX']) {
                d.push(dline({ dsn: `${dsn}.${c}`, dsorg: '0008', volsq: pick([1, 2]), allkb: kbForTrk(50), ...attrs(), recfm: '00' }));
                if (r() < 0.9) a.push(`A;${dsn}.${c};${dsn};82`);
            }
        } else if (k < 0.3) {
            for (let g = 1; g <= 1 + r() * 8; g++) d.push(dline({ dsn: `${dsn}.G000${g}V00`, f1: pick(['48', '48', '40']), ...size(), ...attrs() }));
        } else if (k < 0.4) {
            for (const v of pick([[1, 2], [2, 1], [3, 1, 2]])) d.push(dline({ dsn, volsq: v, ...size(), ...attrs() }));
        } else {
            d.push(dline({ dsn, f1: pick(['40', '40', '00', '60']), dsorg: pick(['4000', '4000', '0200']), f5: pick(['00', '00', 'C0']), allx: kbForTrk(315), usex: 100, ...size(), ...attrs() }));
        }
    }
    d.sort(() => r() - 0.5);
    const lines = r() < 0.5 ? [...d, ...a] : [...a, ...d];
    return csv(lines).trimEnd().split('\n').map(l => l + ' '.repeat(pad)).join(eol) + (r() < 0.5 ? eol : '');
}

const silent = () => new Progress(4, () => {}, false);
const WHEN = parseConds('allocTrk=315 usedTrk<=3', 'w');
const isSmall = (x: DataSet) => x.allocTrk === 315 && x.usedTrk <= 3;

async function small2(seed: number, count: number) {
    const file = write('R.CSV', randomCsv(seed, count));
    const { dataSets } = await readDataSets(file);
    stripGds(dataSets);
    return { file, u: dataSets.filter(x => x.sms && x.dsorg === 'PS') };
}

/** Elementy masek z definicji (src/auto-mine.ts): wzorce z %, poczatek*. */
function elements(names: string[][]): (q: string, first: boolean) => { text: string; cost: number }[] {
    const all = [...new Set(names.flat())];
    const pats = new Set(all.map(digitMask).filter(x => x !== null));
    const heads = new Set<string>();
    for (const a of all) {
        for (const b of all) {
            if (a === b) continue;
            let n = 0;
            while (n < a.length && n < b.length && a[n] === b[n]) n++;
            const p = a.slice(0, n).replace(/[0-9]+$/, '');
            if (p.length < 8 && p.length >= (p.length < n ? 2 : 3)) heads.add(p);
        }
    }
    const rx = [...pats].map(p => ({ p, m: parseMask(p!) }));
    const memo = new Map<string, { text: string; cost: number }[]>();
    return (q, first) => {
        const key = `${first}${q}`;
        let l = memo.get(key);
        if (!l) {
            l = [...(!first && /^[A-Z#@$]{1,3}\d{5,7}$/.test(q) ? [] : [{ text: q, cost: 0 }]),
                ...rx.filter(x => matches(x.m, q)).map(x => ({ text: x.p!, cost: 0 })),
                ...[...heads].filter(h => q.startsWith(h)).map(h => ({ text: `${h}*`, cost: 1 }))];
            memo.set(key, l);
        }
        return l;
    };
}

interface BruteOpt { minPurity: number; minCount: number; maxMasks: number; maxWild: number; head?: string[] }

/** Wszystkie maski, ktore moze dac silnik, z objetymi malymi (numery) i liczba duzych. */
function family(pos: DataSet[], neg: DataSet[], o: BruteOpt) {
    const head = o.head ?? [];
    const names = [...new Set(pos.map(x => x.quals.slice(head.length).join('.')))].map(x => (x ? x.split('.') : []));
    const el = elements(names);
    const found = new Map<string, number>();
    const seen = new Set<string>();
    const gen = (q: string[], i: number, path: string[], w: number) => {
        const emit = (p: string[]) => {
            const text = p.join('.');
            if (!text || text.length > 44 || (head.length === 0 && !/[^*%.]/.test(text))) return;
            found.set(text, Math.min(w, found.get(text) ?? 99));
        };
        if (i === q.length) emit(path);
        if (path.length) emit([...path, '**']);
        const key = `${q.slice(i).join('.')}|${path.join('.')}|${w}`;
        if (seen.has(key)) return;
        seen.add(key);
        for (let j = i; j < q.length; j++) {
            for (const t of el(q[j], j === 0 && head.length === 0)) {
                if (j === i && w + t.cost <= o.maxWild) gen(q, j + 1, [...path, t.text], w + t.cost);
                if (w + 1 + t.cost <= o.maxWild) gen(q, j + 1, [...path, '**', t.text], w + 1 + t.cost);
            }
        }
        if (i < q.length && w < o.maxWild) gen(q, i + 1, [...path, '*'], w + 1);
    };
    for (const q of names) gen(q, 0, head, 0);
    const texts = [...found.keys()];
    const tree = new MaskTree(texts.map(t => t.split('.')));
    const fam = texts.map(text => ({ text, wild: found.get(text)!, pos: [] as number[], neg: 0 }));
    const hits = (dsn: string) => {
        const b = Buffer.from(dsn);
        return tree.match(b, 0, b.length);
    };
    pos.forEach((x, i) => hits(x.dsn).forEach(m => fam[m].pos.push(i)));
    neg.forEach(x => hits(x.dsn).forEach(m => { fam[m].neg++; }));
    return fam;
}

/** Wynik szukania: kazdy wybor najlepszy z mozliwych, potem uscislenie i liczby (kazda maska z kazda nazwa). */
function verify(r: SearchResult, pos: DataSet[], neg: DataSet[], o: BruteOpt) {
    const all = family(pos, neg, o);
    const byText = new Map(all.map(f => [f.text, f]));
    const pur = (f: { pos: number[]; neg: number }) => f.pos.length / (f.pos.length + f.neg);
    const good = all.filter(f => f.pos.length >= o.minCount * Math.max(1, f.wild) && pur(f) >= o.minPurity);
    const covered = new Set<number>();
    const gain = (f: { pos: number[] }) => f.pos.reduce((n, i) => n + Number(!covered.has(i)), 0);
    const best = () => good.reduce((m, f) => Math.max(m, gain(f)), 0);
    for (const s of r.steps) {
        const f = byText.get(s.text)!;
        assert.ok(f && good.includes(f), s.text);
        assert.deepEqual([gain(f), best()], [s.gain, s.gain], s.text);
        f.pos.forEach(i => covered.add(i));
    }
    if (r.steps.length < o.maxMasks) assert.ok(best() < o.minCount);

    const lit = (t: string) => t.replace(/[*%.]/g, '').length;
    const stars = (t: string) => t.split('*').length - 1;
    const union = new Set<number>();
    for (const m of r.masks) {
        const f = byText.get(m.text)!;
        assert.ok(f, m.text);
        f.pos.forEach(i => union.add(i));
        const same = all.filter(x => x.pos.length === f.pos.length && x.pos.every((i, k) => i === f.pos[k]));
        const from = r.steps.find(s => same.some(x => x.text === s.text) && within(m.text.split('.'), s.text.split('.')))!;
        assert.ok(from, m.text);
        for (const x of same) {
            if (!within(x.text.split('.'), from.text.split('.'))) continue;
            const d = x.neg - f.neg || lit(m.text) - lit(x.text) || stars(x.text) - stars(m.text) || x.text.length - m.text.length;
            assert.ok(d > 0 || (d === 0 && m.text <= x.text), `${x.text} zamiast ${m.text}`);
        }
        assert.ok(f.pos.some(i => !r.masks.some(x => x !== m && byText.get(x.text)!.pos.includes(i))), `zbedna ${m.text}`);
    }
    assert.deepEqual([...union].sort(), [...covered].sort());

    const kb = (l: DataSet[]) => l.reduce((t, x) => t + x.allocKb, 0);
    const check1 = (row: MaskRow, texts: string[]) => {
        const p = texts.map(t => parseMask(t));
        const [s, l] = [pos, neg].map(d => d.filter(x => p.some(m => matches(m, x.dsn))));
        assert.deepEqual([row.small, row.large, row.smallKb, row.largeKb, row.purity],
            [s.length, l.length, kb(s), kb(l), s.length ? s.length / (s.length + l.length) : 0], row.text);
    };
    r.masks.forEach(m => check1(m, [m.text]));
    check1(r.total, r.masks.map(m => m.text));
}

describe('nowy silnik = wzorzec (dataset.ts, mine.ts, mask.ts)', () => {
    const today = new Date('2026-11-16T00:00:00Z');

    for (let seed = 1; seed <= 12; seed++) {
        it(`czytanie CSV: wszystkie pola, ziarno ${seed}`, async () => {
            const bom = seed % 4 === 0 ? '\ufeff' : '';
            const file = write('R.CSV', bom + randomCsv(seed, 250, seed % 2 ? '\n' : '\r\n', seed % 3 ? 0 : 60));
            const { dataSets, dRecords } = await readDataSets(file, { today });
            stripGds(dataSets);
            const all = [...NUM, ...STR, ...BOOL];
            for (const chunk of [1 << 20, 64, 7]) {
                const st = readStore(file, new Set<Field>(all), undefined, today, chunk);
                assert.equal(st.records, dRecords);
                assert.equal(st.sets, dataSets.length);
                const get = { ...Object.fromEntries(NUM.map(f => [f, st.num(f)])), ...Object.fromEntries(STR.map(f => [f, st.str(f)])),
                    ...Object.fromEntries(BOOL.map(f => [f, st.bool(f)])) } as Record<Field, (r: number) => unknown>;
                const rows = [...Array(st.rows).keys()].filter(i => !st.dead[i]).map(i => JSON.stringify(all.map(f => get[f](i))));
                assert.deepEqual(rows.sort(), dataSets.map(x => JSON.stringify(all.map(f => x[f]))).sort());
            }
            // kazde pole osobno: zaladowanie tylko potrzebnych kolumn daje to samo
            for (const f of all) {
                const st = readStore(file, new Set<Field>([f]), undefined, today);
                const g = (NUM as readonly string[]).includes(f) ? st.num(f as never) : (STR as readonly string[]).includes(f) ? st.str(f as never) : st.bool(f as never);
                const v = [...Array(st.rows).keys()].filter(i => !st.dead[i]).map(i => JSON.stringify((g as (r: number) => unknown)(i)));
                assert.deepEqual(v.sort(), dataSets.map(x => JSON.stringify(x[f])).sort(), f);
            }
        });
    }

    const opts = [
        { minPurity: 0.95, minCount: 3, maxMasks: 1000, maxWild: 2 }, { minPurity: 0.5, minCount: 2, maxMasks: 1000, maxWild: 1 },
        { minPurity: 0, minCount: 1, maxMasks: 1000, maxWild: 0 }, { minPurity: 1, minCount: 1, maxMasks: 7, maxWild: 2 },
        { minPurity: 0.7, minCount: 2, maxMasks: 1000, maxWild: 3 },
    ];
    for (let seed = 1; seed <= 12; seed++) {
        it(`maski i liczby = przeglad wszystkich masek, ziarno ${seed}`, async () => {
            const { file, u } = await small2(seed + 100, 40 + seed * 5);
            opts.forEach(o => {
                const r = search(file, parseConds('sms=true dsorg=PS', 's'), WHEN, o, silent());
                verify(r, u.filter(isSmall), u.filter(x => !isSmall(x)), o);
            });
        });
    }

    for (const prefix of ['A%.**', 'A%', 'PROD.**', 'A*.%*', '*.**', '*.A%%.**', 'A{.*', 'A*.*1*.*%', '%%.%%%.**', 'A*.*.*.**', '*1*.**', 'BRAK.**', '**']) {
        it(`--prefix ${prefix}`, async () => {
            const head = parseHead(prefix);
            assert.throws(() => parseHead(`X.**.${prefix}`), /tylko na koncu/);
            const starts = parseMask([...head, '**'].join('.'));
            let found = 0;
            for (let seed = 1; seed <= 4; seed++) {
                const { file, u: all } = await small2(seed + 300, 250);
                const u = all.filter(x => matches(starts, x.dsn)).slice(0, 1e9);
                const o = { ...opts[seed % 2 ? 0 : 4], maxWild: 1, minCount: 1, head };
                const r = search(file, parseConds('sms=true dsorg=PS', 's'), WHEN, o, silent());
                assert.deepEqual([r.inScope, r.small], [u.length, u.filter(isSmall).length]);
                verify(r, u.filter(isSmall), u.filter(x => !isSmall(x)), o);
                found += r.masks.length;
            }
            assert.equal(found > 0, prefix !== 'BRAK.**');
        });
    }

    it('--prefix: zbiory spod roznych HLQ liczone razem, poczatek w masce doslownie', () => {
        const line = (dsn: string, usekb: number) => dline({ dsn, allkb: kbForTrk(315), usekb });
        write('H.CSV', csv(['ABC1', 'ABC2', 'ABCX'].flatMap(h => [line(`${h}.LOG.A`, 40), line(`${h}.LOG.B`, 40), line(`${h}.DATA.A`, kbForTrk(200))])
            .concat(line('ABCD1.LOG.A', kbForTrk(200)), line('XYZ1.LOG.A', 40))));
        for (const p of ['ABC%.**', 'abc%']) {
            const r = auto(['H.CSV', '--prefix', p, '--min-count', '4', '--out', 'm.csv']);
            assert.equal(r.code, 0, r.err);
            assert.deepEqual(rowsOf('m.csv').map(x => x.slice(0, 3)), [['ABC%.LOG.*', '6', '0']]);
            assert.match(r.out, /poczatek masek: ABC% /);
            assert.match(r.out, /w zakresie: 9, malych: 6/);
        }
    });

    const masksOf = (small: string[], large: string[], minCount: number) => {
        const line = (dsn: string, usekb: number) => dline({ dsn, allkb: kbForTrk(315), usekb });
        const file = write('R.CSV', csv([...small.map(x => line(x, 40)), ...large.map(x => line(x, kbForTrk(200)))]));
        return search(file, parseConds('', 's'), parseConds('usedTrk<=3', 'w'), { minPurity: 1, minCount, maxMasks: 99, maxWild: 1 }, silent())
            .masks.map(m => m.text).sort();
    };
    it('wzorzec, do ktorego pasuje dokladnie min-count zbiorow', () => {
        assert.deepEqual(masksOf(['A.D1', 'A.D2', 'A.D3'], ['A.X'], 3), ['A.D%']);
        assert.deepEqual(masksOf(['A.D1', 'A.D2', 'A.D3'], ['A.X'], 4), []);
    });
    it('* i ** w srodku maski', () => {
        // ta sama nazwa kwalifikatora w dwoch miejscach; P.**.X objeloby P.Q.X
        assert.deepEqual(masksOf(['P.P.X', 'P.X'], ['P.Q.X', 'P.Y', 'P.P.Y'], 2), ['**.P.X']);
        assert.deepEqual(masksOf(['A.B.K.LOG', 'A.C.K.LOG'], ['A.K.LOG', 'A.B.C.K.LOG', 'A.B.Q.LOG'], 2), ['A.*.K.LOG']);
        assert.deepEqual(masksOf(['A.B.C.K.LOG', 'A.K.LOG'], ['A.K.LIST', 'B.K.LOG', 'A.Q.LOG'], 2), ['A.**.K.LOG']);
        assert.deepEqual(masksOf(['PRDA.K.X', 'PRDB.K.Y'], ['PRXA.K.X', 'PRDA.L.X'], 2), ['PRD*.K.**']);
    });
    it('data w srodku nazwy zawsze jako %, w pierwszym kwalifikatorze zostaje', () => {
        assert.deepEqual(masksOf(['A.JOB12345.LA', 'A.JOB12345.BB'], ['A.X.LC'], 2), ['A.JOB%%%%%.*']);
        assert.deepEqual(masksOf(['A.D241113.LA', 'A.D241113.BB'], ['A.X.LC'], 2), ['A.D%%%%%%.*']);
        assert.deepEqual(masksOf(['U241113.A.X', 'U241113.B.Y'], ['U241114.A.X'], 2), ['U241113.**']);
    });
    it('maska najwyzej 44 znaki', () => {
        const base = 'AAAAAAAA.BBBBBBBB.CCCCCCCC.DDDDDDDD.EEEEE';
        const got = masksOf([`${base}.X`, `${base}.Y`], [`${base.slice(0, 30)}Q`], 2);
        assert.equal(got.length, 1);
        assert.ok(got[0].length <= 44, got[0]);
    });
    it('maska zbedna (jej zbiory obejmuja pozniejsze) jest usuwana', () => {
        const names = ['A', 'B'].flatMap(h => ['P', 'Q', 'R'].map(m => `${h}.${m}.Z`));
        assert.deepEqual(masksOf([...names, 'A.KK', 'A.LL', 'B.MM', 'B.NN'], ['C.X'], 2), ['A.**', 'B.**']);
    });

    it('bez zbiorow w zakresie, bez malych, same male', () => {
        const file = write('R.CSV', randomCsv(5, 100));
        const run = (s: string, w: string) => search(file, parseConds(s, 's'), parseConds(w, 'w'), { minPurity: 0.9, minCount: 1, maxMasks: 9, maxWild: 2 }, silent());
        assert.deepEqual([run('dsn=BRAK', '').inScope, run('', 'allocTrk<0').masks.length], [0, 0]);
        const all = run('', '');
        assert.equal(all.small, all.inScope);
        assert.ok(all.masks.length > 0);
        write('R.CSV', csv([]));
        assert.equal(run('', '').inScope, 0);
    });
});

describe('sprawdzanie listy masek', () => {
    const pickOf = (r: () => number) => <T>(a: T[]) => a[Math.floor(r() * a.length)];
    const randomMask = (r: () => number, quals: string[], max: number) => {
        const pick = pickOf(r);
        for (;;) {
            const m = Array.from({ length: 1 + Math.floor(r() * max) }, () => pick(quals)).join('.');
            if (m.length <= 44) return m;
        }
    };

    it('drzewo masek = matches() dla kazdej pary', () => {
        const r = rng(11);
        const quals = ['**', '**', '*', 'A', 'B', 'A%', '%%', '*A*', 'A*', '*1', '%*', 'A*B*1', '**', '%', 'AB1', '#G', '*%*'];
        const masks = [...new Set(Array.from({ length: 400 }, () => randomMask(r, quals, 5)))];
        const parsed = masks.map(m => parseMask(m));
        const tree = new MaskTree(parsed.map(m => m.quals));
        const names = Array.from({ length: 3000 }, () => randomMask(r, ['A', 'B', 'AB', 'A1', 'AB1', 'ABB1', '#G', 'X', 'AAA', '1A1'], 6));
        for (const n of names) {
            const b = Buffer.from(`xx${n}yy`);
            assert.deepEqual(tree.match(b, 2, b.length - 2), [...masks.keys()].filter(i => matches(parsed[i], n)), n);
        }
    });

    it('zawieranie masek = porownanie na wszystkich krotkich nazwach', () => {
        const abc = ['A', 'B', 'Z'];
        const q1 = [...abc, ...abc.flatMap(x => abc.map(y => x + y)), 'AAA', 'ABA', 'BAB', 'ZZZ', 'ZAZ', 'AZB', 'BZA', 'ZAB', 'ABZ'];
        const names = [...q1, ...q1.flatMap(x => q1.map(y => `${x}.${y}`)), ...q1.flatMap(x => q1.flatMap(y => q1.map(z => `${x}.${y}.${z}`)))];
        const r = rng(5);
        const quals = ['**', '**', '*', 'A', 'B', '%', 'A%', 'A*', '*A', '*A*', '%*', '%%', 'A*B'];
        const masks = [...new Set(Array.from({ length: 90 }, () => randomMask(r, quals, 3)))].map(m => parseMask(m));
        const hit = masks.map(m => {
            const all = names.map(n => n.split('.'));
            return Uint8Array.from(all, n => Number(matches(m, n.join('.'))));
        });
        let yes = 0;
        masks.forEach((a, i) => masks.forEach((b, j) => {
            const want = hit[i].every((x, k) => !x || hit[j][k] === 1);
            assert.equal(within(a.quals, b.quals), want, `${a.text} w ${b.text}`);
            if (want && i !== j) yes++;
        }));
        assert.ok(yes > 100);
    });

    it('zawieranie: przyklady', () => {
        const w = (a: string, b: string) => within(a.split('.'), b.split('.'));
        for (const [a, b] of [['ABC.X.**', 'ABC.**'], ['ABC.**', 'ABC.**.**'], ['ABC1.**', 'ABC%.**'], ['ABC%.**', 'ABC*.**'], ['*.**', '**'],
            ['A.*.B', 'A.**.B'], ['A.B', '**.B.**'], ['*.**.LOG', '**.LOG'], ['A.**.D%%', 'A.**.D*'], ['**', '**'], ['**', '**.*'], ['**', '*.**'], ['A.*.**', 'A.**.*']]) assert.ok(w(a, b), `${a} w ${b}`);
        for (const [a, b] of [['ABC.**', 'ABC.X.**'], ['ABC%.**', 'ABC1.**'], ['A*.**', 'A%.**'], ['A.**.B', 'A.*.B'], ['A.**', 'A.*.**'],
            ['A', 'A.*'], ['**.LOG', '*.**.LOG'], ['A.D%', 'A.D'], ['A.B', 'AB']]) assert.ok(!w(a, b), `${a} w ${b}`);
    });

    for (let seed = 1; seed <= 15; seed++) {
        it(`liczby, zbedne i pary = porownanie kazdej maski z kazda nazwa, ziarno ${seed}`, async () => {
            const file = write('R.CSV', randomCsv(seed + 500, 200 + seed * 20));
            const { dataSets } = await readDataSets(file);
            stripGds(dataSets);
            const u = dataSets.filter(x => x.sms && x.dsorg === 'PS');
            const isSmall = (x: DataSet) => x.allocTrk === 315 && x.usedTrk <= 3;
            const r = rng(seed);
            const texts = [...new Set(Array.from({ length: 4 + seed * 2 }, () => randomMask(r,
                ['**', '**', 'A', 'B', 'PROD', 'LIST', 'A%', 'A*', 'AB*', 'D%%', 'A{', '*', '%%%', 'AX2', 'NIC'], 4)))];
            const masks = texts.map(t => parseMask(t));
            const o = { minPurity: pickOf(r)([0, 0.5, 0.9]), minCount: 1 + seed % 3, maxMasks: 50, maxWild: 1 };
            const { list: res, fresh } = check(file, parseConds('sms=true dsorg=PS', 's'), parseConds('allocTrk=315 usedTrk<=3', 'w'), texts, [], o, silent());
            const small = u.filter(isSmall);
            const large = u.filter(x => !isSmall(x));
            const kb = (l: DataSet[]) => l.reduce((t, x) => t + x.allocKb, 0);
            const hit = (l: DataSet[], of: typeof masks) => l.filter(x => of.some(m => matches(m, x.dsn)));
            assert.deepEqual([res.small, res.large, res.smallKb], [small.length, large.length, kb(small)]);
            const same = (row: typeof res.total, of: typeof masks) => {
                const s = hit(small, of);
                const l = hit(large, of);
                assert.deepEqual([row.small, row.large, row.smallKb, row.largeKb, row.purity],
                    [s.length, l.length, kb(s), kb(l), s.length ? s.length / (s.length + l.length) : 0], row.text);
            };
            same(res.total, masks);
            const alone = (of: typeof masks, m: typeof masks[number]) => hit(small, [m]).length
                - hit(hit(small, [m]), of.filter(x => x !== m)).length;
            res.rows.forEach((row, k) => {
                assert.equal(row.text, texts[k]);
                same(row, [masks[k]]);
                assert.equal(row.only, alone(masks, masks[k]));
                assert.equal(row.state === '', row.only > 0, row.text);
                assert.equal(row.note === '', row.state === '', row.text);
                const in1 = /^zawiera sie w (.*)$/.exec(row.note);
                if (in1) {
                    const b = texts.indexOf(in1[1]);
                    assert.ok(b >= 0 && b !== k && within(masks[k].quals, masks[b].quals));
                    if (row.state === 'usun') assert.notEqual(res.rows[b].state, 'usun');
                }
                const by = /obejmuja: (.*?)( i \d+ innych)?$/.exec(row.note);
                if (by && !by[2]) {
                    const others = by[1].split(', ').map(t => masks[texts.indexOf(t)]);
                    assert.ok(!others.includes(masks[k]));
                    assert.equal(hit(hit(small, [masks[k]]), others).length, row.small, row.note);
                    if (row.state === 'usun') for (const o of others) assert.notEqual(res.rows[masks.indexOf(o)].state, 'usun');
                }
            });
            // po usunieciu "usun": to samo pokrycie malych i kazda pozostala maska jest potrzebna
            const left = masks.filter((_, k) => res.rows[k].state !== 'usun');
            same(res.after, left);
            assert.equal(res.after.small, res.total.small);
            for (const m of left) assert.ok(alone(left, m) > 0, m.text);
            // nowe maski: te same co szukanie wsrod zbiorow nieobjetych lista
            const free = (l: DataSet[]) => l.filter(x => !masks.some(m => matches(m, x.dsn)));
            const [fs1, fl1] = [free(small), free(large)];
            assert.deepEqual([fresh.inScope, fresh.small], [fs1.length + fl1.length, fs1.length]);
            verify(fresh, fs1, fl1, o);
            const add = fresh.masks.map(m => parseMask(m.text));
            assert.deepEqual([res.total.small + fresh.total.small, res.total.large + fresh.total.large],
                [hit(small, [...masks, ...add]).length, hit(large, [...masks, ...add]).length]);
            // pary
            const want: string[] = [];
            masks.forEach((a, i) => masks.slice(i + 1).forEach(b => {
                const s = small.filter(x => matches(a, x.dsn) && matches(b, x.dsn)).length;
                const l = large.filter(x => matches(a, x.dsn) && matches(b, x.dsn)).length;
                if (s + l) want.push(JSON.stringify([a.text, b.text, s, l, s / Math.max(1, hit(small, [a]).length), s / Math.max(1, hit(small, [b]).length)]));
            }));
            assert.deepEqual(res.overlaps.map(o => JSON.stringify([o.a, o.b, o.small, o.large, o.partA, o.partB])).sort(), want.sort());
            assert.ok(res.overlaps.every((o, k, l) => k === 0 || l[k - 1].small >= o.small));
        });
    }

    it('kolejnosc usuwania i powody', () => {
        const line = (dsn: string, usekb: number) => dline({ dsn, allkb: kbForTrk(315), usekb });
        write('K.CSV', csv([line('A.X.A', 40), line('A.X.B', 40), line('A.Y.A', 40), line('A.Z.DUZY', kbForTrk(200)), line('Q.R.S', 40)]));
        const run = (...masks: string[]) => check(path.join(dir, 'K.CSV'), parseConds('', 's'), parseConds('usedTrk<=3', 'w'), masks, [], { minPurity: 1, minCount: 1, maxMasks: 9, maxWild: 1 }, silent())
            .list.rows.map(x => [x.text, x.state, x.note]);
        // najpierw maska o nizszej czystosci, chociaz szersza; po niej pozostale sa potrzebne
        assert.deepEqual(run('A.X.**', 'A.Y.**', 'A.**'), [['A.X.**', 'zamiast', 'zawiera sie w A.**'], ['A.Y.**', 'zamiast', 'zawiera sie w A.**'],
            ['A.**', 'usun', 'w danych jej male zbiory obejmuja: A.X.**, A.Y.**']]);
        // rowna czystosc: zawarta w innej, a bez zawierania - dalsza na liscie
        assert.deepEqual(run('A.X.**', 'A.X*.**'), [['A.X.**', 'usun', 'zawiera sie w A.X*.**'], ['A.X*.**', 'zamiast', 'w danych jej male zbiory obejmuja: A.X.**']]);
        assert.deepEqual(run('Q.R.%', '%.R.S'), [['Q.R.%', 'zamiast', 'w danych jej male zbiory obejmuja: %.R.S'],
            ['%.R.S', 'usun', 'w danych jej male zbiory obejmuja: Q.R.%']]);
        assert.deepEqual(run('Q.**', 'Q.**.**'), [['Q.**', 'zamiast', 'zawiera sie w Q.**.**'], ['Q.**.**', 'usun', 'zawiera sie w Q.**']]);
        // bez zbiorow
        assert.deepEqual(run('A.X.NIC', 'A.X.**', 'NIC.**', 'A.Z.**'), [['A.X.NIC', 'usun', 'zawiera sie w A.X.**'], ['A.X.**', '', ''],
            ['NIC.**', 'usun', 'nie pasuje do zadnego zbioru'], ['A.Z.**', 'usun', 'nie obejmuje malych zbiorow (duzych: 1)']]);
        // dlugi powod
        const line2 = (i: number) => line(`M.N${i}.X`, 40);
        write('K.CSV', csv([1, 2, 3, 4, 5, 6].map(line2).concat(line('M.D.D', kbForTrk(200)))));
        assert.match(run('M.**', ...[1, 2, 3, 4, 5, 6].map(i => `M.N${i}.**`))[0][2], /obejmuja: M.N1.\*\*, M.N2.\*\*, M.N3.\*\*, M.N4.\*\* i 2 innych$/);
    });

    it('lista masek: linie, przecinki, CSV z --out, komentarze, apostrofy, powtorzenia', () => {
        const p = (t: string) => parseMaskList(t, 'm').masks;
        assert.deepEqual(p('﻿A.**\r\nb.%*, C.** D\n\n /* E.**\nF.** */ \'G.H\',\n'), ['A.**', 'B.%*', 'C.**', 'D', 'G.H']);
        assert.deepEqual(p('maska;malych\nA.**;12;0\n;\nB.C;1;2\n'), ['A.**', 'B.C']);
        assert.deepEqual(parseMaskList('A.**\n/* x\n */a.**\n', 'm'), { masks: ['A.**'], excludes: [], warnings: ['m, wiersz 3: maska A.** powtorzona'] });
        for (const [t, msg] of [['A.**\nA**.B', /m, wiersz 2: .*caly kwalifikator/], ["/*\n*/'A.**'", /wiersz 2: .*bez apostrofow/], ['A.** 12', /cyfra/],
            ['', /brak masek/], ['maska;x\n', /brak masek/], ['ZADLUGIQUAL.**', /niepoprawny kwalifikator/]] as [string, RegExp][]) {
            assert.throws(() => parseMaskList(t, 'm'), msg, t);
        }
    });

    it('wywolanie: raport, CSV, jednostki; wynik szukania nie ma masek zbednych', () => {
        const line = (dsn: string, trk: number, usekb: number) => dline({ dsn, allkb: kbForTrk(trk), usekb });
        write('H.CSV', csv([...Array.from({ length: 8 }, (_, i) => line(`ABC.X.N${i}`, 315, 40)), line('ABC.Y.A', 315, 40),
            line('ABC.Z.DUZY', 900, kbForTrk(800)), line('INNY.A', 315, 40)]));
        write('m.txt', 'ABC.X.**\nABC.**\n*.X.**\nNIC.**\nABC.X.**\n');
        const r = auto(['H.CSV', '--masks', 'm.txt', '--out', 'w.csv']);
        assert.equal(r.code, 0, r.err);
        assert.match(r.err, /Uwaga: m.txt, wiersz 5: maska ABC.X.\*\* powtorzona/);
        assert.match(r.out, /Masek: 4; obejmuja 90,0% malych \(9 z 10\), 90,0% ich alokacji/);
        assert.match(r.out, /Malych GB/);
        assert.deepEqual(rowsOf('w.csv').map(x => [x[0], x[1], x[2], x[6], x[7], x[8]]), [
            ['ABC.X.**', '8', '0', '0', 'usun', 'zawiera sie w ABC.**'], ['ABC.**', '9', '1', '1', '', ''],
            ['*.X.**', '8', '0', '0', 'usun', 'w danych jej male zbiory obejmuja: ABC.**'], ['NIC.**', '0', '0', '0', 'usun', 'nie pasuje do zadnego zbioru']]);
        // suma alokacji: 8 x 315 TRK
        const kb = 8 * kbForTrk(315);
        for (const [u, v] of [['mb', (kb / 1024).toFixed(0)], ['GB', (kb / 1024 ** 2).toFixed(2)], ['TB', (kb / 1024 ** 3).toFixed(3)]]) {
            for (const extra of [['--masks', 'm.txt'], ['--min-count', '2', '--min-purity', '1']]) {
                const x = auto(['H.CSV', '--unit', u, '--out', 'w.csv', ...extra]);
                assert.equal(x.code, 0, x.err);
                assert.equal(rowsOf('w.csv').find(y => y[0].startsWith('ABC.X.'))![4], v.replace('.', ','));
                assert.match(x.out, new RegExp(`Malych ${u.toUpperCase()}`));
            }
        }
        assert.match(auto(['H.CSV', '--masks', 'm.txt', '--prefix', 'ABC']).out, /obejmuja 100,0% malych \(9 z 9\)/);

        assert.equal(auto(['P.CSV', '--out', 'm.csv']).code, 0);
        const again = auto(['P.CSV', '--masks', 'm.csv', '--out', 'w.csv']);
        assert.match(again.out, /Maski zbedne: 0\n/);
        assert.deepEqual(rowsOf('w.csv').filter(x => x[7] !== 'nowa').map(x => x.slice(0, 6)), rowsOf('m.csv'));
        assert.equal(again.err.split('\n').filter(l => /^\[\d\/5\]/.test(l)).length, 5);
        // nowe maski tylko dla zbiorow spoza listy; wynik jako nastepna lista
        write('n.txt', 'ABC.X.**\n');
        const n = auto(['H.CSV', '--masks', 'n.txt', '--min-count', '1', '--min-purity', '1', '--out', 'n.csv']);
        assert.equal(n.code, 0, n.err);
        assert.deepEqual(rowsOf('n.csv').map(x => [x[0], x[1], x[2], x[6], x[7]]), [['ABC.X.**', '8', '0', '8', ''],
            ['**.A', '2', '0', '', 'nowa']]);
        assert.match(n.out, /nie obejmuje zadna maska z listy \(malych: 2, duzych: 1\)/);
        assert.match(n.out, /Lista i nowe maski razem: 100,0% malych \(10 z 10\), 100,0% ich alokacji, duzych 0, purity 100,0%/);
        const all = auto(['H.CSV', '--masks', 'n.csv', '--min-count', '1', '--min-purity', '1']);
        assert.match(all.out, /Maski zbedne: 0\n/);
        assert.match(all.out, /Lista obejmuje wszystkie male zbiory\.\n$/);
        assert.match(auto(['H.CSV', '--masks', 'n.txt']).out, /Brak masek dla tych progow/);
        // --prefix: poczatek nowych masek
        assert.equal(auto(['H.CSV', '--masks', 'n.txt', '--min-count', '1', '--prefix', 'INN%', '--out', 'n.csv']).code, 0);
        assert.deepEqual(rowsOf('n.csv').map(x => [x[0], x[1], x[7]]), [['ABC.X.**', '0', 'usun'], ['INN%.A', '1', 'nowa']]);

        for (const a of [['P.CSV', '--masks', 'BRAK'], ['P.CSV', '--unit', 'KG'], ['P.CSV', '--masks', 'P.CSV'], ['P.CSV', '--unit', 'toString']]) {
            const x = auto(a);
            assert.equal(x.code, 1, a.join(' '));
            assert.doesNotMatch(x.err, /^\s+at /m);
        }
    });
});

describe('EXCLUDE, FILTLIST i testy', () => {
    const scope = parseConds('sms=true dsorg=PS', 's');
    const when = parseConds('allocTrk=315 usedTrk<=3', 'w');
    const isSmall = (x: DataSet) => x.allocTrk === 315 && x.usedTrk <= 3;
    const hits = (list: string[]) => {
        const p = list.map(m => parseMask(m));
        return (x: { dsn: string }) => p.some(m => matches(m, x.dsn));
    };
    const load = async (seed: number) => {
        const file = write('R.CSV', randomCsv(seed, 400));
        const { dataSets } = await readDataSets(file);
        stripGds(dataSets);
        return { file, u: dataSets.filter(x => x.sms && x.dsorg === 'PS') };
    };
    const kb = (l: DataSet[]) => l.reduce((t, x) => t + x.allocKb, 0);

    for (let seed = 1; seed <= 12; seed++) {
        it(`EXCLUDE i lista z EXCLUDE = wzorzec, ziarno ${seed}`, async () => {
            const { file, u } = await load(seed + 700);
            const r = search(file, scope, when, { minPurity: 0.4, minCount: 2, maxMasks: 12, maxWild: 2 }, silent());
            const include = r.masks.map(m => m.text);
            const old = seed % 3 === 0 ? ['*.**.A%', 'PROD.**'] : [];
            const isInc = hits(include);
            const isOld = hits(old);
            const cov = u.filter(x => isInc(x) && !isOld(x));
            const [small, large] = [cov.filter(isSmall), cov.filter(x => !isSmall(x))];
            for (const minCount of [1, 2, 5]) {
                const e = findExcludes(r.input, include, old, { minCount, maxWild: 1 }, () => {});
                // bez malych; zadna dodatkowa maska nie wylaczy juz minCount duzych
                const pure = family(large, small, { minPurity: 1, minCount, maxMasks: 255, maxWild: 1 }).filter(f => f.neg === 0 && f.pos.length >= minCount);
                for (const m of e.masks) {
                    const own = cov.filter(hits([m.text]));
                    assert.deepEqual([m.small, m.large, m.largeKb], [0, own.length, kb(own)], m.text);
                    assert.ok(own.every(x => !isSmall(x)) && own.length >= minCount, m.text);
                }
                // najwieksza jest co najmniej tak dobra, jak kazda z jednego pelnego kwalifikatora (z dokladnoscia 2%)
                const oneQual = [...new Set(large.flatMap(x => x.quals))].map(t => cov.filter(hits([`**.${t}.**`])))
                    .filter(l => l.length >= minCount && !l.some(isSmall)).map(kb);
                assert.ok((e.masks[0]?.largeKb ?? 0) >= 0.98 * Math.max(0, ...oneQual));
                const gone = hits(e.masks.map(m => m.text));
                for (const f of pure) assert.ok(f.pos.filter(i => !gone(large[i])).length < minCount, f.text);
                const isNew = hits(e.masks.map(m => m.text));
                const left = cov.filter(x => !isNew(x));
                const row = (l: DataSet[]) => {
                    const [s, g] = [l.filter(isSmall), l.filter(x => !isSmall(x))];
                    return [s.length, g.length, kb(s), kb(g), s.length ? s.length / l.length : 0];
                };
                const got = (m: typeof e.before) => [m.small, m.large, m.smallKb, m.largeKb, m.purity];
                assert.deepEqual(got(e.before), row(cov));
                assert.deepEqual(got(e.after), row(left));
                assert.equal(left.filter(isSmall).length, small.length);

                // ta sama lista przez --masks
                const ex = [...old, ...e.masks.map(m => m.text)];
                const isEx = hits(ex);
                const c = check(file, scope, when, include, ex, { minPurity: 0.9, minCount: 1, maxMasks: 50, maxWild: 1 }, silent());
                assert.deepEqual([c.list.total.small, c.list.total.large, c.list.small], [e.after.small, e.after.large, u.filter(isSmall).length]);
                assert.deepEqual(c.list.excludes.map(m => [m.text, m.small, m.large]), ex.map(t => {
                    const one = u.filter(x => isInc(x) && hits([t])(x));
                    return [t, one.filter(isSmall).length, one.filter(x => !isSmall(x)).length];
                }));
                c.list.rows.forEach(m => {
                    const own = u.filter(x => hits([m.text])(x) && !isEx(x));
                    assert.deepEqual([m.small, m.large], [own.filter(isSmall).length, own.filter(x => !isSmall(x)).length]);
                });
                const rest = u.filter(x => !isInc(x) && !isEx(x));
                assert.deepEqual([c.fresh.inScope, c.fresh.small], [rest.length, rest.filter(isSmall).length]);
            }
            // --prefix: EXCLUDE tez od niego sie zaczyna i nie wyklucza malych
            const head = parseHead('A%.**');
            const p = search(file, scope, when, { minPurity: 0, minCount: 1, maxMasks: 2, maxWild: 1, head }, silent());
            const pe = findExcludes(p.input, p.masks.map(m => m.text), [], { minCount: 1, maxWild: 1, head }, () => {});
            assert.ok(pe.masks.every(m => /^A%(\.|$)/.test(m.text)));
            assert.equal(u.filter(x => isSmall(x) && hits(pe.masks.map(m => m.text))(x)).length, 0);
        });

        it(`testy do masek = wzorzec, ziarno ${seed}`, async () => {
            const { file, u } = await load(seed + 800);
            const r = search(file, scope, when, { minPurity: 0.3, minCount: 2, maxMasks: 8, maxWild: 2 }, silent());
            const include = r.masks.map(m => m.text);
            // maska tylko z duzymi zbiorami
            include.push(u.find(x => !isSmall(x) && !hits(include)(x) && !u.some(y => isSmall(y) && y.dsn === x.dsn))!.dsn);
            const exclude = findExcludes(r.input, include, [], { minCount: 1, maxWild: 1 }, () => {}).masks.slice(0, 5).map(m => m.text).concat(seed % 2 ? ['*.**.A%'] : []);
            for (const per of [1, 3, 20]) {
                const tests = maskTests(r.input, include, exclude, per, 'ACM', () => {});
                const want = new Map<string, string>();
                const of = (list: string[], x: { dsn: string }) => list.filter(m => hits([m])(x));
                const reps = (list: string[], m: string, pool: DataSet[]) => [...new Set(pool.filter(x => hits([m])(x)).sort((a, b) =>
                    of(list, a).length - of(list, b).length || (a.dsn < b.dsn ? -1 : Number(a.dsn > b.dsn))).map(x => x.dsn))].slice(0, per);
                const isInc = hits(include);
                const isEx = hits(exclude);
                for (const m of include) {
                    const own = u.filter(x => hits([m])(x) && !isEx(x));
                    const pool = own.some(isSmall) ? own.filter(isSmall) : own;
                    const nq = pool.map(x => x.quals.length);
                    for (const n of [Math.min(...nq), ...(m.split('.').includes('**') ? [Math.max(...nq)] : [])]) {
                        for (const d of reps(include, m, pool.filter(x => x.quals.length === n))) want.set(d, of(include, { dsn: d }).join(' '));
                    }
                }
                for (const m of exclude) for (const d of reps(exclude, m, u.filter(x => isInc(x) && isEx(x)))) want.set(d, `EXCLUDE ${of(exclude, { dsn: d }).join(' ')}`);
                const wide = include.filter(m => m.split('.').includes('*'));
                const loose = wide.map(m => m.split('.').map(x => (x === '*' ? '**' : x)).join('.'));
                wide.forEach((_, k) => {
                    for (const d of reps(loose, loose[k], u.filter(x => !isInc(x)))) want.set(d, `BEZ MASKI - ${wide.filter((_m, i) => hits([loose[i]])({ dsn: d })).join(' ')}`);
                });
                assert.deepEqual(tests.map(t => [t.dsn, t.lines[1]]).sort(), [...want].map(([d, x]) => [d, x.slice(0, 72).trimEnd()]).sort());
                assert.equal(tests[0].member, 'ACM00001');
                assert.deepEqual(tests[0].lines.slice(2), [`DSN: ${tests[0].dsn}`, 'ACSENVIR: ALLOC']);
            }
        });
    }

    it('FILTLIST: zawijanie, EXCLUDE, ponad 255 masek, maski nie do przyjecia', () => {
        const many = Array.from({ length: 300 }, (_, i) => `PROD.APP${i}.**`);
        const l = filtlistText('MALE', many, ['*.**.LOG', 'PROD.X-1.A']);
        assert.ok(l.every(x => x.length <= 71));
        const p = parseMaskList(l.join('\n'), 'm');
        assert.deepEqual([p.masks, p.excludes, p.warnings], [many, ['*.**.LOG', 'PROD.X-1.A'], []]);
        assert.deepEqual(l.filter(x => /FILTLIST/.test(x)).map(x => x.trim().split(' ')[1]), ['MALE_1', 'MALE_2']);
        assert.deepEqual(filtlistText('MALE', ['A.**'], []), ['  FILTLIST MALE INCLUDE(A.**)']);
        assert.deepEqual(filtlistText('MALE', ['A.**'], ['A.B']), ['  FILTLIST MALE INCLUDE(A.**)', '                EXCLUDE(A.B)']);
        assert.throws(() => filtlistText('MALE', ['A.**'], Array.from({ length: 256 }, (_, i) => `A.B${i}`)), /256 masek/);
        assert.deepEqual(['A.**', 'A-B.C', 'A-B.**', 'A.LONGQUAL9'].map(m => acsProblem(m) === null), [true, true, false, false]);
        // translator (parser ACS projektu) przyjmuje
        const f = write('ROUT', ['PROC STORGRP', ...l, '  IF &DSN = &MALE_1 OR &DSN = &MALE_2 THEN', "    SET &STORGRP = 'SG1'", 'END', ''].join('\n'));
        return full(['check', f]).then(r => {
            assert.equal(r.code, 0, r.out + r.err);
            assert.match(r.out, /FILTLIST: 2, porownan: 2/);
        });
    });

    it('lista z FILTLIST i CSV ze stanem exclude', () => {
        const p = (t: string) => {
            const x = parseMaskList(t, 'm');
            return [x.masks, x.excludes];
        };
        assert.deepEqual(p("/* x */ FILTLIST MALE\n INCLUDE(A.**, 'B.C' +\n ,D.%)\n EXCLUDE (A.X.**)"), [['A.**', 'B.C', 'D.%'], ['A.X.**']]);
        assert.deepEqual(p('include(A.**,B.**)'), [['A.**', 'B.**'], []]);
        assert.deepEqual(p('FILTLIST X INCLUDE(A.**) EXCLUDE(Q.**,Z.**) FILTLIST Y EXCLUDE(Z.**,Q.**) INCLUDE(B.**)'), [['A.**', 'B.**'], ['Q.**', 'Z.**']]);
        assert.deepEqual(p('maska;malych;stan\nA.**;1;\nA.X.**;0;exclude\nB.**;1;usun\n'), [['A.**', 'B.**'], ['A.X.**']]);
        for (const [t, msg] of [['FILTLIST X INCLUDE(A.**', /brak "\)"/], ['FILTLIST X INCLUDE(A.** FILTLIST Y INCLUDE(', /wiersz 1: brak "\)" przed|niepoprawny/],
            ['FILTLIST X INCLUDE(A.**)\nFILTLIST Y INCLUDE(B.**) EXCLUDE(C.**)', /wiersz 2: .*rozne EXCLUDE/],
            ['FILTLIST X INCLUDE(A.**) EXCLUDE(Q.**)\nFILTLIST Y INCLUDE(B.**) EXCLUDE(C.**)', /rozne EXCLUDE/],
            ['FILTLIST X INCLUDE(A.**) EXCLUDE(Q.**,Z.**)\nFILTLIST Y INCLUDE(B.**) EXCLUDE(Q.**)', /rozne EXCLUDE/],
            ['PROC STORGRP\nFILTLIST X INCLUDE(A.**)', /wiersz 1: "PROC"/], ['FILTLIST X INCLUDE(A.**)\nINCLUDE A', /wiersz 2: oczekiwano "\("/],
            ["FILTLIST X INCLUDE(\n'A.*')", /wiersz 2: .*bez apostrofow/], ['FILTLIST X EXCLUDE(A.**)', /brak masek/]] as [string, RegExp][]) {
            assert.throws(() => parseMaskList(t, 'm'), msg, t);
        }
    });

    it('wywolanie: pliki i raport; FILTLIST i CSV jako nastepna lista', () => {
        const line = (dsn: string, trk: number, usekb: number) => dline({ dsn, allkb: kbForTrk(trk), usekb });
        write('X.CSV', csv([...Array.from({ length: 20 }, (_, i) => line(`ABC.N${i}.DAT`, 315, 40)),
            ...Array.from({ length: 4 }, (_, i) => line(`ABC.N${i}.LOG`, 900, kbForTrk(800))), line('ABC.SAM.DUZY', 900, kbForTrk(800))]));
        write('abc.txt', 'ABC.**\n');
        const files = ['--filtlist', 'fl.txt', '--tests', 'ACMTEST', '--out', 'e.csv'];
        const r = auto(['X.CSV', '--masks', 'abc.txt', '--exclude', ...files]);
        assert.equal(r.code, 0, r.err);
        assert.match(r.out, /Masek EXCLUDE: 1; wylaczaja 80,0% duzych objetych maskami/);
        assert.match(r.out, /Po EXCLUDE: malych 20, duzych 5 -> 1, purity 80,0% -> 95,2%/);
        const read = (n: string) => fs.readFileSync(path.join(dir, n), 'utf-8');
        assert.equal(read('fl.txt'), '  FILTLIST MALE INCLUDE(ABC.**)\n                EXCLUDE(**.LOG.**)\n');
        assert.equal(read('ACMTEST'), ['./ ADD NAME=ACM00001', 'DESCRIPTION1:', 'ABC.**', 'DSN: ABC.N0.DAT', 'ACSENVIR: ALLOC',
            './ ADD NAME=ACM00002', 'DESCRIPTION1:', 'EXCLUDE **.LOG.**', 'DSN: ABC.N0.LOG', 'ACSENVIR: ALLOC', './ ENDUP', ''].join('\n'));
        assert.deepEqual(rowsOf('e.csv').map(x => [x[0], x[1], x[2], x[7]]), [['ABC.**', '20', '5', ''], ['**.LOG.**', '0', '4', 'exclude']]);
        assert.equal(r.err.split('\n').filter(l => /^\[\d\/7\]/.test(l)).length, 7);

        const again = ['fl.txt', 'e.csv'].map(f => auto(['X.CSV', '--masks', f, '--exclude', '--out', 'e2.csv']).out.split('\n').slice(1).join('\n'));
        assert.equal(again[0], again[1]);
        assert.match(again[0], /\*\*\.LOG\.\*\* +0 +4 /);
        assert.match(again[0], /Brak masek EXCLUDE/);
        assert.deepEqual(rowsOf('e2.csv').map(x => [x[0], x[2], x[7]]), [['ABC.**', '1', ''], ['**.LOG.**', '4', 'exclude']]);

        // FILTLIST: maski z listy i nowe, EXCLUDE z listy i nowy
        write('abx.txt', 'FILTLIST A INCLUDE(ABC.N1*.**) EXCLUDE(ABC.N1.LOG)');
        assert.equal(auto(['X.CSV', '--masks', 'abx.txt', '--min-count', '3', '--min-purity', '0.5', '--exclude', '--exclude-min', '1', '--filtlist', 'fl2.txt']).code, 0);
        const two = parseMaskList(read('fl2.txt'), 'm');
        assert.equal(two.masks[0], 'ABC.N1*.**');
        assert.ok(two.masks.length > 1);
        assert.equal(two.excludes[0], 'ABC.N1.LOG');

        // przy szukaniu: kolumna stan tylko z EXCLUDE
        const s = auto(['X.CSV', '--min-purity', '0.8', '--exclude', '--exclude-min', '1', '--per-mask', '2', '--test-prefix', 'T', ...files]);
        assert.equal(s.code, 0, s.err);
        assert.ok(rowsOf('e.csv').every(x => x.length === 6));
        assert.match(s.out, /EXCLUDE niepotrzebny/);
        assert.match(read('ACMTEST'), /^\.\/ ADD NAME=T0000001\n[^]*NAME=T0000002\n/);
        const none = auto(['X.CSV', '--min-count', '99', '--filtlist', 'brak1', '--tests', 'brak2', '--exclude']);
        assert.equal(none.code, 0, none.err);
        assert.ok(!fs.existsSync(path.join(dir, 'brak1')) && !fs.existsSync(path.join(dir, 'brak2')));
        for (const a of [['--test-prefix', 'A1'], ['--exclude-min', '0'], ['--per-mask', 'x'], ['--filtlist', 'brak/x']]) {
            const x = auto(['X.CSV', '--min-purity', '0.8', ...a]);
            assert.equal(x.code, 1, a.join(' '));
            assert.doesNotMatch(x.err, /^\s+at /m);
        }
    });
});

describe('struktury i pasek postepu', () => {
    it('Interner i PairMap jak Map (z powiekszaniem)', () => {
        const r = rng(3);
        const it1 = new Interner();
        const pm = new PairMap();
        const m1 = new Map<string, number>();
        const m2 = new Map<string, number>();
        for (let i = 0; i < 60000; i++) {
            const t = `Q${Math.floor(r() * 30000)}`;
            const b = Buffer.from(`xx${t}yy`);
            if (!m1.has(t)) m1.set(t, m1.size);
            assert.equal(it1.add(b, 2, b.length - 2), m1.get(t));
            const [x, y] = [Math.floor(r() * 300), Math.floor(r() * 300)];
            if (!m2.has(`${x},${y}`)) m2.set(`${x},${y}`, m2.size);
            assert.equal(pm.index(x, y), m2.get(`${x},${y}`));
        }
        for (const [t, id] of m1) assert.equal(it1.text(id), t);
        assert.equal(it1.find(Buffer.from('BRAK'), 0, 4), -1);
        assert.equal(pm.get(999, 1), -1);
    });

    it('terminal: pasek w jednej linii, kazdy etap konczy sie na 100%', () => {
        let err = '';
        const code = autoMain([path.join(dir, 'P.CSV')], { out: () => {}, err: t => void (err += t), tty: true });
        assert.equal(code, 0);
        const lines = err.split('\n').filter(Boolean);
        assert.equal(lines.length, 4);
        lines.forEach((l, i) => {
            const end = l.split('\r').pop()!;
            assert.match(end, new RegExp(`^\\[${i + 1}/4\\] .*\\[#{30}\\] 100%  [0-9]+,[0-9] s`));
            assert.ok(l.split('\r').slice(0, -1).every(x => x.length < 80), l);
        });
    });

    it('poza terminalem: jedna linia na etap, bez \\r; wynik na stdout', () => {
        const r = auto(['P.CSV']);
        assert.equal(r.err.trim().split('\n').length, 4);
        assert.doesNotMatch(r.err, /\r/);
        assert.doesNotMatch(r.out, /\[1\/4\]/);
    });

    it('blad w trakcie etapu zaczyna sie od nowej linii', () => {
        let err = '';
        const code = autoMain([write('Z.CSV', `${csv([])}X;Y\n`)], { out: () => {}, err: t => void (err += t), tty: true });
        assert.equal(code, 1);
        assert.match(err, /\nBlad: wiersz 2: nieznany typ rekordu "X"/);
    });

    it('CSV: bledy z numerem wiersza', () => {
        const bad = (text: string) => auto([write('Z.CSV', text)]).err;
        const one = dline({ dsn: 'A.B' });
        assert.match(bad(`${one}\n`), /brak wiersza naglowka/);
        assert.match(bad('T;X\n'), /wiersz 1: inny naglowek/);
        assert.match(bad(csv([one, 'D;A.C;V'])), /wiersz 3: 3 kolumn, oczekiwano 25/);
        assert.match(bad(csv([one.replace(';01;', ';1X;')])), /wiersz 2: VOLSQ "1X" nie jest liczba/);
        assert.match(bad(csv([one.replace('D;A.B', 'D;')])), /wiersz 2: pusta nazwa/);
        assert.match(bad(csv([one.replace(';01;', ';\x00\x01;')])), /binarnym VOLSQ/);
    });
});

describe('kombinacje kwalifikatorow', () => {
    const input = (small: string[], large: string[]) => {
        const names = new Interner();
        for (const n of [...small, ...large]) names.add(Buffer.from(n), 0, n.length);
        const allocKb = Float64Array.from({ length: names.size }, (_, i) => 1000 + i);
        return { names, allocKb, pos: Int32Array.from(small, (_, i) => i), neg: Int32Array.from(large, (_, i) => small.length + i) };
    };
    const base: QualOptions = { maxQuals: 3, top: 100000, minCount: 4, minPurity: 0, partial: 2, seconds: 600, minGain: 0 };
    const hit = (mask: string, list: string[]) => {
        const m = parseMask(mask.length > 44 ? 'X' : mask);
        assert.ok(mask.length <= 44, mask);
        return list.filter(n => matches(m, n));
    };
    const wide = (quals: string[], head: string[] = []) => [...head, '**', ...quals.flatMap(q => [q, '**'])].join('.');

    /** male i duze nazwy o krotkich kwalifikatorach z powtarzajacymi sie czesciami */
    function data(seed: number) {
        const r = rng(seed);
        const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)];
        const qual = () => pick(['AB', 'ABC', 'ABD', 'XAB', 'XABY', 'LOG', 'LOG1', 'LOG2', 'ALOG', 'T1', 'T2', 'TMP', `Q${pick(['A', 'B', 'C', 'D'])}Z`]);
        const set = new Set<string>();
        while (set.size < 60) set.add(Array.from({ length: 1 + Math.floor(r() * 4) }, qual).join('.'));
        const all = [...set];
        return { small: all.slice(0, 30), large: all.slice(30) };
    }
    /** wszystkie kombinacje: maska **.A.**.B.** -> male zbiory */
    function brute(small: string[], k: number, partial: number) {
        const forms = (q: string) => {
            const out = new Set([q]);
            for (let n = partial; n < q.length; n++) {
                for (let i = 0; i + n <= q.length; i++) {
                    const p = q.slice(i, i + n);
                    if (/^[0-9]+$/.test(p)) continue;
                    if (i === 0) out.add(`${p}*`);
                    if (i + n === q.length) out.add(`*${p}`);
                    out.add(`*${p}*`);
                }
            }
            const d = digitMask(q);
            if (d && /[A-Z]/.test(d) && partial) out.add(d);
            return [...out];
        };
        const masks = new Set<string>();
        const walk = (quals: string[], from: number, left: number, acc: string[]): void => {
            if (left === 0) {
                masks.add(wide(acc));
                return;
            }
            for (let i = from; i + left <= quals.length; i++) for (const f of forms(quals[i])) walk(quals, i + 1, left - 1, [...acc, f]);
        };
        for (const n of small) walk(n.split('.'), 0, k, []);
        return [...masks];
    }

    it('tabele maja wszystkie rozne zestawy malych zbiorow (pelny przeglad), liczby zgodne z maskami', () => {
        for (let seed = 1; seed <= 12; seed++) {
            const { small, large } = data(seed);
            for (const partial of [0, 2, 3]) {
                const inp = input(small, large);
                const r = findCombos(inp, { ...base, partial, maxQuals: 3, minCount: 4 }, () => {});
                assert.equal(r.floor, null);
                for (let k = 1; k <= 3; k++) {
                    const want = new Map<string, number>();
                    for (const m of brute(small, k, partial || 99)) {
                        const c = hit(m, small);
                        if (c.length >= 4 && (partial || !/[%*][A-Z0-9]|[A-Z0-9][%*]/.test(m))) want.set(c.join(), c.length);
                    }
                    const got = r.tables[k - 1].map(c => hit(wide(c.quals), small).join());
                    assert.deepEqual([...got].sort(), [...want.keys()].sort(), `seed ${seed} partial ${partial} k ${k}`);
                    const counts = r.tables[k - 1].map(c => c.small);
                    assert.deepEqual(counts, [...counts].sort((a, b) => b - a));
                    for (const c of r.tables[k - 1]) {
                        const [s, l] = [hit(wide(c.quals), small), hit(wide(c.quals), large)];
                        assert.deepEqual([c.small, c.large], [s.length, l.length], wide(c.quals));
                        const kb = (list: string[], all: string[], from: number) => list.reduce((x, n) => x + 1000 + from + all.indexOf(n), 0);
                        assert.deepEqual([c.smallKb, c.largeKb], [kb(s, small, 0), kb(l, large, small.length)]);
                        for (const a of c.also) assert.deepEqual(hit(wide(a), small), s, `${c.quals} / ${a}`);
                        assert.ok(c.mask);
                        assert.deepEqual(hit(c.mask.text, small), s, c.mask.text);
                        const ml = hit(c.mask.text, large);
                        assert.equal(c.mask.large, ml.length, c.mask.text);
                        assert.ok(ml.every(n => l.includes(n)));
                        assert.deepEqual([c.mask.small, c.mask.smallKb, c.mask.largeKb], [c.small, c.smallKb, kb(ml, large, small.length)]);
                    }
                }
            }
        }
    });

    it('top: pierwsze wiersze pelnej tabeli', () => {
        for (let seed = 1; seed <= 12; seed++) {
            const { small, large } = data(seed);
            const all = findCombos(input(small, large), { ...base, minCount: 2 }, () => {});
            const top = findCombos(input(small, large), { ...base, minCount: 2, top: 7 }, () => {});
            for (let k = 0; k < 3; k++) assert.deepEqual(top.tables[k].map(c => c.small), all.tables[k].slice(0, 7).map(c => c.small));
        }
    });

    it('--min-purity: same czyste, kazda czysta kombinacja zawarta w ktoryms wierszu', () => {
        for (let seed = 1; seed <= 12; seed++) {
            const { small, large } = data(seed);
            const r = findCombos(input(small, large), { ...base, minPurity: 0.8 }, () => {});
            const rows = r.tables.flat();
            assert.ok(rows.every(c => c.purity >= 0.8));
            const covers = rows.map(c => new Set(hit(wide(c.quals), small)));
            for (let k = 1; k <= 3; k++) {
                for (const m of brute(small, k, 2)) {
                    const s = hit(m, small);
                    if (s.length < 4 || s.length / (s.length + hit(m, large).length) < 0.8) continue;
                    assert.ok(covers.some(c => s.every(n => c.has(n))), `seed ${seed}: ${m}`);
                }
            }
            for (const a of rows) for (const b of rows) if (a !== b) assert.ok(!within(wide(a.quals).split('.'), wide(b.quals).split('.')), `${a.quals} w ${b.quals}`);
        }
    });

    it('poczatek nazw, data, niepelny o stalej dlugosci, prawie to samo co szczegolowszy', () => {
        const small = [...Array.from({ length: 12 }, (_, i) => `ABC1.X${i % 3}.D24110${i % 9}.PAYLOG${i % 4}`), 'ABC1.X0.D241101.PAYLOGS1'];
        const r = findCombos(input([...new Set(small)], ['ABC1.PAYLOG1']), { ...base, minCount: 3, head: ['ABC%'], minGain: 0.2 }, () => {});
        const [one] = r.tables;
        const texts = one.map(c => c.quals[0]);
        assert.ok(texts.includes('PAYLOG%') || one.some(c => c.also.some(a => a[0] === 'PAYLOG%')), texts.join());
        assert.ok(!texts.some(t => /^D24/.test(t)) && !one.some(c => c.also.some(a => /^D24/.test(a[0]))));
        assert.ok(r.tables.flat().every(c => c.mask!.text.startsWith('ABC%.')));
        // ABC* i wezsze PAYLOG* z prawie tymi samymi malymi: zostaje jedna
        const full = findCombos(input([...new Set(small)], []), { ...base, minCount: 3, head: ['ABC%'] }, () => {});
        assert.ok(full.tables[0].length >= one.length);
        assert.deepEqual(findCombos(input(['A.B'], []), { ...base, minCount: 2 }, () => {}).tables, [[], [], []]);
    });

    it('miejsca wzorca, prawie rowne konce, data tylko na poczatku, bez szerszych w "te same male"', () => {
        const one = (list: string[], o: Partial<QualOptions> = {}) =>
            findCombos(input(list, []), { ...base, partial: 3, maxQuals: 1, minCount: 2, ...o }, () => {}).tables[0];
        const texts = (list: string[], o: Partial<QualOptions> = {}) => one(list, o).flatMap(c => [c.quals[0], ...c.also.map(a => a[0])]);
        // ta sama dlugosc, rozne miejsca: *ABC*; ta sama dlugosc i miejsce: %ABC%
        assert.ok(texts(['P.ABCXY', 'Q.XABCY', 'R.XYABC']).includes('*ABC*'));
        assert.ok(texts(['P.XABCY', 'Q.ZABCW']).includes('%ABC%'));
        assert.ok(texts(['P.XABCY', 'Q.ZABCWW']).includes('*ABC*'));
        // koniec: ZLOG 3 razy, *LOG o jeden wiecej
        const ends = one(['A.ZLOG', 'B.ZLOG', 'C.ZLOG', 'D.YYLOG', 'E.LOGX']);
        assert.equal(ends.find(c => c.quals[0] === '*LOG')?.small, 4);
        assert.equal(ends.find(c => c.quals[0] === 'ZLOG')?.small, 3);
        // D241101: pelny tylko jako pierwszy kwalifikator, i nie za --prefix
        assert.ok(texts(['D241101.A', 'D241101.B']).includes('D241101'));
        assert.ok(!texts(['A.D241101.C', 'B.D241101.D']).includes('D241101'));
        assert.ok(!texts(['H.D241101.C', 'H.D241101.D'], { head: ['H'] }).includes('D241101'));
        for (let seed = 1; seed <= 6; seed++) {
            const { small, large } = data(seed);
            for (const c of findCombos(input(small, large), { ...base, partial: 2 }, () => {}).tables.flat()) {
                const all = [c.quals, ...c.also];
                for (const a of all) for (const b of all) if (a !== b) assert.ok(!a.every((q, i) => narrower(q, b[i])), `${a} / ${b}`);
            }
        }
        assert.ok(findCombos(input(['A.B.C', 'A.B.D', 'A.B.E'], []), { ...base, maxQuals: 2, minCount: 2 }, () => {}).tables[0][0].also.length === 1);
    });

    it('przerwanie po czasie', () => {
        const { small, large } = data(3);
        const r = findCombos(input(small, large), { ...base, seconds: -1 }, () => {});
        assert.equal(r.floor, small.length + 1);
    });

    it('narrower = within na pojedynczych kwalifikatorach', () => {
        const r = rng(9);
        const word = () => Array.from({ length: 1 + Math.floor(r() * 4) }, () => 'AB%*'[Math.floor(r() * 4)]).join('').replace(/\*+/g, '*');
        for (let i = 0; i < 4000; i++) {
            const [a, b] = [word(), word()];
            if (a === '*' || b === '*') continue;
            // w druga strone moze nie zauwazyc: * z sasiednim znakiem wobec %
            if (narrower(a, b)) assert.ok(within([a], [b]), `${a} ${b}`);
            else if (!/[*]/.test(a) || !/%/.test(b)) assert.ok(!within([a], [b]), `${a} ${b}`);
        }
    });

    it('--try: podane kombinacje i skrocenia', () => {
        assert.deepEqual(parseTries(' prod + sys*, LOG ,'), [['PROD', 'SYS*'], ['LOG']]);
        for (const bad of ['A+', 'A.B', '**', '*', '%%', 'A+*', 'ABCDEFGHI']) assert.throws(() => parseTries(bad), /MaskError|kwalifikator|stalego/, bad);
        assert.deepEqual(shorten('AB12', 3), ['AB%%', 'AB1*', '*B12', '*AB12*', '*AB1*', '*B12*']);
        assert.deepEqual(shorten('AB*', 2), []);
        assert.deepEqual(shorten('ABCD', 0), []);
        const { small, large } = data(5);
        const groups = tryCombos(input(small, large), parseTries('LOG1, LOG*+AB'), 2, [], () => {});
        assert.deepEqual(groups[0][0].quals, ['LOG1']);
        assert.ok(groups[0].length > 1);
        for (const x of groups.flat()) {
            assert.deepEqual([x.small, x.large], [hit(x.text, small).length, hit(x.text, large).length], x.text);
            assert.equal(x.text, wide(x.quals));
        }
        for (const g of groups) for (const x of g.slice(1)) assert.ok(x.small >= g[0].small && x.large >= g[0].large);
    });

    it('z wiersza polecen: tabele, CSV na liste --masks, --masks pomija objete, bledy', () => {
        const r = auto(['P.CSV', '--quals', '4', '--top', '5', '--try', 'PROD+SYSOUT', '--out', 'q.csv']);
        assert.equal(r.code, 0, r.err);
        assert.match(r.out, /Kombinacje: kwalifikatorow 4/);
        assert.match(r.out, /SYSOUT .*\*\.\*\.\*\.\*\.SYSOUT/);
        assert.match(r.out, /Sprawdzenie: PROD \+ SYSOUT/);
        const list = auto(['P.CSV', '--masks', 'q.csv']);
        assert.equal(list.code, 0, list.err);
        const rows = rowsOf('q.csv');
        const checked = new Map(list.out.split('\n').reverse().map(l => l.trim().split(/ +/)).filter(c => c.length > 5).map(c => [c[0], c]));
        for (const x of rows) if (x[0]) assert.deepEqual(checked.get(x[0])!.slice(1, 3), x.slice(1, 3), x[0]);
        write('one.txt', '**.SYSOUT');
        const rest = auto(['P.CSV', '--quals', '1', '--masks', 'one.txt']);
        assert.match(rest.out, /pominiete, objete lista masek: malych [1-9]/);
        assert.ok(!/^SYSOUT /m.test(rest.out));
        for (const [args, msg] of [
            [['--quals', '5'], /zakres 1-4/], [['--quals', '2', '--partial', '1'], /--partial/], [['--top', '5'], /tylko z --quals/],
            [['--quals', '2', '--exclude'], /--exclude: nie z/], [['--try', ' , '], /brak kombinacji/], [['--try', 'A.B'], /znakiem \+/],
        ] as [string[], RegExp][]) {
            const e = auto(['P.CSV', ...args]);
            assert.equal(e.code, 1);
            assert.match(e.err, msg);
        }
    });
});

describe('--compact', () => {
    interface Set1 { dsn: string; kb: number; quals: string[] }
    /** aplikacje, rodziny nazw i koncowki: male i duze skupione, z wyjatkami */
    function data(seed: number, n: number) {
        const r = rng(seed * 31 + 1);
        const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)];
        const apps = ['ABC', 'ABD', 'XYZ', 'QRS'];
        const fams = apps.flatMap(a => [['LOG', 0.97], ['LIST', 0.9], ['DUMP', 0.05], ['BKP', 0.3], ['WORK', 0.6]].filter(() => r() < 0.6)
            .map(([q, p]) => ({ a, q: q as string, p: p as number, mid: pick(['DAY', 'MTH', 'JOBS']), form: Math.floor(r() * 3) })));
        const seen = new Set<string>();
        const small: Set1[] = [];
        const large: Set1[] = [];
        for (let i = 0; i < n; i++) {
            const f = pick(fams);
            const h = f.a + pick(['P', 'T']);
            const j = `J${1 + Math.floor(r() * 40)}`;
            const dsn = [[h, f.mid, j, f.q], [h, f.q, j], [h, j, f.mid, f.q, pick(['A', 'B'])]][f.form].join('.');
            if (seen.has(dsn)) continue;
            seen.add(dsn);
            const isSmall = r() < f.p;
            (isSmall ? small : large).push({ dsn, quals: dsn.split('.'), kb: isSmall ? 1000 : 1000 + Math.floor(r() * 4000) });
        }
        return { small, large };
    }
    const input = (small: Set1[], large: Set1[]) => {
        const names = new Interner();
        const all = [...small, ...large];
        for (const x of all) names.add(Buffer.from(x.dsn), 0, x.dsn.length);
        return { names, allocKb: Float64Array.from(all, x => x.kb), pos: Int32Array.from(small, (_, i) => i), neg: Int32Array.from(large, (_, i) => small.length + i) };
    };
    const base: CompactOptions = {
        minPurity: 0.5, minCount: 5, maxMasks: 30, maxWild: 2, anyStart: false, maxLarge: { part: 0.1 }, loss: 0.02, exMin: 2, exGain: 0.005, seconds: 600,
    };
    const run = (small: Set1[], large: Set1[], o: Partial<CompactOptions> = {}) =>
        findCompact(input(small, large), { ...base, ...o }, { candidates: () => {}, excludes: () => () => {}, select: () => () => {} });
    const hit = (list: string[]) => {
        const p = list.map(m => parseMask(m));
        return (x: Set1) => p.some(m => matches(m, x.dsn));
    };
    const sum = (l: Set1[]) => l.reduce((t, x) => t + x.kb, 0);
    const size = (p: Point) => p.include.length + p.exclude.length;

    it('kazdy punkt: liczby zgodne z maskami, granica, strata, purity, poczatek; krzywa rosnie', () => {
        for (let seed = 1; seed <= 20; seed++) {
            const { small, large } = data(seed, 200);
            for (const o of [{}, { maxLarge: { kb: 3000 }, loss: 0 }, { anyStart: true, maxLarge: { part: 0.3 }, loss: 0.1, minPurity: 0.3 }, { maxMasks: 4 }] as Partial<CompactOptions>[]) {
                const opt = { ...base, ...o };
                const r = run(small, large, o);
                assert.deepEqual([r.small, r.large, r.smallKb], [small.length, large.length, sum(small)]);
                r.points.forEach((p, i) => {
                    const [inc, exc] = [hit(p.include), hit(p.exclude)];
                    const s = small.filter(x => inc(x) && !exc(x));
                    const l = large.filter(x => inc(x) && !exc(x));
                    const lost = small.filter(x => inc(x) && exc(x));
                    assert.deepEqual([p.small, p.large, p.smallKb, p.largeKb, p.lost], [s.length, l.length, sum(s), sum(l), lost.length], `${seed} ${p.include} | ${p.exclude}`);
                    assert.ok(sum(l) <= ('kb' in opt.maxLarge ? opt.maxLarge.kb : opt.maxLarge.part * sum(s)) + 1e-6);
                    assert.ok(lost.length <= opt.loss * (s.length + lost.length));
                    assert.ok(size(p) <= opt.maxMasks);
                    for (const m of p.include) {
                        const [a, b] = [small.filter(hit([m])).length, large.filter(hit([m])).length];
                        assert.ok(a / (a + b) >= opt.minPurity && a >= opt.minCount, m);
                        assert.ok(opt.anyStart || !/^\*/.test(m), m);
                    }
                    for (const m of p.exclude) assert.ok(large.filter(x => inc(x) && hit([m])(x)).length >= opt.exMin || large.filter(hit([m])).length >= opt.exMin, m);
                    if (i) assert.ok(size(p) > size(r.points[i - 1]) && p.small > r.points[i - 1].small);
                });
            }
        }
    });

    it('blisko najlepszego mozliwego wyniku (pelny przeglad do 3 masek)', () => {
        const ratios: number[] = [];
        for (let seed = 1; seed <= 15; seed++) {
            const { small, large } = data(seed, 110);
            const o = { ...base, minCount: 4 };
            const r = run(small, large, { minCount: 4 });
            const fam = family(small as unknown as DataSet[], large as unknown as DataSet[], { minPurity: 0, minCount: 4, maxMasks: 1, maxWild: 2 } as BruteOpt)
                .filter(f => !/^\*/.test(f.text) && f.pos.length >= 4 * Math.max(1, f.wild) && f.pos.length / (f.pos.length + f.neg) >= 0.5);
            const bits = (m: string[], l: Set1[]) => {
                const t = hit(m);
                return l.map(x => Number(t(x)));
            };
            const uniq = <T extends { s: number[]; l: number[] }>(list: T[]) => [...new Map(list.map(x => [`${x.s.join('')}|${x.l.join('')}`, x])).values()];
            const inc = uniq(fam.map(f => ({ s: bits([f.text], small), l: bits([f.text], large) })));
            const toks = new Set(large.flatMap(x => x.quals.flatMap(q => [q, ...Array.from({ length: Math.max(0, q.length - 3) }, (_, i) => `${q.slice(0, 3 + i)}*`), digitMask(q) ?? q])));
            const exc = uniq([...toks].filter(t => /[A-Z]/.test(t)).map(t => ({ s: bits([`**.${t}.**`], small), l: bits([`**.${t}.**`], large) }))).filter(e => e.l.reduce((a, b) => a + b, 0) >= 2);
            /** male po EXCLUDE albo -1, gdy poza granica */
            const value = (a: typeof inc, e: typeof exc): number => {
                let s = 0;
                let lost = 0;
                let skb = 0;
                let lkb = 0;
                for (let i = 0; i < small.length; i++) {
                    if (!a.some(x => x.s[i])) continue;
                    if (e.some(x => x.s[i])) lost++;
                    else {
                        s++;
                        skb += small[i].kb;
                    }
                }
                for (let i = 0; i < large.length; i++) if (a.some(x => x.l[i]) && !e.some(x => x.l[i])) lkb += large[i].kb;
                return lkb <= 0.1 * skb && lost <= o.loss * (s + lost) ? s : -1;
            };
            const best = [0, 0, 0, 0];
            // najwiecej malych bez granicy: porzadek pozwala szybko odciac
            const top = inc.sort((a, b) => b.s.reduce((x, y) => x + y, 0) - a.s.reduce((x, y) => x + y, 0)).slice(0, 25);
            top.forEach((a, i) => {
                best[1] = Math.max(best[1], value([a], []));
                for (const e of exc) best[2] = Math.max(best[2], value([a], [e]));
                for (let j = i + 1; j < top.length; j++) {
                    best[2] = Math.max(best[2], value([a, top[j]], []));
                    for (const e of exc) best[3] = Math.max(best[3], value([a, top[j]], [e]));
                    for (let k = j + 1; k < top.length; k++) best[3] = Math.max(best[3], value([a, top[j], top[k]], []));
                }
            });
            for (let k = 1; k <= 3; k++) {
                const got = Math.max(0, ...r.points.filter(p => size(p) <= k).map(p => p.small));
                if (best[k] > 0) ratios.push(got / best[k]);
            }
        }
        const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
        assert.ok(avg >= 0.95, `srednio ${avg}`);
        assert.ok(ratios.filter(x => x < 0.8).length <= 0.1 * ratios.length, ratios.map(x => x.toFixed(2)).join(' '));
    });

    it('EXCLUDE: pary w obu kolejnosciach, rodzaj kwalifikatora, strata, KB malych, zbedne', () => {
        const make = (dsn: string, kb: number): Set1 => ({ dsn, kb, quals: dsn.split('.') });
        const rep = (n: number, f: (i: number) => string, kb = 100) => Array.from({ length: n }, (_, i) => make(f(i), kb));
        const abc = (i: number) => 'ABCDEFGH'[i];
        const pickX = (small: Set1[], large: Set1[], o: Partial<Parameters<typeof pickExcludes>[2]> = {}) =>
            pickExcludes(input(small, large), [], { minCount: 2, gain: 0.005, loss: 0, maxWild: 0, maxMasks: 9, ...o }, () => {});
        // QQQ i WWW maja male, QQQ potem WWW - nie (i odwrotnie)
        const mixed = [...rep(3, i => `H.QQQ.${abc(i)}A.ZZZ`), ...rep(3, i => `H.${abc(i)}B.WWW.ZZZ`), ...rep(3, i => `H.WWW.${abc(i)}B.QQQ`)];
        assert.deepEqual(pickX(mixed, rep(5, i => `H.QQQ.${abc(i)}C.WWW`)), ['**.QQQ.**.WWW.**']);
        // wiekszy kwalifikator jest drugi: pierwszy z pary rzadszy niz PAIR_HEADS i tak znaleziony
        assert.deepEqual(pickX([...rep(3, i => `H.${abc(i)}A.WWW`), ...rep(2, i => `K.QQQ.${abc(i)}A`)],
            [...rep(5, i => `H.QQQ.${abc(i)}C.WWW`), ...rep(9, i => `${abc(i % 8)}K.WWW.${abc(i % 8)}L${i}`, 1)]).slice(0, 1), ['**.QQQ.**.WWW.**']);
        // pelny kwalifikator przed niepelnym i cyframi, choc te maja o 1% wiecej
        assert.deepEqual(pickX(rep(3, i => `H.${abc(i)}A.ZZZ`), [...rep(5, i => `H.P${i}${i}.DUMP`, 1000), make('H.P77.XXX', 40)], { minCount: 1 })[0], '**.DUMP.**');
        // druga maska juz bez prawa do straty
        const loss = [...rep(96, i => `H.N${i}X.ZZZ`), make('H.AA.DUMP', 100), make('H.AB.BACK', 100)];
        const two = [...rep(9, i => `H.${abc(i % 8)}${i}.DUMP`, 1000), ...rep(9, i => `H.${abc(i % 8)}${i}.BACK`, 900)];
        assert.deepEqual(pickX(loss, two, { loss: 0.0103 }), ['**.DUMP.**']);
        assert.deepEqual(pickX(loss, two, { loss: 0.03 }), ['**.DUMP.**', '**.BACK.**']);
        // strata malych wieksza niz zysk
        assert.deepEqual(pickX([...rep(96, i => `H.N${i}X.ZZZ`), make('H.AA.DUMP', 99999)], rep(9, i => `H.${abc(i % 8)}${i}.DUMP`, 1000), { loss: 0.5 }), []);
        // maska dobrana wczesniej, ktorej duze obejmuja pozniejsze, odpada
        const red = pickX(rep(3, i => `H.${abc(i)}A.ZZZ`), [...rep(4, i => `H.XX.${abc(i)}Q.MM`), ...rep(4, i => `H.${abc(i)}Q.MM.YY`),
            ...rep(3, i => `H.XX.${abc(i)}Q`), ...rep(3, i => `H.${abc(i)}Q.YY`)]);
        assert.deepEqual(red.sort(), ['**.XX.**', '**.YY.**']);
    });

    it('--min-purity dziala przed EXCLUDE', () => {
        const make = (dsn: string, kb: number): Set1 => ({ dsn, kb, quals: dsn.split('.') });
        const small = Array.from({ length: 20 }, (_, i) => make(`ABC1.${'ABCDEFGHIJKLMNOPQRST'[i]}X.LOG`, 1000));
        const large = Array.from({ length: 30 }, (_, i) => make(`ABC1.${'ABCDEFGHIJKLMNOPQRSTUVWXYZABCD'[i]}${i}.LOG`, 1000)).map((x, i) => (i % 2 ? x : make(`${x.dsn}.DUMP`, 1000)));
        for (const p of run(small, large, { minPurity: 0.6, maxWild: 1 }).points) {
            for (const m of p.include) assert.ok(small.filter(hit([m])).length >= 0.6 * [...small, ...large].filter(hit([m])).length, m);
        }
        const dump = large.map(x => make(`ABC1.${x.quals[1]}.DUMP`, 1000));
        assert.deepEqual(run(small, dump, { minPurity: 0.6, maxWild: 0 }).points.flatMap(p => p.include).filter(m => m === 'ABC1.**'), []);
        assert.equal(run(small, dump, { minPurity: 0.3, maxWild: 0 }).points[0]?.include[0], 'ABC1.**');
    });

    it('szeroki INCLUDE z EXCLUDE o jednym kwalifikatorze; punkt domyslny; przerwanie', () => {
        const make = (dsn: string, kb: number): Set1 => ({ dsn, kb, quals: dsn.split('.') });
        const mids = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
        const small = mids.flatMap((m, i) => Array.from({ length: 10 }, (_, k) => make(`ABC1.${m}X.N${k}.${['LOG', 'RPT', 'MSG', 'TXT'][i % 4]}`, 1000)));
        const large = mids.flatMap(m => Array.from({ length: 4 }, (_, k) => make(`ABC1.${m}X.N${k}.DUMP`, 9000)));
        const r = run(small, large, { exGain: 0.005 });
        const last = r.points[r.points.length - 1];
        assert.deepEqual([last.include, last.exclude, last.small, last.large], [['ABC1.*.N%.*'], ['**.DUMP.**'], 80, 0]);
        const p = (small1: number) => ({ small: small1 }) as Point;
        assert.equal(defaultPoint([p(50), p(94), p(96), p(100)], 0.95)!.small, 96);
        assert.equal(defaultPoint([], 0.95), null);
        assert.ok(run(small, large, { seconds: -1 }).stopped);
        assert.deepEqual(run([], large).points, []);
    });

    it('z wiersza polecen: krzywa, --pick, --verify, pliki, bledy', () => {
        const line = (dsn: string, trk: number, usekb: number) => dline({ dsn, allkb: kbForTrk(trk), usekb });
        const file = (extra: string[]) => csv([...['LOG', 'RPT', 'MSG'].flatMap(q => Array.from({ length: 20 }, (_, i) => line(`ABC1.DAY.N${i}.${q}`, 315, 40))),
            ...Array.from({ length: 8 }, (_, i) => line(`ABC1.DAY.N${i}.DUMP`, 900, kbForTrk(800))), ...extra]);
        write('C1.CSV', file([]));
        write('C2.CSV', file([...Array.from({ length: 5 }, (_, i) => line(`ABC1.DAY.N${i}.BKP`, 9000, kbForTrk(8000))), line('ABC1.DAY.N50.LOG', 315, 40)]));
        const r = auto(['C1.CSV', '--compact', '--verify', 'C2.CSV', '--out', 'c.csv', '--filtlist', 'cf.txt', '--tests', 'CT']);
        assert.equal(r.code, 0, r.err);
        assert.match(r.out, /<- wybrany/);
        assert.match(r.out, /Uwaga: duze w drugim pliku przekraczaja granice/);
        assert.match(r.out, /w tym nazwy, ktorych w pierwszym nie bylo +1 +1 +100,0% +5 /);
        assert.match(r.out, /gorszej o ponad 5 punktow|\*\*\.BKP/);
        assert.equal(fs.readFileSync(path.join(dir, 'cf.txt'), 'utf-8'), '  FILTLIST MALE INCLUDE(ABC1.DAY.**) EXCLUDE(**.DUMP.**)\n'.replace(' EXCLUDE', '\n                EXCLUDE'));
        assert.deepEqual(rowsOf('c.csv').map(x => [x[0], x[1], x[2], x[7]]), [['ABC1.DAY.**', '60', '0', ''], ['**.DUMP.**', '0', '8', 'exclude']]);
        // ta sama lista przez --masks daje te same liczby
        assert.match(auto(['C1.CSV', '--masks', 'cf.txt']).out, /RAZEM +60 +0 /);
        const one = auto(['C1.CSV', '--compact', '--pick', '1']);
        assert.match(one.out, /Wybrany punkt: masek 1 \(INCLUDE 1, EXCLUDE 0\)/);
        assert.match(one.out, /FILTLIST MALE INCLUDE\(/);
        assert.match(auto(['C1.CSV', '--compact', '--min-count', '1000']).out, /Brak masek dla tych progow/);
        assert.match(auto(['C1.CSV', '--compact', '--max-large', '1TB', '--unit', 'GB']).out, /Duze w liscie: do 1024,00 GB/);
        for (const [args, msg] of [
            [['--compact', '--max-large', 'x'], /--max-large/], [['--compact', '--pick', '0'], /--pick/], [['--pick', '3'], /tylko z --compact/],
            [['--any-start'], /tylko z --compact/], [['--compact', '--quals', '2'], /--quals: nie z --compact/], [['--compact', '--masks', 'cf.txt'], /--masks: nie z/],
            [['--exclude-loss', '1%'], /tylko z --exclude/], [['--compact', '--exclude-loss', '101%'], /0-100/], [['--compact', '--verify', 'brak.csv'], /brak pliku/],
            [['--time', '5'], /--time: tylko/],
        ] as [string[], RegExp][]) {
            const e = auto(['C1.CSV', ...args]);
            assert.equal(e.code, 1, args.join(' '));
            assert.match(e.err, msg);
        }
    });

    it('--exclude: --exclude-gain i --exclude-loss', () => {
        const line = (dsn: string, trk: number, usekb: number) => dline({ dsn, allkb: kbForTrk(trk), usekb });
        write('E1.CSV', csv([...Array.from({ length: 50 }, (_, i) => line(`ABC1.N${i}.LOG`, 315, 40)), line('ABC1.N1.DUMP', 315, 40),
            ...Array.from({ length: 9 }, (_, i) => line(`ABC1.N${i + 10}.DUMP`, 900, kbForTrk(800))), ...Array.from({ length: 2 }, (_, i) => line(`ABC1.N${i}.TINY`, 1, 40))]));
        write('abc1.txt', 'ABC1.**\n');
        const ex = (a: string[]) => auto(['E1.CSV', '--masks', 'abc1.txt', '--exclude', ...a]).out;
        assert.ok(!/\*\*\.TINY/.test(ex([])));
        assert.match(ex(['--exclude-gain', '0']), /\*\*\.TINY\.\*\*/);
        assert.ok(!/^\*\*\.DUMP\.\*\*/m.test(ex([])));
        assert.match(ex([]), /^\*\*\.N%%\.\*\*\.DUMP\.\*\* +9 /m);
        assert.match(ex(['--exclude-loss', '2%']), /\n\*\*\.DUMP\.\*\* +9 .* 1\n/);
    });
});

describe('--build', () => {
    interface Set1 { dsn: string; kb: number }
    /** jak w --compact: aplikacje, rodziny nazw i koncowki, z wyjatkami; w srodku takze daty */
    function data(seed: number, n: number) {
        const r = rng(seed * 17 + 5);
        const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)];
        const apps = ['ABC', 'ABD', 'XYZ', 'QRS'];
        const fams = apps.flatMap(a => [['LOG', 0.99], ['LIST', 0.95], ['DUMP', 0.02], ['BKP', 0.2], ['WORK', 0.7]].filter(() => r() < 0.6)
            .map(([q, p]) => ({ a, q: q as string, p: p as number, mid: pick(['DAY', 'MTH', 'JOBS']), form: Math.floor(r() * 3) })));
        const seen = new Set<string>();
        const small: Set1[] = [];
        const large: Set1[] = [];
        for (let i = 0; i < n; i++) {
            const f = pick(fams);
            const h = f.a + pick(['P', 'T', '1']);
            const j = `${pick(['D', 'D', 'T'])}${String(Math.floor(r() * 1e6)).padStart(6, '0')}`;
            const dsn = [[h, f.mid, j, f.q], [h, f.q, j], [h, j, f.mid, f.q, pick(['A', 'B'])]][f.form].join('.');
            if (seen.has(dsn)) continue;
            seen.add(dsn);
            const isSmall = r() < f.p;
            (isSmall ? small : large).push({ dsn, kb: isSmall ? 1000 : 1000 + Math.floor(r() * 3000) });
        }
        return { small, large };
    }
    const input = (small: Set1[], large: Set1[]) => {
        const names = new Interner();
        const all = [...small, ...large];
        for (const x of all) names.add(Buffer.from(x.dsn), 0, x.dsn.length);
        return { names, allocKb: Float64Array.from(all, x => x.kb), pos: Int32Array.from(small, (_, i) => i), neg: Int32Array.from(large, (_, i) => small.length + i) };
    };
    const base: BuildOptions = {
        weights: POINTS, minPurity: 0.9, minCount: 5, maxMasks: 30, maxLarge: { part: 0.1 }, loss: 0.02, exMin: 2, partial: 3, beam: 8, rounds: 2, seconds: 600,
    };
    const run = (small: Set1[], large: Set1[], o: Partial<BuildOptions> = {}, w: Partial<Points> = {}, ask?: Parameters<typeof buildList>[3]) =>
        buildList(input(small, large), { ...base, ...o, weights: { ...POINTS, ...w } }, { names: () => {}, build: () => () => {} }, ask);
    const hit = (list: string[]) => {
        const p = list.map(m => parseMask(m));
        return (x: Set1) => p.some(m => matches(m, x.dsn));
    };
    const sum = (l: Set1[]) => l.reduce((t, x) => t + x.kb, 0);
    const many = (n: number, f: (i: number) => string, kb = 1000): Set1[] => Array.from({ length: n }, (_, i) => ({ dsn: f(i), kb }));
    const letters = (i: number) => String.fromCharCode(65 + i % 26, 65 + Math.floor(i / 26) % 26, 65 + i * 7 % 26);

    it('maski: dopasowanie ciagow jak matches(), tekst -> maska -> tekst', () => {
        const { small, large } = data(1, 300);
        const all = [...small, ...large];
        const sp = makeSpace(input(small, large), { ...base, minCount: 3 }, () => {});
        const r = rng(9);
        let hits = 0;
        for (let k = 0; k < 600; k++) {
            const gap = () => ({ min: r() < 0.3 ? 1 + Math.floor(r() * 2) : 0, any: r() < 0.5 });
            const n = 1 + Math.floor(r() * 3);
            const m: Pattern = { toks: Array.from({ length: n }, () => Math.floor(r() * sp.q.tokens.length)), gaps: Array.from({ length: n }, gap), tail: gap() };
            const text = sp.text(m);
            assert.deepEqual(sp.parse(text), m);
            if (text.length > 44) continue;
            const mask = parseMask(text);
            const seqs = new Set(sp.select(m));
            all.forEach((x, i) => {
                // dane w srodku nazwy nie maja elementu doslownego
                if (m.toks.some(t => sp.q.tokens[t].dated)) return;
                assert.equal(seqs.has(sp.q.rowSeq[i]), matches(mask, x.dsn), `${text} ${x.dsn}`);
                hits += Number(seqs.has(sp.q.rowSeq[i]));
            });
        }
        assert.ok(hits > 300, String(hits));
        assert.equal(sp.parse('NIEMA.**'), null);
    });

    it('wynik: liczby, granice, purity, punkty; kazda maska daje wiecej, niz kosztuje', () => {
        for (let seed = 1; seed <= 12; seed++) {
            const { small, large } = data(seed, 250);
            for (const [o, w] of [[{}, {}], [{ maxLarge: { kb: 2000 }, loss: 0 }, { masks: 2 }], [{ maxMasks: 3 }, { start: 0, risk: 0 }],
                [{ minPurity: 0.6, maxLarge: { part: 0.5 }, loss: 0.1 }, { large: 0.5 }], [{ partial: 0 }, { exclude: 0 }]] as [Partial<BuildOptions>, Partial<Points>][]) {
                const opt = { ...base, ...o };
                const ww = { ...POINTS, ...w };
                const r = run(small, large, o, w);
                const label = `${seed} ${JSON.stringify([o, w])} ${r.include} | ${r.exclude}`;
                const [inc, exc] = [hit(r.include), hit(r.exclude)];
                const s = small.filter(x => inc(x) && !exc(x));
                const l = large.filter(x => inc(x) && !exc(x));
                const lost = small.filter(x => inc(x) && exc(x));
                const hidden = sum(large.filter(x => inc(x) && exc(x)));
                assert.deepEqual(r.totals, { small: s.length, large: l.length, smallKb: sum(s), largeKb: sum(l), lost: lost.length, hiddenKb: hidden }, label);
                assert.ok(sum(l) <= ('kb' in opt.maxLarge ? opt.maxLarge.kb : opt.maxLarge.part * sum(s)) + 1e-6, label);
                assert.ok(lost.length <= opt.loss * (s.length + lost.length), label);
                assert.ok(r.include.length + r.exclude.length <= opt.maxMasks, label);
                for (const m of r.include) {
                    const [a, b] = [small.filter(x => hit([m])(x) && !exc(x)).length, large.filter(x => hit([m])(x) && !exc(x)).length];
                    assert.ok(a / (a + b) >= opt.minPurity, `${label} ${m}`);
                    // bez zadnego EXCLUDE
                    assert.ok(small.filter(hit([m])).length >= large.filter(hit([m])).length, `${label} ${m}`);
                }
                for (const m of [...r.include, ...r.exclude]) assert.equal(acsProblem(m), null, m);
                // punkty
                const value = (i: string[], e: string[]) => {
                    const [pi, pe] = [hit(i), hit(e)];
                    const sh = (m: string, start: number) => start * Number(m.startsWith('*')) + ww.percent * m.replace(/[^%]/g, '').length
                        + ww.wild * m.split('.').reduce((t, q, k, a) => t + (q === '**' ? Number(k < a.length - 1) : q.replace(/[^*]/g, '').length), 0);
                    const ex = (m: string) => sh(m, 0);
                    return ww.small * 100 * small.filter(x => pi(x) && !pe(x)).length / small.length - ww.large * 100 * sum(large.filter(x => pi(x) && !pe(x))) / sum(small)
                        - ww.risk * 100 * sum(large.filter(x => pi(x) && pe(x))) / sum(small) - ww.masks * i.length - ww.exclude * e.length
                        - i.reduce((t, m) => t + sh(m, ww.start), 0) - e.reduce((t, m) => t + ex(m), 0);
                };
                assert.ok(Math.abs(value(r.include, r.exclude) - r.points) < 0.05, `${label} ${value(r.include, r.exclude)} ${r.points}`);
                assert.ok(Math.abs(Object.values(r.parts).reduce((a, b) => a + b, 0) - r.points) < 0.05, label);
                if (opt.maxMasks > 3) for (const m of r.exclude) assert.ok(large.some(hit([m])), m);
                assert.equal(r.how.length, r.include.length);
                r.how.forEach((h, i) => assert.equal(h?.steps[h.steps.length - 1].text, r.include[i]));
            }
        }
    });

    it('jedna maska: blisko najlepszej z pelnego przegladu', () => {
        const ratios: number[] = [];
        for (let seed = 1; seed <= 25; seed++) {
            const { small, large } = data(seed, 150);
            const opt = { ...base, maxMasks: 1, rounds: 0, exMin: 1e9, weights: { ...POINTS, start: seed % 2 ? 2 : 0 } };
            const data1 = input(small, large);
            const sp = makeSpace(data1, { ...opt, minCount: enough(small.length, opt) }, () => {});
            const b = new Builder(sp, opt);
            let best = 0;
            const gaps = [{ min: 0, any: true }, { min: 0, any: false }, { min: 1, any: false }];
            const toks = sp.q.tokens.map((t, i) => i);
            const grow = (ts: number[], gs: Pattern['gaps'], depth: number) => {
                for (const t of toks) {
                    for (const g of gaps) {
                        const open: Pattern = { toks: [...ts, t], gaps: [...gs, g], tail: gaps[0] };
                        const text = sp.text(open);
                        const seqs = sp.select(open);
                        let n = 0;
                        for (const s of seqs) n += sp.small[s];
                        if (100 * n / small.length - 0.5 <= best) continue;
                        for (const tail of gaps) {
                            const m = { ...open, tail };
                            if (sp.text(m).length > 44) continue;
                            const list = { inc: [b.item(m)], exc: [] };
                            const { t: tt } = b.live(list);
                            if (tt.small < 5 || tt.small / (tt.small + tt.large) < opt.minPurity || tt.largeKb > 0.1 * tt.smallKb) continue;
                            best = Math.max(best, b.score(list, tt));
                        }
                        if (depth > 1 && text.length < 44) grow([...ts, t], [...gs, g], depth - 1);
                    }
                }
            };
            grow([], [], 2);
            if (best <= 0) continue;
            ratios.push(run(small, large, opt, opt.weights).points / best);
        }
        assert.ok(ratios.length > 15);
        assert.ok(Math.min(...ratios) > 0.9, String(ratios));
        assert.ok(ratios.reduce((a, x) => a + x, 0) / ratios.length > 0.98, String(ratios));
    });

    it('D* zamiast D%%%%%%; % tylko, gdy D* obejmuje duze', () => {
        const day = (i: number) => `D${String(240101 + 37 * i)}`;
        const small = [...many(40, i => `ABC.JOBS.${day(i)}.X${letters(i)}`), ...many(40, i => `ABC.${letters(i)}`)];
        const large = many(30, i => `ABC.JOBS.Q${letters(i)}.Y${letters(i)}`, 3000);
        const a = run(small, large);
        assert.ok(a.include.includes('ABC.JOBS.D*.*') || a.include.includes('ABC.JOBS.D*.**') || a.include.includes('ABC.JOBS.**'), String(a.include));
        assert.ok(a.include.every(m => !m.includes('%')), String(a.include));
        // duze o tym samym poczatku: DATA, DUMP... i innej koncowce niz EXCLUDE moglby zdjac
        const dirty = many(60, i => `ABC.JOBS.D${letters(i)}K.X${letters(i + 3)}`, 3000);
        const c = run(small, [...large, ...dirty]);
        assert.ok(c.include.some(m => /\bD%+/.test(m)), String(c.include));
        assert.ok(hit(c.include)({ dsn: `ABC.JOBS.${day(1)}.XQQQ`, kb: 1 }));
    });

    it('numery zadan: JA*, nie JA0*, JA1*', () => {
        const small = many(200, i => `ABC.RUN.JA${String(i * 7 % 1000).padStart(3, '0')}.LST`);
        const large = many(60, i => `ABC.RUN.${letters(i)}X.DAT`, 3000);
        const sp = makeSpace(input(small, large), base, () => {});
        assert.ok(sp.byText.has('JA*') && sp.byText.has('JA%%%'));
        assert.ok([...sp.byText.keys()].every(t => !/^JA[0-9]+[*%]/.test(t)), [...sp.byText.keys()].join(' '));
    });

    it('wagi: start, masks, large, risk', () => {
        // LOG w dwoch aplikacjach: dwie maski sa tansze niz start=2, przy start=0 wystarczy jedna
        const small = [...many(60, i => `AAA.X${letters(i)}.LOG`), ...many(60, i => `BBB.Y${letters(i)}.LOG`)];
        const large = [...many(60, i => `AAA.X${letters(i)}.DATA`, 1500), ...many(60, i => `BBB.Y${letters(i)}.BASE`, 1500)];
        assert.deepEqual(run(small, large).include.map(m => m.slice(0, 3)).sort(), ['AAA', 'BBB']);
        const free = run(small, large, {}, { start: 0 });
        assert.equal(free.include.length, 1);
        assert.match(free.include[0], /^\*/);
        // wiele aplikacji: ** na poczatku sie oplaca mimo start=2
        const apps = many(400, i => `${letters(i)}${letters(i + 100)}.X${letters(i)}.LOG`);
        const other = many(200, i => `${letters(i)}${letters(i + 100)}.X${letters(i)}.DATA`, 1500);
        assert.deepEqual(run(apps, other).include.map(m => m.split('.').pop()), ['LOG']);
        // mniej masek przy drozszych maskach
        for (let seed = 1; seed <= 5; seed++) {
            const d = data(seed, 300);
            const [cheap, dear] = [0.1, 4].map(masks => run(d.small, d.large, {}, { masks, exclude: masks }));
            assert.ok(dear.include.length + dear.exclude.length <= cheap.include.length + cheap.exclude.length);
            const strict = run(d.small, d.large, {}, { large: 50 });
            assert.ok(strict.totals.largeKb <= run(d.small, d.large, {}, { large: 0.5 }).totals.largeKb);
        }
        // risk: bez niego szeroka maska z EXCLUDE
        const s2 = [...many(40, i => `PAY.LOG.X${letters(i)}`), ...many(40, i => `PAY.OUT.Y${letters(i)}`), ...many(20, i => `PAY.Z${letters(i)}.TMP`)];
        const l2 = many(60, i => `PAY.DB.W${letters(i)}`, 3000);
        const bold = run(s2, l2, { loss: 0 }, { risk: 0 });
        assert.deepEqual([bold.include, bold.exclude], [['PAY.**'], ['**.DB.**']]);
        const safe = run(s2, l2, { loss: 0 }, { risk: 1 });
        assert.ok(safe.exclude.length === 0 && safe.include.length === 3, `${safe.include} | ${safe.exclude}`);
        assert.equal(safe.totals.hiddenKb, 0);
    });

    it('cala lista: lepsza niz zachlanna (szeroka maska z EXCLUDE albo od **), granice przy kazdej zmianie', () => {
        // zachlannie: PAY.** z EXCLUDE albo **.LIST; najlepiej trzy maski bez EXCLUDE
        const q = (i: number) => `${letters(i)}Q`;
        const small = [...many(30, i => `PAY.LOG.N24${1000 + 37 * i}`), ...many(20, i => `PAY.WORK.${q(i)}.LIST`), ...many(12, i => `HR.WORK.${q(i + 40)}.LIST`), ...many(6, i => `HR.TEMP.${q(i + 60)}.OUT`)];
        const large = [...many(8, i => `PAY.WORK.${q(i)}.DATA`), ...many(26, i => `PAY.MASTER.${q(i)}`), ...many(26, i => `HR.BASE.${q(i)}.DATA`)];
        const r = run(small, large, { minCount: 10, loss: 0.01, maxLarge: { part: 0.05 }, minPurity: 0.95 });
        assert.deepEqual([r.include.slice().sort(), r.exclude], [['HR.WORK.**', 'PAY.LOG.**', 'PAY.WORK.*.LIST'], []]);
        // ta sama lista przez allowed(): purity maski, KB duzych, strata, liczba masek
        const all: BuildOptions = { ...base, minPurity: 0, maxLarge: { part: 9 }, loss: 1, maxMasks: 2 };
        const list = (b: Builder, sp: Space) => ({ inc: [b.item(sp.parse('PAY.**')!)], exc: [b.item(sp.parse('**.WORK.**')!)] });
        const ok = (o: Partial<BuildOptions>) => {
            const sp = makeSpace(input(small, large), all, () => {});
            const b = new Builder(sp, { ...all, ...o });
            return b.allowed(list(b, sp), b.live(list(b, sp)));
        };
        // po EXCLUDE: 30 malych, 26 duzych (purity 53,6%, KB 26/30), strata 20 z 50
        assert.deepEqual([{}, { minPurity: 0.53 }, { minPurity: 0.54 }, { maxLarge: { part: 0.87 } }, { maxLarge: { part: 0.86 } }, { maxLarge: { kb: 26000 } }, { maxLarge: { kb: 25999 } },
            { loss: 0.4 }, { loss: 0.39 }, { maxMasks: 1 }].map(ok), [true, true, false, true, false, true, false, true, false, false]);
    });

    it('--ask: po odrzuceniu nie wraca inny zapis tych samych zbiorow', () => {
        const small = [...many(30, i => `PAY.LOG.X${letters(i)}`), ...many(30, i => `PAY.OUT.Y${letters(i)}`)];
        const large = many(30, i => `HR.DB.W${letters(i)}`, 3000);
        const seen: string[][] = [];
        run(small, large, {}, {}, list => {
            seen.push(list.map(p => p.text));
            return seen.length < 2 ? { reject: true } : { stop: true };
        });
        assert.equal(seen[0][0], 'PAY.**');
        const names = [...small, ...large];
        const of = (m: string) => names.filter(hit([m])).length;
        assert.ok(seen[1].length > 0 && seen[1].every(m => of(m) < 60), String(seen[1]));
    });

    it('poczatek nazw, brak malych, przerwanie po czasie, koszt wygladu', () => {
        const { small, large } = data(3, 250);
        const only = (l: Set1[]) => l.filter(x => /^ABCP\./.test(x.dsn));
        const r = run(only(small), only(large), { head: ['ABC%'], minCount: 3 });
        assert.ok(r.include.length > 0 && r.include.every(m => m.startsWith('ABC%.')), String(r.include));
        assert.equal(run([], large).include.length, 0);
        assert.equal(run(small, []).totals.large, 0);
        const late = run(small, large, { seconds: 0 });
        assert.ok(late.stopped);
        const c = (t: string, head = 0) => Math.round(1000 * shapeCost(t, POINTS, head)) / 1000;
        assert.equal(c('A.B.**'), 0);
        assert.equal(c('A.**.B*.C%%'), 0.02 + 0.02 + 0.1);
        assert.equal(c('**.A.*'), 2.04);
        assert.equal(c('*.**.A', 1), 0.04);
        // niepelna nazwa przegrywa z pelniejsza o tych samych zbiorach
        assert.ok(shapeCost('ABC*.**', POINTS) < shapeCost('A*.**', POINTS));
    });

    it('ten sam wynik za kazdym razem', () => {
        const { small, large } = data(7, 300);
        assert.deepEqual(run(small, large), run(small, large));
    });

    it('--ask: przyjecie, inna, odrzucenie, wlasna, cofniecie, koniec', () => {
        const { small, large } = data(2, 300);
        const seen: { list: Proposal[]; no: number; small: number; last: string | undefined }[] = [];
        const script = (answers: (Answer | ((l: Proposal[]) => Answer))[]) => {
            seen.length = 0;
            let n = 0;
            return run(small, large, {}, {}, (list, no, now, last) => {
                seen.push({ list, no, small: now.small, last: last?.text });
                const a = answers[n++] ?? { stop: true };
                return typeof a === 'function' ? a(list) : a;
            });
        };
        let r = script([{ take: 0 }, { take: 1 }]);
        assert.deepEqual(r.include, [seen[0].list[0].text, seen[1].list[1].text]);
        assert.deepEqual(seen.map(x => x.no), [1, 2, 3]);
        assert.equal(seen[1].small, seen[0].list[0].gain);
        r = script([{ reject: true }, { take: 0 }]);
        assert.notEqual(r.include[0], seen[0].list[0].text);
        assert.ok(seen.slice(1).every(x => x.list.every(p => p.text !== seen[0].list[0].text)));
        // takze inny zapis tych samych zbiorow
        const names = [...small, ...large];
        const of = (m: string) => names.filter(hit([m])).map(x => x.dsn).join();
        assert.ok(seen[1].list.every(p => of(p.text) !== of(seen[0].list[0].text)));
        // wlasna z kwalifikatorem, ktorego nie ma w danych, i z cala nazwa
        const own = small[0].dsn;
        r = script([{ take: 0 }, { mask: 'ABC*.**.Q*Z' }, { mask: own }, { take: 0 }]);
        assert.deepEqual(r.include.slice(1, 3), ['ABC*.**.Q*Z', own]);
        assert.equal(r.how[1], null);
        assert.match(journalText(r), /2\. ABC\*\.\*\*\.Q\*Z {3}\(wpisana\)/);
        const inc = hit(r.include);
        const exc = hit(r.exclude);
        assert.equal(r.totals.small, small.filter(x => inc(x) && !exc(x)).length);
        r = script([{ take: 0 }, { mask: 'XYZ*.**' }, { undo: true }, { undo: true }, { undo: true }, { take: 0 }]);
        assert.deepEqual(r.include, [seen[0].list[0].text]);
        assert.equal(r.changes.length, 1);
        assert.equal(script([]).include.length, 0);
    });

    it('z wiersza polecen: raport, dziennik, --what-if, --verify, pliki, --ask, bledy', () => {
        const row = (dsn: string, kb: number, small: boolean) => dline({ dsn, f1: '48', allkb: kb, usekb: small ? 40 : kb - 100 });
        const t = kbForTrk(315);
        const make = (n: number, from: number) => csv([
            ...Array.from({ length: n }, (_, i) => row(`PAY.LOG.D${240101 + from + i}`, t, true)),
            ...Array.from({ length: n }, (_, i) => row(`PAY.WORK.${letters(from + i)}Q.LIST`, t, true)),
            ...Array.from({ length: n }, (_, i) => row(`PAY.WORK.${letters(from + i)}Q.DATA`, t, false)),
        ]);
        write('B1.CSV', make(30, 0));
        write('B2.CSV', make(30, 10));
        const r = auto(['B1.CSV', '--build', '--verify', 'B2.CSV', '--what-if', '--filtlist', 'bf.txt', '--out', 'b.csv', '--log', 'bd.txt', '--tests', 'BT']);
        assert.equal(r.code, 0, r.err);
        for (const x of [/Masek 2 \(INCLUDE 2, EXCLUDE 0\)/, /^PAY\.LOG\.\*\* +30 +0 +100,0%/m, /^objete male +small=1 +\+100,00$/m, /^RAZEM +\+98,9\d$/m,
            /^masks, exclude {2}x0,5/m, /^start {2}x2 /m, /w tym nazwy, ktorych w pierwszym nie bylo +20/]) assert.match(r.out, x);
        assert.doesNotMatch(r.out, /Dziennik/);
        const log = fs.readFileSync(path.join(dir, 'bd.txt'), 'utf-8');
        assert.match(log, /start: .*ranking 1: [0-9,]+% malych, [0-9,]+% duzych/);
        assert.match(log, /Zmiany listy po kolei/);
        assert.deepEqual(rowsOf('b.csv').map(x => x[0]).sort(), ['PAY.LOG.**', 'PAY.WORK.*.LIST']);
        assert.match(fs.readFileSync(path.join(dir, 'bf.txt'), 'utf-8'), /FILTLIST MALE INCLUDE\(/);
        assert.match(fs.readFileSync(path.join(dir, 'BT'), 'utf-8'), /PAY\.LOG/);
        const again = auto(['B1.CSV', '--masks', 'bf.txt']);
        assert.match(again.out, /obejmuja 100,0% malych/);

        const ask = (lines: string[]) => {
            const err: string[] = [];
            let out = '';
            const queue = lines.slice();
            const code = autoMain([path.join(dir, 'B1.CSV'), '--build', '--ask'], { out: x => void (out += x), err: x => void err.push(x), line: () => queue.shift() ?? null });
            return { code, out, err: err.join('') };
        };
        const a = ask(['9', 'zle', 'A..B', 'n', '', 'c', '1', 'PAY.WORK.*.LIST', 'k']);
        assert.equal(a.code, 0, a.err);
        assert.match(a.err, /nieznana odpowiedz/);
        assert.match(a.err, /Przyjeta: wpisana PAY\.WORK\.\*\.LIST/);
        assert.match(a.out, /Masek [23] \(INCLUDE 2,/);
        assert.equal(ask([]).code, 0);
        const over = ask(['PAY.**']);
        assert.match(over.err, /Uwaga: lista przekracza --max-large/);
        const piped = spawnSync(process.execPath, [path.join(dir, NAME), 'B1.CSV', '--build', '--ask'], { cwd: dir, encoding: 'utf-8', input: '\n\r\nk' });
        assert.equal(piped.status, 0, piped.stderr);
        assert.match(piped.stdout, /INCLUDE 2,/);

        for (const x of [['--ask'], ['--weights', 'masks=1'], ['--beam', '4'], ['--what-if'], ['--log', 'x'], ['--rounds', '1'], ['--build', '--compact'], ['--build', '--masks', 'bf.txt'],
            ['--build', '--quals', '2'], ['--build', '--wild', '2'], ['--build', '--weights', 'masks'], ['--build', '--weights', 'inne=1'], ['--build', '--weights', 'masks=-1'],
            ['--build', '--weights', 'small=0'], ['--build', '--ask', '--what-if'], ['--build', '--partial', '1'], ['--build', '--exclude'], ['--build', '--pick', '3'], ['--build', '--beam', '0'],
            ['--build', '--exclude-gain', '1%'], ['--build', '--verify', 'brak.csv']]) {
            const e = auto(['B1.CSV', ...x]);
            assert.equal(e.code, 1, x.join(' '));
            assert.doesNotMatch(e.err, /^\s+at /m, x.join(' '));
        }
        assert.deepEqual(parseWeights('masks=1, large=0,5 START=3'), { ...POINTS, masks: 1, large: 0.5, start: 3 });
        assert.match(auto(['B1.CSV', '--build', '--min-count', '1000']).out, /Brak masek/);
    });
});
