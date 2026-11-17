/**
 * Grupy zbiorow i reprezentanci do testow NaviQuest.
 *
 * Grupa = zbiory z tym samym kluczem (wektor warunkow rutyn albo sciezka wykonania). Reprezentant:
 * pierwszy zbior grupy wg nazwy, z pierwszenstwem zbiorow nie-VSAM (rekord D zbioru VSAM ma nazwe
 * komponentu, wiec test z DCOLLECT dostalby nazwe .DATA / .INDEX zamiast klastra).
 * Wynik dla z/OS: member ACMRLST (FB 80) - kol. 1-44 nazwa z rekordu D, 46-51 wolumen, 53-59 numer grupy;
 * job ACMRSEL wybiera te rekordy D z DCOLLECT do REPDCOL (wejscie ACSTGEN).
 */
import type { DataSet } from './dataset';

export interface Group {
    /** numer grupy (od 1, wg malejacej liczby zbiorow) */
    id: number;
    key: string;
    count: number;
    /** indeksy zbiorow grupy */
    members: number[];
    reps: DataSet[];
    /** rozne obecne klasy DC/SC/MC/SG w grupie -> liczba zbiorow */
    classes: Map<string, number>;
    vsamOnly: boolean;
}

export interface GroupOptions {
    /** reprezentantow na grupe */
    perGroup: number;
    /** osobny reprezentant dla kazdej kombinacji obecnych klas w grupie */
    byClasses: boolean;
}

export const classKey = (d: DataSet) => `${d.dc}/${d.sc}/${d.mc}/${d.sg}`;

/**
 * Grupowanie wg klucza. Klucz jest liczony po kolei dla kazdego zbioru (keyOf(i), i rosnaco) i nie jest
 * przechowywany per zbior - w pamieci zostaja tylko klucze grup (duze CSV: miliony zbiorow).
 */
export function buildGroups(dataSets: DataSet[], keyOf: (i: number) => string, opt: GroupOptions): Group[] {
    const map = new Map<string, number[]>();
    for (let i = 0; i < dataSets.length; i++) {
        const k = keyOf(i);
        const m = map.get(k);
        if (m) m.push(i);
        else map.set(k, [i]);
    }
    const groups: Group[] = [];
    for (const [key, members] of map) {
        const classes = new Map<string, number>();
        for (const i of members) classes.set(classKey(dataSets[i]), (classes.get(classKey(dataSets[i])) ?? 0) + 1);
        // nie-VSAM przed VSAM; w ramach tego - kolejnosc nazw (dataSets jest posortowane)
        const order = [...members.filter(i => !dataSets[i].vsam), ...members.filter(i => dataSets[i].vsam)];
        let reps: DataSet[];
        if (opt.byClasses) {
            const seen = new Set<string>();
            reps = [];
            for (const i of order) {
                const ck = classKey(dataSets[i]);
                if (!seen.has(ck)) {
                    seen.add(ck);
                    reps.push(dataSets[i]);
                }
            }
        } else {
            reps = order.slice(0, Math.max(1, opt.perGroup)).map(i => dataSets[i]);
        }
        groups.push({ id: 0, key, count: members.length, members, reps, classes, vsamOnly: dataSets[order[0]].vsam });
    }
    groups.sort((a, b) => b.count - a.count || (a.reps[0].dsn < b.reps[0].dsn ? -1 : 1));
    groups.forEach((g, i) => (g.id = i + 1));
    return groups;
}

/** Member ACMRLST: reprezentanci (nazwa i wolumen pierwszego rekordu D) - wejscie joba ACMRSEL. */
export function listMember(groups: Group[]): string[] {
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const g of groups) {
        for (const d of g.reps) {
            const k = `${d.recDsn} ${d.vol}`;
            if (seen.has(k)) continue;
            seen.add(k);
            lines.push(`${d.recDsn.padEnd(44)} ${d.vol.padEnd(6)} G${String(g.id).padStart(6, '0')}`);
        }
    }
    return lines.sort();
}

const q = (s: string | number) => String(s).replace(/;/g, ',');

export function groupsCsv(groups: Group[], describe: (g: Group) => string, extra: { head: string[]; row: (g: Group) => (string | number)[] }): string {
    const head = ['grupa', 'zbiorow', 'reprezentant', 'rekord_d', 'wolumen', 'vsam', 'roznych_klas', ...extra.head, 'opis'];
    const rows = groups.flatMap(g => g.reps.map(d =>
        [g.id, g.count, d.dsn, d.recDsn, d.vol, d.vsam ? 'T' : 'N', g.classes.size, ...extra.row(g), describe(g)].map(q).join(';')));
    return [head.join(';'), ...rows].join('\n') + '\n';
}

/** zbiory.csv - linie generowane w trakcie zapisu (bez jednego napisu na caly plik). */
export function* membersCsv(dataSets: DataSet[], groups: Group[]): Generator<string> {
    const of = new Int32Array(dataSets.length);
    for (const g of groups) for (const i of g.members) of[i] = g.id;
    yield 'dsn;grupa;dc;sc;mc;sg';
    for (let i = 0; i < dataSets.length; i++) {
        const d = dataSets[i];
        yield `${d.dsn};${of[i]};${d.dc};${d.sc};${d.mc};${d.sg}`;
    }
}
