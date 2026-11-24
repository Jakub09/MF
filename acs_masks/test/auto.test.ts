import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { check, main as autoMain, parseConds, parseHead, search, SearchResult } from '../src/auto';
import { acsProblem, filtlistText, findExcludes, maskTests } from '../src/auto-acs';
import { parseMaskList } from '../src/auto-check';
import { MaskRow } from '../src/auto-mine';
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
                // najwieksza mozliwa maska bez malych; zadna dodatkowa nie wylaczy juz minCount duzych
                const pure = family(large, small, { minPurity: 1, minCount, maxMasks: 255, maxWild: 1 }).filter(f => f.neg === 0 && f.pos.length >= minCount);
                const most = pure.reduce((n, f) => Math.max(n, f.pos.length), 0);
                assert.equal(e.masks.reduce((n, m) => Math.max(n, m.large), 0), most);
                assert.ok(e.masks.every(m => m.small === 0 && m.large >= minCount && pure.some(f => f.text === m.text && f.pos.length === m.large)));
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
        assert.equal(read('fl.txt'), '  FILTLIST MALE INCLUDE(ABC.**)\n                EXCLUDE(ABC.N%.LOG)\n');
        assert.equal(read('ACMTEST'), ['./ ADD NAME=ACM00001', 'DESCRIPTION1:', 'ABC.**', 'DSN: ABC.N0.DAT', 'ACSENVIR: ALLOC',
            './ ADD NAME=ACM00002', 'DESCRIPTION1:', 'EXCLUDE ABC.N%.LOG', 'DSN: ABC.N0.LOG', 'ACSENVIR: ALLOC', './ ENDUP', ''].join('\n'));
        assert.deepEqual(rowsOf('e.csv').map(x => [x[0], x[1], x[2], x[7]]), [['ABC.**', '20', '5', ''], ['ABC.N%.LOG', '0', '4', 'exclude']]);
        assert.equal(r.err.split('\n').filter(l => /^\[\d\/7\]/.test(l)).length, 7);

        const again = ['fl.txt', 'e.csv'].map(f => auto(['X.CSV', '--masks', f, '--exclude', '--out', 'e2.csv']).out.split('\n').slice(1).join('\n'));
        assert.equal(again[0], again[1]);
        assert.match(again[0], /ABC\.N%\.LOG +0 +4 /);
        assert.match(again[0], /Brak masek EXCLUDE/);
        assert.deepEqual(rowsOf('e2.csv').map(x => [x[0], x[2], x[7]]), [['ABC.**', '1', ''], ['ABC.N%.LOG', '4', 'exclude']]);

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
