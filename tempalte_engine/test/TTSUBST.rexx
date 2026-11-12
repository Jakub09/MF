/* REXX */
/*-------------------------------------------------------------------*/
/* TTSUBST  - testy jednostkowe modulu TGSUBST                       */
/*            exec = TTSUBST + TTLIB + moduly (jcl/BUILD)            */
/*   Szablony w pamieci (ttTpl). DD NOTPL ma NIE byc zaalokowany.    */
/*-------------------------------------------------------------------*/
signal on syntax name tgFatal
signal on novalue name tgFatal
call tgInit
call ttStart 'TGSUBST'

call ttCase 'COMMAND - linia na rekord'
call ttTable 'T1', 'VOL UNIT', 'SYS001 1000;SYS002 1001'
call ttTpl 'TPL', ' DELETE {VOL} U={UNIT}'
call ttExec 'COMMAND(TPL)'
call ttEq 'liczba linii', ttOutN('GENOUT'), 2
call ttEq 'linia 2', ttOut('GENOUT', 2), ' DELETE SYS002 U=1001'
call ttRc 'bez bledow', 0

call ttCase 'COMMAND - HEADER, TRAILER, MAXCMD, OUTPUT'
call ttTable 'T1', 'VOL', 'V1;V2;V3'
call ttTpl 'TPL', ' DEL {VOL}'
call ttTpl 'HDR', 'BLOCK {_JOBSEQ}'
call ttTpl 'TRL', 'END {_JOBSEQ}'
call ttExec 'COMMAND(TPL) HEADER(HDR) TRAILER(TRL) MAXCMD(2) OUTPUT(O1)'
call ttEq 'liczba linii', ttOutN('O1'), 7
call ttEq 'l1', ttOut('O1', 1), 'BLOCK 1'
call ttEq 'l3', ttOut('O1', 3), ' DEL V2'
call ttEq 'l4', ttOut('O1', 4), 'END 1'
call ttEq 'l5', ttOut('O1', 5), 'BLOCK 2'
call ttEq 'l7', ttOut('O1', 7), 'END 2'
call ttEq 'GENOUT nieuzywany', ttOutN('GENOUT'), 0

call ttCase 'STEP - unikalne nazwy krokow'
call ttTable 'T1', 'VOL', 'V1;V2'
call ttTpl 'TPL', '//STEP1    EXEC PGM=IEFBR14;//DD1      DD DSN={VOL}'
call ttTpl 'JC', '//MYJOB JOB (A)'
call ttExec 'STEP(TPL) HEADER(JC)'
call ttEq 'liczba linii', ttOutN('GENOUT'), 5
call ttEq 'karta JOB', ttOut('GENOUT', 1), '//MYJOB JOB (A)'
call ttEq 'krok 1', ttOut('GENOUT', 2), '//STEP001  EXEC PGM=IEFBR14'
call ttEq 'DD kroku 1', ttOut('GENOUT', 3), '//DD1      DD DSN=V1'
call ttEq 'krok 2', ttOut('GENOUT', 4), '//STEP002  EXEC PGM=IEFBR14'
call ttRc 'bez bledow', 0

call ttCase 'STEP - MAXSTEPS dzieli na joby'
call ttTable 'T1', 'VOL', 'V1;V2;V3'
call ttTpl 'TPL', '//S1 EXEC PGM=IEFBR14'
call ttTpl 'JC', '//J{_JOBSEQ} JOB (A)'
call ttTpl 'TRL', '//* END {_JOBSEQ}'
call ttExec 'STEP(TPL) HEADER(JC) TRAILER(TRL) MAXSTEPS(2)'
call ttEq 'liczba linii', ttOutN('GENOUT'), 7
call ttEq 'job 1', ttOut('GENOUT', 1), '//J1 JOB (A)'
call ttEq 'koniec joba 1', ttOut('GENOUT', 4), '//* END 1'
call ttEq 'job 2', ttOut('GENOUT', 5), '//J2 JOB (A)'
call ttEq 'krok 3', ttOut('GENOUT', 6), '//S003 EXEC PGM=IEFBR14'

call ttCase 'STEP - MAXSTEPS bez HEADER'
call ttTable 'T1', 'VOL', 'V1;V2;V3'
call ttTpl 'TPL', '//S1 EXEC PGM=IEFBR14'
call ttExec 'STEP(TPL) MAXSTEPS(2)'
call ttRc 'ostrzezenie', 4
call ttHasMsg 'komunikat', 'cannot split'
call ttEq 'wszystkie kroki', ttOutN('GENOUT'), 3

call ttCase 'STEP - NORENAME'
call ttTable 'T1', 'VOL', 'V1;V2'
call ttTpl 'TPL', '//S1 EXEC PGM=A'
call ttExec 'STEP(TPL) NORENAME'
call ttEq 'nazwa bez zmian', ttOut('GENOUT', 2), '//S1 EXEC PGM=A'

