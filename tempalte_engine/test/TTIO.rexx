/* REXX */
/*-------------------------------------------------------------------*/
/* TTIO     - testy jednostkowe modulu TGIO (EXECIO, BPXWDYN)        */
/*            exec = TTIO + TTLIB + moduly (jcl/BLDITn, jcl/BUILD)   */
/*   Wymaga DD w kroku:                                              */
/*     TTIN  - DD * z 3 liniami: 'LINE ONE', '  LINE TWO', pusta     */
/*     TTOUT - pusty dataset FB80 z DSORG=PS (np. &&TTOUT,           */
/*             DISP=(NEW,DELETE),...,DSORG=PS)                       */
/*   DD NOSUCH ma NIE byc zaalokowany.                               */
/*-------------------------------------------------------------------*/
signal on syntax name tgFatal
signal on novalue name tgFatal
call tgInit
call ttStart 'TGIO'

call ttCase 'ddExists'
call ttEq 'DD TTIN istnieje', ddExists('TTIN'), 1
call ttEq 'nazwa malymi literami', ddExists('ttin'), 1
call ttEq 'DD NOSUCH nie istnieje', ddExists('NOSUCH'), 0

call ttCase 'readDD'
call readDD 'TTIN'
call ttEq 'liczba linii', rd.0, 3
call ttEq 'linia 1', rd.1, 'LINE ONE'
call ttEq 'linia 2 - spacje z lewej zostaja', rd.2, '  LINE TWO'
call ttEq 'linia 3 - pusta (spacje z prawej usuniete)', rd.3, ''
call ttRc 'odczyt', 0

call ttCase 'ddInfo (BPXWDYN INFO)'
parse value ddInfo('TTOUT') with irc ';' dsn ';' mem ';' org ';' typ
call ttEq 'TTOUT: RC', irc, 0
call ttEq 'TTOUT: DSORG z DD (DSORG=PS)', org, 'PS'
call ttEq 'TTOUT: typ = dataset (puste)', typ, ''
call ttEq 'TTOUT: bez membra', mem, ''
call ttEq 'TTOUT: nazwa datasetu ustawiona', dsn <> '', 1
parse value ddInfo('TTIN') with irc ';' .
call ttEq 'TTIN: RC', irc, 0
say 'TTST-I ddInfo(TTOUT) =' ddInfo('TTOUT')
say 'TTST-I ddInfo(TTIN)  =' ddInfo('TTIN')

call ttCase 'writeDD + ponowny odczyt'
drop wr.
wr.0 = 2
wr.1 = 'OUT A'
wr.2 = 'OUT B'
call writeDD 'TTOUT'
call ttRc 'zapis', 0
call ttHasMsg 'komunikat zapisu', '2 lines written to DD TTOUT'
call readDD 'TTOUT'
call ttEq 'odczyt - liczba linii', rd.0, 2
call ttEq 'odczyt - linia 2', rd.2, 'OUT B'

call ttCase 'writeDD - DD nie zaalokowany'
drop wr.
wr.0 = 1
wr.1 = 'X'
call writeDD 'NOSUCH'
call ttRc 'blad krytyczny', 12
call ttHasMsg 'komunikat', 'DD NOSUCH (output) not allocated'

exit ttEnd()
