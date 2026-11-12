/* REXX */
/*-------------------------------------------------------------------*/
/* TTRANGE  - testy jednostkowe modulu TGRANGE                       */
/*            exec = TTRANGE + TTLIB + moduly (jcl/BLDITn, BUILD)    */
/*-------------------------------------------------------------------*/
signal on syntax name tgFatal
signal on novalue name tgFatal
call tgInit
call ttStart 'TGRANGE'

call ttCase 'dziesietne - cyfry na koncu wartosci'
call ttTable 'T1', 'VOL', 'SYS001;SYS002;SYS003;SYS005'
call ttExec 'RANGE(T1) VAR(VOL)'
call ttEq 'liczba zakresow', ttRows('RANGES'), 2
call ttEq 'z1 RNGPREF', ttVal('RANGES', 1, 'RNGPREF'), 'SYS'
call ttEq 'z1 RNGSTART', ttVal('RANGES', 1, 'RNGSTART'), '001'
call ttEq 'z1 RNGEND', ttVal('RANGES', 1, 'RNGEND'), '003'
call ttEq 'z1 RNGCOUNT', ttVal('RANGES', 1, 'RNGCOUNT'), 3
call ttEq 'z2 RNGFIRST', ttVal('RANGES', 2, 'RNGFIRST'), 'SYS005'
call ttEq 'z2 RNGLAST', ttVal('RANGES', 2, 'RNGLAST'), 'SYS005'
call ttEq 'RNGTYPE puste', ttVal('RANGES', 1, 'RNGTYPE'), ''
call ttEq 'biezaca tabela = wynik', g.cur, 'RANGES'
call ttRc 'bez bledow', 0

call ttCase 'sortowanie, kolumny z pierwszego rekordu zakresu'
call ttTable 'T1', 'VOL UNIT', 'SYS003 C;SYS001 A;SYS002 B'
call ttExec 'RANGE VAR(VOL)'
call ttEq 'jeden zakres', ttRows('RANGES'), 1
call ttEq 'UNIT z SYS001', ttVal('RANGES', 1, 'UNIT'), 'A'
call ttEq 'RNGLAST', ttVal('RANGES', 1, 'RNGLAST'), 'SYS003'

call ttCase 'TYPE(X) - ciaglosc hex 009 -> 00A'
call ttTable 'T1', 'VOL',,
     'VOL008;VOL009;VOL00A;VOL00B;VOL00F;VOL010;VOL013'
call ttExec "RANGE VAR(VOL) PREFIX('VOL') TYPE(X)"
call ttEq 'liczba zakresow', ttRows('RANGES'), 3
call ttEq 'z1', rng(1), '008-00B'
call ttEq 'z2', rng(2), '00F-010'
call ttEq 'z3', rng(3), '013-013'
call ttEq 'RNGTYPE', ttVal('RANGES', 1, 'RNGTYPE'), 'X'
call ttRc 'bez bledow', 0

call ttCase 'TYPE(N) - te same dane dziesietnie'
call ttTable 'T1', 'VOL',,
     'VOL008;VOL009;VOL00A;VOL00B;VOL00F;VOL010;VOL013'
call ttExec "RANGE VAR(VOL) PREFIX('VOL') TYPE(N)"
call ttRc 'wartosci hex pominiete', 4
call ttEq 'liczba zakresow', ttRows('RANGES'), 2
call ttEq 'z1', rng(1), '008-010'

call ttCase 'AUTO - wykrywa hex'
call ttTable 'T1', 'VOL', 'VOLSR0;VOLSR1;VOLSRA'
call ttExec "RANGE VAR(VOL) PREFIX('VOLSR')"
call ttEq 'RNGTYPE X', ttVal('RANGES', 1, 'RNGTYPE'), 'X'
call ttEq 'zakresy 0-1 i A', ttRows('RANGES'), 2

call ttCase 'MAX - dzielenie dlugich zakresow'
call ttTable 'T1', 'VOL', 'S001;S002;S003;S004;S005'
call ttExec 'RANGE VAR(VOL) MAX(2)'
call ttEq 'liczba zakresow', ttRows('RANGES'), 3
call ttEq 'z3', rng(3), '005-005'

call ttCase 'GAPS - przerwy dozwolone, MAX = rozpietosc'
call ttTable 'T1', 'VOL', 'S001;S002;S005;S009;S020'
call ttExec 'RANGE VAR(VOL) GAPS MAX(10)'
call ttEq 'liczba zakresow', ttRows('RANGES'), 2
call ttEq 'z1', rng(1), '001-009'
call ttEq 'z1 RNGCOUNT', ttVal('RANGES', 1, 'RNGCOUNT'), 4

