import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { evaluateChecks } from '../src/checks';
import { EXIT, main } from '../src/cli';
import { compileConfig } from '../src/config';
import type { OpenStart } from '../src/durations';
import type { MappedEvent } from '../src/mapper';
import type { TaskCheck } from '../src/sqlite-store';
import { clockStats, formatTaskTimes } from '../src/task-times';

const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 12); // 2026-11-12 00:00 UTC
const cfg = compileConfig({
    timezone: 'UTC',
    messages: { ARC0720I: {}, ARC0721I: {}, ARC0801I: {}, ARC0802I: {} },
    durations: { tasks: {
        AUTOBACKUP: { start: 'ARC0720I', end: { ARC0721I: 'OK' }, expectedEnd: '06:00' },
        AUDIT: { start: 'ARC0801I', end: { ARC0802I: 'OK' }, expectedEnd: '04:00', days: ['SUN'] },
    } },
});
const d = cfg.durations!;
const done = (startH: number, endH: number, task = 'AUTOBACKUP', hostId = 'A') =>
    ({ task, sysname: 'SYS1', hostId, startMs: T0 + startH * H, endMs: T0 + endH * H, status: 'OK' });
const openStart = (startH: number, task = 'AUTOBACKUP'): OpenStart =>
    ({ task, sysname: 'SYS1', hostId: 'A', key: {}, start: { timeMs: T0 + startH * H } as MappedEvent });

/** Kolejne "ekstrakty" z zapamietanym stanem jak w SQLite */
function runner() {
    const state = new Map<string, TaskCheck>();
    const k = (t: string, s: string, h: string | undefined, dl: number) => `${t}/${s}/${h}/${dl}`;
    return (asOfH: number, completed: ReturnType<typeof done>[], open: OpenStart[] = []) => {
        const r = evaluateChecks({
            durations: d, timezone: 'UTC', countField: 'events', asOfMs: T0 + asOfH * H, completed, open,
            hosts: [{ sysname: 'SYS1', hostId: 'A', firstMs: T0 - 72 * H }],
            previous: (t, s, h, dl) => state.get(k(t, s, h, dl)),
        });
        for (const c of r.checks) state.set(k(c.task, c.sysname, c.hostId, c.deadlineMs), c);
        return r;
    };
}
// historia: wczoraj (11-11) backup 22:00 -> 03:00 skonczony przed terminem 06:00
const history = [done(-26, -21)];
/** Tylko termin 2026-11-12 06:00 (pierwsze uruchomienie sprawdza tez wczorajszy - z historii COMPLETED) */
const today = <T extends { deadlineMs: number }>(xs: T[]) => xs.filter(x => x.deadlineMs === T0 + 6 * H);

