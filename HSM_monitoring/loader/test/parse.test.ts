import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseEvents, sourceMeta, fullText } from '../src/parse';
import { compileConfig } from '../src/config';

describe('parseEvents', () => {
    it('skleja linie (CONT.) po SYSNAME + GROUP ID', () => {
        const { events, issues } = parseEvents([
            'SYS1    ;00002007;ARC0744E BCDS COULD NOT BE BACKED UP, RC=12, REAS=8',
            'SYS1    ;00002007;ARC0744E (CONT.) MIGRATION, BACKUP, FRBACKUP, DUMP, AND RECYCLE HELD',
            'SYS1    ;00002008;ARC0741I CDS BACKUP ENDING AT 00:31:20 ON 26/11/03, STATUS=UNSUCCESSFUL',
            '',
        ].join('\r\n'));
        assert.equal(issues.length, 0);
        assert.equal(events.length, 2);
        assert.equal(events[0].msgId, 'ARC0744E');
        assert.deepEqual(events[0].cont, ['MIGRATION, BACKUP, FRBACKUP, DUMP, AND RECYCLE HELD']);
        assert.equal(fullText(events[0]), 'BCDS COULD NOT BE BACKED UP, RC=12, REAS=8 MIGRATION, BACKUP, FRBACKUP, DUMP, AND RECYCLE HELD');
        assert.equal(events[1].line, 3);
    });

    it('ten sam GROUP ID na innym systemie to osobne zdarzenie', () => {
        const { events } = parseEvents('SYS1;00000001;ARC0720I AUTOMATIC BACKUP STARTING\nSYS2;00000001;ARC0720I AUTOMATIC BACKUP STARTING');
        assert.equal(events.length, 2);
    });

    it('zglasza rekordy w zlym formacie', () => {
        const { events, issues } = parseEvents('bez separatorow\nSYS1;ABC;ARC0720I X\nSYS1;00000001;IEF123I X\nSYS1;00000002;ARC0002I');
        assert.equal(events.length, 1);
        assert.equal(events[0].text, '');
        assert.deepEqual(issues.map(i => i.line), [1, 2, 3]);
    });

    it('zglasza powtorzony (niesasiadujacy) GROUP ID', () => {
        const { events, issues } = parseEvents('SYS1;00000001;ARC0720I A\nSYS1;00000002;ARC0721I B\nSYS1;00000001;ARC0720I C');
        assert.equal(events.length, 3);
        assert.match(issues[0].detail, /GROUP ID 00000001 powtorzony \(pierwszy raz w linii 1\)/);
    });
});

describe('sourceMeta', () => {
    const pattern = compileConfig({ messages: {} }).fileNamePattern;
    it('host_id, log_type i czas z nazwy zbioru', () => {
        const meta = sourceMeta('/data/in/HSMACT.HA.BAKLOG.D26307.T010000.txt', pattern);
        assert.equal(meta.source, 'HSMACT.HA.BAKLOG.D26307.T010000.txt');
        assert.equal(meta.hostId, 'A');
        assert.equal(meta.logType, 'BAKLOG');
        assert.deepEqual(meta.fileDate, { y: 2026, m: 11, d: 3 });
        assert.equal(meta.fileMsOfDay, 3_600_000);
    });
    it('male litery w nazwie pliku', () => {
        assert.equal(sourceMeta('hsmact.h1.miglog.d26001.t000000.csv', pattern).logType, 'MIGLOG');
    });
    it('nazwa bez wzorca', () => {
        const meta = sourceMeta('dane.txt', pattern);
        assert.equal(meta.hostId, undefined);
        assert.equal(meta.fileDate, undefined);
    });
});
