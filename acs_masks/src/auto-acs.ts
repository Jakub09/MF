/**
 * Maski -> z/OS: EXCLUDE dla duzych zbiorow objetych maskami, tekst FILTLIST i testy ISMF (jak repr --tests).
 */
import { CheckInput, MaskListError } from './auto-check';
import { pickExcludes } from './auto-exclude';
import { MaskRow } from './auto-mine';
import { MaskTree } from './auto-tree';
import { Interner, Tick } from './auto-util';
import { chunks, filtlist, MAX_LIST } from './filtlist';
import { parseMask } from './mask';
import { buildTests, iebupdte, TestCase } from './testcase';

export interface ExcludeResult {
    /** zbiory objete maskami przed EXCLUDE */
    before: MaskRow;
    after: MaskRow;
    /** maski EXCLUDE: large = wylaczone duze, small = stracone male */
    masks: MaskRow[];
    /** wylaczone razem, kazdy zbior raz */
    total: MaskRow;
}

/** Wiersze objete maskami (INCLUDE i nie EXCLUDE). */
function covered(input: CheckInput, include: string[], exclude: string[], tick: Tick): CheckInput {
    const { names } = input;
    const inc = new MaskTree(include.map(m => m.split('.')));
    const exc = exclude.length ? new MaskTree(exclude.map(m => m.split('.'))) : null;
    const total = input.pos.length + input.neg.length;
    let done = 0;
    const pick = (rows: Int32Array) => rows.filter(row => {
        if ((done++ & 0x3fff) === 0) tick(done / total);
        const s = names.start[row];
        const e = s + names.len[row];
        return inc.match(names.pool, s, e).length > 0 && !exc?.match(names.pool, s, e).length;
    });
    return { ...input, pos: pick(input.pos), neg: pick(input.neg) };
}

/**
 * Maski EXCLUDE (auto-exclude): jak najszersze - jeden kwalifikator, dwa, a na koncu pelna maska; kazda wylacza co
 * najmniej minCount nowych duzych objetych INCLUDE i gain (czesc) ich alokacji, razem nie wiecej niz loss malych.
 */
export function findExcludes(input: CheckInput, include: string[], old: string[],
    opt: { minCount: number; maxWild: number; head?: string[]; gain?: number; loss?: number }, tick: Tick): ExcludeResult {
    const c = covered(input, include, old, p => tick(0.2 * p));
    const texts = c.neg.length ? pickExcludes(c, opt.head ?? [], {
        minCount: opt.minCount, gain: opt.gain ?? 0, loss: opt.loss ?? 0, maxWild: opt.maxWild, maxMasks: MAX_LIST - old.length,
    }, p => tick(0.2 + 0.7 * p)) : [];

    // ---- liczby z porownania masek z nazwami
    const row = (text: string): MaskRow => ({ text, small: 0, large: 0, purity: 0, smallKb: 0, largeKb: 0 });
    const masks = texts.map(row);
    const [before, total, after] = [row('PRZED EXCLUDE'), row('RAZEM'), row('PO EXCLUDE')];
    const tree = new MaskTree(texts.map(t => t.split('.')));
    const add = (rows: Int32Array, n: 'small' | 'large', kb: 'smallKb' | 'largeKb') => {
        for (let x = 0; x < rows.length; x++) {
            if ((x & 0x3fff) === 0) tick(0.9 + 0.1 * (x / rows.length));
            const s = input.names.start[rows[x]];
            const ids = tree.match(input.names.pool, s, s + input.names.len[rows[x]]);
            for (const r of [before, ids.length ? total : after, ...ids.map(m => masks[m])]) {
                r[n]++;
                r[kb] += input.allocKb[rows[x]];
            }
        }
    };
    add(c.pos, 'small', 'smallKb');
    add(c.neg, 'large', 'largeKb');
    for (const r of [before, after]) r.purity = r.small ? r.small / (r.small + r.large) : 0;
    return { before, after, masks: masks.sort((a, b) => b.largeKb - a.largeKb || (a.text < b.text ? -1 : 1)), total };
}

/** Dlaczego translator ACS nie przyjmie maski; null = dobra. */
export function acsProblem(mask: string): string | null {
    try {
        if (parseMask(mask).generic && mask.includes('-')) return '"-" w masce to znak kontynuacji';
        return null;
    } catch (e) {
        return (e as Error).message;
    }
}

/** FILTLIST z INCLUDE i EXCLUDE; ponad 255 masek - kilka list, kazda z tym samym EXCLUDE. */
export function filtlistText(name: string, include: string[], exclude: string[]): string[] {
    if (exclude.length > MAX_LIST) throw new MaskListError(`EXCLUDE: ${exclude.length} masek, FILTLIST przyjmuje ${MAX_LIST}`);
    const parts = chunks(include, MAX_LIST);
    return parts.flatMap((p, i) => filtlist(parts.length > 1 ? `${name}_${i + 1}` : name, p, exclude));
}

