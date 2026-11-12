import { compileConfig, CompiledConfig, ConfigInput } from '../src/config';
import { mapEvents } from '../src/mapper';
import { parseEvents, SourceMeta } from '../src/parse';

export function config(messages: ConfigInput['messages'], extra: Partial<ConfigInput> = {}): CompiledConfig {
    return compileConfig({ timezone: 'UTC', ...extra, messages });
}

/** Linie "TEKST KOMUNIKATU" -> rekordy SYS1;GROUPID;... z kolejnymi GROUP ID */
export function records(...texts: string[]): string {
    return texts.map((t, i) => `SYS1    ;${String(i + 1).padStart(8, '0')};${t}`).join('\n');
}

export function run(cfg: CompiledConfig, content: string, meta: Partial<SourceMeta> = {}) {
    const parsed = parseEvents(content);
    return mapEvents(parsed.events, { source: 'test', hostId: 'A', logType: 'BAKLOG', ...meta }, cfg);
}

export const iso = (ms: number) => new Date(ms).toISOString();
