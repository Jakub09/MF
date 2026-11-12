import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { compileConfig, ConfigError, groupNames, loadConfig } from '../src/config';

const msg = (pattern: string, extract: Record<string, unknown>) => ({ pattern, extract });

describe('konfiguracja', () => {
    it('config/hsm-map.json jest poprawny', () => {
        const cfg = loadConfig(path.join(__dirname, '..', 'config', 'hsm-map.json'));
        assert.ok(cfg.messages.size > 50);
        assert.ok(cfg.messages.has('ARC0723I'));
        assert.ok(cfg.disabled.has('ARC1807I'));
    });

    it('wartosci domyslne', () => {
        const cfg = compileConfig({ messages: { ARC0720I: {} } });
        assert.equal(cfg.timezone, 'UTC');
        assert.equal(cfg.defaultMeasurement, 'MF.HSM.EVENT');
        assert.deepEqual(cfg.commonTags, ['sysname', 'host_id', 'log_type', 'msg_id']);
        assert.equal(cfg.countField, 'events');
        assert.equal(cfg.messages.get('ARC0720I')!.timeFallback, 'previous');
        assert.equal(cfg.messages.get('ARC0720I')!.onNoMatch, 'warn');
    });

    it('grupy "time" / "date" sa domyslnym zrodlem czasu', () => {
        const cfg = compileConfig({ messages: { ARC0723I: { pattern: 'AT (?<time>\\S+) ON (?<date>\\S+)' } } });
        const m = cfg.messages.get('ARC0723I')!;
        assert.equal(m.timeGroup, 'time');
        assert.equal(m.dateGroup, 'date');
    });

    it('groupNames', () => {
        assert.deepEqual([...groupNames('(?<a>x)(?:y)(?<b_2>z)')], ['a', 'b_2']);
    });

    const rejects = (input: unknown, fragment: RegExp) =>
        assert.throws(() => compileConfig(input), (err: Error) => err instanceof ConfigError && fragment.test(err.message));

    it('brak grupy we wzorcu', () => {
        rejects({ messages: { ARC0723I: msg('(?<volser>\\S+)', { volume: 'tag' }) } }, /extract\.volume: brak grupy/);
    });
    it('niepoprawny regex', () => {
        rejects({ messages: { ARC0723I: msg('(?<a>[', {}) } }, /niepoprawny regex/);
    });
    it('nieznana strefa', () => {
        rejects({ timezone: 'Mars/Olympus', messages: {} }, /nieznana strefa/);
    });
    it('zle ID komunikatu i nieznany typ', () => {
        rejects({ messages: { XYZ: {} } }, /ID komunikatu/);
        rejects({ messages: { ARC0723I: msg('(?<a>x)', { a: 'number' }) } }, /extract\.a/);
    });
    it('ta sama nazwa raz tagiem, raz polem w jednym measurement', () => {
        rejects({
            messages: {
                ARC0722I: msg('(?<rc>\\d+)', { rc: 'tag' }),
                ARC0723I: msg('(?<rc>\\d+)', { rc: 'int' }),
            },
        }, /"rc" w measurement MF\.HSM\.EVENT jest "int", a w ARC0722I "tag"/);
    });
    it('rozne typy pola w jednym measurement', () => {
        rejects({
            messages: {
                ARC0722I: msg('(?<n>\\d+)', { n: 'int' }),
                ARC0723I: msg('(?<n>\\d+)', { n: 'float' }),
            },
        }, /InfluxDB odrzuci/);
    });
    it('rozne measurementy - brak konfliktu', () => {
        assert.doesNotThrow(() => compileConfig({
            messages: {
                ARC0722I: { ...msg('(?<n>\\d+)', { n: 'int' }), measurement: 'A' },
                ARC0723I: { ...msg('(?<n>\\d+)', { n: 'float' }), measurement: 'B' },
            },
        }));
    });
    it('kolizja z tagiem wspolnym', () => {
        rejects({ messages: { ARC0722I: msg('(?<msg_id>\\S+)', { msg_id: 'tag' }) } }, /zarezerwowana/);
    });
    it('nieznana opcja (literowka)', () => {
        rejects({ messages: { ARC0722I: { patern: 'x' } } }, /patern|Unrecognized/);
    });
});
