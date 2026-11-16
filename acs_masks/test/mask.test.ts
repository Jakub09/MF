import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { digitMask, MaskError, matches, parseMask } from '../src/mask';

const m = (mask: string, dsn: string) => matches(parseMask(mask), dsn);

describe('maski FILTLIST', () => {
    it('literal', () => {
        assert.ok(m('SYS1.LINKLIB', 'SYS1.LINKLIB'));
        assert.ok(!m('SYS1.LINKLIB', 'SYS1.LINKLIB.X'));
    });
    it('** - zero lub wiecej kwalifikatorow', () => {
        assert.ok(m('PROD.**', 'PROD'));
        assert.ok(m('PROD.**', 'PROD.A.B'));
        assert.ok(m('PROD.**.LOAD', 'PROD.LOAD'));
        assert.ok(m('PROD.**.LOAD', 'PROD.X.Y.LOAD'));
        assert.ok(!m('PROD.**.LOAD', 'PROD.X.LOADX'));
        assert.ok(m('**', 'A.B'));
    });
    it('* - jeden kwalifikator albo znaki w kwalifikatorze', () => {
        assert.ok(m('*.**.LOAD', 'A.LOAD'));
        assert.ok(!m('*.**.LOAD', 'LOAD'));
        assert.ok(m('PROD.*', 'PROD.X'));
        assert.ok(!m('PROD.*', 'PROD.X.Y'));
        assert.ok(m('PROD.TMP*', 'PROD.TMP'));
        assert.ok(m('PROD.TMP*', 'PROD.TMP123'));
        assert.ok(m('PROD.*TMP', 'PROD.XTMP'));
    });
    it('% - dokladnie jeden znak', () => {
        assert.ok(m('PROD.D%%%', 'PROD.D123'));
        assert.ok(!m('PROD.D%%%', 'PROD.D12'));
        assert.ok(!m('PROD.D%%%', 'PROD.D1234'));
    });
    it('znaki specjalne w nazwie', () => {
        assert.ok(m('A$B.#X.@Y', 'A$B.#X.@Y'));
        assert.ok(m('A$B.**', 'A$B.C'));
    });
    it('bledne maski', () => {
        assert.throws(() => parseMask('A..B'), MaskError);
        assert.throws(() => parseMask('A.ABCDEFGHI'), MaskError);
        assert.throws(() => parseMask('A.B**'), MaskError);
        assert.throws(() => parseMask(''), MaskError);
    });
    it('digitMask', () => {
        assert.equal(digitMask('D241113'), 'D%%%%%%');
        assert.equal(digitMask('G0001V00'), 'G%%%%V%%');
        assert.equal(digitMask('LOAD'), null);
    });
});
