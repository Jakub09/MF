import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { main } from '../src/cli';
import { compileConfig, ConfigError } from '../src/config';
import { pairTasks } from '../src/durations';
import { toLine } from '../src/line-protocol';
import { config, records, run } from './helpers';

const messages = {
    ARC0722I: { pattern: 'VOLUME (?<volser>\\S+) AT (?<time>[\\d:]+)', extract: { volser: 'tag' } },
    ARC0723I: { pattern: 'VOLUME (?<volser>\\S+) AT (?<time>[\\d:]+)', extract: { volser: 'tag' } },
    ARC0570I: { pattern: '^(?<function>.+?) FOR (?<scope>\\S+)', extract: { function: 'tag', scope: 'tag' } },
    ARC0720I: { pattern: '^AUTOMATIC BACKUP STARTING', time: { fallback: 'next' as const } },
    ARC0721I: { pattern: '^AUTOMATIC BACKUP (?<status>ENDING)', extract: { status: 'tag' } },
};
const durations = {
    tasks: {
        VOLBACKUP: {
            start: 'ARC0722I',
            end: { ARC0723I: 'OK', ARC0570I: { status: 'TERMINATED', when: { function: '^AUTOMATIC BACKUP$' } } },
            key: ['volser'],
            keyAlias: { ARC0570I: { volser: 'scope' } },
            maxHours: 2,
        },
        AUTOBACKUP: { start: 'ARC0720I', end: { ARC0721I: { statusFrom: 'status' } } },
    },
};
const meta = { fileDate: { y: 2026, m: 11, d: 3 }, fileMsOfDay: 0 };

describe('durations - konfiguracja', () => {
    const rejects = (d: unknown, re: RegExp) =>
        assert.throws(() => compileConfig({ timezone: 'UTC', messages, durations: d }), (e: Error) => e instanceof ConfigError && re.test(e.message));

    it('poprawna', () => {
        const cfg = compileConfig({ timezone: 'UTC', messages, durations });
        assert.deepEqual(cfg.durations!.tasks.map(t => t.name), ['VOLBACKUP', 'AUTOBACKUP']);
        assert.equal(cfg.durations!.measurement, 'MF.HSM.DURATION');
    });
    it('komunikat bez mapowania, brak klucza, statusFrom, when, tag zarezerwowany', () => {
        rejects({ tasks: { X: { start: 'ARC0999I', end: { ARC0723I: 'OK' } } } }, /ARC0999I nie ma mapowania/);
        rejects({ tasks: { X: { start: 'ARC0720I', end: { ARC0723I: 'OK' }, key: ['volser'] } } }, /ARC0720I nie dostarcza "volser"/);
        rejects({ tasks: { X: { start: 'ARC0722I', end: { ARC0723I: { statusFrom: 'rc' } } } } }, /nie dostarcza "rc" \(statusFrom\)/);
        rejects({ tasks: { X: { start: 'ARC0722I', end: { ARC0570I: { status: 'T', when: { function: '(' } } } } } }, /niepoprawny regex/);
        rejects({ tasks: { X: { start: 'ARC0722I', end: { ARC0723I: 'OK' }, tags: ['status'] } } }, /tag "status" jest zarezerwowany/);
        rejects({ tasks: { x: { start: 'ARC0722I', end: { ARC0723I: 'OK' } } } }, /nazwa zadania/);
    });
});

