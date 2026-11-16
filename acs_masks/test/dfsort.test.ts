/**
 * Karty ACMCARD: emulacja warunkow DFSORT na rekordzie ukladu DSX (jak NRM1) i porownanie z dopasowaniem
 * FILTLIST; zgodnosc LAYOUT z sym/ACMREPR.TXT i jcl/ACMREPR.jcl.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { CardError, CARD_MAX_COL, generateCards, generateSymbols, LAYOUT, maskConds, VecMask } from '../src/dfsort';
import { matches, parseMask } from '../src/mask';
import { rng } from './helpers';

const ROOT = path.join(__dirname, '..');

/** Rekord jak po INREC w NRM1 (przed kartami ACMCARD): NQ, Q01..Q22, Q99. */
function record(dsn: string): string {
    const q = dsn.split('.');
    const rec = Array<string>(LAYOUT.vec - 1).fill(' ');
    const put = (pos: number, s: string) => [...s].forEach((c, i) => (rec[pos - 1 + i] = c));
    put(LAYOUT.nq, String(q.length).padStart(2, '0'));
    q.forEach((x, i) => put(LAYOUT.q01 + i * 8, x.padEnd(8)));
    put(LAYOUT.q99, q[q.length - 1].padEnd(8));
    return rec.join('');
}

/** Warunek "p,m,CH,op,C'...'" albo "p,2,ZD,op,+n" na rekordzie. */
function evalCond(c: string, rec: string): boolean {
    const m = /^(\d+),(\d+),(CH|ZD),(EQ|NE|GE|GT|LT|LE),(?:C'(.*)'|\+(\d+))$/.exec(c);
    assert.ok(m, `nieznany warunek ${c}`);
    const p = Number(m[1]);
    const len = Number(m[2]);
    const field = rec.slice(p - 1, p - 1 + len);
    let d: number;
    if (m[3] === 'ZD') {
        d = Number(field) - Number(m[6]);
    } else {
        const k = m[5].padEnd(len, ' ');
        assert.equal(k.length, len, `stala dluzsza niz pole: ${c}`);
        d = field < k ? -1 : field > k ? 1 : 0;
    }
    return { EQ: d === 0, NE: d !== 0, GE: d >= 0, GT: d > 0, LT: d < 0, LE: d <= 0 }[m[4]]!;
}

const cardMatches = (mask: string, dsn: string) => maskConds(mask).every(c => evalCond(c, record(dsn)));

describe('ACMCARD - warunki = semantyka FILTLIST', () => {
    const masks = ['PROD.**', 'PROD.TMP.**', 'PROD.TMP', '*.**.LOG', 'PROD.**.LOG', 'PROD.D%%%%%%.**',
        'PROD.**.G%%%%V%%', 'A.B.C.D', 'PROD.X%', 'PROD.*.LOG', 'PROD.TM*', '**', 'TEST.ABCDEFG%.**'];
    const r = rng(7);
    const quals = ['PROD', 'TEST', 'TMP', 'TMPX', 'LOG', 'D241113', 'D2411', 'G0001V00', 'X1', 'X', 'A', 'B',
        'ABCDEFGH', 'ABCDEFG'];
    const dsns = new Set<string>(['PROD', 'PROD.LOG', 'A.B.C.D', 'PROD.TMP', 'PROD.X.LOG']);
    while (dsns.size < 400) {
        const n = 1 + Math.floor(r() * 5);
        dsns.add(Array.from({ length: n }, () => quals[Math.floor(r() * quals.length)]).join('.'));
    }
    for (const mk of masks) {
        it(mk, () => {
            const pm = parseMask(mk);
            for (const d of dsns) assert.equal(cardMatches(mk, d), matches(pm, d), `${mk} / ${d}`);
        });
    }
    it('maski nieobslugiwane', () => {
        assert.throws(() => maskConds('A.**.B.**'), CardError);
        assert.throws(() => maskConds('A.**.B.C'), CardError);
        assert.throws(() => maskConds('A.*B'), CardError);
        assert.throws(() => maskConds('A.B*C'), CardError);
    });
});

