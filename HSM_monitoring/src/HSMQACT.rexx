/* REXX - HSMQACT                                                   */
/*------------------------------------------------------------------*/
/* Snapshot stanu DFSMShsm: QUERY ACTIVE (i opcjonalnie QUERY       */
/* COPYPOOL) przez SDSF REXX (ISFSLASH) -> plik SYSNAME;GROUPID;    */
/* linia dla mf-load hsm (komunikaty z members/QACTIVE, QCOPYPL).   */
/*                                                                  */
/* Wywolanie (IKJEFT1B, SYSTSIN - patrz jcl/HSMQRY):                */
/*   %HSMQACT PROC(DFHSM) OUTHLQ(MYHLQ.HSMEXT) CPOOLS(CP1 CP2)      */
/*            HOST(A) WAIT(10) SYSNAME(SYS1)                        */
/*   PROC    - nazwa procedury (STC) DFSMShsm dla komendy MODIFY    */
/*   HOST    - ID hosta HSM do nazwy pliku; domyslnie z ARC0101I    */
/*   WAIT    - ile sekund czekac na odpowiedzi (ISFDELAY)           */
/*   CPOOLS  - copy poole dla QUERY COPYPOOL (puste = bez)          */
/* Wynik: outhlq.HSMQRY.Hhost.QACTIVE.Dyyddd.Thhmmss (FB 300) i     */
/*        outhlq.HSMQRY.Hhost.QCOPYPL.Dyyddd.Thhmmss (gdy CPOOLS)   */
/* Wymaga: SDSF z interfejsem REXX (ISFCALLS), uprawnienie do       */
/*   komendy MODIFY procedury HSM (OPERCMDS) dla uzytkownika joba.  */
/* RC: 0 OK, 8 blad (komunikaty HSMQ-E)                             */
/* Do weryfikacji na z/OS: uklad linii ISFULOG (kolumna tekstu      */
/* komunikatu ustalana z pierwszego slowa ARCnnnnx w linii).        */
/*------------------------------------------------------------------*/
/* Ogony stemow to stale liczbowe (out.i.1) - nazwa jak out.i.txt
   podstawilaby wartosc zmiennej TXT. */
parse upper arg args
hsmproc = kw('PROC', 'DFHSM')
outhlq  = kw('OUTHLQ', '')
cpools  = kw('CPOOLS', '')
host    = kw('HOST', '')
wait    = kw('WAIT', '10')
sysname = kw('SYSNAME', '')
if sysname = '' then sysname = mvsvar('SYSNAME')
if outhlq = '' then call fail 'OUTHLQ() is required'
if datatype(wait, 'W') = 0 then call fail 'WAIT() must be a number'

/* Dyyddd.Thhmmss - jak w nazwach Activity Logow */
yyddd = substr(date('S'), 3, 2)right(date('D'), 3, '0')
stamp = 'D'yyddd'.T'space(translate(time('N'), ' ', ':'), 0)

/* QUERY ACTIVE */
call query 'F' hsmproc',QUERY ACTIVE'
if out.0 = 0 then
  call fail 'no ARC messages in response to QUERY ACTIVE'
if host = '' then host = hostid()
if host = '' then call fail 'HSM host ID not found - use HOST()'
call writeout outhlq'.HSMQRY.H'host'.QACTIVE.'stamp

/* QUERY COPYPOOL - wszystkie copy poole w jednym pliku */
if cpools <> '' then do
  all.0 = 0
  base = 0
  do c = 1 to words(cpools)
    call query 'F' hsmproc',QUERY COPYPOOL('word(cpools, c)')'
    /* numery grup unikalne w pliku: przesuniecie o grupy poprzednich */
    do i = 1 to out.0
      n = all.0 + 1
      all.n.1 = out.i.1 + base
      all.n.2 = out.i.2
      all.n.3 = out.i.3
      all.0 = n
    end
    if out.0 > 0 then do
      last = out.0
      base = base + out.last.1
    end
  end
  do i = 1 to all.0
    out.i.1 = all.i.1
    out.i.2 = all.i.2
    out.i.3 = all.i.3
  end
  out.0 = all.0
  if out.0 > 0 then
    call writeout outhlq'.HSMQRY.H'host'.QCOPYPL.'stamp
