import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { filtlistMap } from 'acs-routines/lang/check';
import { buildDataSets, DataSet, parseCsv } from '../src/dataset';
import { extractAtoms } from '../src/lang/atoms';
import { DEFAULT_ENV, envBase, makeEnv } from '../src/lang/env';
import { evalExpr } from '../src/lang/eval';
import { runRoutine, simulate } from '../src/lang/interp';
import { Loaded, loadSource, RoutineSet, SHORT } from '../src/lang/load';
import { csv, dline, DOpts, kbForTrk } from './helpers';

const TODAY = new Date('2026-11-16T00:00:00Z');

function ds(o: DOpts, extra: string[] = []): DataSet {
    return buildDataSets(parseCsv(csv([dline(o), ...extra])), { vsamCluster: true, today: TODAY })[0];
}

function load(src: string): Loaded {
    const l = loadSource('test', src);
    const errors = l.diagnostics.filter(d => d.severity === 'error');
    assert.deepEqual(errors.map(d => `${d.code} ${d.message}`), []);
    assert.ok(l.routine);
    return { ...l, routine: l.routine, label: SHORT[l.routine] };
}

const base = (vars: Record<string, string> = {}, o: Partial<typeof DEFAULT_ENV> = {}) =>
    envBase({ ...DEFAULT_ENV, ...o, vars, today: TODAY });

/** Wartosc warunku IF w rutynie "PROC STORCLAS IF <cond> THEN SET ... END". */
function cond(text: string, d: DataSet, vars: Record<string, string> = {}, pre = ''): boolean {
    const l = load(`PROC STORCLAS\n${pre}\nIF ${text} THEN SET &STORCLAS = 'X'\nEND`);
    const s = l.program.body.find(x => x.kind === 'if');
    assert.ok(s && s.kind === 'if');
    return evalExpr(s.cond, makeEnv(d, base(vars)), l.lists);
}

