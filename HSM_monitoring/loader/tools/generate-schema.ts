/** Generuje schematy JSON konfiguracji (podpowiedzi i walidacja w VS Code przez "$schema") */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ConfigSchema, InfluxSelectSchema, MessageFileSchema } from '../src/config';
import { DurationsSchema } from '../src/durations';

const dir = path.join(__dirname, '..', 'config');
const schemas: [string, string, z.ZodType][] = [
    ['hsm-map.schema.json', 'HSM ARC* -> InfluxDB: ustawienia ogolne', ConfigSchema],
    ['hsm-messages.schema.json', 'HSM ARC*: mapowanie komunikatow jednej grupy (member)', MessageFileSchema],
    ['influx-select.schema.json', 'HSM ARC*: include / exclude dla InfluxDB', InfluxSelectSchema],
    ['durations.schema.json', 'HSM ARC*: zadania start / koniec (czas trwania)', DurationsSchema],
];
for (const [file, title, schema] of schemas) {
    const json = z.toJSONSchema(schema, { io: 'input', target: 'draft-07' });
    fs.writeFileSync(path.join(dir, file), `${JSON.stringify({ title, ...json }, null, 2)}\n`);
    console.log(`Zapisano config/${file}`);
}
