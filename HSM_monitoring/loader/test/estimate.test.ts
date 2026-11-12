import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { main } from '../src/cli';
import { Assumptions, bytes, collectSample, countAt, project, sampleDaysOf, Usage } from '../src/estimate';
import { config, records, run } from './helpers';

const A: Assumptions = { bytesPerValue: { int: 10, float: 10, bool: 5, string: 10 }, stringFactor: 1, keyIndexBytes: 0, seriesIndexBytes: 0, shardBytes: 0 };
const DAY = 86_400_000;

describe('project', () => {
    const cfg = config({
        ARC0723I: { pattern: 'VOL (?<volser>\\S+) N=(?<n>\\d+) OK=(?<ok>\\S+)', extract: { volser: 'tag', n: 'int', ok: 'bool' } },
    });
    const day = (d: number) => ({ fileDate: { y: 2026, m: 1, d }, fileMsOfDay: 0 });
    // dzien 1: wolumeny A, B; dzien 2: A, C (nowa seria)
    const events = [
        ...run(cfg, records('ARC0723I VOL A N=1 OK=Y', 'ARC0723I VOL B N=2 OK=N'), day(1)).events,
        ...run(cfg, records('ARC0723I VOL A N=3 OK=Y', 'ARC0723I VOL C N=4 OK=Y'), day(2)).events,
    ];
    const sample = collectSample(events, cfg);

    it('liczy punkty, wartosci wg typu, serie i klucze', () => {
        assert.equal(sample.total.points, 4);
        assert.deepEqual(sample.total.values, { int: 8, float: 0, bool: 4, string: 0 }); // events + n, ok
        assert.equal(sample.total.series.size, 3);
        assert.equal(sample.total.keys.size, 9);
    });

    it('skaluje liniowo i ekstrapoluje nowe serie z kolejnych dni probki', () => {
        const x = project(sample.total, sample.minMs, 2, 30, 7, A);
        assert.equal(x.points, 60);
        assert.equal(x.values, 180);
        assert.equal(x.series, 3 + 1 * 28); // 2 serie 1. dnia, potem 1 nowa / dzien
        // wartosci: 8 int x 15 x 10 B + 4 bool x 15 x 5 B = 1500 B
        // + indeks TSM: 5 shardow x 24 klucze w oknie 7 dni (9 + 3 nowe / dzien x 5) x srednia dlugosc klucza
        const avgKeyLen = [...sample.total.keys.keys()].reduce((n, k) => n + k.length, 0) / sample.total.keys.size;
        assert.ok(Math.abs(x.diskBytes - (1500 + 5 * 24 * avgKeyLen)) < 1e-6);
    });

    it('narzut indeksu rosnie z liczba shardow; staly narzut tylko z withShardFixed', () => {
        const withIdx = { ...A, keyIndexBytes: 100, shardBytes: 1000 };
        const one = project(sample.total, sample.minMs, 2, 7, 7, withIdx);
        const two = project(sample.total, sample.minMs, 2, 14, 7, withIdx);
        const noFixed = project(sample.total, sample.minMs, 2, 14, 7, withIdx, false);
        assert.ok(Math.abs(two.diskBytes - 2 * one.diskBytes) < 1e-6); // 2x wartosci i 2 shardy z tymi samymi kluczami
        assert.equal(two.diskBytes - noFixed.diskBytes, 2 * 1000);
    });

    it('probka >= 4 dni: tempo nowych serii z drugiej polowy probki', () => {
        const fs = new Map<string, number>();
        // 8 dni: dzien 0 - 10 serii, dni 1-3 - po 4 nowe, dni 4-7 - po 1 nowej (nasycanie)
        let n = 0;
        for (let i = 0; i < 10; i++) fs.set(`s${n++}`, 0);
        for (let d = 1; d <= 3; d++) for (let i = 0; i < 4; i++) fs.set(`s${n++}`, d * DAY);
        for (let d = 4; d <= 7; d++) fs.set(`s${n++}`, d * DAY);
        assert.equal(countAt(fs, 0, 8, 8), 26);
        assert.equal(countAt(fs, 0, 8, 108), 26 + 100); // 1 / dzien, nie (26-10)/7
    });

    it('probka bez nowych serii po 1. dniu -> liczba serii stala', () => {
        const u = new Usage();
        const e = events[0];
        u.add(e, 'x', 's1');
        u.add({ ...e, timeMs: e.timeMs + DAY }, 'x', 's1');
        assert.equal(project(u, e.timeMs, 2, 365, 7, A).series, 1);
    });

    it('sampleDaysOf: override, daty plikow, rozpietosc', () => {
        assert.deepEqual(sampleDaysOf(sample, ['a'], 3), { days: 3, source: '--sample-days' });
        assert.equal(sampleDaysOf(sample, ['2026-1-1', '2026-1-2', '2026-1-2']).days, 2);
        assert.equal(sampleDaysOf(sample, ['2026-1-1', undefined]).source, 'rozpietosc czasu zdarzen');
    });

    it('bytes', () => {
        assert.equal(bytes(512), '512 B');
        assert.equal(bytes(1536), '1,50 KB');
        assert.equal(bytes(50 * 1024 * 1024), '50,0 MB');
    });
});

describe('cli --estimate', () => {
    const FIX = path.join(__dirname, 'fixtures');
    async function cli(...argv: string[]) {
        let out = '';
        let err = '';
        const code = await main(argv, { out: t => void (out += t), err: t => void (err += t) });
        return { code, out, err };
    }

    it('tabela 7 / 30 / 365 dni, rozbicie, bez zapisu', async () => {
        const r = await cli('--estimate', '--top', '3', path.join(FIX, 'HSMACT.HA.ALLLOG.D26307.T000000.txt'));
        assert.equal(r.code, 0, r.err);
        assert.match(r.out, /probka: 1 d \(rozne daty w nazwach plikow\), shard 7 d/);
        assert.match(r.out, /7 d +30 d +365 d/);
        assert.match(r.out, /dysk TSM \+ indeks \(szac\.\)/);
        assert.match(r.out, /Wg komunikatu \(365 d, najwieksze 3 z \d+\)/);
        assert.doesNotMatch(r.err, /Zapisano/);
    });

    it('wlasne okresy i zle argumenty', async () => {
        const r = await cli('--estimate', '--periods', '1,90', '--sample-days', '2', path.join(FIX, 'HSMACT.HB.BAKLOG.D26308.T020000.txt'));
        assert.match(r.out, /probka: 2 d \(--sample-days\)/);
        assert.match(r.out, /1 d +90 d/);
        assert.equal((await cli('--estimate', '--periods', '7,x', 'a')).code, 1);
        assert.equal((await cli('--estimate', '--shard-days', '0', 'a')).code, 1);
    });
});
