/* REXX */
/*-------------------------------------------------------------------*/
/* TTHELP   - testy jednostkowe modulu TGHELP                        */
/*            exec = TTHELP + TTLIB + moduly (jcl/BLDITn, jcl/BUILD) */
/*-------------------------------------------------------------------*/
signal on syntax name tgFatal
signal on novalue name tgFatal
call tgInit
call ttStart 'TGHELP'

call ttCase 'tgInit'
call ttEq 'gx zawiera stemy', wordpos('val.', gx) > 0, 1
call ttEq 'MAXRC = 0', g.maxrc, 0
call ttEq 'TRACE = N', g.trace, 'N'
call ttEq 'nazwa exec ustawiona', g.pgm <> '', 1

call ttCase 'unquote'
call ttEq 'apostrofy', unquote("'ABC'"), 'ABC'
call ttEq 'cudzyslowy', unquote('"x y"'), 'x y'
call ttEq 'podwojony apostrof', unquote("'IT''S'"), "IT'S"
call ttEq 'bez cudzyslowow + spacje', unquote('  VOL  '), 'VOL'
call ttEq 'niedomkniety', unquote("'ABC"), "'ABC"
call ttEq 'pusty literal', unquote("''"), ''
call ttEq 'jeden znak', unquote("'"), "'"

call ttCase 'validName'
call ttEq 'litery i cyfry', validName('VOL1'), 1
call ttEq 'znaki narodowe', validName('A#@$_'), 1
call ttEq 'pusta', validName(''), 0
call ttEq 'zaczyna sie od _', validName('_SEQ'), 0
call ttEq 'myslnik', validName('A-B'), 0
call ttEq 'male litery (wolajacy robi translate)', validName('vol'), 0

call ttCase 'validMember'
call ttEq 'litery i cyfry', validMember('VOLSR0'), 1
call ttEq 'znaki narodowe', validMember('$X#@1'), 1
call ttEq '8 znakow', validMember('ABCDEFGH'), 1
call ttEq '9 znakow', validMember('ABCDEFGHI'), 0
call ttEq 'cyfra na poczatku', validMember('1ABC'), 0
call ttEq 'podkreslnik', validMember('A_B'), 0
call ttEq 'myslnik', validMember('A-B'), 0
call ttEq 'pusta', validMember(''), 0

call ttCase 'dropComments'
call ttEq 'w srodku', dropComments('A /* x */ B'), 'A   B'
call ttEq 'niezamkniety', dropComments('A B /* x'), 'A B '
call ttEq 'dwa komentarze', dropComments('/*1*/A/*2*/'), ' A '
call ttEq 'bez komentarza', dropComments('A B'), 'A B'

call ttCase 'parenDepth'
call ttEq 'zbalansowane', parenDepth('A(B(C))'), 0
call ttEq 'otwarty', parenDepth('RANGE(X'), 1
call ttEq 'nawias w apostrofach', parenDepth("P('(')"), 0
call ttEq 'nadmiarowy )', parenDepth('A)'), -1

call ttCase 'isJcl'
call ttEq 'EXEC', isJcl('//STEP1 EXEC PGM=X', 'EXEC'), 1
call ttEq 'JOB', isJcl('//J1 JOB (A)', 'JOB'), 1
call ttEq 'male litery', isJcl('//s1 exec pgm=x', 'EXEC'), 1
call ttEq 'komentarz //*', isJcl('//* EXEC', 'EXEC'), 0
call ttEq 'bez etykiety', isJcl('//  EXEC PGM=X', 'EXEC'), 0
call ttEq 'DD to nie EXEC', isJcl('//DD1 DD *', 'EXEC'), 0
call ttEq 'nie JCL', isJcl(' EXEC', 'EXEC'), 0
call ttEq 'samo //', isJcl('//', 'EXEC'), 0

call ttCase 'opcje: addOpt / hasOpt / getOpt / checkOpts'
opt.0 = 0
call addOpt 'MAX', '10', 1
call addOpt 'GAPS', '', 0
call addOpt 'PREFIX', "'VOL'", 1
call ttEq 'hasOpt MAX', hasOpt('MAX'), 1
call ttEq 'hasOpt brak', hasOpt('XYZ'), 0
call ttEq 'getOpt wartosc', getOpt('MAX', 0), 10
call ttEq 'getOpt zdejmuje apostrofy', getOpt('PREFIX', ''), 'VOL'
call ttEq 'getOpt flaga -> domyslna', getOpt('GAPS', 'D'), 'D'
call ttEq 'getOpt brak -> domyslna', getOpt('XYZ', 'D'), 'D'
call ttEq 'checkOpts - wszystkie dozwolone',,
          checkOpts('MAX GAPS PREFIX'), 1
call ttRc 'checkOpts OK', 0
call ttEq 'checkOpts niedozwolony PREFIX', checkOpts('MAX GAPS'), 0
call ttRc 'checkOpts blad', 8
call ttHasMsg 'checkOpts komunikat', 'Unknown parameter PREFIX'

call ttCase 'setv / getv'
call setv 'T1', 1, 'VOL', 'SYS001'
call ttEq 'getv', getv('T1', 1, 'VOL'), 'SYS001'

call ttCase 'msg - poziomy i MAXRC'
call msg 'I', 'info'
call ttRc 'I nie zmienia RC', 0
call msg 'W', 'ostrzezenie'
call ttRc 'W -> 4', 4
call msg 'E', 'blad'
call ttRc 'E -> 8', 8
call msg 'W', 'ostrzezenie po bledzie'
call ttRc 'MAXRC nie maleje', 8
call ttEq 'przechwycone komunikaty', g.mcap.0, 4
call ttHasMsg 'tresc z poziomem', 'E blad'

exit ttEnd()
