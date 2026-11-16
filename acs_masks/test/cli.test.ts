import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { filtlist } from '../src/acs';
import { main } from '../src/cli';
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

describe('FILTLIST - zawijanie', () => {
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
