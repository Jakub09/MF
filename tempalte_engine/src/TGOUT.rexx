/*-------------------------------------------------------------------*/
/* TGOUT    - Bufor wyjscia, polecenie OUTPUT, zapis DD i memberow   */
/*            czesc TMPLGEN - skladane przez jcl/BUILD i jcl/BLDITn  */
/*-------------------------------------------------------------------*/

emit: procedure expose (gx)
  parse arg dd, line, jcl
  if wordpos(dd, g.outs) = 0 then do
    g.outs = g.outs dd
    out.dd.0 = 0
  end
  line = strip(line, 'T')
  n = out.dd.0 + 1
  out.dd.n = line
  out.dd.0 = n
  if length(line) > 80 then
    call msg 'E', dd 'line' n 'longer than 80 characters (would be',
                  'truncated):' left(line, 40)'...'
  else if jcl & left(line, 2) = '//' & length(line) > 71 then
    call msg 'W', dd 'line' n 'JCL extends beyond column 71:',
                  left(line, 40)'...'
  return

outCount: procedure expose (gx)
  parse arg dd
  if wordpos(dd, g.outs) = 0 then return 0
  return out.dd.0

/* OUTPUT(dd) SPLIT(JOB) | MEMBER(nazwa) - zapis do PDS bez membra  */
/*   SPLIT(JOB)   - kazdy job (karta JOB) do osobnego membra         */
/*                  (to samo jest domyslne, gdy DSORG=PO)            */
/*   MEMBER(x)    - wszystko do jednego membra x                     */
doOutput: procedure expose (gx)
  parse arg dd
  if checkOpts('SPLIT MEMBER') = 0 then return
  dd = translate(dd)
  if dd == '' then dd = 'GENOUT'
  sp = translate(getOpt('SPLIT', ''))
  mb = translate(getOpt('MEMBER', ''))
  if hasOpt('SPLIT') + hasOpt('MEMBER') <> 1 then do
    call msg 'E', 'OUTPUT: specify SPLIT(JOB) or MEMBER(name)'
    return
  end
  if hasOpt('SPLIT') & sp <> 'JOB' then do
    call msg 'E', 'OUTPUT: SPLIT must be JOB:' sp
    return
  end
  if hasOpt('MEMBER') then do
    if validMember(mb) = 0 then do
      call msg 'E', 'OUTPUT: invalid member name:' mb
      return
    end
    sp = 'MEMBER'
  end
  g.osplit.dd = sp
  g.omember.dd = mb
  call msg 'I', '   OUTPUT' dd':' sp mb
  return

/* Zapis wszystkich wyjsc. Faza 1: plan dla kazdego DD (bez zapisu). */
/* Faza 2: zapis - tylko gdy wszystkie plany sa poprawne.            */
writeOutputs: procedure expose (gx)
  ok = 1
  do i = 1 to words(g.outs)
    dd = word(g.outs, i)
    info = ''
    if ddExists(dd) then info = ddInfo(dd)
    if planOutput(dd, info) = 0 then ok = 0
    else if g.omode.dd == 'MEMBERS' then
      if canAlloc(g.odsn.dd) = 0 then do
        call msg 'S', dd': cannot allocate' g.odsn.dd,
                      '(must be a cataloged PDS/PDSE)'
        ok = 0
      end
  end
  if ok = 0 then do
    call msg 'E', 'Output problems - nothing written:' space(g.outs)
    return
  end
  do i = 1 to words(g.outs)
    if g.maxrc >= 12 then leave
    call writeOutput word(g.outs, i)
  end
  return

