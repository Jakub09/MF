import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toLine } from '../src/line-protocol';
import type { MappedEvent } from '../src/mapper';

const event = (over: Partial<MappedEvent> = {}): MappedEvent => ({
    raw: { line: 1, sysname: 'SYS1', groupId: '00000042', msgId: 'ARC0741I', text: '', cont: [] },
    source: 'test',
    measurement: 'MF.HSM.EVENT',
    timeMs: Date.UTC(2026, 10, 3),
    timeSource: 'message',
    tags: { status: 'ENDED PRIOR, X=Y', msg_id: 'ARC0741I', empty: '' },
    fields: {
        events: { type: 'int', value: 1 },
        pct: { type: 'float', value: 85.5 },
        ok: { type: 'bool', value: false },
        text: { type: 'string', value: 'JOURNAL "I/O" \\ ERROR' },
    },
    extra: { dsn: 'NIE.DO.INFLUXA' },
    matched: true,
    influx: true,
    ...over,
});

describe('toLine', () => {
    it('escape, sortowanie tagow, typy pol, ns z GROUP ID', () => {
        assert.equal(toLine(event(), true),
            'MF.HSM.EVENT,msg_id=ARC0741I,status=ENDED\\ PRIOR\\,\\ X\\=Y '
            + 'events=1i,pct=85.5,ok=false,text="JOURNAL \\"I/O\\" \\\\ ERROR" 1793664000000000042');
    });
    it('bez uniqueTimestamps', () => {
        assert.match(toLine(event(), false), / 1793664000000000000$/);
    });
    it('spacja i przecinek w measurement', () => {
        assert.match(toLine(event({ measurement: 'MF HSM,X' }), true), /^MF\\ HSM\\,X,/);
    });
});