end
exit 0

/*------------------------------------------------------------------*/
/* kw - wartosc slowa kluczowego NAZWA(wartosc) z argumentow        */
/*------------------------------------------------------------------*/
kw: procedure expose args
  parse arg name, dflt
  p = pos(name'(', args)
  if p = 0 then return dflt
  parse var args =(p) . '(' val ')' .
  /* SET X='A B' w JCL zostawia apostrofy w podstawionej wartosci */
  return space(translate(val, ' ', "'"))

/*------------------------------------------------------------------*/
/* query - komenda przez ISFSLASH; linie z ARCnnnnx do out.:        */
/*   out.i.1 numer grupy, out.i.2 ID komunikatu, out.i.3 tekst      */
/*------------------------------------------------------------------*/
query:
  parse arg cmd
  out.0 = 0
  if isfcalls('ON') <> 0 then
    call fail 'SDSF REXX (ISFCALLS) unavailable'
  isfdelay = wait
  address SDSF "ISFSLASH '"cmd"' (WAIT)"
  qrc = rc
  call isfcalls 'OFF'
  if qrc > 4 then call fail 'ISFSLASH RC='qrc 'for' cmd
  if symbol('isfulog.0') <> 'VAR' then return
  col = 0
  grp = 0
  msgid = ''
  do i = 1 to isfulog.0
    line = isfulog.i
    w = arcword(line)
    if w > 0 then do
      /* poczatek komunikatu: kolumna tekstu z tej linii */
      col = wordindex(line, w)
      msgid = word(line, w)
      grp = grp + 1
      txt = substr(line, col)
    end
    else do
      /* kontynuacja: ta sama kolumna co linia z ID; linia z ID */
      /* innego komunikatu (np. IEE123I) konczy grupe            */
      if col = 0 then iterate
      if msgword(word(substr(line, col), 1)) then do
        col = 0
        iterate
      end
      txt = msgid '(CONT.)' strip(substr(line, col))
    end
    n = out.0 + 1
    out.n.1 = grp
    out.n.2 = msgid
    out.n.3 = strip(txt, 'T')
    out.0 = n
  end
  return

/* arcword - numer slowa ARCnnnnx w linii (0 = brak) */
arcword: procedure
  parse arg ln
  do k = 1 to words(ln)
    w = word(ln, k)
    if length(w) = 8 & left(w, 3) = 'ARC' &,
       datatype(substr(w, 4, 4), 'W') then return k
  end
  return 0

/* msgword - czy slowo wyglada jak ID komunikatu (np. IEE123I) */
msgword: procedure
  parse arg w
  if length(w) < 7 | length(w) > 10 then return 0
  if datatype(left(w, 3), 'U') = 0 | datatype(right(w, 1), 'U') = 0
    then return 0
  return datatype(substr(w, 4, length(w) - 4), 'W')

/* hostid - HOST=x z ARC0101I (QUERY ... COMMAND ... ON HOST=x) */
hostid:
  do i = 1 to out.0
    if out.i.2 <> 'ARC0101I' then iterate
    p = pos('HOST=', out.i.3)
    if p > 0 then return word(substr(out.i.3, p + 5), 1)
  end
  return ''

/*------------------------------------------------------------------*/
/* writeout - out. -> zbior FB 300: SYSNAME;GROUPID;tekst           */
/*------------------------------------------------------------------*/
writeout:
  parse arg wdsn
  do i = 1 to out.0
    rec.i = left(sysname, 8)';'right(out.i.1, 8, '0')';'out.i.3
  end
  rec.0 = out.0
  call msg 'OFF'
  "DELETE '"wdsn"'"
  call msg 'ON'
  "ALLOC F(HSMQW) DA('"wdsn"') NEW CATALOG SPACE(1,5) TRACKS",
    "RECFM(F B) LRECL(300) BLKSIZE(27900) REUSE"
  if rc <> 0 then call fail 'cannot allocate' wdsn', RC='rc
  "EXECIO" rec.0 "DISKW HSMQW (STEM rec. FINIS"
  "FREE F(HSMQW)"
  say 'HSMQ-I' rec.0 'lines ->' wdsn
  return

fail:
  parse arg text
  say 'HSMQ-E' text
  exit 8