describe('durations - parowanie', () => {
    const cfg = compileConfig({ timezone: 'UTC', messages, durations });
    const pair = (...lines: string[]) => {
        const r = run(cfg, records(...lines), meta);
        return pairTasks(r.events, cfg.durations!, cfg.countField);
    };

    it('start -> koniec po kluczu, punkty z czasem konca i tagami', () => {
        const r = pair(
            'ARC0722I VOLUME A AT 02:00:00', 'ARC0722I VOLUME B AT 02:01:00',
            'ARC0723I VOLUME B AT 02:03:30', 'ARC0723I VOLUME A AT 02:10:00',
        );
        assert.deepEqual(r.records.map(x => [x.key.volser, x.durationS, x.status, x.exact]), [['B', 150, 'OK', true], ['A', 600, 'OK', true]]);
        const p = r.points[0];
        assert.equal(p.measurement, 'MF.HSM.DURATION');
        assert.deepEqual(p.tags, { sysname: 'SYS1', task: 'VOLBACKUP', status: 'OK', host_id: 'A', volser: 'B' });
        assert.match(toLine(p, true), /^MF\.HSM\.DURATION,host_id=A,status=OK,sysname=SYS1,task=VOLBACKUP,volser=B events=1i,duration=150i,exact=true \d+$/);
    });

    it('ARC0570I zamyka tylko przy pasujacym when (keyAlias scope -> volser)', () => {
        // ARC0570I bez czasu w tresci -> czas poprzedniego komunikatu (02:05), czas trwania przyblizony
        const r = pair('ARC0722I VOLUME A AT 02:00:00', 'ARC0722I VOLUME B AT 02:05:00',
            'ARC0570I PRIMARY SPACE MANAGEMENT FOR A', 'ARC0570I AUTOMATIC BACKUP FOR A');
        assert.deepEqual(r.records.map(x => [x.status, x.durationS, x.exact]), [['TERMINATED', 300, false]]);
        assert.equal(r.stats.get('VOLBACKUP')!.unmatchedEnd, 0);
    });

    it('koniec bez startu, otwarte, ponowny start, maxHours', () => {
        const r = pair(
            'ARC0723I VOLUME X AT 01:00:00',
            'ARC0722I VOLUME A AT 02:00:00', 'ARC0722I VOLUME A AT 02:05:00', 'ARC0723I VOLUME A AT 02:06:00',
            'ARC0722I VOLUME B AT 02:00:00', 'ARC0723I VOLUME B AT 05:00:00',
            'ARC0722I VOLUME C AT 06:00:00',
        );
        assert.deepEqual(r.records.map(x => [x.key.volser, x.durationS]), [['A', 60]]);
        // B: koniec po 3 h > maxHours 2 -> koniec bez startu, start B zostaje otwarty (kandydat na zawieszenie); C - otwarty
        assert.deepEqual({ ...r.stats.get('VOLBACKUP') }, { paired: 1, unmatchedEnd: 2, open: 2, restarted: 1, noTime: 0 });
    });

    it('czas zastepczy -> exact=false, status z wartosci', () => {
        const r = pair('ARC0720I AUTOMATIC BACKUP STARTING', 'ARC0722I VOLUME A AT 02:00:00', 'ARC0723I VOLUME A AT 03:00:00', 'ARC0721I AUTOMATIC BACKUP ENDING');
        const ab = r.records.find(x => x.task === 'AUTOBACKUP')!;
        assert.deepEqual([ab.durationS, ab.status, ab.exact], [3600, 'ENDING', false]);
    });

    it('start i koniec bez czasu w tresci obok siebie -> bez punktu (noTime)', () => {
        const r = pair('ARC0722I VOLUME A AT 02:00:00', 'ARC0720I AUTOMATIC BACKUP STARTING', 'ARC0721I AUTOMATIC BACKUP ENDING');
        assert.equal(r.records.filter(x => x.task === 'AUTOBACKUP').length, 0);
        assert.equal(r.stats.get('AUTOBACKUP')!.noTime, 1);
    });

    it('durationFrom: czas trwania z pola komunikatu konca', () => {
        const c = compileConfig({ timezone: 'UTC', messages: {
            ARC0522I: { pattern: 'VOLUME (?<volser>\\S+) AT (?<time>[\\d:]+)', extract: { volser: 'tag' } },
            ARC0523I: { pattern: 'VOLUME (?<volser>\\S+), TIME (?<elapsed>[\\d:]+)', extract: { volser: 'tag', elapsed: 'duration' } },
        }, durations: { tasks: { SMVOL: { start: 'ARC0522I', end: { ARC0523I: { status: 'OK', durationFrom: 'elapsed' } }, key: ['volser'] } } } });
        const ev = run(c, records('ARC0522I VOLUME A AT 01:00:00', 'ARC0523I VOLUME A, TIME 00:12:31'), meta).events;
        const r = pairTasks(ev, c.durations!, 'events');
        assert.deepEqual(r.records.map(x => [x.durationS, x.exact]), [[751, true]]);
    });

    it('rozne hosty / systemy sie nie paruja', () => {
        const a = run(cfg, records('ARC0722I VOLUME A AT 02:00:00'), { ...meta, hostId: 'A' }).events;
        const b = run(cfg, records('ARC0723I VOLUME A AT 02:10:00'), { ...meta, hostId: 'B' }).events;
        assert.equal(pairTasks([...a, ...b], cfg.durations!, 'events').records.length, 0);
    });
});

