/** FILTLIST rutyn ACS: zapis list w liniach do kolumny 71. */

export const ACS_MAX_COL = 71;
/** limit pozycji listy INCLUDE / EXCLUDE */
export const MAX_LIST = 255;

export function chunks<T>(a: T[], n: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
    return out;
}

/** Pozycja listy FILTLIST: maska bez apostrofow; nazwa z '-' / '{' w apostrofach. */
function entry(text: string): string {
    return /[-{]/.test(text) && !/[*%]/.test(text) ? `'${text}'` : text;
}

/** Najdluzsza pozycja FILTLIST: nazwa 44 znaki w apostrofach + przecinek. */
const MAX_ENTRY = 47;

/**
 * FILTLIST z zawijaniem do ACS_MAX_COL; kazda linia poza ostatnia konczy sie przecinkiem (albo nawiasem
 * otwierajacym, gdy pierwsza pozycja nie miesci sie za naglowkiem; EXCLUDE od nowej linii, pod INCLUDE). Wciecie
 * kontynuacji pod nawiasem, a gdy przy dlugiej nazwie listy pelna nazwa zbioru by sie nie zmiescila - 4 spacje.
 */
export function filtlist(name: string, items: string[], excludes: string[] = []): string[] {
    const start = `  FILTLIST ${name} `;
    const fits = start.length + 'INCLUDE('.length + MAX_ENTRY <= ACS_MAX_COL;
    const list = (head: string, entries: string[]): string[] => {
        const indent = ' '.repeat(fits ? head.length : 4);
        const lines: string[] = [];
        let cur = head;
        entries.forEach((it, i) => {
            const piece = entry(it) + (i < entries.length - 1 ? ',' : ')');
            if (cur.length + piece.length > ACS_MAX_COL && cur !== indent) {
                lines.push(cur);
                cur = indent;
            }
            cur += piece;
        });
        lines.push(cur);
        return lines;
    };
    return [...list(`${start}INCLUDE(`, items),
        ...(excludes.length ? list(`${' '.repeat(fits ? start.length : 4)}EXCLUDE(`, excludes) : [])];
}