/**
 * Testy do masek INCLUDE i EXCLUDE, najwyzej per zbiorow kazdego rodzaju na maske; opis = maski, do ktorych nazwa pasuje:
 *   maska               zbior objety INCLUDE (maly, a gdy ich nie ma - duzy); maska z **: nazwy o najmniejszej
 *                       i o najwiekszej liczbie kwalifikatorow
 *   EXCLUDE maska       zbior wylaczony
 *   BEZ MASKI - maska   zbior, ktory nie pasuje do zadnej maski, a pasowalby, gdyby * bylo **
 */
export function maskTests(input: CheckInput, include: string[], exclude: string[], per: number, prefix: string, tick: Tick): TestCase[] {
    const { names, pos, neg } = input;
    const inc = new MaskTree(include.map(m => m.split('.')));
    const exc = new MaskTree(exclude.map(m => m.split('.')));
    const wide = include.filter(m => m.split('.').includes('*'));
    const near = new MaskTree(wide.map(m => m.split('.').map(x => (x === '*' ? '**' : x))));
    // lepszy reprezentant: pasujacy do mniejszej liczby masek, wczesniejszy alfabetycznie
    interface Rep { row: number; masks: number }
    /** liczba kwalifikatorow -> reprezentanci */
    type Reps = Map<number, Rep[]>;
    const make = (n: number) => Array.from({ length: n }, (): Reps => new Map());
    const incSmall = make(include.length);
    const incLarge = make(include.length);
    const excAny = make(exclude.length);
    const nearAny = make(wide.length);
    const put = (reps: Reps, key: number, r: Rep) => {
        let list = reps.get(key);
        if (!list) reps.set(key, list = []);
        let i = list.length;
        while (i > 0 && (list[i - 1].masks - r.masks || compareNames(names, list[i - 1].row, r.row)) >= 0) i--;
        if (i === per) return;
        // ta sama nazwa (generacje GDG pod nazwa bazy) raz
        if (list.some(x => compareNames(names, x.row, r.row) === 0)) return;
        list.splice(i, 0, r);
        if (list.length > per) list.pop();
    };
    const total = pos.length + neg.length;
    let done = 0;
    const scan = (rows: Int32Array, small: boolean) => {
        for (let x = 0; x < rows.length; x++) {
            if ((done++ & 0x3fff) === 0) tick(done / total);
            const s = names.start[rows[x]];
            const e = s + names.len[rows[x]];
            const ids = inc.match(names.pool, s, e);
            if (ids.length === 0) {
                const almost = near.match(names.pool, s, e);
                for (const m of almost) put(nearAny[m], 0, { row: rows[x], masks: almost.length });
                continue;
            }
            const out = exc.match(names.pool, s, e);
            if (out.length) {
                for (const m of out) put(excAny[m], 0, { row: rows[x], masks: out.length });
                continue;
            }
            let n = 1;
            for (let p = s; p < e; p++) if (names.pool[p] === 46) n++;
            for (const m of ids) put((small ? incSmall : incLarge)[m], n, { row: rows[x], masks: ids.length });
        }
    };
    scan(pos, true);
    scan(neg, false);
    const items = new Map<string, string>();
    const add = (reps: Rep[], masks: string[], tree: MaskTree, label: string) => {
        for (const { row } of reps) {
            const s = names.start[row];
            items.set(names.text(row), label + tree.match(names.pool, s, s + names.len[row]).map(m => masks[m]).join(' '));
        }
    };
    include.forEach((mask, m) => {
        const reps = incSmall[m].size ? incSmall[m] : incLarge[m];
        const keys = [...reps.keys()];
        if (keys.length === 0) return;
        add(reps.get(Math.min(...keys))!, include, inc, '');
        if (mask.split('.').includes('**')) add(reps.get(Math.max(...keys))!, include, inc, '');
    });
    excAny.forEach(reps => add(reps.get(0) ?? [], exclude, exc, 'EXCLUDE '));
    nearAny.forEach(reps => add(reps.get(0) ?? [], wide, near, 'BEZ MASKI - '));
    return buildTests(prefix, [...items].map(([dsn, description]) => ({ dsn, description })));
}

function compareNames(names: Interner, a: number, b: number): number {
    const { pool, start, len } = names;
    const n = Math.min(len[a], len[b]);
    for (let i = 0; i < n; i++) {
        const d = pool[start[a] + i] - pool[start[b] + i];
        if (d) return d;
    }
    return len[a] - len[b];
}

export const testFile = (tests: TestCase[]): string => iebupdte(tests).join('\n') + '\n';