describe('durations - aggregate', () => {
    const msgs = {
        ARC0720I: { pattern: '^AUTOMATIC BACKUP STARTING', time: { fallback: 'next' as const } },
        ARC0721I: { pattern: '^AUTOMATIC BACKUP ENDING' },
        ARC0722I: { pattern: 'VOLUME (?<volser>\\S+) AT (?<time>[\\d:]+)', extract: { volser: 'tag' } },
        ARC0723I: { pattern: 'VOLUME (?<volser>\\S+) AT (?<time>[\\d:]+), (?<n>\\d+) DATA SETS', extract: { volser: 'tag', n: 'int' } },
        ARC0570I: { pattern: '^(?<function>.+?) FOR (?<scope>\\S+)', extract: { function: 'tag', scope: 'tag' } },
        ARC1801I: { pattern: 'POOL (?<copy_pool>\\S+) AT (?<time>[\\d:]+)', extract: { copy_pool: 'tag' } },
        ARC1802I: { pattern: 'POOL (?<copy_pool>\\S+) AT (?<time>[\\d:]+)', extract: { copy_pool: 'tag' } },
        ARC1805I: { pattern: '^(?<ok>\\d+) VOLUMES POOL (?<copy_pool>\\S+)', extract: { ok: 'int', copy_pool: 'tag' } },
    };
    const durs = { tasks: {
        AUTOBACKUP: { start: 'ARC0720I', end: { ARC0721I: 'OK' }, aggregate: {
            volumes: { op: 'count', msg: 'ARC0723I' },
            volumes_failed: { op: 'count', msg: 'ARC0570I', when: { function: '^AUTOMATIC BACKUP$' } },
            datasets: { op: 'sum', msg: 'ARC0723I', value: 'n' },
            biggest: { op: 'max', msg: 'ARC0723I', value: 'n' },
        } },
        FR: { start: 'ARC1801I', end: { ARC1802I: 'OK' }, key: ['copy_pool'], aggregate: { volumes: { op: 'sum', msg: 'ARC1805I', value: 'ok' } } },
    } };
    const cfg = compileConfig({ timezone: 'UTC', messages: msgs, durations: durs });
    const pairAll = (...lines: string[]) => pairTasks(run(cfg, records(...lines), meta).events, cfg.durations!, 'events');

    it('count / sum / max w oknie zadania, when', () => {
        const r = pairAll(
            'ARC0723I VOLUME Z AT 01:00:00, 9 DATA SETS',             // przed zadaniem - nie liczy sie
            'ARC0720I AUTOMATIC BACKUP STARTING',
            'ARC0722I VOLUME A AT 02:00:00', 'ARC0723I VOLUME A AT 02:10:00, 100 DATA SETS',
            'ARC0722I VOLUME B AT 02:10:00', 'ARC0570I AUTOMATIC BACKUP FOR B',
            'ARC0570I PRIMARY SPACE MANAGEMENT FOR C',
            'ARC0722I VOLUME D AT 02:20:00', 'ARC0723I VOLUME D AT 02:30:00, 50 DATA SETS',
            'ARC0721I AUTOMATIC BACKUP ENDING',
        );
        assert.deepEqual(r.records[0].metrics, { volumes: 2, volumes_failed: 1, datasets: 150, biggest: 100 });
        assert.match(toLine(r.points[0], true), /duration=1800i,exact=false,volumes=2i,volumes_failed=1i,datasets=150i,biggest=100i/);
    });

    it('klucz zadania filtruje komunikaty z innym kluczem; komunikat bez czasu po koncu (ten sam czas) wliczony', () => {
        const r = pairAll(
            'ARC1801I POOL P1 AT 03:00:00', 'ARC1801I POOL P2 AT 03:00:05',
            'ARC1802I POOL P1 AT 03:00:20', 'ARC1805I 12 VOLUMES POOL P1',
            'ARC1802I POOL P2 AT 03:01:00', 'ARC1805I 24 VOLUMES POOL P2',
        );
        assert.deepEqual(r.records.map(x => [x.key.copy_pool, x.metrics.volumes]), [['P1', 12], ['P2', 24]]);
    });

    it('walidacja: sum bez value, komunikat bez wartosci, nazwa zarezerwowana', () => {
        const bad = (aggregate: unknown, re: RegExp) => assert.throws(() => compileConfig({ timezone: 'UTC', messages: msgs,
            durations: { tasks: { X: { start: 'ARC0720I', end: { ARC0721I: 'OK' }, aggregate } } } }), re);
        bad({ v: { op: 'sum', msg: 'ARC0723I' } }, /sum wymaga "value"/);
        bad({ v: { op: 'sum', msg: 'ARC0722I', value: 'n' } }, /ARC0722I nie dostarcza "n"/);
        bad({ duration: { op: 'count', msg: 'ARC0723I' } }, /zarezerwowana/);
    });
});

