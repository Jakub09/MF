import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { EXIT, main } from '../src/cli';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-dir-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const incoming = path.join(tmp, 'incoming');
const archive = path.join(tmp, 'archive');
const db = path.join(tmp, 'state.db');
const conf = path.join(tmp, 'hsm-map.json');
fs.mkdirSync(incoming);
fs.writeFileSync(conf, JSON.stringify({
    timezone: 'UTC',
    input: { dir: 'incoming', include: 'HSMACT*.txt', minAgeSeconds: 60 },
    messages: {
        ARC0720I: { pattern: '^AUTOMATIC BACKUP STARTING', time: { fallback: 'next' } },
        ARC0721I: { pattern: '^AUTOMATIC BACKUP ENDING' },
        ARC0722I: { pattern: 'AT (?<time>[\\d:]+) ON (?<date>[\\d/]+)' },
    },
    durations: { tasks: { AUTOBACKUP: { start: 'ARC0720I', end: { ARC0721I: 'OK' }, expectedEnd: '06:00' } } },
}));

/** Plik ekstraktu z czasem modyfikacji sprzed 2 min (minAgeSeconds = 60) */
function extract(name: string, lines: string[], ageS = 120) {
    const f = path.join(incoming, name);
    fs.writeFileSync(f, lines.map((l, i) => `SYS1    ;${String(i + 1).padStart(8, '0')};${l}`).join('\n'));
    const t = new Date(Date.now() - ageS * 1000);
    fs.utimesSync(f, t, t);
    return f;
}
/** Pelny przebieg automatic backup jednego dnia (02:00 - 03:00) */
const day = (d: string, y: string) => extract(`HSMACT.HA.BAKLOG.D${d}.T000000.txt`,
    ['ARC0720I AUTOMATIC BACKUP STARTING', `ARC0722I BACKUP STARTING ON VOLUME P1(SMS) AT 02:00:00 ON ${y}`,
        `ARC0722I BACKUP STARTING ON VOLUME P2(SMS) AT 03:00:00 ON ${y}`, 'ARC0721I AUTOMATIC BACKUP ENDING']);

async function cli(...argv: string[]) {
    let out = '';
    let err = '';
    const code = await main(['-c', conf, '--sqlite', db, '--out', path.join(tmp, 'p.lp'), ...argv], { out: t => void (out += t), err: t => void (err += t) });
    return { code, out, err };
}

describe('katalog ekstraktow (input.dir)', () => {
    it('nowe pliki; potem tylko nowe; --all; swieze i spoza wzorca pominiete', async () => {
        day('26315', '26/11/11');
        extract('inny.log', ['ARC0720I AUTOMATIC BACKUP STARTING']);
        extract('HSMACT.HA.BAKLOG.D26316.T120000.txt', ['ARC0720I AUTOMATIC BACKUP STARTING'], 5); // transfer w toku

        const r1 = await cli('--as-of', '2026-11-11T12:00:00Z');
        assert.equal(r1.code, EXIT.OK, r1.err);
        assert.match(r1.err, /nowych plikow 1, juz przetworzonych 0, pominietych \(zmienione < 60 s\) 1/);

        const r2 = await cli('--as-of', '2026-11-11T13:00:00Z');
        assert.match(r2.err, /nowych plikow 0, juz przetworzonych 1/);

        const r3 = await cli('--as-of', '2026-11-11T13:30:00Z', '--all');
        assert.match(r3.err, /nowych plikow 1, juz przetworzonych 0/);

        // zmieniony plik (inny rozmiar) - przetwarzany ponownie
        const f = path.join(incoming, 'HSMACT.HA.BAKLOG.D26315.T000000.txt');
        fs.appendFileSync(f, '\n');
        const t = new Date(Date.now() - 120_000);
        fs.utimesSync(f, t, t);
        assert.match((await cli('--as-of', '2026-11-11T14:00:00Z')).err, /nowych plikow 1/);
    });

    it('bez nowych plikow po terminie -> kontrola terminow dziala (WARNING)', async () => {
        const r = await cli('--as-of', '2026-11-12T08:00:00Z');
        assert.equal(r.code, EXIT.TASK_WARNING, r.err);
        assert.match(r.err, /nowych plikow 0/);
        assert.match(r.err, /HSM-W AUTOBACKUP SYS1\/A \(termin 2026-11-12 06:00\): brak konca - nie wystartowalo/);
    });

    it('--archive-dir: przenosi przetworzone pliki po udanym zapisie', async () => {
        day('26316', '26/11/12');
        const r = await cli('--as-of', '2026-11-12T09:00:00Z', '--archive-dir', archive);
        assert.match(r.err, /Przeniesiono 1 plikow do/);
        assert.ok(fs.existsSync(path.join(archive, 'HSMACT.HA.BAKLOG.D26316.T000000.txt')));
        assert.ok(!fs.existsSync(path.join(incoming, 'HSMACT.HA.BAKLOG.D26316.T000000.txt')));
        assert.match(r.err, /HSM-I AUTOBACKUP SYS1\/A \(termin 2026-11-12 06:00\): koniec w kolejnym ekstrakcie/);
    });

    it('brak katalogu -> kod 2; brak plikow i katalogu -> kod 1', async () => {
        assert.equal((await cli('--input-dir', path.join(tmp, 'nie-ma'))).code, EXIT.INPUT);
        let err = '';
        const code = await main([], { out: () => undefined, err: t => void (err += t) });
        assert.equal(code, EXIT.USAGE);
        assert.match(err, /podaj pliki albo katalog/);
    });
});
