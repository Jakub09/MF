/** Kontrola tekstu dla z/OS: FB 80, kolumny 1-71 (ACS, karty DFSORT), znaki bezpieczne dla IBM-1047. */

export class ZosTextError extends Error {}

export function checkZosLines(member: string, lines: string[], maxCol = 71): void {
    if (!/^[A-Z#@$][A-Z0-9#@$]{0,7}$/.test(member)) throw new ZosTextError(`niepoprawna nazwa membra ${member}`);
    lines.forEach((l, i) => {
        if (l.length > maxCol) throw new ZosTextError(`${member}:${i + 1} linia dluzsza niz ${maxCol} (${l.length})`);
        if (/[^\x20-\x7e]|[[\]\\!^~`]/.test(l)) {
            throw new ZosTextError(`${member}:${i + 1} znak niebezpieczny dla EBCDIC: ${l}`);
        }
    });
}

/**
 * Tekst do pliku z/OS: bez polskich znakow, wielkie litery, tylko znaki bezpieczne dla IBM-1047
 * (bez [ ] \ ! ^ ~ ` i znakow spoza ASCII).
 */
export function zosText(s: string): string {
    return s.replace(/[łŁ]/g, 'L').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
        .replace(/[^\x20-\x7e]|[[\]\\!^~`]/g, '?');
}
