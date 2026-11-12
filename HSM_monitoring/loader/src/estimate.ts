/**
 * Szacunek przyrostu InfluxDB 1.x (TSM) dla danej konfiguracji na podstawie probki logow.
 *
 * Co liczymy dokladnie (z probki): punkty, wartosci pol wg typu, bajty line protocol, serie
 * (measurement + tagi), klucze TSM (seria + pole). Co szacujemy (model + wspolczynniki z ASSUMPTIONS):
 *
 *   dysk(T) = suma_typow wartosci(T) * B/wartosc[typ]           - dane TSM (czas + wartosc, po kompresji)
 *           + bajty stringow(T) * stringFactor                  - pola string (snappy)
 *           + shardy(T) * klucze_w_shardzie * (dl. klucza + keyIndexBytes)  - indeks TSM, osobny w kazdym shardzie
 *           + shardy(T) * (serie_w_shardzie * seriesIndexBytes + shardBytes)  - indeks TSI
 *
 * W TSM kazde pole jest osobna kolumna z wlasnymi znacznikami czasu, wiec koszt zalezy od liczby
 * wartosci pol, a nie punktow. Nieregularne czasy (zdarzenia) z nanosekundami z GROUP ID
 * (influx.uniqueTimestamps) kompresuja sie gorzej niz czasy w pelnych sekundach.
 */
import type { CompiledConfig, FieldType } from './config';
import { toLine } from './line-protocol';
import type { MappedEvent } from './mapper';

const DAY_MS = 86_400_000;

export interface Assumptions {
    /** Bajty na wartosc pola (czas + wartosc) po kompresji TSM */
    bytesPerValue: Record<FieldType, number>;
    /** Mnoznik bajtow tekstu pol string (kompresja snappy) */
    stringFactor: number;
    /** Narzut indeksu TSM na klucz (seria + pole) w kazdym shardzie, oprocz dlugosci klucza */
    keyIndexBytes: number;
    /** Narzut indeksu TSI na serie w kazdym shardzie */
    seriesIndexBytes: number;
    /** Staly narzut indeksu TSI na shard */
    shardBytes: number;
}

/**
 * Wspolczynniki zmierzone 2026-11-12 na InfluxDB 1.8.10 (TSI, po pelnej kompakcji, shard 7 dni, 53 shardy),
 * syntetyczne dane roczne o losowych czasach zdarzen:
 *   - rzadkie: 300 serii x 3 pola int, 2 zdarzenia / dobe / serie   -> TSM 12,45 MB (ns z GROUP ID) / 9,45 MB (sekundy)
 *   - geste (jak ARC0734I): 20 serii x 5 pol int, 2000 punktow / dobe -> TSM 32,1 MB / 8,7 MB
 *   - indeks TSI: 3,4 KB / shard + ok. 10 B / seria / shard
 * Model odtwarza oba scenariusze z ns z dokladnoscia ok. 2%. Przy czasach w sekundach koszt wartosci zalezy
 * od gestosci (2,2 B geste - 4,4 B rzadkie), przyjeto srodek - blad do ok. 50%.
 * int zmierzony; bool, float i string wyprowadzone (inna kompresja wartosci, ten sam koszt czasu) - do potwierdzenia.
 * Szczegoly: README.md, sekcja "Szacunek przyrostu".
 */
export const ASSUMPTIONS: { unique: Assumptions; seconds: Assumptions } = {
    unique: {
        bytesPerValue: { int: 8.7, float: 9.5, bool: 7.8, string: 8.7 },
        stringFactor: 0.5, keyIndexBytes: 43, seriesIndexBytes: 10, shardBytes: 3400,
    },
    seconds: {
        bytesPerValue: { int: 3.3, float: 4.1, bool: 2.4, string: 3.3 },
        stringFactor: 0.5, keyIndexBytes: 43, seriesIndexBytes: 10, shardBytes: 3400,
    },
};

/** Zuzycie w probce dla jednej grupy (calosc, measurement albo komunikat) */
export class Usage {
    points = 0;
    values: Record<FieldType, number> = { int: 0, float: 0, bool: 0, string: 0 };
    stringBytes = 0;
    lpBytes = 0;
    /** klucz serii -> pierwszy czas (ms) */
    series = new Map<string, number>();
    /** klucz TSM (seria + pole) -> pierwszy czas (ms) */
    keys = new Map<string, number>();

