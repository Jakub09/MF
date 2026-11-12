/* REXX */
/*-------------------------------------------------------------------*/
/* TTOUT    - testy jednostkowe modulu TGOUT (bufor, OUTPUT, plan)   */
/*            exec = TTOUT + TTLIB + moduly (jcl/BLDITn, jcl/BUILD)  */
/*   writeOutputs (zapis przez EXECIO) testuja TTIO i TGRUN.         */
/*-------------------------------------------------------------------*/
signal on syntax name tgFatal
signal on novalue name tgFatal
call tgInit
call ttStart 'TGOUT'

call ttCase 'emit - nowe DD i licznik'
call emit 'OUT1', 'LINE 1   ', 0
call emit 'OUT1', 'LINE 2', 0
call ttEq 'liczba linii', outCount('OUT1'), 2
call ttEq 'spacje z prawej usuniete', ttOut('OUT1', 1), 'LINE 1'
call ttEq 'lista DD wyjsciowych', space(g.outs), 'OUT1'
call ttEq 'nieznane DD', outCount('OUT2'), 0
call ttRc 'bez bledow', 0

call ttCase 'emit - dwa DD'
call emit 'A', 'X', 0
call emit 'B', 'Y', 0
call emit 'A', 'Z', 0
call ttEq 'DD A', outCount('A'), 2
call ttEq 'DD B', outCount('B'), 1
call ttEq 'kolejnosc DD', space(g.outs), 'A B'

call ttCase 'emit - linia dluzsza niz 80 = blad (EXECIO by ja obcial)'
call emit 'OUT1', copies('X', 81), 0
call ttRc 'blad', 8
call ttHasMsg 'komunikat', 'longer than 80'

call ttCase 'emit - JCL poza kolumna 71'
call emit 'OUT1', '//' || copies('X', 70), 1
call ttRc 'ostrzezenie', 4
call ttHasMsg 'komunikat', 'beyond column 71'

call ttCase 'emit - dlugie linie, ktore sa OK'
call emit 'OUT1', '//' || copies('X', 70), 0
call ttRc '// w trybie COMMAND', 0
call emit 'OUT1', ' ' || copies('X', 75), 1
call ttRc 'dane (nie //) w trybie JCL', 0
call emit 'OUT1', copies('X', 80), 0
call ttRc 'dokladnie 80 znakow', 0

call ttCase 'OUTPUT - poprawne polecenia'
call ttExec 'OUTPUT(GENOUT) SPLIT(JOB)'
call ttEq 'SPLIT(JOB)', g.osplit.GENOUT, 'JOB'
call ttExec 'OUTPUT MEMBER(alljobs)'
call ttEq 'MEMBER - domyslnie DD GENOUT', g.osplit.GENOUT, 'MEMBER'
call ttEq 'nazwa membra wielkimi literami', g.omember.GENOUT, 'ALLJOBS'
call ttExec 'OUTPUT(SMSCMD) SPLIT(JOB)'
call ttEq 'inny DD', g.osplit.SMSCMD, 'JOB'
call ttRc 'bez bledow', 0

call ttCase 'OUTPUT - bledy'
call ttExec 'OUTPUT(GENOUT)'
call ttHasMsg 'brak parametru', 'specify SPLIT(JOB) or MEMBER(name)'
call ttExec 'OUTPUT(GENOUT) SPLIT(JOB) MEMBER(X)'
call ttEq 'SPLIT i MEMBER naraz',,
          ttMsgCount('specify SPLIT(JOB) or MEMBER(name)'), 2
call ttExec 'OUTPUT(GENOUT) SPLIT(ALL)'
call ttHasMsg 'zly SPLIT', 'SPLIT must be JOB: ALL'
call ttExec 'OUTPUT(GENOUT) SPLIT(NONE)'
call ttHasMsg 'SPLIT(NONE) usuniety', 'SPLIT must be JOB: NONE'
call ttExec 'OUTPUT(GENOUT) MEMBER(1ABC)'
call ttHasMsg 'zla nazwa membra', 'invalid member name: 1ABC'
call ttExec 'OUTPUT(GENOUT) FOO(1)'
call ttHasMsg 'nieznany parametr', 'Unknown parameter FOO'
call ttRc 'bledy', 8
call ttEq 'konfiguracja nieustawiona', g.osplit.GENOUT, ''

call ttCase 'plan - SYSOUT/INTRDR: jeden zbior'
call jobs3
call ttEq 'wynik', planOutput('GENOUT', '0;JES2.OUT;;;SYSOUT'), 1
call ttEq 'tryb', g.omode.GENOUT, 'NONE'
call ttRc 'bez bledow', 0

call ttCase 'plan - PDS (DSORG=PO): domyslnie 1 job = 1 member'
call jobs3
call ttEq 'wynik', planOutput('GENOUT', '0;MY.PDS;;PO;'), 1
call ttEq 'tryb', g.omode.GENOUT, 'MEMBERS'
call ttEq 'membery (preambula do 1.)', ttMembers('GENOUT'),,
          'J1(1-3) J2(4-5) J3(6-7)'
