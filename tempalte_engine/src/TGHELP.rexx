/*-------------------------------------------------------------------*/
/* TGHELP   - zmienne globalne, obsluga bledow REXX, helpery         */
/*            czesc TMPLGEN - skladane przez jcl/BUILD i jcl/BLDITn  */
/*-------------------------------------------------------------------*/

/*-------------------------------------------------------------------*/
/* Zmienne globalne - kazda procedura ma PROCEDURE EXPOSE (gx)       */
/*   g.        skalary: g.maxrc, g.pgm (nazwa exec), g.trace,        */
/*             g.cur (biezaca tabela), g.tables, g.lastdata          */
/*             (ostatnio wczytane dane - domyslne zrodlo RANGE),     */
/*             g.globals (nazwy z SET), g.outs (DD wyjsciowe),       */
/*             g.tpls (wczytane szablony), g.dO/g.dC (delimitery),   */
/*             g.count, g.jobseq, g.stepno.<dd>, g.stepw, g.unk,     */
/*             g.pverb/g.parg1 (wynik parseStatement),               */
/*             g.vardef/g.vardefread (cache DD VARDEF),              */
/*             g.mcap/g.mcap.n (przechwytywanie komunikatow-testy)   */
/*             g.osplit.<dd>/g.omember.<dd> (polecenie OUTPUT),      */
/*             g.omode.<dd>/g.odsn.<dd> (plan zapisu: NONE|MEMBERS)  */
/*   tbl.t.0   liczba rekordow tabeli t, tbl.t.vlist - nazwy zmien.  */
/*   val.t.r.v wartosc zmiennej v w rekordzie r tabeli t             */
/*   glob.n    wartosc zmiennej globalnej n (SET)                    */
/*   tpl.dd.i  linie szablonu z DD dd                                */
/*   out.dd.i  bufor wyjscia dla DD dd (zapis na koncu)              */
/*   opt.i.*   parametry biezacego polecenia (name, val, hv)         */
/*   tk.i.*    tokeny (tokenize), cmd.i - polecenia z CMDIN          */
/*   rd. / wr. bufory EXECIO (odczyt / zapis)                        */
/*   mbr.dd.0  liczba memberow wyjscia dd, mbr.dd.k.mname/.mfrom/.mto */
/*             nazwa membra i zakres linii out.dd (plan zapisu PDS)  */
/* UWAGA: nie uzywaj zmiennych lokalnych o nazwach takich jak ogony  */
/* stemow (name, val, hv, raw, vlist, maxrc, cur, pverb...) - REXX   */
/* podstawi ich wartosc w nazwie zmiennej zlozonej.                  */
/*-------------------------------------------------------------------*/

/* Inicjalizacja stanu globalnego. BEZ "procedure": ustawia gx i g.  */
/* w kontekscie wywolujacego (program glowny albo driver testow).    */
tgInit:
  gx = 'g. tbl. val. out. tpl. opt. glob. cmd. rd. wr. tk. mbr.'
  g. = ''
  g.maxrc = 0
  g.trace = 'N'
  g.vardefread = 0
  g.mcap = 0
  g.mcap.0 = 0
  parse source . . g.pgm .
  return

/* Bledy REXX - program glowny ma SIGNAL ON SYNTAX/NOVALUE NAME      */
/* tgFatal. Wypisuje miejsce bledu i konczy exec z RC=12.            */
tgFatal:
  signal off syntax
  signal off novalue
  tgferr = rc
  tgfcon = condition('C')
  say 'TMPG-S REXX' tgfcon 'condition in line' sigl':'
  say 'TMPG-S   ' strip(sourceline(sigl))
  if tgfcon = 'SYNTAX' then do
    say 'TMPG-S    Error' tgferr':' errortext(tgferr)
    if tgferr = 43 then
      say 'TMPG-S    (routine not found - not in this build?)'
  end
  else say 'TMPG-S    Variable without value:' condition('D')
  say 'TMPG-S Execution terminated with RC=12, outputs NOT written'
  exit 12

addOpt: procedure expose (gx)
  parse arg nm, v, hasv
  n = opt.0 + 1
  opt.n.name = nm
  opt.n.val = v
  opt.n.hv = hasv
  opt.0 = n
  return

hasOpt: procedure expose (gx)
  parse arg nm
  do i = 1 to opt.0
    if opt.i.name == nm then return 1
  end
  return 0

getOpt: procedure expose (gx)
  parse arg nm, dflt
  do i = 1 to opt.0
    if opt.i.name == nm then do
      if opt.i.hv then return unquote(opt.i.val)
      return dflt
    end
  end
  return dflt

checkOpts: procedure expose (gx)
  parse arg allowed
  ok = 1
  do i = 1 to opt.0
    if wordpos(opt.i.name, allowed) = 0 then do
      if allowed = '' then
        call msg 'E', 'Unknown parameter' opt.i.name,
                      '(no parameters allowed)'
      else call msg 'E', 'Unknown parameter' opt.i.name,
                         '(allowed:' allowed')'
      ok = 0
    end
  end
  return ok

unquote: procedure
  parse arg v
  v = strip(v)
  if length(v) < 2 then return v
  q = left(v, 1)
  if (q == "'" | q == '"') & right(v, 1) == q then do
    v = substr(v, 2, length(v) - 2)
    p = pos(q || q, v)
    do while p > 0
      v = left(v, p) || substr(v, p + 2)
      p = pos(q || q, v, p + 1)
    end
  end
  return v

validName: procedure
  parse arg nm
  if nm == '' then return 0
  if left(nm, 1) == '_' then return 0
  return verify(nm, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_#@$') = 0

/* Nazwa membra PDS: 1-8 znakow, A-Z @ # $ na poczatku, potem cyfry */
validMember: procedure
  parse arg m
  if length(m) < 1 | length(m) > 8 then return 0
  if verify(left(m, 1), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ@#$') > 0 then
    return 0
  return verify(m, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$') = 0

dropComments: procedure
  parse arg l
  p = pos('/*', l)
  do while p > 0
    q = pos('*/', l, p + 2)
    if q = 0 then l = left(l, p - 1)
    else l = left(l, p - 1) substr(l, q + 2)
    p = pos('/*', l)
  end
  return l

parenDepth: procedure
  parse arg s
  d = 0
  q = ''
  do i = 1 to length(s)
    c = substr(s, i, 1)
    if q <> '' then do
      if c == q then q = ''
    end
    else if c == "'" | c == '"' then q = c
    else if c == '(' then d = d + 1
    else if c == ')' then d = d - 1
  end
  return d

isJcl: procedure
  parse arg l, verb
  if left(l, 2) <> '//' then return 0
  c = substr(l, 3, 1)
  if c == '*' | c == ' ' | c == '' then return 0
  return translate(word(l, 2)) == verb

setv: procedure expose val.
  parse arg t, r, n, v
  val.t.r.n = v
  return

getv: procedure expose val.
  parse arg t, r, n
  return val.t.r.n

/* Komunikat TMPG-sev. I=0 W=4 E=8 S=12 -> g.maxrc (tylko rosnie).   */
/* Gdy g.mcap=1 (testy), komunikat trafia tez do g.mcap.n.           */
msg: procedure expose (gx)
  parse arg sev, text
  rcv = 0
  if sev == 'W' then rcv = 4
  if sev == 'E' then rcv = 8
  if sev == 'S' then rcv = 12
  if rcv > g.maxrc then g.maxrc = rcv
  if g.mcap then do
    n = g.mcap.0 + 1
    g.mcap.n = sev text
    g.mcap.0 = n
  end
  say 'TMPG-'sev text
  return