    add(e: MappedEvent, line: string, seriesKey: string): void {
        this.points++;
        this.lpBytes += Buffer.byteLength(line) + 1;
        const firstSeen = (m: Map<string, number>, k: string) => {
            const prev = m.get(k);
            if (prev === undefined || e.timeMs < prev) m.set(k, e.timeMs);
        };
        firstSeen(this.series, seriesKey);
        for (const [name, f] of Object.entries(e.fields)) {
            this.values[f.type]++;
            if (f.type === 'string') this.stringBytes += Buffer.byteLength(String(f.value));
            firstSeen(this.keys, `${seriesKey}#!~#${name}`);
        }
    }

    get valueCount(): number {
        return this.values.int + this.values.float + this.values.bool + this.values.string;
    }
}

export interface Sample {
    total: Usage;
    byMeasurement: Map<string, Usage>;
    byMessage: Map<string, Usage>;
    /** "measurement.tag" -> wartosc -> pierwszy czas (ms) */
    tagValues: Map<string, Map<string, number>>;
    minMs: number;
    maxMs: number;
}

const seriesKeyOf = (e: MappedEvent) =>
    `${e.measurement},${Object.keys(e.tags).sort().filter(k => e.tags[k] !== '').map(k => `${k}=${e.tags[k]}`).join(',')}`;

/** Tylko zdarzenia wybrane do InfluxDB (influx-select) */
export function collectSample(events: MappedEvent[], cfg: CompiledConfig): Sample {
    const sample: Sample = {
        total: new Usage(), byMeasurement: new Map(), byMessage: new Map(), tagValues: new Map(),
        minMs: Infinity, maxMs: -Infinity,
    };
    const group = (m: Map<string, Usage>, k: string) => {
        let u = m.get(k);
        if (!u) m.set(k, (u = new Usage()));
        return u;
    };
    for (const e of events) {
        if (!e.influx) continue;
        const line = toLine(e, cfg.uniqueTimestamps);
        const key = seriesKeyOf(e);
        sample.total.add(e, line, key);
        group(sample.byMeasurement, e.measurement).add(e, line, key);
        group(sample.byMessage, e.raw.msgId).add(e, line, key);
        for (const [tag, value] of Object.entries(e.tags)) {
            const k = `${e.measurement}.${tag}`;
            let values = sample.tagValues.get(k);
            if (!values) sample.tagValues.set(k, (values = new Map()));
            const prev = values.get(value);
            if (prev === undefined || e.timeMs < prev) values.set(value, e.timeMs);
        }
        sample.minMs = Math.min(sample.minMs, e.timeMs);
        sample.maxMs = Math.max(sample.maxMs, e.timeMs);
    }
    return sample;
}

export interface Projection {
    days: number;
    points: number;
    values: number;
    series: number;
    keys: number;
    lpBytes: number;
    diskBytes: number;
}

/**
 * Liczba kluczy po `days` dniach: to, co bylo w probce pierwszego dnia, + nowe klucze w tempie przybywania
 * w probce. Przy probce >= 4 dni tempo z drugiej polowy probki - rzadkie, ale ograniczone kombinacje tagow
 * (np. wynik FAILED na danym wolumenie) pojawiaja sie z czasem coraz rzadziej. Liniowa ekstrapolacja to wiec
 * gorna granica. Probka 1-dniowa: brak nowych serii (wartosci tagow sie powtarzaja).
 */
export function countAt(firstSeen: Map<string, number>, minMs: number, sampleDays: number, days: number): number {
    if (!firstSeen.size) return 0;
    let firstDay = 0;
    let secondHalf = 0;
    const half = Math.floor(sampleDays / 2);
    for (const t of firstSeen.values()) {
        if (t < minMs + DAY_MS) firstDay++;
        if (t >= minMs + (sampleDays - half) * DAY_MS) secondHalf++;
    }
    const perDay = sampleDays >= 4 ? secondHalf / half
        : sampleDays > 1 ? (firstSeen.size - firstDay) / (sampleDays - 1) : 0;
    return days >= sampleDays
        ? firstSeen.size + perDay * (days - sampleDays)
        : Math.min(firstSeen.size, firstDay + perDay * Math.max(0, days - 1));
}

