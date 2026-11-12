/* REXX */
/*-------------------------------------------------------------------*/
/* TTPARSE  - testy jednostkowe modulu TGPARSE                       */
/*            exec = TTPARSE + TTLIB + moduly (jcl/BLDITn, BUILD)    */
/*-------------------------------------------------------------------*/
signal on syntax name tgFatal
signal on novalue name tgFatal
call tgInit
call ttStart 'TGPARSE'

call ttCase 'tokenize - proste tokeny'
call ttEq 'wynik', tokenize('RANGE(LISTIN) VAR(VOL) NOGAPS'), 1
call ttEq 'liczba tokenow', tk.0, 3
call ttEq 'token 1 nazwa', tk.1.name, 'RANGE'
call ttEq 'token 1 wartosc', tk.1.val, 'LISTIN'
call ttEq 'token 3 bez wartosci', tk.3.hv, 0
call tokenize 'var(x)'
call ttEq 'nazwa wielkimi literami', tk.1.name, 'VAR'
call ttEq 'raw zachowuje wielkosc liter', tk.1.raw, 'var'

call ttCase 'tokenize - nawiasy, apostrofy, przecinki'
call tokenize "PREFIX('A(B') X(F(1),2),Y"
call ttEq 'liczba tokenow', tk.0, 3
call ttEq 'nawias w apostrofach', tk.1.val, "'A(B'"
call ttEq 'zagniezdzony nawias', tk.2.val, 'F(1),2'
call ttEq 'przecinek jako separator', tk.3.name, 'Y'

call ttCase 'tokenize - bledy'
call ttEq 'nadmiarowy )', tokenize('A)'), 0
call ttRc 'nadmiarowy )', 8
call ttEq 'niedomkniety (', tokenize('A(B'), 0
call ttHasMsg 'niedomkniety (', 'Unbalanced parenthesis'
call ttEq 'niedomkniety apostrof', tokenize("A('B)"), 0
call ttHasMsg 'niedomkniety apostrof', 'Unterminated quote'

call ttCase 'parseStatement - skladnia 1: VERB(arg) opcje'
call ttEq 'wynik', parseStatement('RANGE(LISTIN) VAR(VOL) MAX(5)'), 1
call ttEq 'verb', g.pverb, 'RANGE'
call ttEq 'arg1', g.parg1, 'LISTIN'
call ttEq 'liczba opcji', opt.0, 2
call ttEq 'MAX', getOpt('MAX', ''), 5

call ttCase 'parseStatement - skladnia 2: VERB(arg, opcje)'
call ttEq 'wynik', parseStatement('range(LISTIN, var(VOL) max(5))'), 1
call ttEq 'verb', g.pverb, 'RANGE'
call ttEq 'arg1', g.parg1, 'LISTIN'
call ttEq 'liczba opcji', opt.0, 2
call ttEq 'VAR', getOpt('VAR', ''), 'VOL'

call ttCase 'parseStatement - bez argumentu, same opcje w nawiasie'
call parseStatement 'COMMAND'
call ttEq 'COMMAND arg1', g.parg1, ''
call ttEq 'COMMAND opcje', opt.0, 0
call parseStatement 'RANGE(VAR(X))'
call ttEq 'RANGE(VAR(X)) arg1', g.parg1, ''
call ttEq 'RANGE(VAR(X)) VAR', getOpt('VAR', ''), 'X'

call ttCase 'splitCommands - komentarze i kontynuacje'
drop rd.
rd.1 = '* komentarz'
rd.2 = '  SET A(1)   /* komentarz */'
rd.3 = '  RANGE VAR(VOL) -'
rd.4 = '        MAX(5)'
rd.5 = '  RANGE(LISTIN,'
rd.6 = '        VAR(VOL))'
rd.7 = '  LIST - /* kontynuacja z komentarzem */'
rd.8 = '        X(1)'
rd.9 = ''
rd.0 = 9
call splitCommands
call ttEq 'liczba polecen', cmd.0, 4
call ttEq 'komentarz REXX usuniety', cmd.1, 'SET A(1)'
call ttEq 'kontynuacja -', space(cmd.2), 'RANGE VAR(VOL) MAX(5)'
call ttEq 'otwarty nawias', space(cmd.3), 'RANGE(LISTIN, VAR(VOL))'
call ttEq 'kontynuacja - z komentarzem', space(cmd.4), 'LIST X(1)'
call ttRc 'bez bledow', 0

call ttCase 'splitCommands - kolumny 73-80 ignorowane'
drop rd.
rd.1 = left('  SET A(1)', 72) || '00010000'
rd.0 = 1
call splitCommands
call ttEq 'numer sekwencyjny obciety', cmd.1, 'SET A(1)'

call ttCase 'splitCommands - niezamkniete polecenie'
drop rd.
rd.1 = 'RANGE(LISTIN'
rd.0 = 1
call splitCommands
call ttEq 'brak polecen', cmd.0, 0
call ttRc 'blad', 8
call ttHasMsg 'komunikat', 'Unterminated statement'

call ttCase 'setTrace'
call setTrace 'r', 'TEST'
call ttEq 'poziom R', g.trace, 'R'
call ttRc 'poprawny poziom', 0
call setTrace 'Q', 'TEST'
call ttEq 'zly poziom - bez zmiany', g.trace, 'R'
call ttRc 'zly poziom', 8
call setTrace '', 'TEST'
call ttHasMsg 'brak poziomu', 'level missing'

call ttCase 'TRACE w CMDIN - obie skladnie'
call ttExec 'TRACE(O)'
call ttEq 'TRACE(O)', g.trace, 'O'
call ttExec 'TRACE N'
call ttEq 'TRACE N', g.trace, 'N'
call ttRc 'bez bledow', 0
call ttExec 'TRACE R X'
call ttRc 'nadmiarowy parametr', 8
call ttEq 'poziom bez zmiany', g.trace, 'N'

call ttCase 'parseParm'
call parseParm 'trace(I)'
call ttEq 'TRACE z PARM', g.trace, 'I'
g.trace = 'N'
call parseParm 'FOO(1)'
call ttRc 'nieznana opcja PARM', 8
call ttHasMsg 'komunikat', 'Unknown PARM option: FOO'

call ttCase 'execStatement - nieznane polecenie'
call ttExec 'FOO BAR(1)'
call ttRc 'blad', 8
call ttHasMsg 'komunikat', 'Unknown command: FOO'

exit ttEnd()
