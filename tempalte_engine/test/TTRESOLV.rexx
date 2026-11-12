/* REXX */
/*-------------------------------------------------------------------*/
/* TTRESOLV - testy jednostkowe modulu TGRESOLV (podstawianie)       */
/*            exec = TTRESOLV + TTLIB + moduly (jcl/BUILD)           */
/*-------------------------------------------------------------------*/
signal on syntax name tgFatal
signal on novalue name tgFatal
call tgInit
call ttStart 'TGRESOLV'

call ttCase 'zmienne z rekordu'
call ttTable 'T1', 'VOL UNIT', 'SYS001 1000;SYS002 1001'
call delims '{}'
call ttEq 'podstawienie', subst('V={VOL} U={UNIT}', 2, 'T1'),,
          'V=SYS002 U=1001'
call ttEq 'nazwa malymi literami', subst('{vol}', 1, 'T1'), 'SYS001'
call ttEq 'spacje w nawiasie', subst('{ VOL }', 1, 'T1'), 'SYS001'
call ttEq 'bez zmiennych', subst('ABC', 1, 'T1'), 'ABC'
call ttEq 'pusta linia', subst('', 1, 'T1'), ''
call ttRc 'bez bledow', 0

call ttCase 'zmienne wbudowane i globalne (SET)'
call ttTable 'T1', 'VOL', 'A;B;C'
call delims '{}'
g.count = 3
g.jobseq = 7
call ttExec 'SET HLQ(SYS1)'
call ttEq '_SEQ', subst('{_SEQ}', 2, 'T1'), 2
call ttEq '_COUNT', subst('{_COUNT}', 2, 'T1'), 3
call ttEq '_JOBSEQ', subst('{_JOBSEQ}', 2, 'T1'), 7
call ttEq '_DATE = 8 cyfr', datatype(subst('{_DATE}', 1, 'T1'), 'W'),
          length(subst('{_DATE}', 1, 'T1')), '1 8'
call ttEq 'globalna', subst('{HLQ}.X', 1, 'T1'), 'SYS1.X'
call ttRc 'bez bledow', 0

call ttCase 'zmienna rekordu wygrywa z globalna o tej samej nazwie'
call ttTable 'T1', 'HLQ', 'ROWVAL'
call delims '{}'
call ttExec 'SET HLQ(GLOBVAL)'
call ttEq 'rekord', subst('{HLQ}', 1, 'T1'), 'ROWVAL'
call ttEq 'naglowek (r=0) -> globalna', subst('{HLQ}', 0, 'T1'),,
          'GLOBVAL'

call ttCase 'modyfikatory'
call ttTable 'T1', 'VOL N', 'Sys01 7'
call delims '{}'
call ttEq ':U', subst('{VOL:U}', 1, 'T1'), 'SYS01'
call ttEq ':L', subst('{VOL:L}', 1, 'T1'), 'sys01'
call ttEq 'liczba :3 - zera z lewej', subst('{N:3}', 1, 'T1'), '007'
call ttEq 'tekst :8 - spacje z prawej', subst('<{VOL:8}>', 1, 'T1'),,
          '<Sys01   >'
call ttEq 'tekst :3 - obciecie', subst('{VOL:3}', 1, 'T1'), 'Sys'
call ttEq 'lancuch :U:8', subst('{VOL:U:8}#', 1, 'T1'), 'SYS01   #'
call ttRc 'bez bledow', 0

call ttCase 'bledne modyfikatory - wartosc bez zmian, bez przerwania'
call ttTable 'T1', 'N', '7'
call delims '{}'
call ttEq ':0', subst('{N:0}', 1, 'T1'), 7
call ttEq ':-3 (wczesniej awaria REXX)', subst('{N:-3}', 1, 'T1'), 7
call ttEq ':999', subst('{N:999}', 1, 'T1'), 7
call ttEq ':Q', subst('{N:Q}', 1, 'T1'), 7
call ttRc 'blad', 8
call ttEq 'kazdy zly modyfikator raz', ttMsgCount('Unknown modifier'), 4

call ttCase 'escape {{ i niezamknieta zmienna'
call ttTable 'T1', 'VOL', 'A'
call delims '{}'
call ttEq '{{ -> {', subst('X{{Y}', 1, 'T1'), 'X{Y}'
call ttRc 'escape bez bledow', 0
call ttEq 'niezamknieta - bez zmian', subst('A{VOL', 1, 'T1'), 'A{VOL'
call ttRc 'niezamknieta', 4

call ttCase 'nieznana zmienna'
call ttTable 'T1', 'VOL', 'A'
call delims '{}'
call ttEq 'zostaje w tekscie', subst('{NOPE}-{NOPE}', 1, 'T1'),,
          '{NOPE}-{NOPE}'
call ttRc 'blad', 8
call ttEq 'komunikat tylko raz', ttMsgCount('Unknown variable'), 1

call ttCase 'zmienna rekordu w naglowku (r=0)'
call ttTable 'T1', 'VOL', 'A'
call delims '{}'
call subst '{VOL}', 0, 'T1'
call ttHasMsg 'komunikat', 'not available in HEADER/TRAILER'

call ttCase 'inne delimitery'
call ttTable 'T1', 'VOL', 'A'
call delims '<>'
call ttEq '<VOL>, {VOL} to zwykly tekst', subst('<VOL>{VOL}', 1, 'T1'),,
          'A{VOL}'

exit ttEnd()

/* Ustawia delimitery zmiennych (normalnie robi to doSubst)          */
delims: procedure expose (gx)
  parse arg d
  g.dO = left(d, 1)
  g.dC = right(d, 1)
  return
