import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { EXIT, main } from '../src/cli';

const FIX = path.join(__dirname, 'fixtures');
const ALL = path.join(FIX, 'HSMACT.HA.ALLLOG.D26307.T000000.txt');
const BAK = path.join(FIX, 'HSMACT.HB.BAKLOG.D26308.T020000.txt');
const QRY = path.join(FIX, 'HSMQRY.HA.QACTIVE.D26308.T120000.txt');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-load-'));

/** main() z przechwyconym wyjsciem */
async function cli(...argv: string[]) {
    let out = '';
    let err = '';
    const code = await main(argv, { out: t => void (out += t), err: t => void (err += t) });
    return { code, out, err };
}

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('przyklady z HSM_ARC_KOMUNIKATY.md', () => {
    it('kazdy rekord pasuje do wzorca, bez problemow (--strict)', async () => {
        const r = await cli('--dry-run', '--strict', ALL, BAK, QRY);
        assert.equal(r.code, EXIT.OK, r.err);
        assert.doesNotMatch(r.err, /! linia/);
    });
});

describe('cli', () => {
    it('--check', async () => {
        const r = await cli('--check');
        assert.equal(r.code, EXIT.OK);
        assert.match(r.err, /OK - komunikatow \d+ \(grup \d+\), do InfluxDB \d+/);
        assert.match(r.err, /tylko SQLite .*ARC0640I ARC0734I/);
    });

    it('punkty tylko dla wybranych do InfluxDB, SQLite dostaje wszystkie', async () => {
        const out = path.join(tmp, 'sel.lp');
        const db = path.join(tmp, 'sel.db');
        const r = await cli('--out', out, '--sqlite', db, ALL);
        assert.equal(r.code, EXIT.OK, r.err);
        // punkty zdarzen (bez MF.HSM.DURATION - czasy trwania liczone z par, nie z pojedynczych komunikatow)
        const lines = fs.readFileSync(out, 'utf8').trim().split('\n').filter(l => !l.startsWith('MF.HSM.DURATION'));
        assert.ok(!lines.some(l => /msg_id=ARC0(734|640)I/.test(l)));
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
        const sql = new DatabaseSync(db);
        const rows = sql.prepare("SELECT influx, count(*) AS n FROM hsm_event WHERE msg_id IN ('ARC0734I', 'ARC0640I') GROUP BY influx").all();
        const total = (sql.prepare('SELECT count(*) AS n FROM hsm_event').get() as { n: number }).n;
        sql.close();
        assert.deepEqual(rows.map(x => ({ ...x })), [{ influx: 0, n: 8 }]);
        assert.equal(total, lines.length + 8);
    });

    it('--select z innym plikiem', async () => {
        const sel = path.join(tmp, 'only-cds.json');
        fs.writeFileSync(sel, JSON.stringify({ include: ['@CDSBKP'] }));
        const r = await cli('--dry-run', '--print', '--select', sel, ALL);
        assert.equal(r.code, EXIT.OK, r.err);
        const events = r.out.trim().split('\n').filter(l => !l.startsWith('MF.HSM.DURATION'));
        assert.ok(events.length > 0 && events.every(l => /msg_id=ARC0(74\d|75\d|79\d|909|026)[IE]/.test(l)));
    });

    it('bledna konfiguracja -> 1', async () => {
        const bad = path.join(tmp, 'bad.json');
        fs.writeFileSync(bad, JSON.stringify({ messages: { ARC0723I: { pattern: '(?<a>x)', extract: { b: 'int' } } } }));
        const r = await cli('-c', bad, '--check');
        assert.equal(r.code, EXIT.USAGE);
        assert.match(r.err, /brak grupy/);
    });

    it('brak pliku -> 2', async () => {
        const r = await cli('--dry-run', path.join(tmp, 'nie-ma.txt'));
        assert.equal(r.code, EXIT.INPUT);
    });

    it('--strict z problemami -> 4', async () => {
        const f = path.join(tmp, 'HSMACT.HA.MIGLOG.D26307.T000000.txt');
        fs.writeFileSync(f, 'SYS1;00000001;ARC0723I COS NIEZNANEGO\n');
        assert.equal((await cli('--dry-run', f)).code, EXIT.OK);
        assert.equal((await cli('--dry-run', '--strict', f)).code, EXIT.DATA);
    });

    it('--out i --sqlite', async () => {
        const out = path.join(tmp, 'points.lp');
        const db = path.join(tmp, 'events.db');
        const r = await cli('--out', out, '--sqlite', db, '--host-id', 'X', BAK);
        assert.equal(r.code, EXIT.OK, r.err);
        const lines = fs.readFileSync(out, 'utf8').trim().split('\n');
        assert.equal(lines.length, 19);
        assert.ok(lines.every(l => l.includes('host_id=X')));

        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
        const sql = new DatabaseSync(db);
        const row = sql.prepare("SELECT host_id, log_type, extra, time_utc FROM hsm_event WHERE msg_id = 'ARC1850I'").get() as Record<string, string>;
        sql.close();
        assert.equal(row.host_id, 'X');
        assert.equal(row.log_type, 'BAKLOG');
        assert.deepEqual(JSON.parse(row.extra), { fc_targets: 'SGDB2P   DB2001   FRT001   9B01' });

        // ponowny import nadpisuje (klucz source + sysname + group_id)
        assert.equal((await cli('--out', out, '--sqlite', db, BAK)).code, EXIT.OK);
        const again = new DatabaseSync(db);
        assert.equal((again.prepare('SELECT count(*) AS n FROM hsm_event').get() as { n: number }).n, 19);
        again.close();
    });
});

describe('zapis do InfluxDB', () => {
    let server: http.Server;
    let url = '';
    const requests: { url: string; auth?: string; body: string }[] = [];
    let status = 204;

    before(async () => {
        server = http.createServer((req, res) => {
            let body = '';
            req.on('data', c => (body += c));
            req.on('end', () => {
                requests.push({ url: req.url ?? '', auth: req.headers.authorization, body });
                res.writeHead(status).end(status === 204 ? '' : '{"error":"partial write: field type conflict"}');
            });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    after(() => new Promise<void>(resolve => server.close(() => resolve())));

    const withEnv = async <T>(env: Record<string, string>, fn: () => Promise<T>) => {
        const saved = { ...process.env };
        Object.assign(process.env, env);
        try {
            return await fn();
        } finally {
            process.env = saved;
        }
    };

    it('POST /write z baza, precyzja ns i Basic auth', async () => {
        const r = await withEnv({ INFLUXDB_URL: url, INFLUXDB_DATABASE: 'metrics', INFLUXDB_USERNAME: 'u', INFLUXDB_PASSWORD: 'p' },
            () => cli('--db', 'testdb', BAK));
        assert.equal(r.code, EXIT.OK, r.err);
        const req = requests.at(-1)!;
        assert.equal(req.url, '/write?db=testdb&precision=ns');
        assert.equal(req.auth, `Basic ${Buffer.from('u:p').toString('base64')}`);
        assert.equal(req.body.split('\n').length, 19);
    });

    it('blad InfluxDB -> 3', async () => {
        status = 400;
        const r = await withEnv({ INFLUXDB_URL: url }, () => cli(BAK));
        status = 204;
        assert.equal(r.code, EXIT.WRITE);
        assert.match(r.err, /HTTP 400 .*field type conflict/);
    });
});
