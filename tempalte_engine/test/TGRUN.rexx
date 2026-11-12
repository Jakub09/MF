/* REXX */
/*-------------------------------------------------------------------*/
/* TGRUN    - test integracyjny: uruchamia exec i sprawdza wynik     */
/*                                                                   */
/*   //T01 EXEC PGM=IRXJCL,PARM='TGRUN exec rc <argumenty>'          */
/*     exec - exec do uruchomienia (TGIT1..3, TMPLGEN) z SYSEXEC     */
/*     rc   - oczekiwany kod powrotu exec                            */
/*     argumenty - przekazywane do exec (np. TRACE(R))               */
/*   Jesli DD EXPECT jest zaalokowany, DD GENOUT (dataset, np.       */
/*   &&TEMP) jest porownywany linia po linii z EXPECT.               */
/*   EXPECT w formacie IEBUPDTE ('./ ADD NAME=member' + linie) =     */
/*   porownanie memberow PDS wskazanego przez DD GENOUT.             */
/*                                                                   */
/*   RC kroku: 0 = test zaliczony, 12 = test nieudany.               */
/*   SYSEXEC: biblioteka z exec + biblioteka testow (z TGRUN).       */
/*   Samodzielny member - nie wymaga budowania.                      */
/*-------------------------------------------------------------------*/
signal on syntax name tgrErr
signal on novalue name tgrErr
gx = 'rd.'
parse arg exe exprc args
exe = translate(exe)
if exe == '' | datatype(exprc, 'W') = 0 then do
  say 'TGRUN-E Usage: PARM=''TGRUN exec rc <args>'''
  exit 12
end
say 'TGRUN-I Running' exe strip(args) '- expected RC='exprc
say copies('-', 66)
interpret 'call' exe 'args'
got = result
say copies('-', 66)
ok = 1
if got = exprc then say 'TGRUN-I' exe 'ended with RC='got '(OK)'
else do
  say 'TGRUN-E' exe 'ended with RC='got', expected' exprc
  ok = 0
end
if ddExists('EXPECT') then do
  call readDD 'EXPECT'
  mmode = 0
  if rd.0 > 0 then mmode = (left(rd.1, 2) == './')
  if mmode then cok = compareMembers('GENOUT')
  else cok = compareDD('GENOUT', 'EXPECT')
  if cok = 0 then ok = 0
end
if ok then do
  say 'TGRUN-I TEST PASSED'
  exit 0
end
say 'TGRUN-E TEST FAILED'
exit 12

/* Porownuje DD act z DD exp (spacje z prawej pomijane)              */
compareDD: procedure expose (gx)
  parse arg act, exp
  call readDD exp
  if rd.0 < 0 then return 0
  do i = 0 to rd.0
    e.i = rd.i
  end
  call readDD act
  if rd.0 < 0 then return 0
  do i = 0 to rd.0
    a.i = rd.i
  end
  bad = 0
  do i = 1 to max(a.0, e.0)
    av = '<missing line>'
    ev = '<missing line>'
    if i <= a.0 then av = a.i
    if i <= e.0 then ev = e.i
    if (av == ev) = 0 then do
      bad = bad + 1
      if bad <= 10 then do
        say 'TGRUN-E' act 'line' i 'differs from' exp':'
        say 'TGRUN-E   expected:' ev
        say 'TGRUN-E   actual  :' av
      end
    end
  end
  if bad = 0 then do
    say 'TGRUN-I' act 'matches' exp '('a.0 'lines)'
    return 1
  end
  say 'TGRUN-E' act':' bad 'line(s) differ (expected' e.0,
      'lines, got' a.0')'
  return 0

