import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { buildDataSets, CsvError, parseCsv, readDataSets } from '../src/dataset';
import { sampleCsv } from '../tools/gen-sample';
import { csv, dline } from './helpers';

const TODAY = new Date('2026-11-17T00:00:00Z');
let dir: string;
before(() => void (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-stream-'))));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const file = (name: string, text: string) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, text);
    return f;
};

describe('CSV strumieniowo', () => {
    it('ten sam wynik co parseCsv, takze przy porcjach po 7 bajtow i CRLF', async () => {
        const text = sampleCsv(3000);
        const want = buildDataSets(parseCsv(text), { vsamCluster: true, today: TODAY });
        for (const [name, body] of [['lf.csv', text], ['crlf.csv', text.replace(/\n/g, '\r\n')]]) {
            const f = file(name, body);
            for (const chunkSize of [7, 1 << 20]) {
                const r = await readDataSets(f, { chunkSize, today: TODAY });
                assert.deepEqual(r.dataSets, want, `${name} / ${chunkSize}`);
                assert.equal(r.lines, text.trimEnd().split('\n').length);
            }
        }
    });

    it('znak wielobajtowy UTF-8 na granicy porcji', async () => {
        const f = file('utf8.csv', csv([dline({ dsn: 'A.B', job: 'ŻÓŁW' }), dline({ dsn: 'C.D', job: 'ĄĘ' })]));
        for (const chunkSize of [1, 2, 3, 5]) {
            const r = await readDataSets(f, { chunkSize, today: TODAY });
            assert.deepEqual(r.dataSets.map(d => d.createJob), ['ŻÓŁW', 'ĄĘ'], String(chunkSize));
        }
    });

    it('bledy z numerem linii; podpowiedz o starym CSV', async () => {
        const bad = file('bad.csv', csv([dline({ dsn: 'A.B' }), 'X;Y']));
        await assert.rejects(readDataSets(bad), (e: unknown) => e instanceof CsvError && /wiersz 3: nieznany typ/.test(e.message));
        const old = file('old.csv', csv([dline({ dsn: 'E.F' }).replace(/;01;/, ';\x00;') + '\n\x01;x']));
        await assert.rejects(readDataSets(old), /starej wersji joba ACMCSV/);
        await assert.rejects(readDataSets(path.join(dir, 'brak.csv')), { code: 'ENOENT' });
    });

    it('postep co N linii; duzy plik bez wczytywania calosci', async () => {
        const n = 120_000;
        const f = path.join(dir, 'duzy.csv');
        const out = fs.openSync(f, 'w');
        fs.writeSync(out, csv([]));
        let buf = '';
        for (let i = 0; i < n; i++) {
            buf += dline({ dsn: `HLQ${i % 50}.APP.D${String(i).padStart(7, '0')}.LIST`, vol: `VOL${i % 100}` }) + '\n';
            if (buf.length > 1 << 20) {
                fs.writeSync(out, buf);
                buf = '';
            }
        }
        fs.writeSync(out, buf);
        fs.closeSync(out);
        const seen: [number, number][] = [];
        const r = await readDataSets(f, { today: TODAY, progressEvery: 50_000, onProgress: (l, p) => seen.push([l, p]) });
        assert.equal(r.dataSets.length, n);
        assert.equal(r.dRecords, n);
        assert.deepEqual(seen.map(x => x[0]), [50_000, 100_000]);
        assert.ok(seen.every(([, p]) => p > 0 && p <= 1));
        // wartosci wspoldzielone: ten sam wolumen = ten sam napis
        const v = r.dataSets.filter(d => d.vol === 'VOL7');
        assert.ok(v.length > 1 && v.every(d => d.vol === v[0].vol));
    });
});
