/*-------------------------------------------------------------------*/
/* TTLIB    - mini framework testow jednostkowych TMPLGEN            */
/*            exec testu = TTxxxx + TTLIB + moduly TG* (bez TGMAIN), */
/*            skladany przez jcl/BLDITn i jcl/BUILD                  */
/*                                                                   */
/* Szkielet drivera TTxxxx:                                          */
/*   signal on syntax name tgFatal                                   */
/*   signal on novalue name tgFatal                                  */
/*   call tgInit                                                     */
/*   call ttStart 'TGXXXX'                                           */
/*   call ttCase 'opis'          - nowy przypadek, czysci stan       */
/*   call ttTable / ttTpl / ttExec ...   - przygotowanie             */
/*   call ttEq 'opis', wynik, oczekiwany - asercja                   */
/*   exit ttEnd()                - RC 0 = wszystko OK, 8 = bledy     */
/*                                                                   */
/* Wynik w SYSTSPRT: TTST-P (pass), TTST-F (fail), TTST-I (info).    */
/* Wiersze w ttTable/ttTpl oddziela sie srednikiem ';'.              */
/*-------------------------------------------------------------------*/

ttStart: procedure expose (gx) tt.
  parse arg nm
  tt.name = nm
  tt.pass = 0
  tt.fail = 0
  tt.case = ''
  say copies('=', 66)
  say 'TTST-I Unit tests:' nm '- exec' g.pgm
  say copies('=', 66)
  return

/* Nowy przypadek testowy: czysci caly stan globalny (tgInit) i      */
/* wlacza przechwytywanie komunikatow (g.mcap).                      */
ttCase: procedure expose (gx) tt.
  parse arg title
  call tgInit
  g.mcap = 1
  g.mcap.0 = 0
  tt.case = title
  say 'TTST-I ---' title
  return

ttEq: procedure expose (gx) tt.
  parse arg desc, act, exp
  if act == exp then do
    tt.pass = tt.pass + 1
    say 'TTST-P' desc
  end
  else do
    tt.fail = tt.fail + 1
    say 'TTST-F' desc '- expected <'exp'> got <'act'>'
    say 'TTST-F    case:' tt.case
  end
  return

/* Asercja na g.maxrc (najwyzszy RC od poczatku przypadku)           */
ttRc: procedure expose (gx) tt.
  parse arg desc, exp
  call ttEq desc '(MAXRC)', g.maxrc, exp
  return

/* 1 jesli przechwycono komunikat zawierajacy tekst                  */
ttMsg: procedure expose (gx)
  parse arg txt
  do i = 1 to g.mcap.0
    if pos(txt, g.mcap.i) > 0 then return 1
  end
  return 0

ttMsgCount: procedure expose (gx)
  parse arg txt
  n = 0
  do i = 1 to g.mcap.0
    if pos(txt, g.mcap.i) > 0 then n = n + 1
  end
  return n

ttHasMsg: procedure expose (gx) tt.
  parse arg desc, txt
  call ttEq desc '(message "'txt'")', ttMsg(txt), 1
  return

/* Tabela w pamieci przez buildTable (TGLOAD): ttTable 'T1', 'A B',  */
/* 'x1 y1;x2 y2'. Zwraca wynik buildTable (1 = OK).                  */
ttTable: procedure expose (gx) tt.
  parse arg t, vars, rows
  drop rd.
  n = 0
  do while rows <> ''
    parse var rows line ';' rows
    n = n + 1
    rd.n = line
  end
  rd.0 = n
  return buildTable(t, vars)

/* Szablon w pamieci (zamiast DD): ttTpl 'TPL', 'linia1;linia2'      */
ttTpl: procedure expose (gx) tt.
  parse arg dd, lines
  dd = translate(dd)
  n = 0
  do while lines <> ''
    parse var lines line ';' lines
    n = n + 1
    tpl.dd.n = line
  end
  tpl.dd.0 = n
  if wordpos(dd, g.tpls) = 0 then g.tpls = g.tpls dd
  return

/* Liczba rekordow tabeli (-1 = brak tabeli)                          */
ttRows: procedure expose (gx)
  parse arg t
  t = translate(t)
  if wordpos(t, g.tables) = 0 then return -1
  return tbl.t.0

ttVars: procedure expose (gx)
  parse arg t
  t = translate(t)
  if wordpos(t, g.tables) = 0 then return '<no table>'
  return tbl.t.vlist

ttVal: procedure expose (gx)
  parse arg t, r, v
  t = translate(t)
  v = translate(v)
  if wordpos(t, g.tables) = 0 then return '<no table>'
  if r < 1 | r > tbl.t.0 then return '<no row>'
  if wordpos(v, tbl.t.vlist) = 0 then return '<no variable>'
  return val.t.r.v

ttGlob: procedure expose (gx)
  parse arg nm
  nm = translate(nm)
  if wordpos(nm, g.globals) = 0 then return '<undefined>'
  return glob.nm

ttOut: procedure expose (gx)
  parse arg dd, i
  dd = translate(dd)
  if wordpos(dd, g.outs) = 0 then return '<no output>'
  if i < 1 | i > out.dd.0 then return '<no line>'
  return out.dd.i

ttOutN: procedure expose (gx)
  parse arg dd
  dd = translate(dd)
  if wordpos(dd, g.outs) = 0 then return 0
  return out.dd.0

/* Plan memberow wyjscia (planOutput) jako 'NAZWA(od-do) ...'       */
ttMembers: procedure expose (gx)
  parse arg dd
  dd = translate(dd)
  if g.omode.dd <> 'MEMBERS' then return '<no members>'
  s = ''
  do k = 1 to mbr.dd.0
    s = s mbr.dd.k.mname'('mbr.dd.k.mfrom'-'mbr.dd.k.mto')'
  end
  return strip(s)

/* Wykonuje polecenie CMDIN (parser + modul polecenia)               */
ttExec: procedure expose (gx) tt.
  parse arg st
  say 'TTST-I >>' st
  call execStatement st
  return

ttEnd: procedure expose (gx) tt.
  say copies('=', 66)
  say 'TTST-I' tt.name':' tt.pass 'passed,' tt.fail 'failed'
  if tt.fail > 0 then do
    say 'TTST-E UNIT TESTS FAILED'
    return 8
  end
  say 'TTST-I ALL UNIT TESTS PASSED'
  return 0
