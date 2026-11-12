/* REXX */
/*-------------------------------------------------------------------*/
/* TTLOAD   - testy jednostkowe modulu TGLOAD                        */
/*            exec = TTLOAD + TTLIB + moduly (jcl/BLDITn, jcl/BUILD) */
/*   Wymaga DD w kroku:                                              */
/*     LISTIN - 3 rekordy: VOLSR0 1000 / VOLSR1 1001 / VOLSR2 1002   */
/*     VARDEF - VOLSR UNIT                                           */
/*   DD NOSUCH ma NIE byc zaalokowany.                               */
/*-------------------------------------------------------------------*/
signal on syntax name tgFatal
signal on novalue name tgFatal
call tgInit
call ttStart 'TGLOAD'

call ttCase 'buildTable - podstawy'
call ttEq 'wynik',,
          ttTable('T1', 'vol unit', 'SYS001 1000;SYS002 1001'), 1
call ttEq 'liczba rekordow', ttRows('T1'), 2
call ttEq 'nazwy zmiennych wielkimi literami', ttVars('T1'), 'VOL UNIT'
call ttEq 'wartosc', ttVal('T1', 2, 'UNIT'), 1001
call ttEq 'biezaca tabela', g.cur, 'T1'
call ttEq 'ostatnie dane (zrodlo RANGE)', g.lastdata, 'T1'
call ttRc 'bez bledow', 0

call ttCase 'buildTable - ostatnia zmienna dostaje reszte linii'
call ttTable 'T2', 'VOL DESC', 'SYS001 opis z  dwiema spacjami'
call ttEq 'DESC', ttVal('T2', 1, 'DESC'), 'opis z  dwiema spacjami'

call ttCase 'buildTable - komentarze i puste linie pomijane'
call ttTable 'T3', 'VOL', '* komentarz;;SYS001;   ;SYS002'
call ttEq 'liczba rekordow', ttRows('T3'), 2
call ttEq 'rekord 2', ttVal('T3', 2, 'VOL'), 'SYS002'

call ttCase 'buildTable - za malo wartosci'
call ttTable 'T4', 'VOL UNIT', 'SYS001'
call ttRc 'ostrzezenie', 4
call ttEq 'brakujaca wartosc pusta', ttVal('T4', 1, 'UNIT'), ''

call ttCase 'buildTable - niedozwolona nazwa zmiennej'
call ttEq 'wynik', ttTable('T5', 'VOL _X', 'A B'), 0
call ttRc 'blad', 8
call ttEq 'tabela nie powstala', ttRows('T5'), -1

call ttCase 'buildTable - zdublowana nazwa zmiennej'
call ttEq 'wynik', ttTable('T5', 'VOL VOL', 'A B'), 0
call ttHasMsg 'komunikat', 'Invalid or duplicate variable name: VOL'

call ttCase 'buildTable - brak nazw zmiennych'
call ttEq 'wynik', ttTable('T5', '', 'A'), 0
call ttHasMsg 'komunikat', 'No variable names'

call ttCase 'LOAD z DD LISTIN + VARDEF'
call ttExec 'LOAD(LISTIN)'
call ttEq 'liczba rekordow', ttRows('LISTIN'), 3
call ttEq 'zmienne z VARDEF', ttVars('LISTIN'), 'VOLSR UNIT'
call ttEq 'wartosc', ttVal('LISTIN', 3, 'VOLSR'), 'VOLSR2'
call ttRc 'bez bledow', 0

call ttCase 'LOAD z VARS() zamiast VARDEF'
call ttExec 'LOAD(LISTIN) VARS(A B)'
call ttEq 'zmienne', ttVars('LISTIN'), 'A B'
call ttEq 'wartosc', ttVal('LISTIN', 1, 'B'), 1000

call ttCase 'LOAD - domyslnie DD LISTIN'
call ttExec 'LOAD'
call ttEq 'liczba rekordow', ttRows('LISTIN'), 3

call ttCase 'LOAD - DD nie zaalokowany'
call ttExec 'LOAD(NOSUCH)'
call ttRc 'blad', 8
call ttHasMsg 'komunikat', 'DD NOSUCH (data) not allocated'

call ttCase 'ensureTable - nie wczytuje ponownie'
call ttTable 'LISTIN', 'X', 'MEM1'
call ttEq 'wynik', ensureTable('LISTIN'), 1
call ttEq 'nadal tabela z pamieci', ttVal('LISTIN', 1, 'X'), 'MEM1'

exit ttEnd()
