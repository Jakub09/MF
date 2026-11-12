import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { config, iso, records, run } from './helpers';

describe('mapEvents - wartosci', () => {
    const cfg = config({
        ARC0734I: {
            measurement: 'MF.HSM.DSACTION',
            pattern: '^ACTION=(?<action>\\S+)\\s+TRACKS=\\s*(?<tracks>\\d+)\\s+RC=\\s*(?<rc>[^,\\s]+)(?:,\\s*DSN=(?<dsn>\\S+))?(?<held>\\s+HELD)?',
            extract: {
                action: { to: 'tag', map: { MIGRATE: 'MIG' } },
                tracks: 'int',
                rc: { to: 'float', name: 'return_code' },
                dsn: { to: 'sqlite', default: 'BRAK' },
                held: 'bool',
            },
            constTags: { area: 'DS' },
        },
    });

    it('tag z mapa, int, float pod inna nazwa, sqlite, bool, stale tagi', () => {
        const r = run(cfg, records('ARC0734I ACTION=MIGRATE TRACKS=     150 RC=   0, DSN=A.B.C HELD'), {
            fileDate: { y: 2026, m: 11, d: 3 }, fileMsOfDay: 0,
        });
        assert.equal(r.issues.length, 0);
        const e = r.events[0];
        assert.equal(e.measurement, 'MF.HSM.DSACTION');
        assert.deepEqual(e.tags, { sysname: 'SYS1', host_id: 'A', log_type: 'BAKLOG', msg_id: 'ARC0734I', area: 'DS', action: 'MIG' });
        assert.deepEqual(e.fields, {
            events: { type: 'int', value: 1 },
            tracks: { type: 'int', value: 150 },
            return_code: { type: 'float', value: 0 },
            held: { type: 'bool', value: true },
        });
        assert.deepEqual(e.extra, { dsn: 'A.B.C' });
    });

    it('brak grupy: default dla sqlite, false dla bool', () => {
        const r = run(cfg, records('ARC0734I ACTION=RECALL TRACKS=1 RC=4'), { fileDate: { y: 2026, m: 1, d: 1 }, fileMsOfDay: 0 });
        assert.deepEqual(r.events[0].extra, { dsn: 'BRAK' });
        assert.deepEqual(r.events[0].fields.held, { type: 'bool', value: false });
    });

    it('bledna wartosc liczbowa -> problem, punkt bez tego pola', () => {
        const r = run(cfg, records('ARC0734I ACTION=X TRACKS=1 RC=abc'), { fileDate: { y: 2026, m: 1, d: 1 }, fileMsOfDay: 0 });
        assert.equal(r.issues.length, 1);
        assert.equal(r.issues[0].kind, 'value');
        assert.equal(r.events[0].fields.return_code, undefined);
    });
});

describe('mapEvents - multiply', () => {
    it('sciezki 3390 -> bajty; multiply tylko dla int / float', () => {
        const cfg = config({ ARC0523I: { pattern: '(?<tracks>\\d+) TRACK', extract: { tracks: { to: 'int', name: 'freed_bytes', multiply: 56664 } } } });
        const r = run(cfg, records('ARC0523I 100 TRACK(S) FREED'), { fileDate: { y: 2026, m: 1, d: 1 }, fileMsOfDay: 0 });
        assert.deepEqual(r.events[0].fields.freed_bytes, { type: 'int', value: 5_666_400 });
        assert.throws(() => config({ ARC0523I: { pattern: '(?<t>\\d+)', extract: { t: { to: 'tag', multiply: 2 } } } }), /multiply tylko dla int/);
    });
});

describe('mapEvents - niedopasowane i nieznane', () => {
    const meta = { fileDate: { y: 2026, m: 1, d: 1 }, fileMsOfDay: 0 };
    const spec = (onNoMatch: 'skip' | 'warn' | 'count') => config({ ARC0720I: { pattern: '^AUTOMATIC BACKUP STARTING', onNoMatch } });

    it('warn: pominiety i zgloszony', () => {
        const r = run(spec('warn'), records('ARC0720I COS INNEGO'), meta);
        assert.equal(r.events.length, 0);
        assert.equal(r.issues[0].kind, 'no-match');
        assert.equal(r.stats.get('ARC0720I')!.noMatch, 1);
    });
    it('skip: pominiety po cichu', () => {
        const r = run(spec('skip'), records('ARC0720I COS INNEGO'), meta);
        assert.equal(r.events.length + r.issues.length, 0);
    });
    it('count: punkt tylko z tagami wspolnymi', () => {
        const r = run(spec('count'), records('ARC0720I COS INNEGO'), meta);
        assert.equal(r.events.length, 1);
        assert.equal(r.events[0].matched, false);
    });
    it('komunikat spoza konfiguracji: skip / count', () => {
        assert.equal(run(spec('warn'), records('ARC9999I X'), meta).stats.get('ARC9999I')!.skipped, 1);
        const cfg = config({}, { defaults: { unknownMessages: 'count' } });
        const r = run(cfg, records('ARC9999I X'), meta);
        assert.equal(r.events[0].measurement, 'MF.HSM.EVENT');
        assert.equal(r.events[0].tags.msg_id, 'ARC9999I');
    });
    it('enabled=false traktowany jak nieznany', () => {
        const cfg = config({ ARC0720I: { enabled: false } });
        assert.equal(run(cfg, records('ARC0720I AUTOMATIC BACKUP STARTING'), meta).events.length, 0);
    });
    it('pierwszy pasujacy wzorzec z listy', () => {
        const cfg = config({ ARC0640I: { pattern: ['RC (?<rc>\\d+)', '^(?<task>\\S+)'], extract: { rc: 'int', task: 'tag' } } });
        const r = run(cfg, records('ARC0640I ARCDV001 ADR013I RC 4', 'ARC0640I ARCDV001 ADR006I'), meta);
        assert.deepEqual(r.events.map(e => [e.fields.rc?.value, e.tags.task]), [[4, undefined], [undefined, 'ARCDV001']]);
    });
});

