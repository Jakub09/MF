/*-------------------------------------------------------------------*/
/* TGLOAD   - LOAD, VARDEF - wczytanie tabeli danych                 */
/*            czesc TMPLGEN - skladane przez jcl/BUILD i jcl/BLDITn  */
/*-------------------------------------------------------------------*/

doLoad: procedure expose (gx)
  parse arg dd
  if checkOpts('VARS') = 0 then return
  if dd == '' then dd = 'LISTIN'
  call loadTable dd, getOpt('VARS', '')
  return

/* Nazwy zmiennych z DD VARDEF (czytane raz, potem z g.vardef)       */
getVardef: procedure expose (gx)
  if g.vardefread then return g.vardef
  g.vardefread = 1
  if ddExists('VARDEF') = 0 then return ''
  call readDD 'VARDEF'
  v = ''
  do i = 1 to rd.0
    l = strip(rd.i)
    if l == '' | left(l, 1) == '*' then iterate
    v = v l
  end
  g.vardef = space(translate(v))
  return g.vardef

/* Wczytuje DD dd jako tabele o tej samej nazwie                     */
loadTable: procedure expose (gx)
  parse arg dd, vars
  t = translate(dd)
  if ddExists(t) = 0 then do
    call msg 'E', 'DD' t '(data) not allocated'
    return 0
  end
  if vars == '' then vars = getVardef()
  call readDD t
  return buildTable(t, vars)

/* Buduje tabele t z linii w rd.: kolumny = slowa, ostatnia zmienna  */
/* dostaje reszte linii. Puste linie i '*' w kol.1 sa pomijane.      */
buildTable: procedure expose (gx)
  parse arg t, vars
  t = translate(t)
  vars = space(translate(vars))
  if vars == '' then do
    call msg 'E', 'No variable names for' t,
                  '(use DD VARDEF or VARS parameter)'
    return 0
  end
  do k = 1 to words(vars)
    vn = word(vars, k)
    if validName(vn) = 0 | wordpos(vn, vars) < k then do
      call msg 'E', 'Invalid or duplicate variable name:' vn
      return 0
    end
  end
  nv = words(vars)
  n = 0
  do i = 1 to rd.0
    l = rd.i
    if strip(l) == '' | left(strip(l), 1) == '*' then iterate
    n = n + 1
    if words(l) < nv then
      call msg 'W', t 'record' i 'has' words(l) 'values, expected',
                    nv':' strip(l)
    do k = 1 to nv
      vn = word(vars, k)
      if k < nv then val.t.n.vn = word(l, k)
      else val.t.n.vn = subword(l, k)
    end
  end
  tbl.t.0 = n
  tbl.t.vlist = vars
  if wordpos(t, g.tables) = 0 then g.tables = g.tables t
  g.cur = t
  g.lastdata = t
  call msg 'I', '   Loaded' t':' n 'records, variables:' vars
  return 1

ensureTable: procedure expose (gx)
  parse arg t
  if wordpos(t, g.tables) > 0 then return 1
  return loadTable(t, '')
