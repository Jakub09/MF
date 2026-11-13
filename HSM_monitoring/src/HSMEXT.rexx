/* REXX - HSMEXT                                                    */
/*------------------------------------------------------------------*/
/* Ekstrakcja komunikatow ARC* z Activity Logow DFSMShsm do plikow  */
/* SYSNAME;GROUPID;linia - wejscie dla mf-load hsm (repo mf-loader).*/
/*                                                                  */
/* Wywolanie (IKJEFT1B, SYSTSIN - patrz jcl/HSMEXTR):               */
/*   %HSMEXT ACTHLQ(HSMACT) HOSTS(A) LOGS(MIGLOG BAKLOG)            */
/*           OUTHLQ(MYHLQ.HSMEXT) MAXAGE(3) MEMBERS(MIGRATE BACKUP) */
/*           TXTOFF(0) SORTPGM(SORT) SYSNAME(SYS1)                  */
/*   SYSNAME - domyslnie MVSVAR('SYSNAME') systemu wykonania        */
/*   TXTOFF  - ile znakow pominac na poczatku tekstu linii logu     */
/* DD:                                                              */
/*   HSMMEM  - PDS z listami komunikatow (members/), ID w kol. 1-8  */
/*   HSMSYM  - SYMNAMES rekordu roboczego (sym/HSMEXT)              */
/* Przebieg:                                                        */
/*   1. LISTCAT LEVEL(acthlq.Hhost): zbiory acthlq.Hhost.log.Dyyddd */
/*      .Thhmmss z ostatnich MAXAGE dni                             */
/*   2. log z gotowym wynikiem jest pomijany - poza najnowszym      */
/*      logiem danego typu (moze byc aktywny: ekstrakt od nowa)     */
/*   3. DFSORT 1: tekst linii (bez RDW / ASA) -> FB 256             */
/*      DFSORT 2: grupy (linia ARCnnnnx + kontynuacje), INCLUDE wg  */
/*      list z HSMMEM, BUILD SYSNAME;GROUPID;tekst                  */
/* Wynik: outhlq.Hhost.log.Dyyddd.Thhmmss, FB 300                   */
/* RC: 0 OK, 4 nic do ekstrakcji, 8 blad (komunikaty HSMX-E)        */
/* Do weryfikacji na z/OS: RECFM / LRECL Activity Logow (LISTDSI),  */
/* kolumna ID komunikatu (TXTOFF, TXT_ID w HSMSYM), format linii    */
/* kontynuacji komunikatow wielowierszowych.                        */
/*------------------------------------------------------------------*/
/* Ogony stemow to stale liczbowe (found.i.1) - nazwa jak found.i.log
   podstawilaby wartosc zmiennej LOG. */
parse upper arg args
acthlq  = kw('ACTHLQ', 'HSMACT')
hosts   = kw('HOSTS', 'A')
logs    = kw('LOGS', 'MIGLOG BAKLOG DMPLOG CMDLOG ABRLOG')
outhlq  = kw('OUTHLQ', '')
maxage  = kw('MAXAGE', '3')
members = kw('MEMBERS', 'MIGRATE MIGVOL BACKUP VOLBKP EXPIREBV',
  'CDSBKP DUMP VOLDUMP FRBACKUP FRDUMP FCCOPY AUDIT CMDREQ HSMSTAT',
  'ABACKUP ARECOVER DSACTION')
txtoff  = kw('TXTOFF', '0')
sortpgm = kw('SORTPGM', 'SORT')
sysname = kw('SYSNAME', '')
if sysname = '' then sysname = mvsvar('SYSNAME')
if outhlq = '' then call fail 'OUTHLQ() is required'
if datatype(maxage, 'W') = 0 then call fail 'MAXAGE() must be a number'
if datatype(txtoff, 'W') = 0 then call fail 'TXTOFF() must be a number'

/* pliki robocze: SYSIN i SYMNAMES DFSORT, rekordy posrednie */
wctl = outhlq'.HSMXCTL'
wsym = outhlq'.HSMXSYM'
wtxt = outhlq'.HSMXWRK'

call loadids
say 'HSMX-I SYSNAME' sysname', messages' ids.0', members' members

today = date('B')
todo = 0
bad = 0
do h = 1 to words(hosts)
  host = word(hosts, h)
  call findlogs host
  do l = 1 to words(logs)
    log = word(logs, l)
    newest = ''
    do i = 1 to found.0
      if found.i.2 = log then newest = found.i.1
    end
    do i = 1 to found.0
      if found.i.2 <> log then iterate
      out = outhlq'.H'host'.'log'.'found.i.3
      if sysdsn("'"out"'") = 'OK' & found.i.1 <> newest then iterate
      todo = todo + 1
      if extract(found.i.1, out) <> 0 then bad = bad + 1
    end
  end
end
call cleanup
if bad > 0 then do
  say 'HSMX-E' bad 'of' todo 'logs failed'
  exit 8
end
if todo = 0 then do
  say 'HSMX-I nothing to extract'
  exit 4
