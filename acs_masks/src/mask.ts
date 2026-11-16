/**
 * Maski nazw zbiorow jak w FILTLIST rutyn ACS:
 *   %   - dokladnie jeden znak w kwalifikatorze
 *   *   - zero lub wiecej znakow w kwalifikatorze; samo "*" = dokladnie jeden kwalifikator
 *   **  - zero lub wiecej kwalifikatorow (tylko jako caly kwalifikator)
 * Np. PROD.TMP.**, *.**.LOAD, PROD.D%%%%%%.LIST, SYS1.LINKLIB (literal).
 */

const QUAL_CHARS = /^[A-Z0-9#@$*%{-]{1,8}$/;

export class MaskError extends Error {}

export interface Mask {
    text: string;
    /** kwalifikatory maski; '**' jako osobny element */
    quals: string[];
    /** czy maska ma znaki wieloznaczne (inaczej: pelna nazwa) */
    generic: boolean;
}

/** Sprawdza i rozbija maske; rzuca MaskError z opisem bledu. */
export function parseMask(text: string): Mask {
    const t = text.trim().toUpperCase();
    if (t.length === 0 || t.length > 44) throw new MaskError(`maska "${text}": dlugosc 1-44 znaki`);
    const quals = t.split('.');
    for (const q of quals) {
        if (q === '**') continue;
        if (!QUAL_CHARS.test(q)) throw new MaskError(`maska "${text}": niepoprawny kwalifikator "${q}"`);
        if (q.includes('**')) throw new MaskError(`maska "${text}": "**" tylko jako caly kwalifikator`);
    }
    return { text: t, quals, generic: /[*%]/.test(t) };
}

const qualRegexCache = new Map<string, RegExp>();

function qualRegex(q: string): RegExp {
    let re = qualRegexCache.get(q);
    if (!re) {
        const body = q === '*' ? '.+' : q.replace(/[$#@{-]/g, c => '\\' + c).replace(/\*/g, '.*').replace(/%/g, '.');
        re = new RegExp('^' + body + '$');
        qualRegexCache.set(q, re);
    }
    return re;
}

/** Czy kwalifikator nazwy pasuje do kwalifikatora maski (bez '**'). */
export function qualMatches(maskQual: string, qual: string): boolean {
    if (!/[*%]/.test(maskQual)) return maskQual === qual;
    return qualRegex(maskQual).test(qual);
}

/** Czy nazwa (rozbita na kwalifikatory) pasuje do maski. */
export function matchQuals(mask: string[], dsn: string[], mi = 0, di = 0): boolean {
    while (mi < mask.length) {
        const m = mask[mi];
        if (m === '**') {
            // '**' = zero lub wiecej kwalifikatorow
            for (let k = di; k <= dsn.length; k++) {
                if (matchQuals(mask, dsn, mi + 1, k)) return true;
            }
            return false;
        }
        if (di >= dsn.length || !qualMatches(m, dsn[di])) return false;
        mi++;
        di++;
    }
    return di === dsn.length;
}

export function matches(mask: Mask, dsn: string): boolean {
    return matchQuals(mask.quals, dsn.split('.'));
}

/** Cyfry kwalifikatora -> '%' (np. D241113 -> D%%%%%%); null, gdy brak cyfr. */
export function digitMask(qual: string): string | null {
    return /[0-9]/.test(qual) ? qual.replace(/[0-9]/g, '%') : null;
}