/** withShardFixed = staly narzut TSI na shard (raz na baze - tylko dla calosci, nie dla measurementu / komunikatu) */
export function project(u: Usage, minMs: number, sampleDays: number, days: number, shardDays: number, a: Assumptions,
    withShardFixed = true): Projection {
    const f = days / sampleDays;
    const keys = countAt(u.keys, minMs, sampleDays, days);
    const series = countAt(u.series, minMs, sampleDays, days);
    const shards = Math.ceil(days / shardDays);
    const window = Math.min(days, shardDays);
    const keysPerShard = countAt(u.keys, minMs, sampleDays, window);
    const seriesPerShard = countAt(u.series, minMs, sampleDays, window);
    let keyLen = 0;
    for (const k of u.keys.keys()) keyLen += k.length;
    const avgKeyLen = u.keys.size ? keyLen / u.keys.size : 0;

    const valuesBytes = (Object.keys(u.values) as FieldType[]).reduce((s, t) => s + u.values[t] * f * a.bytesPerValue[t], 0);
    const diskBytes = valuesBytes
        + u.stringBytes * f * a.stringFactor
        + shards * keysPerShard * (avgKeyLen + a.keyIndexBytes)
        + shards * (seriesPerShard * a.seriesIndexBytes + (withShardFixed ? a.shardBytes : 0));
    return {
        days,
        points: u.points * f,
        values: u.valueCount * f,
        series,
        keys,
        lpBytes: u.lpBytes * f,
        diskBytes,
    };
}

/** Liczba dni, ktore reprezentuje probka */
export function sampleDaysOf(sample: Sample, fileDates: (string | undefined)[], override?: number): { days: number; source: string } {
    if (override) return { days: override, source: '--sample-days' };
    const dates = new Set(fileDates.filter((d): d is string => !!d));
    if (dates.size && dates.size === new Set(fileDates).size) return { days: dates.size, source: 'rozne daty w nazwach plikow' };
    if (!Number.isFinite(sample.minMs)) return { days: 1, source: 'brak danych - przyjeto 1' };
    return { days: Math.max(1, Math.ceil((sample.maxMs - sample.minMs) / DAY_MS)), source: 'rozpietosc czasu zdarzen' };
}

// --- Raport tekstowy ---

const nf = new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 0 });
const num = (n: number) => nf.format(Math.round(n));

export function bytes(n: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
        n /= 1024;
        i++;
    }
    return `${n.toFixed(i === 0 ? 0 : n < 10 ? 2 : 1).replace('.', ',')} ${units[i]}`;
}

const pad = (s: string, w: number) => s.padStart(w);

export interface EstimateOptions {
    periods: number[];
    shardDays: number;
    sampleDays: number;
    sampleSource: string;
    top: number;
}