end
say 'HSMX-I extracted' todo 'logs'
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
/* loadids - ID komunikatow z memberow HSMMEM (kol. 1-8)            */
/*------------------------------------------------------------------*/
loadids:
  ids.0 = 0
  if listdsi('HSMMEM' 'FILE') > 4 then call fail 'DD HSMMEM:' sysmsglvl2
  memlib = sysdsname
  do m = 1 to words(members)
    mem = word(members, m)
    "ALLOC F(HSMMI) DA('"memlib"("mem")') SHR REUSE"
    if rc <> 0 then call fail 'member' mem 'not found in' memlib
    "EXECIO * DISKR HSMMI (STEM ml. FINIS"
    "FREE F(HSMMI)"
    do k = 1 to ml.0
      id = strip(substr(ml.k, 1, 8))
      if length(id) <> 8 | left(id, 3) <> 'ARC' then iterate
      if symbol('seen.id') = 'VAR' then iterate
      seen.id = 1
      n = ids.0 + 1
      ids.n = id
      ids.0 = n
    end
  end
  if ids.0 = 0 then call fail 'no message IDs in' memlib
  return

/*------------------------------------------------------------------*/
/* findlogs - logi hosta z LISTCAT: found.i.1 dsn, .2 log, .3 Dt   */
/*------------------------------------------------------------------*/
findlogs:
  parse arg fhost
  found.0 = 0
  x = outtrap('lc.')
  "LISTCAT LEVEL('"acthlq".H"fhost"') NAME"
  x = outtrap('OFF')
  plen = length(acthlq) + 1
  do i = 1 to lc.0
    if word(lc.i, 1) <> 'NONVSAM' then iterate
    dsn = word(lc.i, 3)
    parse var dsn =(plen) . '.' q1 '.' q2 '.' q3 '.' q4 '.' rest
    if q1 <> 'H'fhost | rest <> '' then iterate
    if left(q3, 1) <> 'D' | left(q4, 1) <> 'T' then iterate
    jd = substr(q3, 2)
    if length(jd) <> 5 | datatype(jd, 'W') = 0 then iterate
    /* Dyyddd -> dzien bazowy (rok 20yy) */
    base = date('B', '20'left(jd, 2)'0101', 'S') + right(jd, 3) - 1
    if today - base > maxage then iterate
    n = found.0 + 1
    found.n.1 = dsn
    found.n.2 = q2
    found.n.3 = q3'.'q4
    found.0 = n
  end
  /* sortowanie po nazwie = chronologicznie (Dyyddd.Thhmmss) */
  do i = 1 to found.0 - 1
    do j = i + 1 to found.0
      if found.j.1 << found.i.1 then do
        t1 = found.i.1; t2 = found.i.2; t3 = found.i.3
        found.i.1 = found.j.1; found.i.2 = found.j.2
        found.i.3 = found.j.3
        found.j.1 = t1; found.j.2 = t2; found.j.3 = t3
      end
    end
  end
  return