describe('ACMCARD - format', () => {
    const vm: VecMask[] = ['PROD.**', 'TEST.ABCDEFG%.**', 'SYS1.VERYLONG.Q3.Q4.Q5.Q6.Q7.Q8.Q9.Q10.Q11', '*.**.LOG']
        .map((text, i) => ({ no: i + 1, text, uses: ['R INCLUDE'] }));
    const lines = generateCards(vm);
    it('linie <= 71, kazda konczy sie przecinkiem, kolumna 1 pusta', () => {
        for (const l of lines) {
            assert.ok(l.length <= CARD_MAX_COL, l);
            assert.ok(l.endsWith(','), l);
            assert.equal(l[0], ' ');
        }
    });
    it('znak za wektorem i kolumny Y', () => {
        const text = lines.join('');
        assert.ok(text.includes(`OVERLAY=(${LAYOUT.vec + 4}:C'.')`));
        for (let i = 0; i < 4; i++) assert.ok(text.includes(`OVERLAY=(${LAYOUT.vec + i}:C'Y')`));
    });
});

describe('uklad zgodny z sym/ACMREPR.TXT i jcl/ACMREPR.jcl', () => {
    const sym = fs.readFileSync(path.join(ROOT, 'sym/ACMREPR.TXT'), 'utf-8');
    const pos = (name: string) => {
        const m = new RegExp(`^${name},(\\d+),(\\d+)`, 'm').exec(sym);
        assert.ok(m, `brak symbolu ${name}`);
        return { p: Number(m[1]), m: Number(m[2]) };
    };
    it('symbole', () => {
        assert.deepEqual(pos('A_NQ'), { p: LAYOUT.nq, m: 2 });
        assert.deepEqual(pos('A_Q01'), { p: LAYOUT.q01, m: 8 });
        assert.deepEqual(pos('A_Q22'), { p: LAYOUT.q01 + 21 * 8, m: 8 });
        assert.deepEqual(pos('A_Q99'), { p: LAYOUT.q99, m: 8 });
        assert.deepEqual(pos('A_CNT'), { p: LAYOUT.cnt, m: 15 });
        assert.equal(pos('A_CNT').p + 15, LAYOUT.vec);
        assert.equal(pos('A_XFB').m, LAYOUT.fixedLen);
        assert.equal(pos('A_KEYA').m + pos('A_KCLS').m, LAYOUT.keyFixed);
    });
    it('JCL: kolumny NQ, LLQ, licznika', () => {
        const jcl = fs.readFileSync(path.join(ROOT, 'jcl/ACMREPR.jcl'), 'utf-8');
        assert.ok(jcl.includes(`OVERLAY=(${LAYOUT.nq}:C'01',${LAYOUT.q99}:A_Q01)`));
        assert.ok(jcl.includes(`OVERLAY=(${LAYOUT.q01}:%01`));
        assert.ok(jcl.includes(`INREC OVERLAY=(${LAYOUT.cnt}:A_ZD1)`));
        assert.ok(jcl.includes('DSN=&MASKLIB(ACMCARD)'));
        assert.ok(jcl.includes('DSN=&MASKLIB(ACMSYMV)'));
    });
    it('ACMSYMV: B_* wg dlugosci wektora', () => {
        const s = generateSymbols(12, '2026-11-16');
        assert.ok(s.includes(`A_VEC,${LAYOUT.vec},12`));
        assert.ok(s.includes(`B_KEY,1,${LAYOUT.keyFixed + 12}`));
        assert.ok(s.includes(`B_CLS,${LAYOUT.keyFixed + 13},90,CH`));
        for (const l of s) assert.ok(l.length <= 71, l);
    });
});
