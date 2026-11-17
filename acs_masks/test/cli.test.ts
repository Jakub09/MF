import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { filtlist } from '../src/acs';
import { DEFAULT_OUT, main } from '../src/cli';
import { runDir, runStamp } from '../src/outdir';
import { sampleCsv } from '../tools/gen-sample';

const ROOT = path.join(__dirname, '..');
let dir: string;
let csvFile: string;

async function run(argv: string[]) {
    let out = '';
    let err = '';
    const code = await main(argv, { out: t => void (out += t), err: t => void (err += t) });
    return { code, out, err };
}

before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-masks-'));
    csvFile = path.join(dir, 'PROBA.CSV');
    fs.writeFileSync(csvFile, sampleCsv(2000));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('acs-masks - caly przebieg', () => {
    it('przyklad: raport, rutyny ACS, karty ACMREPR', async () => {
        const out = path.join(dir, 'out');
        const r = await run([csvFile, '--config', path.join(ROOT, 'config/przyklad.json'), '--out', out,
            '--today', '2026-11-16']);
        assert.equal(r.code, 0, r.err);
        const files = fs.readdirSync(path.join(out, 'zos')).sort();
        assert.deepEqual(files, ['ACMCARD', 'ACMDC', 'ACMLIST', 'ACMSG', 'ACMSYMV']);
        const dc = fs.readFileSync(path.join(out, 'zos/ACMDC'), 'utf-8');
        assert.match(dc, /PROC DATACLAS/);
        assert.match(dc, /FILTLIST NADALOK_1 INCLUDE\(/);
        assert.match(dc, /FILTLIST NADALOK_X1 INCLUDE\(SYS1\.\*\*\)/);
        assert.match(dc, /SET &DATACLAS = 'DCMALY'/);
        assert.match(dc, /PROD\.BATCH\.\*\*\.SYSOUT/);
        const sg = fs.readFileSync(path.join(out, 'zos/ACMSG'), 'utf-8');
        assert.match(sg, /&DSORG = 'PS'/);
        for (const f of files) {
            for (const l of fs.readFileSync(path.join(out, 'zos', f), 'utf-8').split('\n')) {
                assert.ok(l.length <= 71, `${f}: ${l}`);
                assert.ok(!/[^\x20-\x7e]/.test(l), `${f}: ${l}`);
            }
        }
        assert.match(r.out, /=== Regula NADALOK/);
        assert.ok(fs.existsSync(path.join(out, 'NADALOK.niepokryte.csv')));
    });

    it('wynikowe maski: czystosc >= progu, SYS1 wylaczone', async () => {
        const out = path.join(dir, 'out2');
        const r = await run([csvFile, '--config', path.join(ROOT, 'config/przyklad.json'), '--out', out,
            '--min-purity', '1']);
        assert.equal(r.code, 0, r.err);
        const rows = fs.readFileSync(path.join(out, 'maski.csv'), 'utf-8').trim().split('\n').slice(1)
            .map(l => l.split(';'));
        const masks = rows.filter(x => x[1] === 'maska');
        assert.ok(masks.length > 0);
        for (const m of masks) assert.equal(m[4], '0', `maska ${m[2]} obejmuje zbiory spoza kryterium`);
        // SYS1.** wylaczone z reguly NADALOK - poza zbiorami reguly
        assert.match(r.out, /wylaczonych maskami exclude: \d+/);
    });

    it('--dry-run nie zapisuje plikow', async () => {
        const out = path.join(dir, 'brak');
        const r = await run([csvFile, '-c', path.join(ROOT, 'config/przyklad.json'), '-o', out, '--dry-run']);
        assert.equal(r.code, 0, r.err);
        assert.ok(!fs.existsSync(out));
        assert.match(r.out, /PROC STORGRP/);
    });

    it('bledy: brak argumentow, zla konfiguracja, zly prog', async () => {
        assert.equal((await run([])).code, 1);
        const bad = path.join(dir, 'zla.json');
        fs.writeFileSync(bad, JSON.stringify({ rules: [{ name: 'x', when: {}, routine: 'SG', value: 'A' }] }));
        const r = await run([csvFile, '-c', bad]);
        assert.equal(r.code, 1);
        assert.match(r.err, /bledna konfiguracja/);
        const r2 = await run([csvFile, '-c', path.join(ROOT, 'config/przyklad.json'), '--min-purity', '2']);
        assert.equal(r2.code, 1);
        assert.match(r2.err, /min-purity/);
    });
});

describe('dlugie nazwy i opisy - linie ACS <= 71', () => {
    it('regula 26 znakow, pelne nazwy, wiele grup, dlugi wyraz w opisie', async () => {
        const cfg = path.join(dir, 'dluga.json');
        fs.writeFileSync(cfg, JSON.stringify({
            minPurity: 0.95,
            otherwise: { STORGRP: Array.from({ length: 12 }, (_, i) => `SGDEF${i}`) },
            rules: [{
                name: 'NADMIAROWA_ALOKACJA_315TRK', routine: 'STORGRP',
                value: Array.from({ length: 10 }, (_, i) => `SGPROD${i}`),
                description: `opis ${'X'.repeat(150)} koniec`,
                when: { all: [{ field: 'allocTrk', op: 'eq', value: 315 }, { field: 'usedTrk', op: 'le', value: 1 }] },
                acsCondition: "&DSORG = 'PS' AND &DSTYPE NE 'TEMP' AND &SIZE > 0",
            }],
        }));
        const out = path.join(dir, 'out3');
        const r = await run([csvFile, '-c', cfg, '-o', out, '--literals', '--exclude-fp']);
        assert.equal(r.code, 0, r.err);
        const sg = fs.readFileSync(path.join(out, 'zos/ACMSG'), 'utf-8').split('\n');
        for (const l of sg) assert.ok(l.length <= 71, `${l.length}: ${l}`);
        assert.ok(sg.some(l => /FILTLIST NADMIAROWA_ALOKACJA_315TRK_1 INCLUDE\(/.test(l)));
        assert.ok(sg.some(l => /^ {4}'SGDEF\d+'|^ {10}'SGPROD\d+'/.test(l)), 'SET zawiniety');
    });

    it('domyslny katalog wynikow: out/ w katalogu projektu', () => {
        assert.equal(DEFAULT_OUT, path.join(ROOT, 'out'));
    });

    it('bez --out: kazdy przebieg w osobnym podkatalogu out/<rodzaj>/<data_godzina>', async () => {
        const base = path.join(dir, 'baza');
        const prev = process.env.ACS_MASKS_OUT;
        process.env.ACS_MASKS_OUT = base;
        try {
            const cfg = path.join(ROOT, 'config/przyklad.json');
            assert.equal((await run([csvFile, '-c', cfg])).code, 0);
            assert.equal((await run([csvFile, '-c', cfg])).code, 0);
            const runs = fs.readdirSync(path.join(base, 'maski')).sort();
            assert.equal(runs.length, 2);
            assert.match(runs[0], /^\d{4}-\d{2}-\d{2}_\d{6}(-\d+)?$/);
            for (const r of runs) {
                assert.ok(fs.existsSync(path.join(base, 'maski', r, 'RAPORT.txt')));
                assert.match(fs.readFileSync(path.join(base, 'maski', r, 'wywolanie.txt'), 'utf-8'), /wywolanie: acs-masks .*PROBA\.CSV -c /);
            }
            const ex = path.join(ROOT, 'przyklady');
            assert.equal((await run(['repr', csvFile, '--acs', path.join(ex, 'ACSSC'), '--tests'])).code, 0);
            assert.equal((await run(['sim', csvFile, '--acs', path.join(ex, 'ACSSC')])).code, 0);
            const [rr] = fs.readdirSync(path.join(base, 'repr'));
            assert.ok(fs.existsSync(path.join(base, 'repr', rr, 'zos/ACMTEST')));
            assert.match(fs.readFileSync(path.join(base, 'repr', rr, 'wywolanie.txt'), 'utf-8'), /acs-masks repr .* --tests/);
            assert.equal(fs.readdirSync(path.join(base, 'sim')).length, 1);
        } finally {
            if (prev === undefined) delete process.env.ACS_MASKS_OUT;
            else process.env.ACS_MASKS_OUT = prev;
        }
    });
});

describe('FILTLIST - zawijanie', () => {
    it('dluga nazwa listy i pelne nazwy 44 znaki', () => {
        const items = Array.from({ length: 5 }, (_, i) => `PROD.ABCDEFGH.ABCDEFGH.ABCDEFGH.ABCDEFG${i}.XY`);
        const lines = filtlist('NADMIAROWA_ALOKACJA_315TR_X1', items);
        for (const l of lines) assert.ok(l.length <= 71, l);
    });

    it('linie <= 71, przecinek na koncu, nawias na koncu listy', () => {
        const items = Array.from({ length: 40 }, (_, i) => `PROD.APPLICATION${i % 10}.**.LONGNAME`.slice(0, 44));
        const lines = filtlist('REGULA_1', items);
        for (const l of lines.slice(0, -1)) {
            assert.ok(l.length <= 71, l);
            assert.ok(l.endsWith(','), l);
        }
        assert.ok(lines[lines.length - 1].endsWith(')'));
    });
});

describe('katalog przebiegu', () => {
    it('nazwa z data i godzina; kolizja w tej samej sekundzie -> -2', () => {
        const now = new Date(2026, 10, 17, 9, 5, 7);
        assert.equal(runStamp(now), '2026-11-17_090507');
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-run-'));
        const a = runDir('repr', base, now);
        assert.equal(a, path.join(base, 'repr', '2026-11-17_090507'));
        fs.mkdirSync(a, { recursive: true });
        assert.equal(runDir('repr', base, now), `${a}-2`);
        fs.rmSync(base, { recursive: true, force: true });
    });
});
