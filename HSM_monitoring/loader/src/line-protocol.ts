/**
 * Punkt InfluxDB 1.x w formacie line protocol (precyzja ns).
 * https://docs.influxdata.com/influxdb/v1/write_protocols/line_protocol_reference/
 */
import type { FieldValue, MappedEvent } from './mapper';

const escMeasurement = (s: string) => s.replace(/[, ]/g, m => `\\${m}`);
const escKey = (s: string) => s.replace(/[,= ]/g, m => `\\${m}`);
const escString = (s: string) => s.replace(/[\\"]/g, m => `\\${m}`);

function fieldValue(f: FieldValue): string {
    switch (f.type) {
        case 'int': return `${Math.trunc(f.value as number)}i`;
        case 'float': return String(f.value);
        case 'bool': return f.value ? 'true' : 'false';
        case 'string': return `"${escString(String(f.value))}"`;
    }
}

/**
 * Czas w ns. Przy uniqueTimestamps GROUP ID (mod 1e6) trafia do czesci nanosekundowej - zdarzenia
 * z ta sama sekunda (np. ARC0734I z czasem zastepczym) nie nadpisuja sie, a ponowny import tego
 * samego pliku daje te same punkty (idempotentnie).
 */
export function timestampNs(e: MappedEvent, uniqueTimestamps: boolean): bigint {
    const offset = uniqueTimestamps ? BigInt(Number(e.raw.groupId) % 1_000_000) : 0n;
    return BigInt(e.timeMs) * 1_000_000n + offset;
}

export function toLine(e: MappedEvent, uniqueTimestamps: boolean): string {
    const tags = Object.keys(e.tags).sort()
        .filter(k => e.tags[k] !== '')
        .map(k => `,${escKey(k)}=${escKey(e.tags[k])}`)
        .join('');
    const fields = Object.entries(e.fields).map(([k, v]) => `${escKey(k)}=${fieldValue(v)}`).join(',');
    return `${escMeasurement(e.measurement)}${tags} ${fields} ${timestampNs(e, uniqueTimestamps)}`;
}
