import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildDataSets, DataSet, parseCsv } from '../src/dataset';
import { allCmps } from '../src/lang/ast';
import { extractAtoms } from '../src/lang/atoms';
import { check, filtlistMap } from '../src/lang/check';
import { DEFAULT_ENV, envBase, makeEnv } from '../src/lang/env';
import { evalExpr } from '../src/lang/eval';
import { runRoutine, simulate } from '../src/lang/interp';
import { lex } from '../src/lang/lexer';
import { Loaded, loadSource, RoutineSet, SHORT } from '../src/lang/load';
import { compareChar, dsnMatch, maskProblem, simpleMatch } from '../src/lang/match';
import { parse } from '../src/lang/parser';
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

const codes = (src: string) => {
    const p = parse(src);
    return check(p, src).map(d => d.code);
};

// rutyna z dokumentacji IBM (Figure 59, "Production ACS Routine for Storage Class")
const IBM_SAMPLE = `PROC STORCLAS

/**********************************************************/
/* THIS IS THE PRODUCTION SELECTION SPECIFICATION         */
/**********************************************************/

FILTLIST DBVOLS INCLUDE(IMS*,DB2*)            /* ALL DATABASE VOLUMES */
                EXCLUDE('IMS053','DB2007')

FILTLIST DBJOBS INCLUDE(IMS*,PROD*,ACCT*)     /* ALL DATA BASE JOBS */

FILTLIST VALID_UNITS
  INCLUDE('3330','3340','3350','3375','3380','3390','SYSDA','')

IF &UNIT ^= &VALID_UNITS

   THEN DO
          SET &STORCLAS = ''
          WRITE 'INVALID UNIT TYPE FOR SMS ALLOCATION'
          EXIT
        END

SELECT

  WHEN (&DSN = SYS1.**)                            /* SYSTEM DATA */
       SET &STORCLAS = 'SYSTEM'

  WHEN ((&ALLVOL = &DBVOLS) && (&JOB = &DBJOBS))   /* DATABASE DATA */
       SET &STORCLAS = 'DBPOOL'

  WHEN ((&DSN(3) = 'CLEAR') | (&ANYVOL ^= TSO*))   /* NON-SMS DATA */
       SET &STORCLAS = ''

  WHEN (&DEF_STORCLAS ^= '')                       /* IF DEFAULTS EXIST */
       SET &STORCLAS = &DEF_STORCLAS;

  OTHERWISE SET &STORCLAS = 'COMMON'               /* ALL OTHER DATA */

END                                                /* END STORCLAS PROC */
END
`;

describe('lekser', () => {
    it('operatory, zmienne, liczby z jednostka, maski', () => {
        const t = lex("IF &SIZE >= 10 MB && &HLQ ¬= SYS* | &A ^> 5KB").tokens.map(x => `${x.kind}:${x.value}${x.unit ?? ''}`);
        assert.deepEqual(t, ['word:IF', 'var:SIZE', 'op:GE', 'number:10MB', 'op:AND', 'var:HLQ', 'op:NE', 'word:SYS*',
            'op:OR', 'var:A', 'op:LE', 'number:5KB', 'eof:']);
    });

    it('literal: podwojny apostrof, kontynuacja + i -', () => {
        assert.equal(lex("'PAYROLL''SDATA'").tokens[0].value, "PAYROLL'SDATA");
        assert.equal(lex("'ABC+\n     DEF'").tokens[0].value, 'ABCDEF');
        assert.equal(lex("'ABC-\n  DEF'").tokens[0].value, 'ABC  DEF');
        const bad = lex("WRITE 'ABC\nEND");
        assert.equal(bad.diagnostics[0].code, 'ACS003');
        assert.equal(bad.tokens[bad.tokens.length - 2].value, 'END');
    });

    it('znak kontynuacji poza literalem jest pomijany; komentarze', () => {
        const r = lex("SET &STORCLAS = -\n 'A' /* kom\n entarz */ +\n");
        assert.deepEqual(r.diagnostics, []);
        assert.deepEqual(r.tokens.map(x => x.kind), ['word', 'var', 'op', 'literal', 'eof']);
        assert.equal(r.comments.length, 1);
        assert.equal(lex('/* bez konca').diagnostics[0].code, 'ACS002');
    });

    it('numery sekwencyjne w kol. 73-80 sa pomijane', () => {
        const line = (s: string, n: number) => s.padEnd(72) + String(n).padStart(8, '0');
        const src = [line('PROC STORCLAS', 100), line("SET &STORCLAS = 'A'", 200), line('END', 300)].join('\n');
        const p = parse(src);
        assert.equal(p.sequenceNumbers, true);
        assert.deepEqual(p.diagnostics, []);
    });

    it('pozycje: linia i kolumna od 0', () => {
        const t = lex("PROC STORCLAS\n  SET &STORCLAS = 'A'").tokens;
        assert.deepEqual(t[3].range.start, { line: 1, col: 6, offset: 20 });
    });
});