describe('ocena warunkow', () => {
    const d = ds({ dsn: 'PROD.PAY.DATA.LOAD', allkb: 2048, usekb: 10 });

    it('nazwa, kwalifikatory, indeks, liczby', () => {
        assert.ok(cond('&DSN = PROD.**.LOAD', d) && cond("&HLQ = 'PROD'", d) && cond("&LLQ ^= 'LIST'", d));
        assert.ok(cond("&DSN(2) = 'PAY'", d) && cond('&DSN(&NQUAL) = LO*', d) && cond("&DSN(7) = ''", d));
        assert.ok(cond('&NQUAL = 4', d) && cond('&NQUAL GT 3', d) && !cond('&NQUAL NG 3', d));
        assert.ok(cond('&SIZE = 2MB', d) && cond('&SIZE >= 2048KB', d) && !cond('&SIZE > 2MB', d));
        assert.ok(cond("&DSN = 'PROD.PAY.DATA.LOAD'", d) && !cond("&DSN = 'PROD.**'", d));
        assert.ok(cond("'PROD' = &HLQ", d) && cond('3 < &NQUAL', d));
    });

    it('porzadek znakow jak w dokumentacji (&HLQ > M)', () => {
        assert.ok(cond("&HLQ > 'M'", d) && !cond("&HLQ > 'Q'", d) && cond("&HLQ < '1'", d));
    });

    it('AND / OR od lewej do prawej', () => {
        // (falsz OR prawda) AND falsz = falsz; z priorytetem AND byloby: falsz OR (prawda AND falsz) = falsz
        // prawda OR falsz AND falsz: od lewej = falsz, z priorytetem AND = prawda
        assert.equal(cond("&HLQ = 'PROD' OR &LLQ = 'X' AND &NQUAL = 9", d), false);
        assert.equal(cond("&HLQ = 'PROD' OR (&LLQ = 'X' AND &NQUAL = 9)", d), true);
    });

    it('FILTLIST: EXCLUDE ma pierwszenstwo', () => {
        const pre = "FILTLIST L INCLUDE(PROD.**,'TEST.A') EXCLUDE(**.LIST,'PROD.X')";
        assert.ok(cond('&DSN = &L', d, {}, pre));
        assert.ok(cond('&DSN ^= &L', ds({ dsn: 'PROD.A.LIST' }), {}, pre));
        assert.ok(cond('&DSN = &L', ds({ dsn: 'TEST.A' }), {}, pre) && !cond('&DSN = &L', ds({ dsn: 'PROD.X' }), {}, pre));
    });

    it('&ANYVOL / &ALLVOL (przyklad z dokumentacji)', () => {
        const mv = ds({ dsn: 'A.B', vol: 'IMS101', volsq: 1 }, [dline({ dsn: 'A.B', vol: 'IMS102', volsq: 2 }), dline({ dsn: 'A.B', vol: 'TSO191', volsq: 3 })]);
        assert.deepEqual(mv.volsers, ['IMS101', 'IMS102', 'TSO191']);
        assert.equal(cond('&ALLVOL = IMS*', mv), false);
        assert.equal(cond('&ANYVOL = TSO*', mv), true);
        assert.equal(cond('&ANYVOL ^= TSO*', mv), true);
        assert.equal(cond('&ALLVOL ^= DB2*', mv), true);
        assert.equal(cond('&NVOL = 3', mv), true);
    });

    it('atrybuty: DSORG, DSTYPE, DSNTYPE, RECORG, EXPDT; GDS bez numeru generacji', () => {
        const g = ds({ dsn: 'PROD.PAY.ARCH.G0012V00', f1: '48' });
        assert.ok(cond("&DSTYPE = 'GDS'", g) && cond("&DSN = 'PROD.PAY.ARCH'", g) && cond("&LLQ = 'ARCH'", g) && cond('&NQUAL = 3', g));
        const po = ds({ dsn: 'A.B', dsorg: '0200', f1: '50' });
        assert.ok(cond("&DSORG = 'PO'", po) && cond("&DSNTYPE = 'LIBRARY'", po) && cond("&DSTYPE = 'PERM'", po));
        const k = buildDataSets(parseCsv(csv([dline({ dsn: 'A.K.DATA', dsorg: '0008' }), 'A;A.K.DATA;A.K;82'])), { vsamCluster: true, today: TODAY })[0];
        assert.ok(cond("&DSORG = 'VS' AND &RECORG = 'KS' AND &DSN = 'A.K'", k));
        assert.equal(k.recDsn, 'A.K.DATA');
        const e = ds({ dsn: 'A.B', exp: '2026330F' });
        assert.ok(cond("&EXPDT = '2026330'", e) && cond('&RETPD = 10', e));
    });

    it('zmienne spoza DCOLLECT: stale z opcji vars', () => {
        assert.ok(cond("&UNIT = ''", d) && cond("&ACSENVIR = 'ALLOC'", d));
        assert.ok(cond('&UNIT = 3390', d, { UNIT: '3390' }) && cond('&JOB = JOB*', d, { JOB: '@createJob' }));
        assert.throws(() => base({ NIEMA: 'X' }), /nieznana zmienna/);
    });
});

