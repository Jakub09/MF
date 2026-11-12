/* REXX */
/*-------------------------------------------------------------------*/
/* TTSET    - testy jednostkowe modulu TGSET                         */
/*            exec = TTSET + TTLIB + moduly (jcl/BLDITn, jcl/BUILD)  */
/*-------------------------------------------------------------------*/
signal on syntax name tgFatal
signal on novalue name tgFatal
call tgInit
call ttStart 'TGSET'

call ttCase 'SET - kilka zmiennych'
call ttExec "SET HLQ(SYS1) DESC('A B')"
call ttEq 'HLQ', ttGlob('HLQ'), 'SYS1'
call ttEq 'DESC - apostrofy zdjete', ttGlob('DESC'), 'A B'
call ttEq 'lista zmiennych globalnych', space(g.globals), 'HLQ DESC'
call ttRc 'bez bledow', 0

call ttCase 'SET - nazwa malymi literami'
call ttExec 'SET hlq(x)'
call ttEq 'nazwa zamieniona na wielkie', ttGlob('HLQ'), 'x'

call ttCase 'SET - redefinicja'
call ttExec 'SET A(1)'
call ttExec 'SET A(2)'
call ttEq 'nowa wartosc', ttGlob('A'), 2
call ttEq 'bez duplikatu na liscie', space(g.globals), 'A'

call ttCase 'SET - pusta wartosc'
call ttExec 'SET E()'
call ttEq 'pusta', ttGlob('E'), ''
call ttRc 'bez bledow', 0

call ttCase 'SET - brak wartosci'
call ttExec 'SET A'
call ttRc 'blad', 8
call ttHasMsg 'komunikat', 'SET: invalid definition A'

call ttCase 'SET - niedozwolona nazwa'
call ttExec 'SET _X(1)'
call ttRc 'blad', 8
call ttEq 'nie zdefiniowano', ttGlob('_X'), '<undefined>'

exit ttEnd()
