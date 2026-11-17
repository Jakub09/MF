import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { main } from '../src/cli';
import { sampleCsv } from '../tools/gen-sample';

const ROOT = path.join(__dirname, '..');
const ex = (m: string) => path.join(ROOT, 'przyklady', m);
const OLD = ['--acs', ex('ACSDC'), '--acs', ex('ACSSC'), '--acs', ex('ACSMC'), '--acs', ex('ACSSG')];
const ENV = ['--var', 'UNIT=3390', '--today', '2026-11-16'];
let dir: string;
let csvFile: string;

async function run(argv: string[]) {
    let out = '';
    let err = '';
    const code = await main(argv, { out: t => void (out += t), err: t => void (err += t) });
    return { code, out, err };
}

const rows = (file: string) => fs.readFileSync(file, 'utf-8').trim().split('\n').map(l => l.split(';'));

before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-lang-'));
    csvFile = path.join(dir, 'PROBA.CSV');
    fs.writeFileSync(csvFile, sampleCsv(2000));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('acs-masks check', () => {
    it('przykladowe rutyny bez bledow; bledna rutyna -> kod 1', async () => {
        const ok = await run(['check', ex('ACSDC'), ex('ACSSC'), ex('ACSMC'), ex('ACSSG'), ex('ACSSGN')]);
        assert.equal(ok.code, 0, ok.out);
        assert.match(ok.err, /Bledow: 0, ostrzezen: 0/);
        const bad = path.join(dir, 'ZLA');
        fs.writeFileSync(bad, "PROC STORCLAS\nIF &HLK = 'A' THEN SET &STORCLAS = 'X'\nEND\n");
        const r = await run(['check', bad]);
        assert.equal(r.code, 1);
        assert.match(r.out, /ZLA:2:4 error ACS201 nieznana zmienna albo FILTLIST &HLK/);
    });

    it('przyklady: linie <= 71, znaki bezpieczne dla z/OS', () => {
        for (const m of fs.readdirSync(path.join(ROOT, 'przyklady'))) {
            for (const l of fs.readFileSync(ex(m), 'utf-8').split('\n')) {
                assert.ok(l.length <= 71 && !/[^\x20-\x7e]|[[\]\\!~`]/.test(l), `${m}: ${l}`);
            }
        }
    });
});

describe('acs-masks repr', () => {
    it('grupy wg warunkow: kazdy zbior w jednej grupie, lista dla joba ACMRSEL', async () => {
        const out = path.join(dir, 'r1');
        const r = await run(['repr', csvFile, ...OLD, '--new', ex('ACSSGN'), ...ENV, '-o', out]);
        assert.equal(r.code, 0, r.err);
        assert.match(r.out, /Rutyna SG\* STORGRP/);
        assert.match(r.out, /&UNIT = '3390'/);
        assert.match(r.out, /&DSN = &ARCH\s+SG\*:8/);
        const groups = rows(path.join(out, 'grupy.csv'));
        const members = rows(path.join(out, 'zbiory.csv')).slice(1);
        const total = groups.slice(1).reduce((s, g) => s + Number(g[1]), 0);
        assert.equal(total, members.length);
        assert.ok(members.every(m => Number(m[1]) >= 1));
        // archiwa GDS: wlasna grupa dzieki warunkowi z nowej rutyny; wynik starej i nowej rutyny rozny
        const h = groups[0];
        const arch = groups.find(g => /\.ARCH\.G\d{4}V00$/.test(g[2]))!;
        assert.equal(arch[h.indexOf('sg')], 'SGBIG1,SGBIG2');
        assert.equal(arch[h.indexOf('sg_nowa')], 'SGARCH');
        const list = fs.readFileSync(path.join(out, 'zos/ACMRLST'), 'utf-8').trimEnd().split('\n');
        assert.equal(list.length, groups.length - 1);
        for (const l of list) {
            assert.match(l, /^[A-Z0-9#@$.]{1,44} +[A-Z0-9]{6} G\d{6}$/);
            assert.equal(l.length, 59);
            assert.equal(l.slice(45, 51).trim().length, 6);
        }
        // grupa tylko z VSAM: rekord D to komponent
        const vs = groups.find(g => g[h.indexOf('vsam')] === 'T')!;
        assert.match(vs[h.indexOf('rekord_d')], /\.(DATA|INDEX)$/);
        assert.ok(list.some(l => l.startsWith(vs[h.indexOf('rekord_d')] + ' ')));
    });

    it('zbiory z tej samej grupy maja ten sam wynik emulacji (stare i nowe rutyny)', async () => {
        const out = path.join(dir, 'r2');
        const all = [...OLD, '--new', ex('ACSSGN'), ...ENV, '-o', out];
        assert.equal((await run(['repr', csvFile, ...all, '--trace'])).code, 0);
        const traceGroups = new Map(rows(path.join(out, 'zbiory.csv')).slice(1).map(m => [m[0], m[1]]));
        assert.equal((await run(['sim', csvFile, ...all])).code, 0);
        const sim = rows(path.join(out, 'symulacja.csv')).slice(1);
        const byGroup = new Map<string, string>();
        for (const s of sim) {
            const res = s.slice(5, 15).join(';');
            const g = traceGroups.get(s[0])!;
            if (!byGroup.has(g)) byGroup.set(g, res);
            assert.equal(byGroup.get(g), res, `grupa ${g}: ${s[0]}`);
        }
        assert.ok(byGroup.size >= 5);
    });

    it('opcje: --granularity entry, --by-classes, --dry-run, bledy', async () => {
        const e = await run(['repr', csvFile, ...OLD, ...ENV, '--granularity', 'entry', '--dry-run']);
        assert.equal(e.code, 0, e.err);
        assert.match(e.out, /&DSN = USER%%\.ISPF\.\*\s+SC:16 &NONSMS/);
        assert.ok(!fs.existsSync(path.join(dir, 'brak')));
        assert.equal((await run(['repr', csvFile])).code, 1);
        assert.equal((await run(['repr', csvFile, ...OLD, '--var', 'NIEMA=1'])).code, 1);
        assert.equal((await run(['repr', csvFile, '--acs', ex('ACSSG'), '--acs', ex('ACSSGN')])).code, 1);
        assert.equal((await run(['repr', csvFile, '--acs', path.join(dir, 'niema')])).code, 1);
    });
});

describe('acs-masks sim', () => {
    it('regresja: nowa rutyna SG zmienia tylko archiwa', async () => {
        const out = path.join(dir, 's1');
        const r = await run(['sim', csvFile, ...OLD, '--new', ex('ACSSGN'), ...ENV, '-o', out]);
        assert.equal(r.code, 0, r.err);
        const diff = rows(path.join(out, 'roznice.csv'));
        assert.ok(diff.length > 10);
        const h = diff[0];
        for (const d of diff.slice(1)) {
            assert.match(d[0], /^PROD\.[A-Z]+\.ARCH\.G\d{4}V00$/);
            assert.equal(d[h.indexOf('zmiana')], 'SG');
            assert.equal(d[h.indexOf('sg_nowa')], 'SGARCH');
        }
        assert.match(r.out, /Zbiorow ze zmienionym wynikiem: \d+ z/);
        // zbiory poza SMS wg rutyny SC: MC i SG puste
        const sim = rows(path.join(out, 'symulacja.csv'));
        const sys = sim.find(s => s[0].startsWith('SYS1.'))!;
        assert.deepEqual(sys.slice(6, 10), ['', '', '', '']);
    });

    it('srodowisko z pliku: UNIT spoza listy -> wszystko poza SMS', async () => {
        const env = path.join(dir, 'env.json');
        fs.writeFileSync(env, JSON.stringify({ vars: { UNIT: 'TAPE' }, volumes: 'none' }));
        const r = await run(['sim', csvFile, ...OLD, '--env', env, '--dry-run']);
        assert.equal(r.code, 0, r.err);
        assert.match(r.out, /SC: zgodnych 0 z/);
        fs.writeFileSync(env, JSON.stringify({ zle: 1 }));
        assert.equal((await run(['sim', csvFile, ...OLD, '--env', env])).code, 1);
    });
});
