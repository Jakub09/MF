/**
 * Dopasowanie masek i porownania wartosci jak w ACS.
 *
 * Maska prosta (jeden poziom - volser, job, kwalifikator): * = zero lub wiecej znakow, % = jeden znak.
 * Maska nazwy zbioru: kwalifikatory rozdzielone kropkami; * w kwalifikatorze = zero lub wiecej znakow,
 * samo * = dokladnie jeden kwalifikator, ** = zero lub wiecej kwalifikatorow, % = jeden znak.
 * Porzadek znakow: EBCDIC (litery przed cyframi); literaly dopelniane spacjami.
 */

/** maska -> wyrazenie regularne albo null (maska bez * i %: porownanie wprost) */
const reCache = new Map<string, RegExp | null>();

function wildcardRegex(mask: string): RegExp | null {
    let re = reCache.get(mask);
    if (re === undefined) {
        const body = mask.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/%/g, '[^ ]');
        re = /[*%]/.test(mask) ? new RegExp(`^${body}$`) : null;
        reCache.set(mask, re);
    }
    return re;
}

/** Maska prosta (bez znaczenia kropek). */
export function simpleMatch(mask: string, value: string): boolean {
    if (mask === '*') return true;
    const re = wildcardRegex(mask);
    return re ? re.test(value) : mask === value;
}

function qualMatch(maskQual: string, qual: string): boolean {
    if (maskQual === '*') return qual.length > 0;
    return simpleMatch(maskQual, qual);
}

function matchQuals(mask: string[], quals: string[], mi: number, qi: number): boolean {
    for (; mi < mask.length; mi++, qi++) {
        if (mask[mi] === '**') {
            for (let k = qi; k <= quals.length; k++) if (matchQuals(mask, quals, mi + 1, k)) return true;
            return false;
        }
        if (qi >= quals.length || !qualMatch(mask[mi], quals[qi])) return false;
    }
    return qi === quals.length;
}

const splitCache = new Map<string, string[]>();

/** Maska nazwy zbioru; quals - kwalifikatory nazwy (pusta nazwa = []). */
export function dsnMatch(mask: string, quals: string[]): boolean {
    let m = splitCache.get(mask);
    if (!m) splitCache.set(mask, m = mask.split('.'));
    return matchQuals(m, quals, 0, 0);
}

/** Poprawnosc maski wg "Simple mask rules" / "Data set mask rules"; null = poprawna. */
export function maskProblem(mask: string, dsnLike: boolean): string | null {
    if (!/^[A-Z0-9$@#*%]/.test(mask)) return 'maska musi zaczynac sie litera, cyfra, $ @ # * albo %';
    if (!/^[A-Z0-9$@#*%._]+$/.test(mask)) return 'niedozwolony znak w masce';
    if (/\*\*\*/.test(mask)) return 'trzy lub wiecej * obok siebie';
    if (!dsnLike) {
        if (/\*\*/.test(mask) && !mask.includes('.')) return 'dwie * obok siebie w masce prostej';
        return null;
    }
    if (mask.length > 44) return `maska nazwy zbioru dluzsza niz 44 znaki (${mask.length})`;
    for (const q of mask.split('.')) {
        if (q === '') return 'pusty kwalifikator w masce';
        if (q.includes('**') && q !== '**') return '** nie moze wystapic z innymi znakami w kwalifikatorze';
        if (q.length > 8) return `kwalifikator "${q}" dluzszy niz 8 znakow`;
    }
    return null;
}

// --- porzadek EBCDIC (IBM-1047): spacja < znaki specjalne < male litery < wielkie litery < cyfry
const EBCDIC = new Map<string, number>();
(() => {
    const put = (chars: string, start: number) => [...chars].forEach((c, i) => EBCDIC.set(c, start + i));
    put(' ', 0x40);
    put('.<(+|', 0x4b);
    put('&', 0x50);
    put('!$*);', 0x5a);
    put('-/', 0x60);
    put(',%_>?', 0x6b);
    put(':#@\'="', 0x7a);
    put('abcdefghi', 0x81);
    put('jklmnopqr', 0x91);
    put('stuvwxyz', 0xa2);
    put('{', 0xc0);
    put('ABCDEFGHI', 0xc1);
    put('}', 0xd0);
    put('JKLMNOPQR', 0xd1);
    put('STUVWXYZ', 0xe2);
    put('0123456789', 0xf0);
})();

const code = (c: string | undefined) => (c === undefined ? 0x40 : EBCDIC.get(c) ?? c.charCodeAt(0));

/** Porownanie znakowe: wyrownanie do lewej, dopelnienie spacjami, porzadek EBCDIC. Wynik < 0, 0, > 0. */
export function compareChar(a: string, b: string): number {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
        const d = code(a[i]) - code(b[i]);
        if (d !== 0) return d;
    }
    return 0;
}
