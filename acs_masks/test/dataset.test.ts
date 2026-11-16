import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildDataSets, CsvError, dsorgName, parseCsv, pdDate, recfmName } from '../src/dataset';
import { csv, dline, HEADER, kbForTrk } from './helpers';

const TODAY = new Date('2026-11-16T00:00:00Z');

describe('CSV z ACMCSV', () => {
    it('dekodowanie pol', () => {
        assert.equal(dsorgName('4000'), 'PS');
        assert.equal(dsorgName('0200'), 'PO');
        assert.equal(dsorgName('0008'), 'VS');
        assert.equal(recfmName(0x90), 'FB');
        assert.equal(recfmName(0x54), 'VBA');
        assert.equal(recfmName(0x58), 'VBS');
        assert.equal(recfmName(0xc0), 'U');
        assert.equal(pdDate('2024100F'), '2024100');
        assert.equal(pdDate('0000000F'), null);
        assert.equal(pdDate('00000000'), null);
    });

    it('sciezki jak DCRPTOVR: alokacja ROUND, uzycie w gore', () => {
        const p = parseCsv(csv([dline({ dsn: 'A.B', allkb: kbForTrk(315), usekb: 55 })]));
        const [ds] = buildDataSets(p, { vsamCluster: true, today: TODAY });
        assert.equal(ds.allocTrk, 315);
        assert.equal(ds.usedTrk, 1);
        assert.equal(ds.freeTrk, 314);
    });

    it('63-bit, gdy flaga DCDALLFX/DCDUSEFX; brak flag -> 0', () => {
        const p = parseCsv(csv([
            dline({ dsn: 'A.X', f5: 'C0', allkb: 1, usekb: 1, allx: 5000000, usex: 100 }),
            dline({ dsn: 'A.Y', f2: '00', allkb: 999, usekb: 999 }),
        ]));
        const [x, y] = buildDataSets(p, { vsamCluster: true, today: TODAY });
        assert.equal(x.allocKb, 5000000);
        assert.equal(x.usedKb, 100);
        assert.equal(y.allocKb, 0);
        assert.equal(y.usedKb, 0);
    });

    it('zbior wielowolumenowy: suma przestrzeni, atrybuty z pierwszego wolumenu', () => {
        const p = parseCsv(csv([
            dline({ dsn: 'M.V', vol: 'VOL002', volsq: 2, allkb: 1000, usekb: 10, sc: 'SC2' }),
            dline({ dsn: 'M.V', vol: 'VOL001', volsq: 1, allkb: 2000, usekb: 20, sc: 'SC1' }),
        ]));
        const [ds] = buildDataSets(p, { vsamCluster: true, today: TODAY });
        assert.equal(ds.allocKb, 3000);
        assert.equal(ds.vols, 2);
        assert.equal(ds.vol, 'VOL001');
        assert.equal(ds.sc, 'SC1');
    });

    it('VSAM: komponenty pod nazwa klastra (rekordy A)', () => {
        const text = csv([
            dline({ dsn: 'K.CL.DATA', dsorg: '0008', allkb: 100 }),
            dline({ dsn: 'K.CL.INDEX', dsorg: '0008', allkb: 10 }),
            'A;K.CL.DATA;K.CL;82',
            'A;K.CL.INDEX;K.CL;81',
        ]);
        const cl = buildDataSets(parseCsv(text), { vsamCluster: true, today: TODAY });
        assert.equal(cl.length, 1);
        assert.equal(cl[0].dsn, 'K.CL');
        assert.equal(cl[0].allocKb, 110);
        assert.deepEqual(cl[0].components, ['K.CL.DATA', 'K.CL.INDEX']);
        const comp = buildDataSets(parseCsv(text), { vsamCluster: false, today: TODAY });
        assert.deepEqual(comp.map(d => d.dsn), ['K.CL.DATA', 'K.CL.INDEX']);
    });

    it('flagi i dni', () => {
        const p = parseCsv(csv([dline({ dsn: 'T.X', f1: '78', f3: '40', cre: '2026310F', lst: '2026315F' })]));
        const [ds] = buildDataSets(p, { vsamCluster: true, today: TODAY });
        assert.deepEqual([ds.sms, ds.temp, ds.pdse, ds.gds, ds.ef], [true, true, true, true, true]);
        assert.equal(ds.ageDays, 10);
        assert.equal(ds.unrefDays, 5);
    });

    it('spacje i CRLF z transferu, pusta klasa', () => {
        const text = `${HEADER}\r\n${dline({ dsn: 'A.B', sc: '' })}   \r\n`;
        const [ds] = buildDataSets(parseCsv(text), { vsamCluster: true, today: TODAY });
        assert.equal(ds.sc, '');
        assert.equal(ds.dsn, 'A.B');
    });

    it('bledy: inny naglowek, brak kolumn, nieznany typ', () => {
        assert.throws(() => parseCsv('T;DSN;X\n'), CsvError);
        assert.throws(() => parseCsv(`${HEADER}\nD;A.B;VOL\n`), CsvError);
        assert.throws(() => parseCsv(`${HEADER}\nX;A\n`), CsvError);
        assert.throws(() => parseCsv(`${dline({ dsn: 'A.B' })}\n`), /naglowka/);
    });
});
