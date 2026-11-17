import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { main } from '../src/cli';
import { buildTests, iebupdte, memberNames, TestCaseError, testLines } from '../src/testcase';
import { sampleCsv } from '../tools/gen-sample';

const ROOT = path.join(__dirname, '..');
const ex = (m: string) => path.join(ROOT, 'przyklady', m);

describe('testy ISMF - format membera', () => {
    it('jak member utworzony w ISMF: DESCRIPTION1, opis, DSN, ACSENVIR', () => {
        assert.deepEqual(testLines('maska.do.testu**', 'PRZYKLA.DOWA.NAZWA.ZBIORU'),
            ['DESCRIPTION1:', 'MASKA.DO.TESTU**', 'DSN: PRZYKLA.DOWA.NAZWA.ZBIORU', 'ACSENVIR: ALLOC']);
    });

    it('opis: do 72 znakow, bez polskich znakow, nie zaczyna sie od ./', () => {
        const l = testLines(`zażółć ${'x'.repeat(100)}`, 'A.B');
        assert.equal(l[1].length, 72);
        assert.ok(l[1].startsWith('ZAZOLC X'));
        assert.equal(testLines('./ ADD', 'A.B')[1], '. / ADD');
    });

    it('nazwy memberow: prefiks + numer do 8 znakow', () => {
        assert.deepEqual(memberNames('acm', 3), ['ACM00001', 'ACM00002', 'ACM00003']);
        assert.equal(memberNames('ABCD', 9999)[9998], 'ABCD9999');
        assert.throws(() => memberNames('ABCD', 10000), TestCaseError);
        assert.throws(() => memberNames('A1', 1), TestCaseError);
        assert.throws(() => memberNames('ABCDE', 1), TestCaseError);
    });

    it('wejscie IEBUPDTE', () => {
        const t = buildTests('T', [{ dsn: 'A.B', description: 'X' }, { dsn: 'C.D', description: 'Y' }]);
        assert.deepEqual(iebupdte(t), ['./ ADD NAME=T0000001', 'DESCRIPTION1:', 'X', 'DSN: A.B', 'ACSENVIR: ALLOC',
            './ ADD NAME=T0000002', 'DESCRIPTION1:', 'Y', 'DSN: C.D', 'ACSENVIR: ALLOC', './ ENDUP']);
    });
});

describe('acs-masks repr --tests', () => {
    let dir: string;
    let csvFile: string;
    before(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-tests-'));
        csvFile = path.join(dir, 'PROBA.CSV');
        fs.writeFileSync(csvFile, sampleCsv(2000));
    });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const run = async (argv: string[]) => {
        let out = '';
        let err = '';
        const code = await main(argv, { out: t => void (out += t), err: t => void (err += t) });
        return { code, out, err };
    };

    it('test na reprezentanta, ACMTEST = suma memberow, nazwa jak widzi ACS', async () => {
        const out = path.join(dir, 'o');
        const r = await run(['repr', csvFile, '--acs', ex('ACSDC'), '--acs', ex('ACSSC'), '--acs', ex('ACSMC'),
            '--acs', ex('ACSSG'), '--var', 'UNIT=3390', '--today', '2026-11-17', '--tests', '-o', out]);
        assert.equal(r.code, 0, r.err);
        const groups = fs.readFileSync(path.join(out, 'grupy.csv'), 'utf-8').trim().split('\n').slice(1);
        const tests = fs.readFileSync(path.join(out, 'testy.csv'), 'utf-8').trim().split('\n').slice(1).map(l => l.split(';'));
        assert.ok(tests.length > 0 && tests.length <= groups.length);
        const members = fs.readdirSync(path.join(out, 'zos/testy')).sort();
        assert.deepEqual(members, tests.map(t => t[0]));
        const upd = fs.readFileSync(path.join(out, 'zos/ACMTEST'), 'utf-8').trimEnd().split('\n');
        assert.equal(upd.filter(l => l.startsWith('./ ADD NAME=')).length, members.length);
        assert.equal(upd[upd.length - 1], './ ENDUP');
        for (const m of members) {
            const lines = fs.readFileSync(path.join(out, 'zos/testy', m), 'utf-8').trimEnd().split('\n');
            assert.equal(lines[0], 'DESCRIPTION1:');
            assert.match(lines[2], /^DSN: [A-Z0-9#@$.]{1,44}$/);
            assert.equal(lines[3], 'ACSENVIR: ALLOC');
            assert.ok(lines.every(l => l.length <= 72 && !/[^\x20-\x7e]/.test(l)));
        }
        // opis: tylko maski / kwalifikatory z rutyn, do ktorych pasuje DSN
        const descOf = (m: string) => fs.readFileSync(path.join(out, 'zos/testy', m), 'utf-8').split('\n')[1];
        const descs = members.map(descOf);
        assert.ok(descs.every(d => !/[&;=]/.test(d)), descs.join(' | '));
        const byDsn = new Map(tests.map(t => [t[3], descOf(t[0])]));
        assert.equal(byDsn.get([...byDsn.keys()].find(d => d.startsWith('SYS1.'))!), 'SYS1.**');
        assert.ok([...byDsn].some(([d, x]) => d.startsWith('USER') && x === 'USER%%.ISPF.*'));
        assert.ok([...byDsn].some(([d, x]) => d.startsWith('TEST.TMP.') && /^(WORK|SORTOUT|SYSOUT) TEST$/.test(x)));
        // GDS bez numeru generacji, VSAM jako klaster
        const dsns = tests.map(t => t[3]);
        assert.ok(!dsns.some(d => /\.G\d{4}V\d{2}$/.test(d)));
        assert.ok(!dsns.some(d => /\.(DATA|INDEX)$/.test(d) && d.includes('KSDS')));
        assert.ok(dsns.some(d => /KSDS\d\d$/.test(d)), 'grupa VSAM: test z nazwa klastra');
        assert.match(r.out, /--- Testy ISMF \(--tests\): \d+ \(ACM00001 - ACM\d{5}\)/);
        assert.match(r.out, /test nie zawiera \(w tescie puste\): .*&DSORG/);
        // brak warunku na nazwe -> BEZ MASKI
        const nm = path.join(dir, 'BEZNAZWY');
        fs.writeFileSync(nm, "PROC STORCLAS\nIF &DSORG = 'PO' THEN SET &STORCLAS = 'A'\nEND\n");
        const r3 = await run(['repr', csvFile, '--acs', nm, '--tests', '-o', path.join(dir, 'o3')]);
        assert.equal(r3.code, 0, r3.err);
        assert.equal(fs.readFileSync(path.join(dir, 'o3/zos/testy/ACM00001'), 'utf-8').split('\n')[1], 'BEZ MASKI');
        // bez --tests: brak plikow testow, kolejny przebieg czysci zos/testy tylko gdy sa nowe testy
        const r2 = await run(['repr', csvFile, '--acs', ex('ACSSC'), '--var', 'UNIT=3390', '-o', path.join(dir, 'bez')]);
        assert.equal(r2.code, 0, r2.err);
        assert.ok(!fs.existsSync(path.join(dir, 'bez', 'zos/ACMTEST')));
        assert.equal((await run(['repr', csvFile, '--acs', ex('ACSSC'), '--tests', '--test-prefix', 'X1', '--dry-run'])).code, 1);
    });
});