describe('parser', () => {
    it('rutyna z dokumentacji IBM - bez bledow', () => {
        const p = parse(IBM_SAMPLE);
        assert.deepEqual(check(p, IBM_SAMPLE).filter(d => d.severity === 'error').map(d => `${d.range.start.line + 1} ${d.code} ${d.message}`), []);
        assert.equal(p.routine, 'STORCLAS');
        assert.deepEqual(p.filtlists.map(f => [f.name, f.include.length, f.exclude.length]),
            [['DBVOLS', 2, 2], ['DBJOBS', 3, 0], ['VALID_UNITS', 8, 0]]);
        assert.equal(allCmps(p).length, 7);
        const sel = p.body.find(s => s.kind === 'select');
        assert.ok(sel && sel.kind === 'select');
        assert.equal(sel.whens.length, 4);
        assert.equal(sel.otherwise?.length, 1);
    });

    it('PROC z liczba i ampersandem; SELECT (zmienna)', () => {
        const p = parse("PROC 1 &MGMTCLAS\nSELECT (&DSTYPE)\n WHEN ('GDS') SET &MGMTCLAS = 'A'\n WHEN ('TEMP')\n OTHERWISE SET &MGMTCLAS = 'B'\nEND\nEND");
        assert.deepEqual(p.diagnostics, []);
        assert.equal(p.routine, 'MGMTCLAS');
        const sel = p.body[0];
        assert.ok(sel.kind === 'select');
        assert.equal(sel.subject?.name, 'DSTYPE');
        assert.equal(sel.whens[1].body.length, 0);
    });

    it('AND / OR bez nawiasow: drzewo lewostronne (ACS liczy od lewej)', () => {
        const p = parse("PROC STORCLAS\nIF &HLQ = 'A' OR &HLQ = 'B' AND &LLQ = 'C' THEN EXIT\nEND");
        const s = p.body[0];
        assert.ok(s.kind === 'if' && s.cond?.kind === 'bool');
        assert.equal(s.cond.op, 'AND');
        assert.ok(s.cond.left.kind === 'bool' && s.cond.left.op === 'OR');
        assert.ok(codes("PROC STORCLAS\nIF &HLQ = 'A' OR &HLQ = 'B' AND &LLQ = 'C' THEN EXIT\nEND").includes('ACS240'));
        assert.ok(!codes("PROC STORCLAS\nIF (&HLQ = 'A' OR &HLQ = 'B') AND &LLQ = 'C' THEN EXIT\nEND").includes('ACS240'));
    });

    it('bledy skladni nie przerywaja analizy', () => {
        const src = "PROC STORCLAS\nIF &HLQ 'A' THEN SET &STORCLAS = 'X'\nSET &STORCLAS 'Y'\nFILTLIST L INCLUDE(A*,\nSELECT\nWHEN (&HLQ = 'B') SET &STORCLAS = 'Z'\nEND\nEND";
        const p = parse(src);
        const c = p.diagnostics.map(d => d.code);
        assert.ok(c.includes('ACS104') && c.includes('ACS122') && c.includes('ACS105'), c.join());
        assert.ok(p.body.some(s => s.kind === 'select'));
        assert.equal(p.filtlists.length, 1);
    });

    it('brak PROC, brak END, nadmiarowy END, WHEN bez SELECT', () => {
        assert.ok(parse("SET &STORCLAS = 'A'\nEND").diagnostics.some(d => d.code === 'ACS129'));
        assert.ok(parse("PROC STORCLAS\nDO\nSET &STORCLAS = 'A'\nEND").diagnostics.some(d => d.code === 'ACS131'));
        assert.ok(parse("PROC STORCLAS\nEND\nEND").diagnostics.some(d => d.code === 'ACS130'));
        assert.ok(parse("PROC STORCLAS\nWHEN (&HLQ = 'A') EXIT\nEND").diagnostics.some(d => d.code === 'ACS126'));
        assert.deepEqual(parse('').diagnostics, []);
    });

    it('kilka instrukcji po WHEN - ostrzezenie, obie w akcji', () => {
        const p = parse("PROC STORCLAS\nSELECT\nWHEN (&HLQ = 'A')\n WRITE 'X'\n SET &STORCLAS = 'A'\nEND\nEND");
        const d = p.diagnostics.find(x => x.code === 'ACS113');
        assert.equal(d?.severity, 'warning');
        const s = p.body[0];
        assert.ok(s.kind === 'select');
        assert.equal(s.whens[0].body.length, 2);
    });
});

