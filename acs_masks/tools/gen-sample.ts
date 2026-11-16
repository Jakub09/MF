/**
 * Przykladowy CSV (jak z joba ACMCSV) do wyprobowania acs-masks bez z/OS - dane syntetyczne, deterministyczne.
 *
 *   npx tsx tools/gen-sample.ts [plik.csv] [--count N]
 *
 * Zawiera m.in. zbiory nadmiarowo alokowane (315 TRK, uzycie <= 1 TRK) skupione pod kilkoma maskami
 * (PROD.BATCH.**.SYSOUT, TEST.TMP.D%%%%%%, ...), duze zbiory PS, VSAM (rekordy A), zbiory wielowolumenowe
 * i zbiory spoza SMS.
 */
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { csv, dline, kbForTrk, rng } from '../test/helpers';

export function sampleCsv(count = 2000, seed = 42): string {
    const r = rng(seed);
    const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)];
    const num = (n: number) => String(Math.floor(r() * 10 ** n)).padStart(n, '0');
    const lines: string[] = [];
    const seen = new Set<string>();
    const add = (o: Parameters<typeof dline>[0]) => {
        if (seen.has(o.dsn)) return;
        seen.add(o.dsn);
        lines.push(dline(o));
    };
    const over = { allkb: kbForTrk(315), usekb: 40 };
    for (let i = 0; i < count; i++) {
        const k = r();
        const app = pick(['PAY', 'HR', 'FIN', 'CRM']);
        if (k < 0.12) {
            // nadmiarowe: wynik batch (SYSOUT)
            add({ dsn: `PROD.BATCH.${app}.J${num(4)}.SYSOUT`, ...over });
        } else if (k < 0.2) {
            // nadmiarowe: tymczasowe z data
            add({ dsn: `TEST.TMP.D${num(6)}.${pick(['WORK', 'SORTOUT'])}`, ...over });
        } else if (k < 0.24) {
            // te same nazwy, ale normalnie uzywane (czystosc < 100%)
            add({ dsn: `TEST.TMP.D${num(6)}.WORK`, allkb: kbForTrk(315), usekb: kbForTrk(200) });
        } else if (k < 0.3) {
            add({ dsn: `PROD.${app}.ARCH.G${num(4)}V00`, f1: '48', allkb: kbForTrk(20000), usekb: kbForTrk(18000) });
        } else if (k < 0.33) {
            add({ dsn: `SYS1.TRACE.T${num(3)}`, ...over });
        } else if (k < 0.37) {
            const base = `PROD.${app}.KSDS${num(2)}`;
            if (!seen.has(base)) {
                seen.add(base);
                lines.push(dline({ dsn: `${base}.DATA`, dsorg: '0008', recfm: '00', allkb: kbForTrk(500), usekb: 2000 }));
                lines.push(dline({ dsn: `${base}.INDEX`, dsorg: '0008', recfm: '00', allkb: kbForTrk(15), usekb: 100 }));
                lines.push(`A;${base}.DATA;${base};82`);
                lines.push(`A;${base}.INDEX;${base};81`);
            }
        } else if (k < 0.4) {
            // wielowolumenowe duze PS
            const dsn = `PROD.${app}.EXTRACT.M${num(2)}`;
            if (!seen.has(dsn)) {
                seen.add(dsn);
                lines.push(dline({ dsn, vol: 'VOL101', volsq: 1, allkb: kbForTrk(9000), usekb: kbForTrk(8000) }));
                lines.push(dline({ dsn, vol: 'VOL102', volsq: 2, allkb: kbForTrk(9000), usekb: kbForTrk(7000) }));
            }
        } else if (k < 0.45) {
            add({ dsn: `USER${num(2)}.ISPF.ISPPROF`, f1: '00', allkb: kbForTrk(15), usekb: 300 });
        } else {
            const n = Math.floor(r() * 3);
            const mid = Array.from({ length: n }, () => pick(['SRC', 'LOAD', 'CNTL', 'DATA', `V${num(2)}`]));
            add({
                dsn: [pick(['PROD', 'TEST', 'DEV']), app, ...mid, pick(['LIST', 'OUT', 'LOG', 'BKP'])].join('.'),
                dsorg: pick(['4000', '4000', '0200']),
                allkb: kbForTrk(Math.floor(1 + r() * 3000)),
                usekb: Math.floor(r() * 50000),
            });
        }
    }
    return csv(lines);
}

if (require.main === module) {
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: { count: { type: 'string', default: '2000' } },
    });
    const text = sampleCsv(Number(values.count));
    if (positionals[0]) fs.writeFileSync(positionals[0], text);
    else process.stdout.write(text);
}
