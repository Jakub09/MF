/**
 * Katalogi wynikow. Domyslnie kazdy przebieg ma osobny podkatalog:
 *   <projekt>/out/<rodzaj>/<RRRR-MM-DD_GGMMSS>[-n]
 * rodzaj: maski (dobor masek), repr (reprezentanci i testy), sim (emulacja).
 * Katalog bazowy zamiast <projekt>/out: zmienna srodowiska ACS_MASKS_OUT. Opcja --out wskazuje katalog wprost
 * (bez podkatalogu przebiegu).
 */
import fs from 'node:fs';
import path from 'node:path';

/** Katalog projektu: pierwszy w gore od pliku z package.json (src/, dist/src/ albo rozpakowany bundle). */
export function projectDir(start = __dirname): string {
    for (let d = start; ; d = path.dirname(d)) {
        if (fs.existsSync(path.join(d, 'package.json'))) return d;
        if (path.dirname(d) === d) return process.cwd();
    }
}

export const DEFAULT_OUT = path.join(projectDir(), 'out');

export type RunKind = 'maski' | 'repr' | 'sim';

const two = (n: number) => String(n).padStart(2, '0');

export function runStamp(d = new Date()): string {
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}_${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}

/** Nowy (nieistniejacy) katalog przebiegu; nie jest jeszcze tworzony. */
export function runDir(kind: RunKind, base = process.env.ACS_MASKS_OUT || DEFAULT_OUT, now = new Date()): string {
    const stem = path.join(base, kind, runStamp(now));
    let dir = stem;
    for (let i = 2; fs.existsSync(dir); i++) dir = `${stem}-${i}`;
    return path.resolve(dir);
}

/** Plik wywolanie.txt w katalogu przebiegu: data, katalog biezacy, argumenty. */
export function runInfo(cmd: string, argv: string[]): string {
    const q = (a: string) => (/^[A-Za-z0-9_./:=,@%+-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
    return [`data: ${new Date().toISOString()}`, `katalog: ${process.cwd()}`, `wywolanie: acs-masks ${[cmd, ...argv].filter(Boolean).map(q).join(' ')}`, ''].join('\n');
}