/*------------------------------------------------------------------*/
/* extract - jeden log -> plik wynikowy; 0 OK, inaczej blad         */
/*------------------------------------------------------------------*/
extract:
  parse arg in, out
  if listdsi("'"in"'") > 4 then do
    say 'HSMX-E' in':' sysmsglvl2
    return 8
  end
  /* poczatek tekstu linii: RDW (V) i znak sterujacy ASA (A) */
  start = 1
  if left(sysrecfm, 1) = 'V' then start = 5
  if pos('A', sysrecfm) > 0 then start = start + 1
  start = start + txtoff
  tlen = min(256, syslrecl - start + 1)
  if tlen < 9 then do
    say 'HSMX-E' in': RECFM' sysrecfm 'LRECL' syslrecl 'too short'
    return 8
  end

  /* DFSORT 1: tekst linii -> FB 256 */
  q.1 = '* HSMEXT KROK 1 - TEKST LINII LOGU (WYLICZONE Z RECFM/LRECL)'
  q.2 = 'LOG_TXT,'start','tlen',CH'
  q.0 = 2
  call writeds wsym, 80, 'q.'
  build = 'BUILD=(LOG_TXT'
  if tlen < 256 then build = build',256:X'
  build = build')'
  c.1 = ' OPTION COPY'
  if left(sysrecfm, 1) = 'V' then
    c.2 = ' OUTFIL FNAMES=SORTOUT,VTOF,VLFILL=C'' '','build
  else
    c.2 = ' OUTFIL FNAMES=SORTOUT,'build
  c.0 = 2
  call writeds wctl, 80, 'c.'
  call newds wtxt, 256
  "ALLOC F(SORTIN) DA('"in"') SHR REUSE"
  "ALLOC F(SORTOUT) DA('"wtxt"') OLD REUSE"
  if sort() > 4 then do
    say 'HSMX-E' in': DFSORT step 1 failed'
    return 8
  end

  /* DFSORT 2: grupy komunikatow, filtr, rekord wynikowy */
  "EXECIO * DISKR HSMSYM (STEM q. FINIS"
  call writeds wsym, 80, 'q.'
  pfx = 'C'''left(sysname, 8)';'''
  c.1 = ' OPTION COPY'
  c.2 = ' INREC IFTHEN=(WHEN=GROUP,BEGIN=(TXT_ARC,EQ,C''ARC''),'
  c.3 = '         PUSH=(GRP_ID:ID=8,GRP_MSG:TXT_ID)),'
  c.4 = '       IFTHEN=(WHEN=(TXT_ARC,EQ,C''ARC''),'
  c.5 = '         OVERLAY=(GRP_FIRST:C''Y''))'
  c.6 = ' OUTFIL FNAMES=SORTOUT,'
  n = 6
  /* INCLUDE: po 4 ID w jednej stalej (SS = szukanie w liscie);  */
  /* 4 ID = 36 znakow - karta miesci sie w kolumnach 1-71        */
  do k = 1 to ids.0 by 4
    lst = ''
    do j = k to min(k + 3, ids.0)
      lst = lst || ids.j','
    end
    n = n + 1
    if k = 1 then c.n = '   INCLUDE=(GRP_MSG,SS,EQ,C'''lst''''
    else c.n = '     GRP_MSG,SS,EQ,C'''lst''''
    if k + 4 <= ids.0 then c.n = c.n',OR,'
    else c.n = c.n'),'
  end
  n = n + 1; c.n = '   IFTHEN=(WHEN=(GRP_FIRST,EQ,C''Y''),'
  n = n + 1; c.n = '     BUILD=('pfx',GRP_ID,C'';'',TXT)),'
  n = n + 1; c.n = '   IFTHEN=(WHEN=NONE,'
  n = n + 1; c.n = '     BUILD=('pfx',GRP_ID,C'';'',GRP_MSG,'
  n = n + 1; c.n = '       C'' (CONT.) '',TXT))'
  c.0 = n
  call writeds wctl, 80, 'c.'
  call msg 'OFF'
  "DELETE '"out"'"
  call msg 'ON'
  "ALLOC F(SORTOUT) DA('"out"') NEW CATALOG SPACE(5,15) CYLINDERS",
    "RECFM(F B) LRECL(300) BLKSIZE(27900) REUSE"
  if rc <> 0 then do
    say 'HSMX-E' out': allocation failed, RC='rc
    return 8
  end
  "ALLOC F(SORTIN) DA('"wtxt"') SHR REUSE"
  if sort() > 4 then do
    say 'HSMX-E' in': DFSORT step 2 failed'
    /* bez czesciowego wyniku - inaczej kolejny przebieg pominie log */
    "FREE F(SORTIN SORTOUT)"
    call msg 'OFF'
    "DELETE '"out"'"
    call msg 'ON'
    return 8
  end
  "FREE F(SORTIN SORTOUT)"
  say 'HSMX-I' in '->' out
  return 0

/*------------------------------------------------------------------*/
/* sort - DFSORT z SYSIN = wctl, SYMNAMES = wsym; zwraca RC         */
/*------------------------------------------------------------------*/
sort:
  "ALLOC F(SYSIN) DA('"wctl"') SHR REUSE"
  "ALLOC F(SYMNAMES) DA('"wsym"') SHR REUSE"
  "ALLOC F(SYMNOUT) SYSOUT(*) REUSE"
  "ALLOC F(SYSOUT) SYSOUT(*) REUSE"
  address LINKMVS sortpgm
  src = rc
  "FREE F(SYSIN SYMNAMES)"
  return src

/*------------------------------------------------------------------*/
/* writeds - stem -> zbior FB (tworzy, gdy go nie ma)               */
/*------------------------------------------------------------------*/
writeds:
  parse arg wdsn, wlrecl, wstem
  call newds wdsn, wlrecl
  "ALLOC F(HSMXW) DA('"wdsn"') OLD REUSE"
  "EXECIO" value(wstem'0') "DISKW HSMXW (STEM" wstem "FINIS"
  "FREE F(HSMXW)"
  return

/* newds - zbior roboczy FB o danym LRECL (pusty, gdy jest) */
newds:
  parse arg ndsn, nlrecl
  if sysdsn("'"ndsn"'") = 'OK' then return
  "ALLOC F(HSMXN) DA('"ndsn"') NEW CATALOG SPACE(5,15) CYLINDERS",
    "RECFM(F B) LRECL("nlrecl") BLKSIZE(0) REUSE"
  if rc <> 0 then call fail 'cannot allocate' ndsn', RC='rc
  "FREE F(HSMXN)"
  return

/* cleanup - usuniecie zbiorow roboczych */
cleanup:
  call msg 'OFF'
  "FREE F(SYMNOUT SYSOUT)"
  "DELETE '"wctl"'"
  "DELETE '"wsym"'"
  "DELETE '"wtxt"'"
  call msg 'ON'
  return

fail:
  parse arg text
  say 'HSMX-E' text
  exit 8
