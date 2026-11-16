import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matches, parseMask } from '../src/mask';
import { buildCandidates, purity, selectMasks } from '../src/mine';
import { rng } from './helpers';

function randomDsns(seed: number, count: number): string[] {
    const r = rng(seed);
    const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)];
    const hlq = ['PROD', 'TEST', 'SYS1', 'USR1'];
    const mid = ['TMP', 'LOAD', 'D241113', 'D241114', 'X1', 'X22', 'APP'];
    const llq = ['LIST', 'LOG', 'G0001V00', 'G0002V00', 'OUT', 'T1'];
    const out = new Set<string>();
    while (out.size < count) {
        const n = 1 + Math.floor(r() * 4);
        const q = [pick(hlq)];
        for (let i = 1; i < n; i++) q.push(i === n - 1 ? pick(llq) : pick(mid));
        out.add(q.join('.'));
    }
    return [...out];
}

describe('kandydaci - liczenie przez indeks = dopasowanie FILTLIST', () => {
    for (const seed of [1, 2, 3]) {
        it(`losowe nazwy, ziarno ${seed}`, () => {
            const dsns = randomDsns(seed, 300);
            const r = rng(seed + 100);
            const isPos = dsns.map(() => r() < 0.3);
            const pos = dsns.filter((_, i) => isPos[i]).map(d => d.split('.'));
            const neg = dsns.filter((_, i) => !isPos[i]).map(d => d.split('.'));
            const idx = buildCandidates(pos, neg, true);
            assert.ok(idx.size > 0);
            for (const c of idx.byText.values()) {
                const mk = parseMask(c.text);
                const p = pos.filter(q => matches(mk, q.join('.'))).length;
                const n = neg.filter(q => matches(mk, q.join('.'))).length;
                assert.equal(c.pos.length, p, `${c.text} poz`);
                assert.equal(c.neg, n, `${c.text} neg`);
            }
        });
    }
});

describe('wybor masek', () => {
    const pos = ['PROD.TMP.A1', 'PROD.TMP.A2', 'PROD.TMP.B3', 'PROD.TMP.C4', 'TEST.X.LOG', 'TEST.Y.LOG', 'TEST.Z.LOG']
        .map(d => d.split('.'));
    const neg = ['PROD.APP.LOAD', 'TEST.X.OUT', 'PROD.TMP.KEEP'].map(d => d.split('.'));

    it('czystosc 100%: maska nie obejmuje zbiorow spoza kryterium', () => {
        const idx = buildCandidates(pos, neg, true);
        const sel = selectMasks(idx, pos.length, { minPurity: 1, minCount: 2, maxMasks: 10, digitMasks: true });
        for (const s of sel) assert.equal(s.cand.neg, 0, s.cand.text);
        const texts = sel.map(s => s.cand.text);
        // remis pokrycia i czystosci: maska bardziej szczegolowa (TEST.**.LOG, nie *.**.LOG)
        assert.ok(texts.includes('TEST.**.LOG'), texts.join(','));
        // PROD.TMP.** obejmuje PROD.TMP.KEEP - niedozwolone; A1, A2 -> maska z % (cyfra -> %)
        assert.ok(texts.includes('PROD.TMP.A%'), texts.join(','));
        assert.ok(!texts.includes('PROD.TMP.**'));
    });

    it('tolerancja: PROD.TMP.** dozwolona przy czystosci 0,8', () => {
        const idx = buildCandidates(pos, neg, true);
        const sel = selectMasks(idx, pos.length, { minPurity: 0.8, minCount: 2, maxMasks: 10, digitMasks: true });
        const texts = sel.map(s => s.cand.text);
        assert.ok(texts.includes('PROD.TMP.**') || texts.includes('PROD.**'), texts.join(','));
        for (const s of sel) assert.ok(purity(s.cand) >= 0.8);
    });

    it('minCount i maxMasks', () => {
        const idx = buildCandidates(pos, neg, true);
        const sel = selectMasks(idx, pos.length, { minPurity: 1, minCount: 5, maxMasks: 10, digitMasks: true });
        assert.equal(sel.length, 0);
        const one = selectMasks(idx, pos.length, { minPurity: 1, minCount: 1, maxMasks: 1, digitMasks: true });
        assert.equal(one.length, 1);
    });

    it('bez masek z %', () => {
        const idx = buildCandidates(pos, neg, false);
        for (const c of idx.byText.values()) assert.ok(!c.text.includes('%'), c.text);
    });
});
