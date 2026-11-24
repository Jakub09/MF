import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { check, main as autoMain, parseConds, parseHead, search } from '../src/auto';
import { MaskTree, parseMaskList, within } from '../src/auto-check';
import { BOOL, Field, NUM, readStore, STR } from '../src/auto-read';
import { Interner, PairMap, Progress } from '../src/auto-util';
import { main } from '../src/cli';
import { DataSet, readDataSets, stripGds } from '../src/dataset';
import { matches, parseMask } from '../src/mask';
import { buildCandidates, Candidate, MaskIndex, purity, selectMasks } from '../src/mine';
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

    for (const p of ['0.95', '0.6', '1']) {
        it(`te same maski i liczby co acs-masks --config (domyslne kryterium, min-purity ${p})`, async () => {
            const a = auto(['P.CSV', '--min-purity', p, '--out', 'm.csv']);
            assert.equal(a.code, 0, a.err);
            const r = await full([path.join(dir, 'P.CSV'), '-c', config, '--min-purity', p, '--out', path.join(dir, 'f')]);
            assert.equal(r.code, 0, r.err);
            const want = rowsOf('f/maski.csv').map(x => [x[2], x[3], x[4]]);
            assert.ok(want.length > 0);
            assert.deepEqual(rowsOf('m.csv').map(x => x.slice(0, 3)), want);
        });
    }

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
        { minPurity: 0.95, minCount: 3, maxMasks: 1000 }, { minPurity: 0.5, minCount: 2, maxMasks: 1000 },
        { minPurity: 0, minCount: 1, maxMasks: 1000 }, { minPurity: 1, minCount: 1, maxMasks: 7 },
        { minPurity: 0.6, minCount: 10, maxMasks: 1000 },
    ];
    for (let seed = 1; seed <= 25; seed++) {
        it(`maski i liczby, ziarno ${seed}`, async () => {
            const file = write('R.CSV', randomCsv(seed + 100, 100 + seed * 40));
            const { dataSets } = await readDataSets(file);
            stripGds(dataSets);
            const u = dataSets.filter(x => x.sms && x.dsorg === 'PS');
            const small = (x: DataSet) => x.allocTrk === 315 && x.usedTrk <= 3;
            const pos = u.filter(small);
            const neg = u.filter(x => !small(x));
            const idx = buildCandidates(pos.map(x => x.quals), neg.map(x => x.quals), true);
            for (const o of opts) {
                const want = selectMasks(idx, pos.length, { ...o, digitMasks: true }).map(x => [x.cand.text, x.cand.pos.length, x.cand.neg, purity(x.cand)]);
                const r = search(file, parseConds('sms=true dsorg=PS', 's'), parseConds('allocTrk=315 usedTrk<=3', 'w'), o, silent());
                assert.deepEqual(r.masks.map(m => [m.text, m.small, m.large, m.purity]), want);
                // MB i RAZEM: porownanie kazdej maski z kazda nazwa
                const sum = (l: DataSet[]) => l.reduce((t, x) => t + x.allocKb, 0);
                const masks = r.masks.map(m => parseMask(m.text));
                const check = (row: typeof r.total, hit: DataSet[]) => {
                    const s = hit.filter(small);
                    const l = hit.filter(x => !small(x));
                    assert.deepEqual([row.small, row.large, row.smallKb, row.largeKb], [s.length, l.length, sum(s), sum(l)], row.text);
                };
                r.masks.forEach((m, k) => check(m, u.filter(x => matches(masks[k], x.dsn))));
                check(r.total, u.filter(x => masks.some(m => matches(m, x.dsn))));
            }
        });
    }

    // --prefix: kandydaci z nazw z podmienionym poczatkiem, kazdy porownany z kazda nazwa
    for (const prefix of ['A%.**', 'A%', 'PROD.**', 'A*.%*', '*.**', '*.A%%.**', 'A{.*', 'A*.*1*.*%', '%%.%%%.**', 'A*.*.*.**', '*1*.**', 'BRAK.**', '**']) {
        it(`--prefix ${prefix}`, async () => {
            const head = parseHead(prefix);
            assert.throws(() => parseHead(`X.**.${prefix}`), /tylko na koncu/);
            const starts = parseMask([...head, '**'].join('.'));
            let found = 0;
            for (let seed = 1; seed <= 6; seed++) {
                const file = write('R.CSV', randomCsv(seed + 300, 300));
                const { dataSets } = await readDataSets(file);
                stripGds(dataSets);
                const u = dataSets.filter(x => x.sms && x.dsorg === 'PS' && matches(starts, x.dsn));
                const small = (x: DataSet) => x.allocTrk === 315 && x.usedTrk <= 3;
                const pos = u.filter(small);
                const neg = u.filter(x => !small(x));
                const texts = new MaskIndex(true);
                for (const x of pos) texts.addFrom([...head, ...x.quals.slice(head.length)]);
                const byText = new Map<string, Candidate>();
                for (const text of texts.byText.keys()) {
                    if (head.length && text !== head.join('.') && !text.startsWith(`${head.join('.')}.`)) continue;
                    const m = parseMask(text);
                    byText.set(text, {
                        id: byText.size, text, neg: neg.filter(x => matches(m, x.dsn)).length,
                        pos: [...pos.keys()].filter(i => matches(m, pos[i].dsn)),
                    });
                }
                for (const o of opts) {
                    const want = selectMasks({ byText } as MaskIndex, pos.length, { ...o, digitMasks: true })
                        .map(x => [x.cand.text, x.cand.pos.length, x.cand.neg, purity(x.cand)]);
                    const r = search(file, parseConds('sms=true dsorg=PS', 's'), parseConds('allocTrk=315 usedTrk<=3', 'w'), { ...o, head }, silent());
                    assert.deepEqual([r.inScope, r.small], [u.length, pos.length]);
                    assert.deepEqual(r.masks.map(m => [m.text, m.small, m.large, m.purity]), want);
                    const masks = r.masks.map(m => parseMask(m.text));
                    const hit = u.filter(x => masks.some(m => matches(m, x.dsn)));
                    assert.deepEqual([r.total.small, r.total.large], [hit.filter(small).length, hit.filter(x => !small(x)).length]);
                    found += want.length;
                }
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
            assert.deepEqual(rowsOf('m.csv').map(x => x.slice(0, 3)), [['ABC%.LOG.**', '6', '0']]);
            assert.match(r.out, /poczatek masek: ABC% /);
            assert.match(r.out, /w zakresie: 9, malych: 6/);
        }
    });

    const masksOf = (small: string[], large: string[], minCount: number) => {
        const line = (dsn: string, usekb: number) => dline({ dsn, allkb: kbForTrk(315), usekb });
        const file = write('R.CSV', csv([...small.map(x => line(x, 40)), ...large.map(x => line(x, kbForTrk(200)))]));
        return search(file, parseConds('', 's'), parseConds('usedTrk<=3', 'w'), { minPurity: 1, minCount, maxMasks: 99 }, silent())
            .masks.map(m => m.text).sort();
    };
    it('wzorzec, do ktorego pasuje dokladnie min-count zbiorow', () => {
        assert.deepEqual(masksOf(['A.D1', 'A.D2', 'A.D3'], ['A.X'], 3), ['A.D%']);
        assert.deepEqual(masksOf(['A.D1', 'A.D2', 'A.D3'], ['A.X'], 4), []);
    });
    it('maska zbedna (jej zbiory obejmuja pozniejsze) jest usuwana', () => {
        const names = ['A', 'B'].flatMap(h => ['P', 'Q', 'R'].map(m => `${h}.${m}.Z`));
        assert.deepEqual(masksOf([...names, 'A.KK', 'A.LL', 'B.MM', 'B.NN'], ['C.X'], 2), ['A.**', 'B.**']);
    });

    it('bez zbiorow w zakresie, bez malych, same male', () => {
        const file = write('R.CSV', randomCsv(5, 100));
        const run = (s: string, w: string) => search(file, parseConds(s, 's'), parseConds(w, 'w'), { minPurity: 0.9, minCount: 1, maxMasks: 9 }, silent());
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
            const res = check(file, parseConds('sms=true dsorg=PS', 's'), parseConds('allocTrk=315 usedTrk<=3', 'w'), texts, [], silent());
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
        const run = (...masks: string[]) => check(path.join(dir, 'K.CSV'), parseConds('', 's'), parseConds('usedTrk<=3', 'w'), masks, [], silent())
            .rows.map(x => [x.text, x.state, x.note]);
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
        assert.deepEqual(parseMaskList('A.**\n/* x\n */a.**\n', 'm'), { masks: ['A.**'], warnings: ['m, wiersz 3: maska A.** powtorzona'] });
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
        assert.deepEqual(rowsOf('w.csv').map(x => x.slice(0, 6)), rowsOf('m.csv'));
        assert.equal(again.err.split('\n').filter(l => /^\[\d\/2\]/.test(l)).length, 2);
        for (const a of [['P.CSV', '--masks', 'BRAK'], ['P.CSV', '--unit', 'KG'], ['P.CSV', '--masks', 'P.CSV'], ['P.CSV', '--unit', 'toString']]) {
            const x = auto(a);
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