call ttCase 'STEP - etykieta ze zmienna nie jest zmieniana'
call ttTable 'T1', 'VOL', 'V1;V2'
call ttTpl 'TPL', '//X{_SEQ} EXEC PGM=B'
call ttExec 'STEP(TPL)'
call ttEq 'etykieta z _SEQ', ttOut('GENOUT', 2), '//X2 EXEC PGM=B'

call ttCase 'STEP - numeracja ciagla miedzy poleceniami'
call ttTable 'T1', 'VOL', 'V1'
call ttTpl 'TPL', '//S1 EXEC PGM=A'
call ttExec 'STEP(TPL)'
call ttExec 'STEP(TPL)'
call ttEq 'drugie polecenie', ttOut('GENOUT', 2), '//S002 EXEC PGM=A'

call ttCase 'JOB - job na rekord, HEADER widzi zmienne rekordu'
call ttTable 'T1', 'VOL', 'V1;V2'
call ttTpl 'JC', '//J{VOL} JOB (A)'
call ttTpl 'TPL', '//S1 EXEC PGM=X'
call ttExec 'JOB(TPL) HEADER(JC)'
call ttEq 'liczba linii', ttOutN('GENOUT'), 4
call ttEq 'job 2', ttOut('GENOUT', 3), '//JV2 JOB (A)'
call ttEq 'kroki bez zmiany nazw', ttOut('GENOUT', 4), '//S1 EXEC PGM=X'
call ttRc 'bez bledow', 0

call ttCase 'JOB - brak karty JOB'
call ttTable 'T1', 'VOL', 'V1'
call ttTpl 'TPL', '//S1 EXEC PGM=X'
call ttExec 'JOB(TPL)'
call ttRc 'ostrzezenie', 4
call ttHasMsg 'komunikat', 'contains a JOB card'

call ttCase 'SUBSTITUTE - MODE() i DATA()'
call ttTable 'D1', 'A', 'X1'
call ttTable 'D2', 'A', 'Y1;Y2'
call ttTpl 'TPL', '{A}'
call ttExec 'SUBSTITUTE(TPL) MODE(CMD) DATA(D1)'
call ttEq 'DATA(D1)', ttOut('GENOUT', 1), 'X1'
call ttExec 'SUBST(TPL)'
call ttEq 'domyslnie biezaca tabela D2', ttOutN('GENOUT'), 3
call ttEq 'D2 rekord 2', ttOut('GENOUT', 3), 'Y2'

call ttCase 'DELIM'
call ttTable 'T1', 'VOL', 'V1'
call ttTpl 'TPL', '<VOL> {VOL}'
call ttExec "COMMAND(TPL) DELIM('<>')"
call ttEq 'DELIM <>', ttOut('GENOUT', 1), 'V1 {VOL}'

call ttCase 'pusta tabela - nic nie generuje (takze naglowka)'
call ttTable 'T1', 'VOL', '* tylko komentarz'
call ttTpl 'TPL', '//S1 EXEC PGM=X'
call ttTpl 'JC', '//J JOB (A)'
call ttExec 'STEP(TPL) HEADER(JC)'
call ttEq 'brak wyjscia', ttOutN('GENOUT'), 0
call ttRc 'ostrzezenie', 4

call ttCase 'bledy parametrow'
call ttTable 'T1', 'VOL', 'V1'
call ttTpl 'TPL', 'X'
call ttExec 'SUBSTITUTE(TPL) MODE(FOO)'
call ttHasMsg 'MODE', 'Unknown MODE: FOO'
call ttExec 'STEP(TPL) MAXSTEPS(0)'
call ttHasMsg 'MAXSTEPS 0', 'MAXSTEPS must be 1-255'
call ttExec 'STEP(TPL) MAXSTEPS(256)'
call ttEq 'MAXSTEPS 256', ttMsgCount('MAXSTEPS must be 1-255'), 2
call ttExec 'COMMAND(TPL) MAXCMD(0)'
call ttHasMsg 'MAXCMD 0', 'MAXCMD must be a number > 0'
call ttExec 'STEP(TPL) MAXCMD(2)'
call ttHasMsg 'MAXCMD w trybie STEP', 'Unknown parameter MAXCMD'
call ttExec 'COMMAND(TPL) MAXSTEPS(2)'
call ttHasMsg 'MAXSTEPS w COMMAND', 'Unknown parameter MAXSTEPS'
call ttExec "COMMAND(TPL) DELIM('{{')"
call ttHasMsg 'DELIM', 'DELIM needs 2 different characters'
call ttExec 'COMMAND(NOTPL)'
call ttHasMsg 'brak DD szablonu', 'DD NOTPL (template) not allocated'
call ttExec 'COMMAND(TPL) DATA(NOSUCH)'
call ttHasMsg 'brak danych', 'DD NOSUCH (data) not allocated'
call ttEq 'nic nie wygenerowano', ttOutN('GENOUT'), 0
call ttRc 'bledy', 8

exit ttEnd()