describe('kontrola semantyczna', () => {
    const one = (body: string, routine = 'STORCLAS') => codes(`PROC ${routine}\n${body}\nEND`);

    it('zmienne i FILTLIST', () => {
        assert.ok(one("IF &HLK = 'A' THEN EXIT").includes('ACS201'));
        assert.ok(one("IF &HLQ = &L THEN EXIT\nFILTLIST L INCLUDE(A*)").includes('ACS202'));
        assert.ok(one('FILTLIST L INCLUDE(A*)\nFILTLIST L INCLUDE(B*)').includes('ACS203'));
        assert.ok(one('FILTLIST HLQ INCLUDE(A*)').includes('ACS204'));
        assert.ok(one('FILTLIST L INCLUDE(A*)').includes('ACS207'));
        assert.ok(one(`FILTLIST L INCLUDE(${Array.from({ length: 256 }, (_, i) => `A${i}`).join(',')})\nIF &HLQ = &L THEN EXIT`).includes('ACS206'));
        assert.ok(one('FILTLIST L INCLUDE(A.B**.C)\nIF &DSN = &L THEN EXIT').includes('ACS208'));
    });

    it('SET', () => {
        assert.ok(one("SET &DATACLAS = 'A'").includes('ACS210'));
        assert.ok(one("SET &HLQ = 'A'").includes('ACS210'));
        assert.ok(one("SET &STORCLAS = 'A','B'").includes('ACS211'));
        assert.ok(one("SET &STORCLAS = &PGM").includes('ACS211'));
        assert.ok(one("SET &STORCLAS = '1ABC'").includes('ACS211'));
        assert.ok(one("SET &STORGRP = ''", 'STORGRP').includes('ACS211'));
        assert.deepEqual(one("SET &STORCLAS = &DEF_STORCLAS"), []);
        assert.deepEqual(one("SET &STORGRP = 'A','B'", 'STORGRP'), []);
        assert.ok(one('EXIT').includes('ACS261'));
    });

    it('porownania: typy, jednostki, maski, wartosci', () => {
        assert.ok(one("IF 'A' = 'B' THEN EXIT").includes('ACS220'));
        assert.ok(one("IF &NQUAL = 'A' THEN EXIT").includes('ACS221'));
        assert.ok(one('IF &SIZE > 100 THEN EXIT').includes('ACS222'));
        assert.ok(one('IF &NQUAL > 100KB THEN EXIT').includes('ACS221'));
        assert.ok(one('IF &HLQ > SYS* THEN EXIT').includes('ACS223'));
        assert.ok(one('IF &DSORG = P* THEN EXIT').includes('ACS224'));
        assert.ok(one('FILTLIST L INCLUDE(A)\nIF &NQUAL = &L THEN EXIT').includes('ACS225'));
        assert.ok(one("IF &HLQ = 'ABCDEFGHI' THEN EXIT").includes('ACS226'));
        assert.ok(one("IF &DSORG = 'XX' THEN EXIT").includes('ACS227'));
        assert.ok(one('IF &HLQ(2) = A THEN EXIT').includes('ACS228'));
        assert.ok(one('IF &DSN(23) = A THEN EXIT').includes('ACS228'));
        assert.ok(one("IF &JOB = 'A' THEN EXIT", 'STORGRP').includes('ACS229'));
        assert.ok(one("IF &STORGRP = 'A' THEN EXIT").includes('ACS230'));
        assert.deepEqual(one("IF &SIZE > 100MB AND &DSN(&NQUAL) = LOAD* AND\n 'PROD' = &HLQ AND &UNIT = 3390 THEN SET &STORCLAS = 'A'"), []);
    });

    it('zrodlo: dlugosc linii, wielkosc liter, kod po EXIT', () => {
        assert.ok(one(`/* ${'X'.repeat(90)} */`).includes('ACS250'));
        assert.ok(one("if &hlq = 'A' THEN EXIT").includes('ACS252'));
        assert.ok(one("EXIT\nSET &STORCLAS = 'A'").includes('ACS260'));
    });
});