describe('kontrola expectedEnd', () => {
    it('koniec przed terminem -> OK, bez powiadomien', () => {
        const r = runner()(7, [...history, done(-2, 4)]);
        assert.deepEqual(r.checks.map(c => [c.state, c.level]), [['COMPLETED', 'OK'], ['COMPLETED', 'OK']]); // wczoraj, dzis
        assert.equal(r.notifications.length, 0);
        assert.ok(r.points.every(p => p.tags.level === 'OK'));
    });

    it('brak konca: WARNING (w toku) -> ERROR w kolejnym ekstrakcie -> koniec po terminie aktualizuje czas', () => {
        const run = runner();
        const r1 = run(7, history, [openStart(-2)]);
        assert.deepEqual(r1.notifications.map(n => n.level), ['WARNING']);
        assert.match(r1.notifications[0].text, /AUTOBACKUP SYS1\/A \(termin 2026-11-12 06:00\): brak konca - w toku od 2026-11-11 22:00 \(9 h 00 min\)/);
        const w = r1.points.find(p => p.tags.level === 'WARNING')!;
        assert.equal(w.fields.running_s.value, 9 * 3600);
        assert.equal(w.fields.deadline.value, '2026-11-12 06:00');

        const r2 = run(19, history, [openStart(-2)]);
        assert.deepEqual(r2.notifications.map(n => n.level), ['ERROR']);
        assert.match(r2.notifications[0].text, /brak konca w kolejnym ekstrakcie/);

        const r3 = run(21, [...history, done(-2, 20)]);
        assert.deepEqual(r3.notifications.map(n => [n.level, n.text.replace(/.*: /, '')]), [['INFO', 'zakonczone po terminie o 2026-11-12 20:00 (+14 h 00 min), status OK']]);
        assert.deepEqual(r3.checks.map(c => [c.state, c.level, c.warnedMs !== undefined, c.erroredMs !== undefined]), [['COMPLETED_LATE', 'OK', true, true]]);
        assert.equal(r3.points[0].fields.late_s.value, 14 * 3600);
        assert.equal(run(22, [...history, done(-2, 20)]).notifications.length, 0); // zakonczone - bez kolejnych zmian
        // nastepny dzien 07:00: nowy termin 2026-11-13 06:00 bez konca -> nowe WARNING
        assert.deepEqual(run(31, [...history, done(-2, 20)]).notifications.map(n => [n.level, n.deadlineMs]), [['WARNING', T0 + 30 * H]]);
    });

    it('nie wystartowalo -> NOT_STARTED; po ERROR bez trzeciego powiadomienia', () => {
        const run = runner();
        assert.deepEqual(today(run(7, history).checks).map(c => [c.state, c.level]), [['NOT_STARTED', 'WARNING']]);
        assert.deepEqual(run(19, history).notifications.map(n => n.level), ['ERROR']);
        assert.equal(run(23, history).notifications.length, 0);
    });

    it('po WARNING koniec przed terminem w kolejnym ekstrakcie -> INFO, COMPLETED', () => {
        const run = runner();
        run(7, history);
        const r = run(19, [...history, done(-2, 4)]);
        assert.deepEqual(r.notifications.map(n => [n.level, n.text.replace(/.*: /, '')]), [['INFO', 'koniec w kolejnym ekstrakcie - zakonczone o 2026-11-12 04:00 (przed terminem), status OK']]);
        assert.deepEqual(r.checks.map(c => [c.state, c.level]), [['COMPLETED', 'OK']]);
    });

    it('ponowne uruchomienie na tym samym ekstrakcie (< 1 h) nie eskaluje', () => {
        const run = runner();
        run(7, history);
        assert.equal(run(7.5, history).notifications.length, 0);
    });

    it('host, na ktorym zadanie nigdy sie nie wykonalo - bez kontroli', () => {
        const r = runner()(7, [done(-26, -21, 'AUTOBACKUP', 'B')]);
        assert.equal(r.checks.length, 0);
    });

    it('koniec po terminie w pierwszym ekstrakcie -> INFO, bez WARNING', () => {
        const r = runner()(9, [...history, done(-2, 7)]);
        assert.deepEqual(r.notifications.map(n => n.level), ['INFO']);
        assert.equal(today(r.checks)[0].state, 'COMPLETED_LATE');
    });

    it('days: termin tylko w wybrane dni (AUDIT w niedziele; 2026-11-12 to czwartek)', () => {
        const r = runner()(7, [done(-100, -99, 'AUDIT')]);
        assert.equal(r.checks.filter(c => c.task === 'AUDIT').length, 0);
    });
});

describe('--task-times', () => {
    it('srednia godzina po okregu (wokol polnocy)', () => {
        const c = clockStats([23 * 60 + 50, 10, 30]);
        assert.equal(Math.round(c.mean), 10);
        assert.equal(Math.round(c.max), 30);
        assert.equal(Math.round(c.min), -10); // 23:50 = -10 min wzgledem polnocy
    });

    it('raport i sugestia expectedEnd', () => {
        const txt = formatTaskTimes([done(-26, -21), done(-2, 4), done(-50, -45)], d, 'UTC');
        assert.match(txt, /AUTOBACKUP\s+SYS1\/A\s+3\s+3\s+22:00\s+03:20\s+04:00\s+04:00\s+5 h 20 min\s+6 h 00 min\s+06:00/);
        assert.match(txt, /"AUTOBACKUP": \{ \.\.\., "expectedEnd": "04:30" \}/);
    });
});