call ttEq 'dataset', g.odsn.GENOUT, 'MY.PDS'

call ttCase 'plan - POU to tez PDS'
call jobs3
call ttEq 'wynik', planOutput('GENOUT', '0;MY.PDS;;POU;'), 1
call ttEq 'tryb', g.omode.GENOUT, 'MEMBERS'

call ttCase 'plan - PDS + MEMBER(ALL): wszystko do jednego membra'
call jobs3
call ttExec 'OUTPUT(GENOUT) MEMBER(ALL)'
call ttEq 'wynik', planOutput('GENOUT', '0;MY.PDS;;PO;'), 1
call ttEq 'jeden member', ttMembers('GENOUT'), 'ALL(1-7)'

call ttCase 'plan - sekwencyjny (PS) + MEMBER = blad'
call jobs3
call ttExec 'OUTPUT(GENOUT) MEMBER(ALL)'
call ttEq 'wynik', planOutput('GENOUT', '0;MY.SEQ;;PS;'), 0
call ttHasMsg 'komunikat', 'need a PDS without member (DD is SEQ'

call ttCase 'plan - member podany w JCL: jeden zbior'
call jobs3
call ttEq 'wynik', planOutput('GENOUT', '0;MY.PDS;ALLJOBS;PO;'), 1
call ttEq 'tryb', g.omode.GENOUT, 'NONE'

call ttCase 'plan - sekwencyjny (PS): jeden zbior'
call jobs3
call ttEq 'wynik', planOutput('GENOUT', '0;MY.SEQ;;PS;'), 1
call ttEq 'tryb', g.omode.GENOUT, 'NONE'

call ttCase 'plan - DSORG nieznany: odmowa zapisu'
call jobs3
call ttEq 'wynik', planOutput('GENOUT', '0;MY.X;;;'), 0
call ttHasMsg 'komunikat', 'cannot tell if MY.X is a PDS'
call ttRc 'blad', 8

call ttCase 'plan - DSORG nieznany + SPLIT(JOB): membery'
call jobs3
call ttExec 'OUTPUT(GENOUT) SPLIT(JOB)'
call ttEq 'wynik', planOutput('GENOUT', '0;MY.X;;;'), 1
call ttEq 'tryb', g.omode.GENOUT, 'MEMBERS'

call ttCase 'plan - DSORG nieznany + MEMBER(ALL): jeden member'
call jobs3
call ttExec 'OUTPUT(GENOUT) MEMBER(ALL)'
call ttEq 'wynik', planOutput('GENOUT', '0;MY.X;;;'), 1
call ttEq 'jeden member', ttMembers('GENOUT'), 'ALL(1-7)'

call ttCase 'plan - SPLIT(JOB) na SYSOUT = blad'
call jobs3
call ttExec 'OUTPUT(GENOUT) SPLIT(JOB)'
call ttEq 'wynik', planOutput('GENOUT', '0;JES2.OUT;;;SYSOUT'), 0
call ttHasMsg 'komunikat', 'need a PDS without member'

call ttCase 'plan - PDS bez kart JOB = blad'
call emit 'GENOUT', '  DELETE X', 0
call ttEq 'wynik', planOutput('GENOUT', '0;MY.PDS;;PO;'), 0
call ttHasMsg 'komunikat', 'no JOB statement'

call ttCase 'plan - powtorzona nazwa joba = blad'
call emit 'GENOUT', '//J1 JOB (A)', 1
call emit 'GENOUT', '//J1 JOB (A)', 1
call ttEq 'wynik', planOutput('GENOUT', '0;MY.PDS;;PO;'), 0
call ttHasMsg 'komunikat', 'duplicate member J1 (lines 1 and 2)'

call ttCase 'plan - nazwa joba niedozwolona jako member'
call emit 'GENOUT', '//J-1 JOB (A)', 1
call ttEq 'wynik', planOutput('GENOUT', '0;MY.PDS;;PO;'), 0
call ttHasMsg 'komunikat', 'not a valid member name'

call ttCase 'plan - DD nie zaalokowany, blad BPXWDYN INFO'
call jobs3
call ttEq 'brak DD', planOutput('GENOUT', ''), 0
call ttHasMsg 'komunikat', 'DD GENOUT (output) not allocated'
call ttRc 'blad krytyczny', 12
call ttEq 'blad INFO', planOutput('GENOUT', '4;;;;'), 0
call ttHasMsg 'komunikat INFO', 'BPXWDYN INFO RC=4'

exit ttEnd()

/* Wyjscie z 3 jobami i linia komentarza przed pierwszym             */
jobs3: procedure expose (gx)
  call emit 'GENOUT', '//* wygenerowane', 1
  call emit 'GENOUT', '//J1 JOB (A)', 1
  call emit 'GENOUT', '//S1 EXEC PGM=IEFBR14', 1
  call emit 'GENOUT', '//J2 JOB (A)', 1
  call emit 'GENOUT', '//S1 EXEC PGM=IEFBR14', 1
  call emit 'GENOUT', '//J3 JOB (A)', 1
  call emit 'GENOUT', '//S1 EXEC PGM=IEFBR14', 1
  return
