import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseDate, parseDuration, parseTimeOfDay, zonedToEpochMs } from '../src/time';

describe('parseDate', () => {
    it('yy/mm/dd i yyyy/mm/dd', () => {
        assert.deepEqual(parseDate('26/11/03'), { y: 2026, m: 11, d: 3 });
        assert.deepEqual(parseDate('2026/11/03'), { y: 2026, m: 11, d: 3 });
        assert.deepEqual(parseDate('2026-11-03'), { y: 2026, m: 11, d: 3 });
    });
    it('data julianska', () => {
        assert.deepEqual(parseDate('2026.307'), { y: 2026, m: 11, d: 3 });
        assert.deepEqual(parseDate('26307'), { y: 2026, m: 11, d: 3 });
        assert.deepEqual(parseDate('24366'), { y: 2024, m: 12, d: 31 });
    });
    it('niepoprawne daty', () => {
        assert.equal(parseDate('26/02/30'), null);
        assert.equal(parseDate('25366'), null);
        assert.equal(parseDate('xx'), null);
    });
});

describe('parseTimeOfDay / parseDuration', () => {
    it('godzina', () => {
        assert.equal(parseTimeOfDay('01:02:03'), 3_723_000);
        assert.equal(parseTimeOfDay('010203'), 3_723_000);
        assert.equal(parseTimeOfDay('01:02:03.5'), 3_723_500);
        assert.equal(parseTimeOfDay('24:00:00'), null);
    });
    it('czas trwania', () => {
        assert.equal(parseDuration('00:12:31'), 751);
        assert.equal(parseDuration('30:00:00'), 108_000);
        assert.equal(parseDuration('90'), 90);
        assert.equal(parseDuration('abc'), null);
    });
});

describe('zonedToEpochMs', () => {
    const d = (y: number, m: number, day: number) => ({ y, m, d: day });
    it('Europe/Warsaw zima (UTC+1) i lato (UTC+2)', () => {
        assert.equal(new Date(zonedToEpochMs(d(2026, 11, 3), 3_600_000, 'Europe/Warsaw')).toISOString(), '2026-11-03T00:00:00.000Z');
        assert.equal(new Date(zonedToEpochMs(d(2026, 7, 1), 3_600_000, 'Europe/Warsaw')).toISOString(), '2026-06-30T23:00:00.000Z');
    });
    it('dzien zmiany czasu', () => {
        // 2026-10-25 03:00 CEST -> 02:00 CET; 12:00 lokalnie = 11:00 UTC
        assert.equal(new Date(zonedToEpochMs(d(2026, 10, 25), 12 * 3_600_000, 'Europe/Warsaw')).toISOString(), '2026-10-25T11:00:00.000Z');
    });
    it('UTC bez zmian', () => {
        assert.equal(zonedToEpochMs(d(2026, 1, 1), 0, 'UTC'), Date.UTC(2026, 0, 1));
    });
});
