/* REXX */
/*-------------------------------------------------------------------*/
/* TTLIST   - testy jednostkowe modulu TGLIST                        */
/*            exec = TTLIST + TTLIB + moduly (jcl/BLDITn, jcl/BUILD) */
/*-------------------------------------------------------------------*/
signal on syntax name tgFatal
signal on novalue name tgFatal
call tgInit
call ttStart 'TGLIST'

call ttCase 'LIST(tabela)'
call ttTable 'T1', 'VOL UNIT', 'SYS001 1000;SYS002 1001'
call ttExec 'LIST(T1)'
call ttHasMsg 'naglowek', 'Table T1 (2 rec.): VOL UNIT'
call ttHasMsg 'rekord 2', 'VOL=SYS002 UNIT=1001'
call ttRc 'bez bledow', 0

call ttCase 'LIST - domyslnie biezaca tabela'
call ttTable 'T1', 'A', 'X1'
call ttTable 'T2', 'B', 'Y1'
call ttExec 'LIST'
call ttHasMsg 'biezaca = ostatnio utworzona', 'Table T2'

call ttCase 'LIST - pusta tabela'
call ttTable 'T1', 'A', '* tylko komentarz'
call ttExec 'LIST(T1)'
call ttHasMsg 'naglowek', 'Table T1 (0 rec.)'
call ttRc 'bez bledow', 0

call ttCase 'LIST - brak tabeli i DD'
call ttExec 'LIST(NOSUCH)'
call ttRc 'blad', 8

exit ttEnd()