describe('durations - cli', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-dur-'));
    after(() => fs.rmSync(tmp, { recursive: true, force: true }));

    it('punkty MF.HSM.DURATION i tabela hsm_task (konfiguracja projektu)', async () => {
        let err = '';
        const out = path.join(tmp, 'd.lp');
        const db = path.join(tmp, 'd.db');
        const code = await main(['--out', out, '--sqlite', db, path.join(__dirname, 'fixtures', 'HSMACT.HA.ALLLOG.D26307.T000000.txt')],
            { out: () => undefined, err: t => void (err += t) });
        assert.equal(code, 0, err);
        assert.match(err, /Czas trwania \(MF\.HSM\.DURATION\): nowych zadan \d+/);
        const lines = fs.readFileSync(out, 'utf8').split('\n').filter(l => l.startsWith('MF.HSM.DURATION'));
        // fiksura skleja sekwencje udana i nieudana z dokumentu - datasets_failed zalezy od sklejenia, nie sprawdzamy
        assert.ok(lines.some(l => /status=SUCCESSFUL,sysname=SYS1,task=CDSBACKUP events=1i,duration=80i,exact=true,datasets=4i/.test(l)), lines.join('\n'));
        assert.ok(lines.some(l => /task=FRBACKUP .*duration=13i,exact=true,volumes=24i,volumes_failed=2i/.test(l)));
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
        const sql = new DatabaseSync(db);
        const row = sql.prepare("SELECT task_key, duration_s, status, start_msg, end_msg, metrics FROM hsm_task WHERE task = 'CDSBACKUP' AND status = 'SUCCESSFUL'").get();
        sql.close();
        const { metrics, ...rest } = row as Record<string, unknown>;
        assert.deepEqual(rest, { task_key: '{}', duration_s: 80, status: 'SUCCESSFUL', start_msg: 'ARC0740I', end_msg: 'ARC0741I' });
        assert.equal(JSON.parse(String(metrics)).datasets, 4);
    });
});