/* EXPECT (juz w rd.) w formacie IEBUPDTE: './ ADD NAME=x' zaczyna   */
/* member x. Kazdy member jest czytany z PDS z DD act i porownywany. */
compareMembers: procedure expose (gx)
  parse arg act
  k = 0
  do i = 1 to rd.0
    if left(rd.i, 2) == './' then do
      parse upper var rd.i './' cmd rest
      parse var rest 'NAME=' nm .
      k = k + 1
      mn.k = strip(nm)
      ml.k.0 = 0
      if cmd <> 'ADD' | mn.k == '' then do
        say 'TGRUN-E EXPECT line' i 'is not ./ ADD NAME=member:' rd.i
        return 0
      end
    end
    else if k > 0 then do
      n = ml.k.0 + 1
      ml.k.n = rd.i
      ml.k.0 = n
    end
  end
  dsn = ddDsn(act)
  bad = 0
  do j = 1 to k
    call readMember dsn, mn.j
    if rd.0 < 0 then do
      bad = bad + 1
      iterate
    end
    diff = 0
    do i = 1 to max(rd.0, ml.j.0)
      av = '<missing line>'
      ev = '<missing line>'
      if i <= rd.0 then av = rd.i
      if i <= ml.j.0 then ev = ml.j.i
      if (av == ev) = 0 then do
        diff = diff + 1
        if diff <= 5 then do
          say 'TGRUN-E' dsn'('mn.j') line' i 'differs:'
          say 'TGRUN-E   expected:' ev
          say 'TGRUN-E   actual  :' av
        end
      end
    end
    if diff = 0 then say 'TGRUN-I' dsn'('mn.j') matches EXPECT ('rd.0,
                         'lines)'
    else bad = bad + 1
  end
  if bad = 0 then return 1
  say 'TGRUN-E' bad 'of' k 'member(s) differ from EXPECT'
  return 0

ddExists: procedure expose (gx)
  parse arg dd
  return (bpxwdyn('INFO FI('translate(dd)')') = 0)

/* Nazwa datasetu zaalokowanego pod DD                               */
ddDsn: procedure expose (gx)
  parse arg dd
  tgrdsn = ''
  call bpxwdyn 'INFO FI('translate(dd)') INRTDSN(TGRDSN)'
  return strip(tgrdsn)

/* Czyta member dsn(mem) do rd. (rd.0 = -1 przy bledzie)             */
readMember: procedure expose (gx)
  parse arg dsn, mem
  drop rd.
  rd.0 = -1
  r = bpxwdyn("ALLOC FI(TGRMEMB) DA('"dsn"("mem")') SHR REUSE")
  if r <> 0 then do
    say 'TGRUN-E Cannot allocate' dsn'('mem') - BPXWDYN RC='r
    return
  end
  address MVS 'EXECIO * DISKR TGRMEMB (STEM RD. FINIS'
  erc = rc
  call bpxwdyn 'FREE FI(TGRMEMB)'
  if erc <> 0 then do
    say 'TGRUN-E Member' dsn'('mem') not readable - EXECIO RC='erc
    rd.0 = -1
    return
  end
  do i = 1 to rd.0
    rd.i = strip(rd.i, 'T')
  end
  return

readDD: procedure expose (gx)
  parse arg dd
  dd = translate(dd)
  drop rd.
  rd.0 = 0
  address MVS 'EXECIO * DISKR' dd '(STEM RD. FINIS'
  if rc <> 0 then do
    say 'TGRUN-E EXECIO DISKR' dd 'RC='rc
    rd.0 = -1
  end
  do i = 1 to rd.0
    rd.i = strip(rd.i, 'T')
  end
  return

tgrErr:
  signal off syntax
  signal off novalue
  tgrrc = rc
  say 'TGRUN-E REXX' condition('C') 'in line' sigl':',
      strip(sourceline(sigl))
  if condition('C') = 'SYNTAX' then
    say 'TGRUN-E   Error' tgrrc':' errortext(tgrrc)
  else say 'TGRUN-E   Variable without value:' condition('D')
  say 'TGRUN-E TEST FAILED'
  exit 12
