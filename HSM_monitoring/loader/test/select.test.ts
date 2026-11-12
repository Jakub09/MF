import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { compileConfig, ConfigError, loadConfig } from '../src/config';
import { records, run } from './helpers';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-select-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Katalog konfiguracji: { "plik.json": obiekt } */
function configDir(name: string, files: Record<string, unknown>): string {
    const dir = path.join(tmp, name);
    for (const [file, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), JSON.stringify(content));
    }
    return path.join(dir, 'hsm-map.json');
}

const rc = { pattern: 'RC=(?<rc>\\d+)', extract: { rc: 'int' } };
const memberFiles = {
    'messages/BACKUP.json': { messages: { ARC0720I: {}, ARC0721I: {}, ARC0570I: rc } },
    'messages/VOLBKP.json': { member: 'VOLBKP', messages: { ARC0722I: {}, ARC0570I: rc } },
};

describe('messageFiles', () => {
    it('wczytuje pliki membrow, grupy = nazwa pliku / member', () => {
        const cfg = loadConfig(configDir('ok', { 'hsm-map.json': { messageFiles: ['messages/*.json'] }, ...memberFiles }));
        assert.deepEqual([...cfg.messages.keys()].sort(), ['ARC0570I', 'ARC0720I', 'ARC0721I', 'ARC0722I']);
        assert.deepEqual([...cfg.groups.get('BACKUP')!].sort(), ['ARC0570I', 'ARC0720I', 'ARC0721I']);
        assert.ok(cfg.groups.has('VOLBKP'));
        assert.match(cfg.messages.get('ARC0720I')!.origin, /messages[/\\]BACKUP\.json/);
    });

    it('ten sam komunikat w dwoch plikach z rozna definicja -> blad', () => {
        const file = configDir('dup', {
            'hsm-map.json': { messageFiles: ['messages/*.json'] },
            'messages/A.json': { messages: { ARC0570I: rc } },
            'messages/B.json': { messages: { ARC0570I: { ...rc, extract: { rc: 'float' } } } },
        });
        assert.throws(() => loadConfig(file), /ARC0570I: rozne definicje w messages.A\.json i messages.B\.json/);
    });

    it('bledy w pliku membra wskazuja plik', () => {
        const file = configDir('bad', {
            'hsm-map.json': { messageFiles: ['messages/*.json', 'brak.json'] },
            'messages/X.json': { messages: { ARC0720I: { pattern: '(?<a>x)', extract: { b: 'int' } } } },
        });
        assert.throws(() => loadConfig(file), (err: Error) => err instanceof ConfigError
            && /messages.X\.json: messages\.ARC0720I\.extract\.b: brak grupy/.test(err.message)
            && /"brak\.json" nie wskazuje zadnego pliku/.test(err.message));
    });
});

describe('influx-select', () => {
    const files = (select: unknown) => ({
        'hsm-map.json': { messageFiles: ['messages/*.json'], influxSelect: 'influx-select.json' },
        'influx-select.json': select,
        ...memberFiles,
    });

    it('brak wyboru = wszystko do InfluxDB', () => {
        const cfg = loadConfig(configDir('none', { 'hsm-map.json': { messageFiles: ['messages/*.json'] }, ...memberFiles }));
        assert.ok(['ARC0720I', 'ARC0722I', 'ARC9999I'].every(cfg.toInflux));
    });

    it('include grupami i wzorcami, exclude ma pierwszenstwo', () => {
        const cfg = loadConfig(configDir('sel', files({ include: ['@BACKUP', 'ARC07*'], exclude: ['ARC0570I', 'arc0721i'] })));
        assert.deepEqual(['ARC0720I', 'ARC0721I', 'ARC0722I', 'ARC0570I', 'ARC1801I'].map(cfg.toInflux),
            [true, false, true, false, false]);
    });

    it('nieznana grupa i zly wpis -> blad; ID bez mapowania -> ostrzezenie', () => {
        assert.throws(() => loadConfig(configDir('err', files({ include: ['@NIEMA', 'ARC 1'] }))),
            (err: Error) => /"@NIEMA": nieznana grupa \(znane: BACKUP, VOLBKP\)/.test(err.message) && /"ARC 1": oczekiwano/.test(err.message));
        const cfg = loadConfig(configDir('warn', files({ include: ['ARC0999I'] })));
        assert.match(cfg.warnings[0], /ARC0999I.*bez mapowania/);
    });

    it('--select nadpisuje wybor z konfiguracji', () => {
        const file = configDir('override', files({ include: ['ARC0720I'] }));
        const other = path.join(tmp, 'other-select.json');
        fs.writeFileSync(other, JSON.stringify({ exclude: ['ARC0720I'] }));
        const cfg = loadConfig(file, { selectFile: other });
        assert.equal(cfg.toInflux('ARC0720I'), false);
        assert.equal(cfg.toInflux('ARC0722I'), true);
    });

    it('wybor inline i flaga influx w zdarzeniach', () => {
        const cfg = compileConfig({ timezone: 'UTC', messages: { ARC0720I: {}, ARC0721I: {} }, influxSelect: { exclude: ['ARC0721I'] } });
        const r = run(cfg, records('ARC0720I AUTOMATIC BACKUP STARTING', 'ARC0721I AUTOMATIC BACKUP ENDING'),
            { fileDate: { y: 2026, m: 1, d: 1 }, fileMsOfDay: 0 });
        assert.deepEqual(r.events.map(e => e.influx), [true, false]);
        assert.equal(r.stats.get('ARC0721I')!.mapped, 1);
        assert.equal(r.stats.get('ARC0721I')!.influx, 0);
    });
});

describe('config/ projektu', () => {
    const cfg = loadConfig(path.join(__dirname, '..', 'config', 'hsm-map.json'));
    const memberDir = path.join(__dirname, '..', '..', 'members');

    it('kazdy komunikat z ../members/*.txt ma mapowanie w messages/<MEMBER>.json', () => {
        for (const f of fs.readdirSync(memberDir)) {
            const member = path.basename(f, '.txt');
            const ids = fs.readFileSync(path.join(memberDir, f), 'utf8').split(/\r?\n/).filter(l => l.trim()).map(l => l.slice(0, 8).trim());
            assert.deepEqual([...(cfg.groups.get(member) ?? [])].sort(), ids.sort(), `member ${member}`);
        }
    });

    it('ARC0734I i ARC0640I tylko w SQLite, reszta do InfluxDB', () => {
        const notInflux = [...cfg.messages.keys()].filter(id => !cfg.toInflux(id)).sort();
        assert.deepEqual(notInflux, ['ARC0640I', 'ARC0734I']);
    });
});
