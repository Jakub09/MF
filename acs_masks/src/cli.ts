#!/usr/bin/env node
/**
 * acs-masks - maski DSN i przykladowe rutyny ACS z CSV DCOLLECT (job ACMCSV). Uruchamiany na PC.
 *
 * Polecenia na zrodlach rutyn ACS (opis: src/cli-acs.ts):
 *   acs-masks check <rutyna>...                      kontrola skladni rutyn
 *   acs-masks repr <plik.csv> --acs <rutyna>...      reprezentanci do testow wg warunkow rutyn
 *   acs-masks sim  <plik.csv> --acs <rutyna>...      emulacja rutyn, regresja stara / nowa wersja
 *
 * Dobor masek z danych (to polecenie):
 *   acs-masks <plik.csv> --config reguly.json [--out katalog] [opcje]
 *   acs-masks DCOLLECT.CSV --config config/przyklad.json --min-purity 0.95 --dry-run
 *
 * Opcje (nadpisuja konfiguracje dla wszystkich regul):
 *   --min-purity X     minimalna czystosc maski 0-1 (tolerancja; 1 = maska nie obejmuje zadnego zbioru spoza kryterium)
 *   --min-count N      minimalna liczba zbiorow spelniajacych kryterium, ktore maska musi pokryc
 *   --max-masks N      maksymalna liczba masek na regule
 *   --literals         zbiory niepokryte maskami dopisac jako pelne nazwy
 *   --exclude-fp       zbiory nadmiarowe (objete maska, niespelniajace kryterium) -> EXCLUDE (pelne nazwy)
 *   --no-digit-masks   bez kandydatow z % w miejsce cyfr
 *   --vsam MODE        cluster (domyslnie, gdy w CSV sa rekordy A) - komponenty VSAM pod nazwa klastra;
 *                      component - komponenty jako osobne zbiory
 *   --today RRRR-MM-DD data odniesienia dla ageDays / unrefDays (domyslnie dzis)
 *   --top N            ile zbiorow pokazac w raporcie na liste (domyslnie 20; pelne listy w CSV)
 *   --encoding ENC     kodowanie pliku CSV (domyslnie utf-8; plik przeslany z z/OS jako tekst)
 *   --dry-run          tylko raport na standardowe wyjscie, bez plikow
 *
 * Wynik (katalog --out, domyslnie osobny podkatalog przebiegu out/maski/RRRR-MM-DD_GGMMSS w katalogu projektu
 * acs_masks; katalog bazowy zmienia ACS_MASKS_OUT - src/outdir.ts):
 *   RAPORT.txt, maski.csv, <REGULA>.niepokryte.csv, <REGULA>.nadmiarowe.csv
 *   zos/ACMSG, ACMSC, ACMMC, ACMDC - przykladowe rutyny ACS (FB 80)
 *   zos/ACMCARD, ACMSYMV, ACMLIST  - karty, symbole i lista masek dla joba ACMREPR (FB 80)
 *
 * Kody wyjscia: 0 - OK, 1 - blad (argumenty, plik, konfiguracja, CSV, maska nieobslugiwana w ACMREPR).
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { generateRoutines } from './acs';
import { ACS_COMMANDS, AcsCommand, mainAcs } from './cli-acs';
import { CsvError, readDataSets } from './dataset';
import { CardError, generateCards, generateList, generateSymbols, vectorMasks } from './dfsort';
import { runRules } from './engine';
import { dataSetsCsv, masksCsv, textReport } from './report';
import { ConfigError, loadConfig, Tuning } from './rules';
import { runDir, runInfo } from './outdir';
import { checkZosLines, ZosTextError } from './zos';

export interface Io {
    out: (t: string) => void;
    err: (t: string) => void;
}

const STDIO: Io = { out: t => process.stdout.write(t), err: t => process.stderr.write(t) };

const USAGE = 'Uzycie: acs-masks <plik.csv> --config reguly.json [--out katalog] [--min-purity X] [--min-count N]\n'
    + '        [--max-masks N] [--literals] [--exclude-fp] [--no-digit-masks] [--vsam cluster|component]\n'
    + '        [--today RRRR-MM-DD] [--top N] [--encoding utf-8] [--dry-run]\n'
    + '        wynik domyslnie w out/maski/<data_godzina>/ katalogu projektu (--out: wskazany katalog)\n'
    + '        acs-masks check|repr|sim ... - polecenia na zrodlach rutyn ACS (acs-masks repr --help)\n';

function num(v: string | undefined, name: string, min: number, max: number, int: boolean): number | undefined {
    if (v === undefined) return undefined;
    const x = Number(v.replace(',', '.'));
    if (!Number.isFinite(x) || x < min || x > max || (int && !Number.isInteger(x))) {
        throw new ConfigError(`--${name}: niepoprawna wartosc "${v}" (zakres ${min}-${max})`);
    }
    return x;
}

export { DEFAULT_OUT, projectDir } from './outdir';

const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export async function main(argv: string[], io: Io = STDIO): Promise<number> {
    // polecenia na zrodlach rutyn ACS: check, repr, sim (src/cli-acs.ts)
    if ((ACS_COMMANDS as readonly string[]).includes(argv[0])) {
        return mainAcs(argv[0] as AcsCommand, argv.slice(1), io);
    }
    let a;
    try {
        a = parseArgs({
            args: argv,
            allowPositionals: true,
            options: {
                config: { type: 'string', short: 'c' },
                out: { type: 'string', short: 'o' },
                'min-purity': { type: 'string' },
                'min-count': { type: 'string' },
                'max-masks': { type: 'string' },
                literals: { type: 'boolean' },
                'exclude-fp': { type: 'boolean' },
                'no-digit-masks': { type: 'boolean' },
                vsam: { type: 'string' },
                today: { type: 'string' },
                top: { type: 'string', default: '20' },
                encoding: { type: 'string', default: 'utf-8' },
                'dry-run': { type: 'boolean', default: false },
                help: { type: 'boolean', short: 'h', default: false },
            },
        });
    } catch (err) {
        io.err(`${(err as Error).message}\n${USAGE}`);
        return 1;
    }
    const o = a.values;
    if (o.help) {
        io.out(USAGE);
        return 0;
    }
    if (a.positionals.length !== 1 || !o.config) {
        io.err(USAGE);
        return 1;
    }
    const csvFile = a.positionals[0];
    try {
        const override: Partial<Tuning> = {
            minPurity: num(o['min-purity'], 'min-purity', 0, 1, false),
            minCount: num(o['min-count'], 'min-count', 1, 1e9, true),
            maxMasks: num(o['max-masks'], 'max-masks', 1, 1e6, true),
            literals: o.literals,
            excludeFalsePositives: o['exclude-fp'],
            digitMasks: o['no-digit-masks'] ? false : undefined,
        };
        if (o.vsam && o.vsam !== 'cluster' && o.vsam !== 'component') {
            throw new ConfigError('--vsam: cluster albo component');
        }
        if (o.today && !/^\d{4}-\d{2}-\d{2}$/.test(o.today)) throw new ConfigError('--today: RRRR-MM-DD');
        const top = num(o.top, 'top', 0, 1e6, true)!;
        const cfg = loadConfig(o.config);
        const stamp = o.today ?? today();
        const { dataSets, dRecords, assoc, warnings } = await readDataSets(csvFile, {
            encoding: o.encoding as BufferEncoding,
            vsamCluster: o.vsam ? o.vsam === 'cluster' : undefined,
            today: o.today ? new Date(`${o.today}T00:00:00Z`) : undefined,
            onProgress: (lines, part) => io.err(`CSV: ${lines.toLocaleString('pl-PL')} linii (${Math.round(part * 100)}%)\n`),
        });
        for (const w of warnings) io.err(`Uwaga: ${w}\n`);
        io.err(`CSV: ${dRecords} rekordow D, ${assoc} rekordow A -> ${dataSets.length} zbiorow\n`);

        const res = runRules(dataSets, cfg, override);
        const report = textReport(res, { csv: csvFile, config: o.config, stamp, top });
        const routines = generateRoutines(res.rules, cfg.otherwise, stamp);
        const vmasks = vectorMasks(res.rules);
        const zos: Record<string, string[]> = {};
        for (const r of routines) zos[r.member] = r.lines;
        if (vmasks.length) {
            zos.ACMCARD = generateCards(vmasks);
            zos.ACMSYMV = generateSymbols(vmasks.length, stamp);
            zos.ACMLIST = generateList(vmasks, stamp);
        }
        for (const [member, lines] of Object.entries(zos)) checkZosLines(member, lines);

        if (o['dry-run']) {
            io.out(report);
            for (const r of routines) io.out(`\n----- ${r.member} (${r.routine}) -----\n${r.lines.join('\n')}\n`);
            return 0;
        }
        const outDir = o.out ? path.resolve(o.out) : runDir('maski');
        fs.mkdirSync(path.join(outDir, 'zos'), { recursive: true });
        fs.writeFileSync(path.join(outDir, 'wywolanie.txt'), runInfo('', argv));
        const write = (rel: string, text: string) => fs.writeFileSync(path.join(outDir, rel), text);
        write('RAPORT.txt', report);
        write('maski.csv', masksCsv(res));
        for (const r of res.rules) {
            write(`${r.rule.name}.niepokryte.csv`, dataSetsCsv(r.uncovered));
            write(`${r.rule.name}.nadmiarowe.csv`, dataSetsCsv(r.falsePositives));
        }
        for (const [member, lines] of Object.entries(zos)) write(path.join('zos', member), lines.join('\n') + '\n');
        io.out(report);
        io.err(`Zapisano: ${outDir}/ (RAPORT.txt, maski.csv, zos/: ${Object.keys(zos).join(', ')})\n`);
        return 0;
    } catch (err) {
        if (err instanceof ConfigError || err instanceof CsvError || err instanceof CardError
            || err instanceof ZosTextError) {
            io.err(`Blad: ${err.message}\n`);
            return 1;
        }
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            io.err(`Blad: brak pliku ${(err as NodeJS.ErrnoException).path}\n`);
            return 1;
        }
        throw err;
    }
}

if (require.main === module) {
    main(process.argv.slice(2)).then(code => process.exit(code), err => {
        process.stderr.write(`${(err as Error).stack ?? err}\n`);
        process.exit(1);
    });
}
