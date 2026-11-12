/**
 * --task-times: o ktorej (czas lokalny) zaczynaja sie i koncza zadania - do ustawienia expectedEnd
 * w durations.json i godzin ekstraktow. Srednia godzina liczona po okregu (zadania konczace sie
 * okolo polnocy: 23:50 i 00:10 daja srednio 00:00, nie 12:00).
 */
import type { CompletedTask } from './checks';
import type { CompiledDurations } from './durations';
import { hhmm, localParts } from './time';

interface Clock {
    mean: number;
    p90: number;
    max: number;
    min: number;
}

/** Statystyki godziny dnia (minuty 0-1439) */
export function clockStats(minutes: number[]): Clock {
    const rad = (m: number) => (m / 1440) * 2 * Math.PI;
    const s = minutes.reduce((a, m) => a + Math.sin(rad(m)), 0);
    const c = minutes.reduce((a, m) => a + Math.cos(rad(m)), 0);
    let mean = (Math.atan2(s, c) / (2 * Math.PI)) * 1440;
    if (mean < 0) mean += 1440;
    // odchylenia od sredniej w zakresie -12 h .. +12 h
    const rel = minutes.map(m => ((((m - mean + 720) % 1440) + 1440) % 1440) - 720).sort((a, b) => a - b);
    const at = (q: number) => rel[Math.min(rel.length - 1, Math.max(0, Math.ceil(q * rel.length) - 1))];
    return { mean, p90: mean + at(0.9), max: mean + rel[rel.length - 1], min: mean + rel[0] };
}

const fmtDur = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')} min` : `${Math.round(s / 60)} min`);

export function formatTaskTimes(tasks: CompletedTask[], d: CompiledDurations, timezone: string, marginMin = 30): string {
    const out: string[] = [];
    const groups = new Map<string, CompletedTask[]>();
    for (const t of tasks) {
        const k = `${t.task}\u0000${t.sysname}\u0000${t.hostId ?? '-'}`;
        let g = groups.get(k);
        if (!g) groups.set(k, (g = []));
        g.push(t);
    }
    if (!groups.size) return 'Brak zakonczonych zadan (podaj pliki z pelnymi przebiegami albo --sqlite z historia).';
    const days = (ms: number[]) => Math.max(1, Math.round((Math.max(...ms) - Math.min(...ms)) / 86_400_000) + 1);

    out.push(`Godziny zadan (czas lokalny ${timezone}); koniec: srednio / p90 / najpozniej`);
    out.push('');
    out.push(`${'ZADANIE'.padEnd(12)}${'SYSTEM/HOST'.padEnd(13)}${'n'.padStart(4)}${'dni'.padStart(5)}  ${'start sr.'.padEnd(10)}${'koniec sr.'.padEnd(11)}${'p90'.padEnd(7)}${'najpozn.'.padEnd(10)}${'czas sr.'.padEnd(12)}${'czas maks.'.padEnd(12)}expectedEnd`);
    const latest = new Map<string, number>(); // zadanie -> najpozniejszy koniec (minuty wzgledem sredniej, rozwiniete)
    const order = d.tasks.map(t => t.name);
    for (const [k, g] of [...groups].sort(([a], [b]) => order.indexOf(a.split('\u0000')[0]) - order.indexOf(b.split('\u0000')[0]) || a.localeCompare(b))) {
        const [task, sys, host] = k.split('\u0000');
        const start = clockStats(g.map(t => localParts(t.startMs, timezone).minutes));
        const end = clockStats(g.map(t => localParts(t.endMs, timezone).minutes));
        const durs = g.map(t => (t.endMs - t.startMs) / 1000);
        const cfg = d.tasks.find(t => t.name === task)?.expectedEndMin;
        latest.set(task, Math.max(latest.get(task) ?? -Infinity, end.max));
        out.push(`${task.padEnd(12)}${`${sys}/${host}`.padEnd(13)}${String(g.length).padStart(4)}${String(days(g.map(t => t.endMs))).padStart(5)}  `
            + `${hhmm(start.mean).padEnd(10)}${hhmm(end.mean).padEnd(11)}${hhmm(end.p90).padEnd(7)}${hhmm(end.max).padEnd(10)}`
            + `${fmtDur(durs.reduce((a, b) => a + b, 0) / durs.length).padEnd(12)}${fmtDur(Math.max(...durs)).padEnd(12)}${cfg === undefined ? '-' : hhmm(cfg)}`);
    }
    out.push('');
    out.push(`Sugestia expectedEnd (najpozniejszy koniec na wszystkich hostach + ${marginMin} min, w gore do 15 min) - do config/durations.json:`);
    for (const [task, max] of [...latest].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))) {
        const sug = Math.ceil(Math.round(max + marginMin) / 15) * 15;
        out.push(`  "${task}": { ..., "expectedEnd": "${hhmm(sug)}" }`);
    }
    out.push('');
    out.push('Ekstrakt ustaw po najpozniejszym expectedEnd zadan, ktore ma obejmowac. Zadania z czasem przyblizonym (PSM, AUTOBACKUP,');
    out.push('AUTODUMP - start / koniec bez czasu w tresci) koncza sie faktycznie nieco pozniej niz ostatni komunikat wolumenu.');
    return out.join('\n');
}