call ttCase 'duplikaty i wartosci bez cyfr'
call ttTable 'T1', 'VOL', 'S001;S002;S002;ABC'
call ttExec 'RANGE VAR(VOL)'
call ttRc 'ostrzezenia', 4
call ttHasMsg 'duplikat', 'duplicate S002'
call ttHasMsg 'bez cyfr', 'skipping ABC'
call ttEq 'liczba zakresow', ttRows('RANGES'), 1
call ttEq 'RNGCOUNT', ttVal('RANGES', 1, 'RNGCOUNT'), 2

call ttCase 'rozne prefiksy i dlugosci = osobne zakresy'
call ttTable 'T1', 'VOL', 'SYS01;PRD01;PRD02;SYS02;SYS003'
call ttExec 'RANGE VAR(VOL)'
call ttEq 'liczba zakresow', ttRows('RANGES'), 3
call ttEq 'z1 PRD', ttVal('RANGES', 1, 'RNGFIRST'), 'PRD01'
call ttEq 'z3 inna dlugosc', ttVal('RANGES', 3, 'RNGFIRST'), 'SYS003'

call ttCase 'DIGITS i SUFFIX'
call ttTable 'T1', 'VOL', 'A01X;A02X;A03X;B01Y'
call ttExec "RANGE VAR(VOL) DIGITS(2) SUFFIX('X')"
call ttRc 'B01Y bez suffixu X', 4
call ttEq 'liczba zakresow', ttRows('RANGES'), 1
call ttEq 'RNGPREF', ttVal('RANGES', 1, 'RNGPREF'), 'A'
call ttEq 'RNGSUFF', ttVal('RANGES', 1, 'RNGSUFF'), 'X'
call ttEq 'zakres', rng(1), '01-03'

call ttCase 'drugi RANGE czyta dane, a nie wynik pierwszego'
call ttTable 'T1', 'VOL', 'S001;S002'
call ttExec 'RANGE VAR(VOL) INTO(R1)'
call ttExec 'RANGE VAR(VOL) INTO(R2)'
call ttEq 'R2 z T1', ttVal('R2', 1, 'RNGCOUNT'), 2

call ttCase 'pusty wynik'
call ttTable 'T1', 'VOL', 'ABC;DEF'
call ttExec 'RANGE VAR(VOL)'
call ttEq 'brak zakresow', ttRows('RANGES'), 0
call ttRc 'ostrzezenia', 4

call ttCase 'czesc zmienna dluzsza niz 20 znakow'
call ttTable 'T1', 'VOL', 'A123456789012345678901;A01'
call ttExec 'RANGE VAR(VOL)'
call ttHasMsg 'pominieta', 'longer than 20'
call ttEq 'zostal A01', ttRows('RANGES'), 1

call ttCase 'bledy parametrow'
call ttTable 'T1', 'VOL', 'S001'
call ttExec 'RANGE VAR(XYZ)'
call ttHasMsg 'brak zmiennej', 'variable XYZ does not exist'
call ttExec 'RANGE TYPE(X) BASE(16)'
call ttHasMsg 'TYPE i BASE', 'TYPE or BASE, not both'
call ttExec 'RANGE TYPE(Q)'
call ttHasMsg 'zly TYPE', 'TYPE must be X'
call ttExec 'RANGE TYPE(X)'
call ttHasMsg 'TYPE(X) bez PREFIX', 'requires PREFIX or'
call ttExec 'RANGE GAPS NOGAPS'
call ttHasMsg 'GAPS i NOGAPS', 'mutually exclusive'
call ttExec 'RANGE MAX(-1)'
call ttHasMsg 'MAX ujemne', 'MAX must be a whole number'
call ttExec 'RANGE MAX(X)'
call ttEq 'MAX nieliczbowe', ttMsgCount('MAX must be'), 2
call ttExec "RANGE PREFIX('S') DIGITS(2)"
call ttHasMsg 'PREFIX i DIGITS', 'PREFIX or DIGITS, not both'
call ttExec 'RANGE DIGITS(25)'
call ttHasMsg 'DIGITS > 20', 'DIGITS must be 1-20'
call ttExec "RANGE BASE(99) PREFIX('S')"
call ttHasMsg 'BASE poza zakresem', 'BASE must be 2-36'
call ttExec 'RANGE(T1) INTO(T1)'
call ttHasMsg 'INTO = zrodlo', 'must differ from source'
call ttExec 'RANGE FOO(1)'
call ttHasMsg 'nieznany parametr', 'Unknown parameter FOO'
call ttRc 'bledy', 8
call ttEq 'zadnego zakresu', ttRows('RANGES'), -1

exit ttEnd()

/* 'start-end' zakresu nr i z tabeli RANGES                          */
rng: procedure expose (gx)
  parse arg i
  return ttVal('RANGES', i, 'RNGSTART')'-'ttVal('RANGES', i, 'RNGEND')
