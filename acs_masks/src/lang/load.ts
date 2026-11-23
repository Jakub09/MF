/** Wczytanie rutyn ACS z plikow: parsowanie, kontrola, przypisanie do typu (PROC). */
import fs from 'node:fs';
import path from 'node:path';
import type { Program, Routine } from 'acs-routines/lang/ast';
import { check, filtlistMap } from 'acs-routines/lang/check';
import type { Lists } from './eval';
import type { Diagnostic } from 'acs-routines/lang/lexer';
import { parse } from 'acs-routines/lang/parser';

export class AcsError extends Error {}

export interface Loaded {
    /** krotka etykieta do raportow: DC, SC, MC, SG */
    label: string;
    file: string;
    routine: Routine;
    program: Program;
    lists: Lists;
    diagnostics: Diagnostic[];
}

export type RoutineSet = Partial<Record<Routine, Loaded>>;

export const SHORT: Record<Routine, string> = { DATACLAS: 'DC', STORCLAS: 'SC', MGMTCLAS: 'MC', STORGRP: 'SG' };
/** Kolejnosc wywolywania rutyn przez SMS. */
export const ORDER: Routine[] = ['DATACLAS', 'STORCLAS', 'MGMTCLAS', 'STORGRP'];

export function formatDiag(file: string, d: Diagnostic): string {
    return `${file}:${d.range.start.line + 1}:${d.range.start.col + 1} ${d.severity} ${d.code} ${d.message}`;
}

export function loadSource(file: string, source: string): Omit<Loaded, 'routine' | 'label'> & { routine: Routine | null } {
    const program = parse(source);
    return { file, routine: program.routine, program, lists: filtlistMap(program), diagnostics: check(program, source) };
}

/** Wczytuje zestaw rutyn; blad skladni albo dwie rutyny tego samego typu -> AcsError. */
export function loadRoutines(files: string[], encoding: BufferEncoding = 'utf-8'): RoutineSet {
    const set: RoutineSet = {};
    for (const file of files) {
        const l = loadSource(file, fs.readFileSync(file, encoding));
        const errors = l.diagnostics.filter(d => d.severity === 'error');
        if (errors.length) {
            throw new AcsError(`rutyna ${file} ma bledy (${errors.length}):\n`
                + errors.slice(0, 20).map(d => '  ' + formatDiag(path.basename(file), d)).join('\n'));
        }
        if (!l.routine) throw new AcsError(`${file}: brak instrukcji PROC`);
        if (set[l.routine]) throw new AcsError(`dwie rutyny ${l.routine}: ${set[l.routine]!.file} i ${file}`);
        set[l.routine] = { ...l, routine: l.routine, label: SHORT[l.routine] };
    }
    return set;
}

export const loadedList = (set: RoutineSet): Loaded[] => ORDER.filter(r => set[r]).map(r => set[r]!);