describe('dopasowanie masek i porzadek znakow', () => {
    it('maski proste i nazw zbiorow (przyklady z dokumentacji)', () => {
        assert.ok(simpleMatch('TSO*', 'TSO') && simpleMatch('*XYZ*', 'AXYZ') && simpleMatch('IMS%%%', 'IMS123'));
        assert.ok(!simpleMatch('IMS%%%', 'IMS12') && simpleMatch('*%WK%%', 'AWK12') && !simpleMatch('*%WK%%', 'WK12'));
        const m = (mask: string, dsn: string) => dsnMatch(mask, dsn.split('.'));
        assert.ok(m('SYS1.**', 'SYS1') && m('SYS1.**', 'SYS1.A.B') && !m('SYS1.**', 'SYS2.A'));
        assert.ok(m('**.OUTLIST', 'OUTLIST') && m('**.OUTLIST', 'A.B.OUTLIST'));
        assert.ok(m('*.*.PAYROLL.*.SALARY.*', 'A.B.PAYROLL.C.SALARY.D') && !m('*.*.PAYROLL.*.SALARY.*', 'A.B.PAYROLL.C.SALARY'));
        assert.ok(m('*.%%TEST.*.DATA', 'A.XYTEST.B.DATA') && !m('*.%%TEST.*.DATA', 'A.XTEST.B.DATA'));
        assert.ok(m('**.*ABC*.**', 'ABC') && m('**.*ABC*.**', 'X.YABCZ.W') && !m('**.*ABC*.**', 'X.AB.C'));
        assert.ok(m('LABMGR.**.DATA', 'LABMGR.DATA') && m('LABMGR.**.DATA', 'LABMGR.A.B.DATA'));
    });

    it('poprawnosc masek', () => {
        assert.equal(maskProblem('SYS1.**', true), null);
        assert.ok(maskProblem('A.B**', true) && maskProblem('A***', false) && maskProblem('A.ABCDEFGHI', true));
    });

    it('porzadek EBCDIC: litery przed cyframi, dopelnienie spacjami', () => {
        assert.ok(compareChar('Z', '0') < 0 && compareChar('A', 'B') < 0);
        assert.equal(compareChar('ABC', 'ABC   '), 0);
        assert.ok(compareChar('N', 'M') > 0);
    });
});

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