describe('cli: dwa ekstrakty, SQLite', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-chk-'));
    after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const conf = path.join(tmp, 'hsm-map.json');
    fs.writeFileSync(conf, JSON.stringify({
        timezone: 'UTC',
        messages: {
            ARC0720I: { pattern: '^AUTOMATIC BACKUP STARTING', time: { fallback: 'next' } },
            ARC0721I: { pattern: '^AUTOMATIC BACKUP ENDING' },
            ARC0722I: { pattern: 'VOLUME (?<volser>\\S+)\\S* AT (?<time>[\\d:]+) ON (?<date>[\\d/]+)', extract: { volser: 'tag' } },
            ARC0723I: { pattern: 'VOLUME (?<volser>\\S+) AT (?<time>[\\d:]+), (?<n>\\d+) DATA', extract: { volser: 'tag', n: 'int' } },
        },
        durations: { tasks: { AUTOBACKUP: { start: 'ARC0720I', end: { ARC0721I: 'OK' }, expectedEnd: '06:00',
            aggregate: { volumes: { op: 'count', msg: 'ARC0723I' }, datasets: { op: 'sum', msg: 'ARC0723I', value: 'n' } } } } },
    }));
    const file = (name: string, lines: string[]) => {
        const f = path.join(tmp, name);
        fs.writeFileSync(f, lines.map((l, i) => `SYS1    ;${String(i + 1).padStart(8, '0')};${l}`).join('\n'));
        return f;
    };
    // 11-11: pelny przebieg (historia hosta i zadania)
    const f0 = file('HSMACT.HA.BAKLOG.D26315.T000000.txt', ['ARC0720I AUTOMATIC BACKUP STARTING',
        'ARC0722I BACKUP STARTING ON VOLUME P0(SMS) AT 01:00:00 ON 26/11/11 SYSTEM SYS1', 'ARC0723I BACKUP ENDING ON VOLUME P0 AT 02:00:00, 10 DATA', 'ARC0721I AUTOMATIC BACKUP ENDING']);
    // ekstrakt 1 (12-11 07:00): start 11-11 22:00, bez konca
    const f1 = file('HSMACT.HA.BAKLOG.D26315.T200000.txt', ['ARC0720I AUTOMATIC BACKUP STARTING',
        'ARC0722I BACKUP STARTING ON VOLUME P1(SMS) AT 22:00:00 ON 26/11/11 SYSTEM SYS1', 'ARC0723I BACKUP ENDING ON VOLUME P1 AT 23:30:00, 100 DATA']);
    // ekstrakt 2 (12-11 19:00): reszta i koniec
    const f2 = file('HSMACT.HA.BAKLOG.D26316.T080000.txt', ['ARC0722I BACKUP STARTING ON VOLUME P2(SMS) AT 08:00:00 ON 26/11/12 SYSTEM SYS1',
        'ARC0723I BACKUP ENDING ON VOLUME P2 AT 09:00:00, 50 DATA', 'ARC0721I AUTOMATIC BACKUP ENDING']);
    const db = path.join(tmp, 'state.db');
    const cli = async (...argv: string[]) => {
        let out = '';
        let err = '';
        const code = await main(['-c', conf, '--sqlite', db, ...argv], { out: t => void (out += t), err: t => void (err += t) });
        return { code, out, err };
    };

    it('WARNING po 1. ekstrakcie, punkt czasu trwania po 2. (start z SQLite), --task-times', async () => {
        assert.equal((await cli('--out', path.join(tmp, 'a.lp'), '--as-of', '2026-11-11T12:00:00Z', f0)).code, EXIT.OK);

        const r1 = await cli('--out', path.join(tmp, 'b.lp'), '--as-of', '2026-11-12T07:00:00Z', f1);
        assert.equal(r1.code, EXIT.TASK_WARNING, r1.err);
        assert.match(r1.err, /HSM-W AUTOBACKUP SYS1\/A \(termin 2026-11-12 06:00\): brak konca - w toku od 2026-11-11 22:00/);
        assert.match(fs.readFileSync(path.join(tmp, 'b.lp'), 'utf8'), /^MF\.HSM\.TASK_CHECK,host_id=A,level=WARNING,state=RUNNING,sysname=SYS1,task=AUTOBACKUP events=1i,level_num=1i/m);

        const r2 = await cli('--out', path.join(tmp, 'c.lp'), '--as-of', '2026-11-12T19:00:00Z', f2);
        assert.equal(r2.code, EXIT.OK, r2.err);
        assert.match(r2.err, /HSM-I AUTOBACKUP SYS1\/A \(termin 2026-11-12 06:00\): zakonczone po terminie o 2026-11-12 09:00/);
        const lp = fs.readFileSync(path.join(tmp, 'c.lp'), 'utf8');
        assert.match(lp, /MF\.HSM\.DURATION,host_id=A,status=OK,sysname=SYS1,task=AUTOBACKUP events=1i,duration=39600i,exact=false,volumes=2i,datasets=150i/);
        assert.match(lp, /MF\.HSM\.TASK_CHECK,host_id=A,level=OK,state=COMPLETED_LATE/);

        const tt = await cli('--task-times');
        assert.equal(tt.code, EXIT.OK, tt.err);
        assert.match(tt.out, /AUTOBACKUP\s+SYS1\/A\s+2 /);
    });

    it('bez --sqlite: kontrola pominieta z uwaga', async () => {
        let err = '';
        await main(['-c', conf, '--dry-run', f2], { out: () => undefined, err: t => void (err += t) });
        assert.match(err, /kontrola expectedEnd pominieta - wymaga --sqlite/);
    });
});