/* Plan zapisu DD na podstawie informacji o alokacji (z ddInfo):     */
/* 'rc;dsn;member;dsorg;typ', '' = DD nie zaalokowany.               */
/* Zapis sekwencyjny do datasetu bez membra tylko przy DSORG=PS -    */
/* zapis sekwencyjny do PDS zniszczylby jego katalog.                */
/* Ustawia g.omode.dd (NONE | MEMBERS), g.odsn.dd, mbr.dd.*           */
/* Zwraca 1 = OK, 0 = blad (komunikat juz wypisany).                 */
planOutput: procedure expose (gx)
  parse arg dd, info
  if info == '' then do
    call msg 'S', 'DD' dd '(output) not allocated'
    return 0
  end
  parse var info irc ';' dsn ';' mem ';' org ';' typ
  if irc <> 0 then do
    call msg 'S', 'DD' dd': BPXWDYN INFO RC='irc
    return 0
  end
  select
    when typ <> '' then kind = typ
    when dsn == '' then kind = 'OTHER'
    when mem <> '' then kind = 'MEMBER'
    when left(org, 2) == 'PO' then kind = 'PDS'
    when org == 'PS' | org == 'PSU' then kind = 'SEQ'
    otherwise kind = 'UNKNOWN'
  end
  shown = org
  if shown == '' then shown = '?'
  where = dsn
  if mem <> '' then where = dsn'('mem')'
  if typ <> '' then where = typ
  cfg = g.osplit.dd
  if cfg == '' then do
    if kind == 'PDS' then cfg = 'JOB'
    else if kind == 'UNKNOWN' then do
      call msg 'E', dd': cannot tell if' dsn 'is a PDS - code',
                    'DSORG=PO or DSORG=PS on the DD, or OUTPUT('dd')',
                    'SPLIT(JOB) or MEMBER(name) for a PDS'
      return 0
    end
    else cfg = 'NONE'
  end
  if cfg == 'NONE' then do
    g.omode.dd = 'NONE'
    call msg 'I', '   'dd '->' where '(DSORG='shown') - one data set'
    return 1
  end
  if kind <> 'PDS' & kind <> 'UNKNOWN' then do
    call msg 'E', dd': SPLIT(JOB)/MEMBER need a PDS without member',
                  '(DD is' kind':' where')'
    return 0
  end
  g.odsn.dd = dsn
  if cfg == 'MEMBER' then do
    mbr.dd.0 = 1
    mbr.dd.1.mname = g.omember.dd
    mbr.dd.1.mfrom = 1
    mbr.dd.1.mto = out.dd.0
  end
  else do
    k = 0
    seen. = 0
    do i = 1 to out.dd.0
      if isJcl(out.dd.i, 'JOB') = 0 then iterate
      nm = translate(substr(word(out.dd.i, 1), 3))
      if validMember(nm) = 0 then do
        call msg 'E', dd': job name' nm 'in line' i 'is not a valid',
                      'member name'
        return 0
      end
      if seen.nm > 0 then do
        call msg 'E', dd': duplicate member' nm '(lines' seen.nm 'and',
                      i') - make job names unique, e.g.',
                      '//JOB{_JOBSEQ}'
        return 0
      end
      seen.nm = i
      if k > 0 then mbr.dd.k.mto = i - 1
      k = k + 1
      mbr.dd.k.mname = nm
      mbr.dd.k.mfrom = i
      if k = 1 then mbr.dd.k.mfrom = 1
    end
    if k = 0 then do
      call msg 'E', dd': no JOB statement - cannot split into',
                    'members (use OUTPUT('dd') MEMBER(name))'
      return 0
    end
    mbr.dd.k.mto = out.dd.0
    mbr.dd.0 = k
  end
  g.omode.dd = 'MEMBERS'
  call msg 'I', '   'dd '->' dsn '(DSORG='shown') -' mbr.dd.0,
                'member(s)'
  return 1

/* Zapis jednego DD wedlug planu (planOutput)                        */
writeOutput: procedure expose (gx)
  parse arg dd
  if g.omode.dd == 'NONE' then do
    drop wr.
    do j = 0 to out.dd.0
      wr.j = out.dd.j
    end
    call writeDD dd
    return
  end
  do k = 1 to mbr.dd.0
    if g.maxrc >= 12 then leave
    drop wr.
    n = 0
    do j = mbr.dd.k.mfrom to mbr.dd.k.mto
      n = n + 1
      wr.n = out.dd.j
    end
    wr.0 = n
    call writeMember g.odsn.dd, mbr.dd.k.mname
  end
  return
