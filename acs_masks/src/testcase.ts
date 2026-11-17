/**
 * Testy ACS w formacie ISMF (member biblioteki testow, FB 80) - generowane z reprezentantow (acs-masks repr --tests),
 * zamiast testow z DCOLLECT przez NaviQuest (ACBQBAG1; ta droga zostaje).
 *
 * Format membera (z membera utworzonego w ISMF 7.4, 2026-11-17): linie "SLOWO: wartosc"; opis w linii pod
 * DESCRIPTION1:
 *   DESCRIPTION1:
 *   <opis: maski / kwalifikatory z rutyn, do ktorych pasuje DSN>
 *   DSN: <nazwa zbioru>
 *   ACSENVIR: ALLOC
 * Na razie tylko te pola. Pozostale zmienne (DSORG, SIZE, UNIT...) maja w tescie wartosc pusta - warunki rutyn
 * na nich nie roznicuja testow (raport repr je wypisuje).
 *
 * Wynik dla z/OS:
 *   zos/ACMTEST    - wejscie IEBUPDTE (./ ADD NAME=... + linie membera), ladowane jobem ACMTLOAD do TESTBED
 *   zos/testy/*    - te same membery jako osobne pliki (alternatywa: FTP mput do PDS)
 */
import { zosText } from './acs';

export class TestCaseError extends Error {}

/** Najdluzsza linia membera (bez kolumn 73-80). */
export const TEST_MAX_COL = 72;

export interface TestCase {
    member: string;
    dsn: string;
    description: string;
    lines: string[];
}

/** Nazwy memberow jak w NaviQuest: prefiks 1-4 litery + numer do 8 znakow. */
export function memberNames(prefix: string, count: number): string[] {
    const p = prefix.toUpperCase();
    if (!/^[A-Z#@$]{1,4}$/.test(p)) throw new TestCaseError(`prefiks testow "${prefix}": 1-4 litery (A-Z # @ $)`);
    const digits = 8 - p.length;
    if (count > 10 ** digits - 1) {
        throw new TestCaseError(`${count} testow nie miesci sie w nazwach ${p}${'n'.repeat(digits)} - uzyj krotszego prefiksu`);
    }
    return Array.from({ length: count }, (_, i) => p + String(i + 1).padStart(digits, '0'));
}

export function testLines(description: string, dsn: string, acsenvir = 'ALLOC'): string[] {
    const desc = zosText(description).replace(/^\.\//, '. /').slice(0, TEST_MAX_COL).trimEnd();
    return ['DESCRIPTION1:', desc, `DSN: ${dsn}`, `ACSENVIR: ${acsenvir}`];
}

export function buildTests(prefix: string, items: { dsn: string; description: string }[]): TestCase[] {
    const names = memberNames(prefix, items.length);
    return items.map((it, i) => ({ member: names[i], dsn: it.dsn, description: it.description, lines: testLines(it.description, it.dsn) }));
}

/** Wejscie IEBUPDTE (PARM=NEW): kazdy member po "./ ADD NAME=", na koncu "./ ENDUP". */
export function iebupdte(tests: TestCase[]): string[] {
    const out: string[] = [];
    for (const t of tests) out.push(`./ ADD NAME=${t.member}`, ...t.lines);
    out.push('./ ENDUP');
    return out;
}