describe('interpreter', () => {
    const SC = load(`PROC STORCLAS
FILTLIST NONSMS INCLUDE(SYS1.**)
IF &DSN = &NONSMS THEN DO SET &STORCLAS = '' EXIT END
IF &HLQ = 'BAD' THEN EXIT CODE(22)
SELECT
  WHEN (&SIZE >= 100MB) SET &STORCLAS = 'SCBIG'
  OTHERWISE SET &STORCLAS = 'SCSTD'
END
END`);
    const MC = load("PROC MGMTCLAS\nIF &STORCLAS = 'SCBIG' THEN SET &MGMTCLAS = 'MCBIG' ELSE SET &MGMTCLAS = 'MCSTD'\nEND");
    const SG = load("PROC STORGRP\nSELECT (&STORCLAS)\n WHEN ('SCBIG') SET &STORGRP = 'SG1','SG2'\n OTHERWISE SET &STORGRP = 'SG0'\nEND\nEND");
    const set: RoutineSet = { STORCLAS: SC, MGMTCLAS: MC, STORGRP: SG };
    const sim = (d: DataSet) => simulate(set, makeEnv(d, base()), { initial: 'null' });

    it('lancuch SC -> MC -> SG, wynik SC jako wejscie', () => {
        const r = sim(ds({ dsn: 'PROD.A', allkb: 200 * 1024, sc: 'STARA' }));
        assert.deepEqual([r.dc, r.sc, r.mc, r.sg, r.fail], ['DCSTD', 'SCBIG', 'MCBIG', 'SG1,SG2', '']);
        assert.equal(r.path, 'SC[0F 1F 2:0] MC[0T] SG[0:0]');
        const s = sim(ds({ dsn: 'PROD.A', allkb: 100 }));
        assert.deepEqual([s.sc, s.mc, s.sg], ['SCSTD', 'MCSTD', 'SG0']);
    });

    it('pusta klasa pamieci: MC i SG nie sa wywolywane', () => {
        const r = sim(ds({ dsn: 'SYS1.LINKLIB' }));
        assert.deepEqual([r.sc, r.mc, r.sg, r.fail], ['', '', '', '']);
        assert.equal(r.path, 'SC[0T X0]');
    });

    it('EXIT CODE > 0: alokacja odrzucona, dalsze rutyny pominiete', () => {
        const r = sim(ds({ dsn: 'BAD.A', sc: 'SCX' }));
        assert.equal(r.fail, 'SC:22');
        assert.equal(r.path, 'SC[0F 1T X22]');
    });

    it('rutyna niepodana: obecna klasa z DCOLLECT; wartosc poczatkowa', () => {
        const only = simulate({ STORGRP: SG }, makeEnv(ds({ dsn: 'A.B', sc: 'SCBIG' }), base()), { initial: 'null' });
        assert.deepEqual([only.sc, only.sg], ['SCBIG', 'SG1,SG2']);
        const none = simulate({ STORGRP: SG }, makeEnv(ds({ dsn: 'A.B', sc: '', f1: '00' }), base()), { initial: 'null' });
        assert.deepEqual([none.sc, none.sg, none.path], ['', '', '']);
        const keep = load("PROC STORCLAS\nIF &STORCLAS = '' THEN SET &STORCLAS = 'NOWA'\nEND");
        const d = ds({ dsn: 'A.B', sc: 'RECZNA' });
        assert.equal(simulate({ STORCLAS: keep }, makeEnv(d, base()), { initial: 'null' }).sc, 'NOWA');
        assert.equal(simulate({ STORCLAS: keep }, makeEnv(d, base()), { initial: 'dcollect' }).sc, 'RECZNA');
    });

    it('WRITE z podstawieniem zmiennych', () => {
        const w = load("PROC STORCLAS\nWRITE 'HLQ=' &HLQ ' N=' &NQUAL\nSET &STORCLAS = 'A'\nEND");
        assert.deepEqual(runRoutine(w, makeEnv(ds({ dsn: 'X.Y' }), base()), true).writes, ['HLQ=X N=2']);
    });
});

describe('warunki elementarne (atomy)', () => {
    const A = load(`PROC STORCLAS
FILTLIST L INCLUDE(PROD.**,TEST.**) EXCLUDE(**.TMP)
IF &DSN = &L THEN SET &STORCLAS = 'A'
IF &DSN ^= &L THEN SET &STORCLAS = 'B'
IF &NQUAL >= 3 AND &NQUAL < 3 THEN EXIT
IF 'X' = &HLQ THEN EXIT
END`);

    it('postac kanoniczna: NE i GE nie tworza nowych atomow', () => {
        const atoms = extractAtoms([A], 'list');
        assert.deepEqual(atoms.map(a => a.text), ['&DSN = &L', '&NQUAL < 3', "&HLQ = 'X'"]);
        assert.deepEqual(atoms[0].where, ['SC:3', 'SC:4']);
        const env = makeEnv(ds({ dsn: 'PROD.A.B' }), base());
        assert.deepEqual(atoms.map(a => a.test(env)), [true, false, false]);
    });

    it('ziarnistosc entry: atom na pozycje listy', () => {
        const atoms = extractAtoms([A], 'entry');
        assert.deepEqual(atoms.map(a => a.text).slice(0, 3), ['&DSN = PROD.**', '&DSN = TEST.**', '&DSN = **.TMP']);
    });

    it('ta sama nazwa FILTLIST z inna zawartoscia = inny atom', () => {
        const B = { ...load("PROC STORCLAS\nFILTLIST L INCLUDE(PROD.**)\nIF &DSN = &L THEN SET &STORCLAS = 'A'\nEND"), label: 'SC*' };
        const atoms = extractAtoms([A, B], 'list');
        assert.equal(atoms.filter(a => a.text === '&DSN = &L').length, 2);
        assert.equal(filtlistMap(B.program).get('L')?.include.length, 1);
    });
});
