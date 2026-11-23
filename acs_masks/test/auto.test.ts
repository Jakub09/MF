import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { main as autoMain, parseConds, parseHead, search } from '../src/auto';
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
