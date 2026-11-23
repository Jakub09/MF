/**
 * Interpreter rutyn ACS na danych z DCOLLECT (emulator).
 *
 * Wykonanie jednej rutyny: instrukcje po kolei; IF / SELECT (pierwszy prawdziwy WHEN, inaczej OTHERWISE);
 * SET ustawia zmienna rutyny; EXIT konczy rutyne, EXIT CODE(n) z n > 0 = alokacja odrzucona.
 * Kolejnosc rutyn ("ACS routine environments"): DATACLAS, STORCLAS, a gdy klasa pamieci nie jest pusta:
 * MGMTCLAS i STORGRP. Wynik wczesniejszej rutyny jest wejsciem nastepnych (&STORCLAS w rutynie SG).
 *
 * Wartosci poczatkowe zmiennych do ustawiania:
 *  - rutyna podana: pusta (opcja initial: 'null') albo obecna klasa z DCOLLECT ('dcollect');
 *    &STORGRP zawsze pusta
 *  - rutyna niepodana: obecna klasa z DCOLLECT (najlepsza znana wartosc), wynik = ta klasa
 *
 * Czego emulator nie robi (do weryfikacji z NaviQuest): domyslne atrybuty z klasy danych, wyjscia
 * instalacyjne, sprawdzanie, czy klasa / grupa istnieje w konfiguracji SMS.
 * Sciezka wykonania (path): zapis decyzji IF / SELECT - zbiory z ta sama sciezka sa dla rutyn
 * nierozroznialne.
 */
import type { Routine, Stmt } from 'acs-routines/lang/ast';
import { Env, getVar } from './env';
import { evalExpr } from './eval';
import { Loaded, ORDER, RoutineSet, SHORT } from './load';

export interface RoutineRun {
    /** wartosci przypisane przez SET (ostatnie); null = rutyna niczego nie ustawila */
    value: string[] | null;
    /** kod EXIT (0 = brak albo EXIT bez kodu) */
    exit: number;
    path: string;
    /** komunikaty WRITE (tylko gdy trace) */
    writes: string[];
}

class Exit {
    constructor(readonly code: number) {}
}

export function runRoutine(l: Loaded, env: Env, withWrites = false): RoutineRun {
    const target = l.routine as string;
    let value: string[] | null = null;
    const path: string[] = [];
    const writes: string[] = [];
    const exec = (stmts: Stmt[]): void => {
        for (const s of stmts) {
            switch (s.kind) {
                case 'set': {
                    if (!s.target || s.target.name !== target) break;
                    value = s.values.map(x => (x.kind === 'literal' ? x.value.toUpperCase() : String(getVar(env, x.name, x.index))));
                    env.values[target] = value[0] ?? '';
                    break;
                }
                case 'if': {
                    const t = evalExpr(s.cond, env, l.lists);
                    path.push(`${s.id}${t ? 'T' : 'F'}`);
                    const branch = t ? s.then : s.else;
                    if (branch) exec([branch]);
                    break;
                }
                case 'select': {
                    let hit = -1;
                    for (let k = 0; k < s.whens.length; k++) {
                        if (evalExpr(s.whens[k].cond, env, l.lists)) {
                            hit = k;
                            break;
                        }
                    }
                    path.push(`${s.id}:${hit < 0 ? 'O' : hit}`);
                    if (hit >= 0) exec(s.whens[hit].body);
                    else if (s.otherwise) exec(s.otherwise);
                    break;
                }
                case 'do':
                    exec(s.body);
                    break;
                case 'exit':
                    throw new Exit(s.code);
                case 'write':
                    if (withWrites) {
                        writes.push(s.parts.map(x => (x.kind === 'literal' ? x.value : String(getVar(env, x.name, x.index)))).join(''));
                    }
                    break;
                default:
                    break;
            }
        }
    };
    let exit = 0;
    try {
        exec(l.program.body);
    } catch (e) {
        if (!(e instanceof Exit)) throw e;
        exit = e.code;
        path.push(`X${e.code}`);
    }
    return { value, exit, path: path.join(' '), writes };
}

export interface SimOptions {
    /** wartosc poczatkowa zmiennej rutyny: pusta czy obecna klasa z DCOLLECT */
    initial: 'null' | 'dcollect';
    writes?: boolean;
}

export interface SimResult {
    dc: string;
    sc: string;
    mc: string;
    /** grupy pamieci rozdzielone przecinkami */
    sg: string;
    /** '' albo rutyna i kod EXIT, np. SC:22 (alokacja odrzucona) */
    fail: string;
    path: string;
    writes: string[];
}

const FIELD: Record<Routine, 'dc' | 'sc' | 'mc' | 'sg'> = { DATACLAS: 'dc', STORCLAS: 'sc', MGMTCLAS: 'mc', STORGRP: 'sg' };

/** Wykonuje podane rutyny w kolejnosci SMS; env jest modyfikowane (zmienne do ustawiania). */
export function simulate(set: RoutineSet, env: Env, opt: SimOptions): SimResult {
    const ds = env.ds;
    const res: SimResult = { dc: ds.dc, sc: ds.sc, mc: ds.mc, sg: ds.sg, fail: '', path: '', writes: [] };
    const paths: string[] = [];
    for (const r of ORDER) {
        const l = set[r];
        if ((r === 'MGMTCLAS' || r === 'STORGRP') && res.sc === '') {
            // bez klasy pamieci zbior nie jest zarzadzany przez SMS - rutyny MC i SG nie sa wywolywane
            res[FIELD[r]] = '';
            env.values[r] = '';
            continue;
        }
        if (!l) continue;
        const init = r === 'STORGRP' || opt.initial === 'null' ? '' : res[FIELD[r]];
        env.values[r] = init;
        const run = runRoutine(l, env, opt.writes);
        paths.push(`${SHORT[r]}[${run.path}]`);
        if (opt.writes) res.writes.push(...run.writes);
        const value = run.value ? run.value.filter((x, i) => i === 0 || x !== '').join(',') : init;
        res[FIELD[r]] = value;
        env.values[r] = run.value ? run.value[0] ?? '' : init;
        if (run.exit !== 0) {
            res.fail = `${SHORT[r]}:${run.exit}`;
            break;
        }
    }
    res.path = paths.join(' ');
    return res;
}