export function formatEstimate(sample: Sample, cfg: CompiledConfig, o: EstimateOptions): string {
    const a = cfg.uniqueTimestamps ? ASSUMPTIONS.unique : ASSUMPTIONS.seconds;
    const p = (u: Usage, days: number, fixed = false) => project(u, sample.minMs, o.sampleDays, days, o.shardDays, a, fixed);
    const fx = (n: number, d = 1) => n.toFixed(d).replace('.', ',');
    const out: string[] = [];
    const year = o.periods[o.periods.length - 1];

    out.push(`Szacunek przyrostu InfluxDB - probka: ${o.sampleDays} d (${o.sampleSource}), shard ${o.shardDays} d, `
        + `uniqueTimestamps=${cfg.uniqueTimestamps ? 'tak' : 'nie'}`);
    if (!sample.total.points) {
        out.push('Brak punktow do InfluxDB w probce (sprawdz influx-select i pliki wejsciowe).');
        return out.join('\n');
    }

    const head = `${''.padEnd(28)}${o.periods.map(d => pad(`${d} d`, 14)).join('')}`;
    const proj = o.periods.map(d => p(sample.total, d, true));
    out.push('', head);
    const row = (label: string, f: (x: Projection) => string) => out.push(`${label.padEnd(28)}${proj.map(x => pad(f(x), 14)).join('')}`);
    row('punkty', x => num(x.points));
    row('wartosci pol', x => num(x.values));
    row('serie (gorna granica)', x => num(x.series));
    row('klucze TSM (gorna granica)', x => num(x.keys));
    row('line protocol (transfer)', x => bytes(x.lpBytes));
    row('dysk TSM + indeks (szac.)', x => bytes(x.diskBytes));
    row('  w tym staly narzut shardow', x => bytes(Math.ceil(x.days / o.shardDays) * a.shardBytes));

    out.push('', `Wg measurementu (${year} d):`);
    out.push(`  ${'MEASUREMENT'.padEnd(18)}${pad('punkty/d', 11)}${pad('pola/pkt', 9)}${pad('serie', 8)}${pad('dysk', 11)}${pad('udzial', 8)}`);
    const totalDisk = proj[proj.length - 1].diskBytes;
    for (const [m, u] of [...sample.byMeasurement].sort(([, x], [, y]) => p(y, year).diskBytes - p(x, year).diskBytes)) {
        const x = p(u, year);
        out.push(`  ${m.padEnd(18)}${pad(num(u.points / o.sampleDays), 11)}${pad(fx(u.valueCount / u.points), 9)}`
            + `${pad(num(x.series), 8)}${pad(bytes(x.diskBytes), 11)}${pad(`${fx(100 * x.diskBytes / totalDisk)}%`, 8)}`);
    }

    const msgs = [...sample.byMessage].map(([id, u]) => ({ id, u, x: p(u, year) })).sort((x, y) => y.x.diskBytes - x.x.diskBytes);
    out.push('', `Wg komunikatu (${year} d, najwieksze ${Math.min(o.top, msgs.length)} z ${msgs.length}):`);
    out.push(`  ${'MSG_ID'.padEnd(10)}${pad('punkty/d', 11)}${pad('wart./d', 10)}${pad('serie', 8)}${pad('dysk', 11)}${pad('udzial', 8)}  pola`);
    for (const { id, u, x } of msgs.slice(0, o.top)) {
        const fields = new Set([...u.keys.keys()].map(k => k.slice(k.indexOf('#!~#') + 4)));
        out.push(`  ${id.padEnd(10)}${pad(num(u.points / o.sampleDays), 11)}${pad(num(u.valueCount / o.sampleDays), 10)}`
            + `${pad(num(x.series), 8)}${pad(bytes(x.diskBytes), 11)}${pad(`${fx(100 * x.diskBytes / totalDisk)}%`, 8)}  ${[...fields].join(',')}`);
    }

    const risky = [...sample.tagValues]
        .map(([tag, values]) => {
            let later = 0;
            for (const t of values.values()) if (t >= sample.minMs + DAY_MS) later++;
            return { tag, n: values.size, later, points: sample.byMeasurement.get(tag.split('.').slice(0, -1).join('.'))?.points ?? 0 };
        })
        .filter(t => t.n >= 50 && t.n / Math.max(1, t.points) > 0.2)
        .sort((x, y) => y.n - x.n);
    if (risky.length) {
        out.push('', 'Tagi z wieloma wartosciami (kazda wartosc = osobna seria). Jesli wartosci sie powtarzaja (np. te same wolumeny '
            + 'co dzien) - OK; jesli kazdego dnia sa nowe, serie rosna bez konca - wtedy "sqlite" albo pole:');
        for (const t of risky) {
            const growth = o.sampleDays > 1
                ? `${num(t.later)} nowych po 1. dniu probki (${fx(100 * t.later / t.n, 0)}%)`
                : 'probka 1-dniowa - powtarzalnosc sprawdz na probce z kilku dni';
            out.push(`  ${t.tag}: ${num(t.n)} wartosci na ${num(t.points)} punktow; ${growth}`);
        }
    }
    const growing = proj[proj.length - 1].series > sample.total.series.size * 1.05;
    out.push('', `Serie: ${growing ? `rosna w probce - liniowa ekstrapolacja tempa z ${o.sampleDays >= 4 ? 'drugiej polowy' : 'kolejnych dni'} probki (gorna granica; `
        + 'jesli wartosci tagow sa ograniczone, np. lista wolumenow, liczba serii sie nasyci)' : 'w probce nie przybywa nowych serii po 1. dniu - liczba stala'}.`);
    out.push(`Zalozenia (B/wartosc): int ${fx(a.bytesPerValue.int)}, float ${fx(a.bytesPerValue.float)}, bool ${fx(a.bytesPerValue.bool)}, `
        + `string ${fx(a.bytesPerValue.string)} + ${fx(a.stringFactor)} x tekst; indeks TSM ${a.keyIndexBytes} B + dl. klucza / klucz / shard; `
        + `TSI ${a.seriesIndexBytes} B / seria / shard + ${a.shardBytes} B / shard. Bez WAL, replikacji i retencji (RP bez limitu).`);
    if (cfg.uniqueTimestamps) {
        const sec = ASSUMPTIONS.seconds;
        const alt = proj[proj.length - 1];
        const ratio = a.bytesPerValue.int / sec.bytesPerValue.int;
        out.push(`uniqueTimestamps=tak: nanosekundy z GROUP ID psuja kompresje czasu - wartosci kosztuja ok. ${fx(ratio)}x `
            + `wiecej niz przy pelnych sekundach (dysk ${year} d: ${bytes(alt.diskBytes)} vs ok. `
            + `${bytes(project(sample.total, sample.minMs, o.sampleDays, year, o.shardDays, sec, true).diskBytes)}).`);
    }
    return out.join('\n');
}