describe('mapEvents - czas', () => {
    const cfg = config({
        ARC0720I: { pattern: '^AUTOMATIC BACKUP STARTING', time: { fallback: 'next' } },
        ARC0721I: { pattern: '^AUTOMATIC BACKUP ENDING' },
        ARC0722I: { pattern: 'AT (?<time>[\\d:]+) ON (?<date>[\\d/.]+)' },
        ARC0723I: { pattern: 'AT (?<time>[\\d:]+)' },
        ARC0734I: { pattern: 'X', time: { fallback: 'file' } },
        ARC0640I: { pattern: '(?<d>\\d{4}\\.\\d{3}) (?<t>[\\d:]+)', time: { time: 't', date: 'd' } },
    }, { timezone: 'Europe/Warsaw' });
    const meta = { fileDate: { y: 2026, m: 11, d: 3 }, fileMsOfDay: 0 };

    it('czas z tresci, data dziedziczona, przejscie przez polnoc', () => {
        const r = run(cfg, records(
            'ARC0722I BACKUP STARTING ON VOLUME A AT 23:50:00 ON 26/11/03',
            'ARC0723I BACKUP ENDING ON VOLUME A AT 23:55:00',
            'ARC0723I BACKUP ENDING ON VOLUME B AT 00:10:00',
            'ARC0723I BACKUP ENDING ON VOLUME C AT 00:20:00',
        ), meta);
        assert.deepEqual(r.events.map(e => iso(e.timeMs)), [
            '2026-11-03T22:50:00.000Z', '2026-11-03T22:55:00.000Z', '2026-11-03T23:10:00.000Z', '2026-11-03T23:20:00.000Z',
        ]);
    });

    it('fallback next / previous / file', () => {
        const r = run(cfg, records(
            'ARC0720I AUTOMATIC BACKUP STARTING',
            'ARC0722I BACKUP STARTING ON VOLUME A AT 02:00:00 ON 26/11/03',
            'ARC0734I X',
            'ARC0721I AUTOMATIC BACKUP ENDING',
        ), meta);
        assert.deepEqual(r.events.map(e => [e.raw.msgId, e.timeSource, iso(e.timeMs)]), [
            ['ARC0720I', 'next', '2026-11-03T01:00:00.000Z'],
            ['ARC0722I', 'message', '2026-11-03T01:00:00.000Z'],
            ['ARC0734I', 'file', '2026-11-02T23:00:00.000Z'],
            ['ARC0721I', 'previous', '2026-11-03T01:00:00.000Z'],
        ]);
    });

    it('next bez pozniejszego czasu -> previous -> plik', () => {
        const r = run(cfg, records('ARC0720I AUTOMATIC BACKUP STARTING'), meta);
        assert.equal(r.events[0].timeSource, 'file');
    });

    it('brak jakiegokolwiek czasu -> pominiety z problemem', () => {
        const r = run(cfg, records('ARC0721I AUTOMATIC BACKUP ENDING'), {});
        assert.equal(r.events.length, 0);
        assert.equal(r.issues[0].kind, 'time');
        assert.equal(r.stats.get('ARC0721I')!.noTime, 1);
    });

    it('wlasne grupy czasu (data julianska DSS)', () => {
        const r = run(cfg, records('ARC0640I ARCDV001 ADR006I (001)-STEND(01), 2026.307 02:00:06 EXECUTION BEGINS'), meta);
        assert.equal(iso(r.events[0].timeMs), '2026-11-03T01:00:06.000Z');
    });

    it('niepoprawna data w tresci -> fallback i problem', () => {
        const r = run(cfg, records('ARC0722I BACKUP STARTING ON VOLUME A AT 02:00:00 ON 26/13/45'), meta);
        assert.equal(r.events[0].timeSource, 'file');
        assert.equal(r.issues[0].kind, 'time');
    });
});
