/*-------------------------------------------------------------------*/
/* TGPARSE  - CMDIN: odczyt, podzial na polecenia, parser, wykonanie */
/*            czesc TMPLGEN - skladane przez jcl/BUILD i jcl/BLDITn  */
/*-------------------------------------------------------------------*/

/* Czyta DD CMDIN do cmd. (brak DD = jedno polecenie COMMAND)        */
readCommands: procedure expose (gx)
  cmd.0 = 0
  if ddExists('CMDIN') = 0 then do
    call msg 'W', 'DD CMDIN not allocated - default command COMMAND'
    cmd.0 = 1
    cmd.1 = 'COMMAND'
    return
  end
  call readDD 'CMDIN'
  call splitCommands
  if cmd.0 = 0 then call msg 'W', 'CMDIN contains no commands'
  return

/* Linie z rd. -> polecenia cmd.: kolumny 1-72, '*' = komentarz,     */
/* komentarze REXX, kontynuacja: '-' na koncu albo otwarty nawias.   */
splitCommands: procedure expose (gx)
  n = 0
  buf = ''
  do i = 1 to rd.0
    l = strip(left(rd.i, 72), 'T')
    if left(strip(l), 1) == '*' then iterate
    l = strip(dropComments(l), 'T')
    if strip(l) == '' then iterate
    cont = 0
    if right(l, 1) == '-' then do
      cont = 1
      l = left(l, length(l) - 1)
    end
    buf = buf l
    if cont then iterate
    if parenDepth(buf) > 0 then iterate
    n = n + 1
    cmd.n = strip(buf)
    buf = ''
  end
  if strip(buf) <> '' then
    call msg 'E', 'Unterminated statement:' strip(buf)
  cmd.0 = n
  return

/* Rozbija tekst na tokeny NAZWA lub NAZWA(wartosc) -> tk.           */
tokenize: procedure expose (gx)
  parse arg s
  tk.0 = 0
  i = 1
  L = length(s)
  do forever
    do while i <= L
      if pos(substr(s, i, 1), ' ,') = 0 then leave
      i = i + 1
    end
    if i > L then leave
    st = i
    do while i <= L
      if pos(substr(s, i, 1), ' ,()') > 0 then leave
      i = i + 1
    end
    nm = substr(s, st, i - st)
    hasv = 0
    v = ''
    if i <= L then do
      if substr(s, i, 1) == ')' then do
        call msg 'E', 'Unexpected ")" in:' s
        tk.0 = 0
        return 0
      end
      if substr(s, i, 1) == '(' then do
        d = 1
        q = ''
        j = i + 1
        do while j <= L
          c = substr(s, j, 1)
          if q <> '' then do
            if c == q then q = ''
          end
          else if c == "'" | c == '"' then q = c
          else if c == '(' then d = d + 1
          else if c == ')' then do
            d = d - 1
            if d = 0 then leave
          end
          j = j + 1
        end
        if d <> 0 then do
          if q <> '' then call msg 'E', 'Unterminated quote in:' s
          else call msg 'E', 'Unbalanced parenthesis in:' s
          tk.0 = 0
          return 0
        end
        v = substr(s, i + 1, j - i - 1)
        hasv = 1
        i = j + 1
      end
    end
    n = tk.0 + 1
    tk.n.name = translate(nm)
    tk.n.raw = nm
    tk.n.val = v
    tk.n.hv = hasv
    tk.0 = n
  end
  return 1

/* Polecenie -> g.pverb (nazwa), g.parg1 (argument pozycyjny) i      */
/* parametry w opt. Obie skladnie daja ten sam wynik:                */
/*   RANGE(LISTIN) VAR(X) MAX(5)  ==  RANGE(LISTIN, VAR(X) MAX(5))   */
/* Zwraca 1 = OK, 0 = blad skladni.                                  */
parseStatement: procedure expose (gx)
  parse arg st
  g.pverb = ''
  g.parg1 = ''
  opt.0 = 0
  if tokenize(st) = 0 then return 0
  if tk.0 = 0 then return 0
  if tk.1.name == '' then do
    call msg 'E', 'Missing command name:' st
    return 0
  end
  g.pverb = tk.1.name
  vhv = tk.1.hv
  inner = tk.1.val
  do i = 2 to tk.0
    call addOpt tk.i.name, tk.i.val, tk.i.hv
  end
  if vhv then do
    if tokenize(inner) = 0 then return 0
    s1 = 1
    if tk.0 > 0 then if tk.1.hv = 0 then do
      g.parg1 = tk.1.raw
      s1 = 2
    end
    do i = s1 to tk.0
      call addOpt tk.i.name, tk.i.val, tk.i.hv
    end
  end
  return 1

execStatement: procedure expose (gx)
  parse arg st
  trace value g.trace
  if parseStatement(st) = 0 then return
  vb = g.pverb
  a1 = g.parg1
  select
    when vb == 'SET' then call doSet
    when vb == 'LOAD' then call doLoad a1
    when vb == 'RANGE' then call doRange a1
    when vb == 'LIST' then call doList a1
    when vb == 'TRACE' then call doTrace a1
    when vb == 'OUTPUT' then call doOutput a1
    when abbrev('SUBSTITUTE', vb, 5) then call doSubst a1, ''
    when wordpos(vb, 'STEP JOB COMMAND CMD') > 0 then
      call doSubst a1, vb
    otherwise call msg 'E', 'Unknown command:' vb
  end
  return

/* TRACE(x) albo TRACE x - poziom od nastepnego polecenia            */
doTrace: procedure expose (gx)
  parse arg lvl
  if lvl == '' & opt.0 = 1 then if opt.1.hv = 0 then do
    lvl = opt.1.name
    opt.0 = 0
  end
  if checkOpts('') then call setTrace lvl, 'CMDIN'
  return

/* PARM z EXEC: np. PARM='TMPLGEN TRACE(R)'                          */
parseParm: procedure expose (gx)
  parse arg p
  if tokenize(p) = 0 then return
  do i = 1 to tk.0
    if tk.i.name == 'TRACE' & tk.i.hv then
      call setTrace tk.i.val, 'PARM'
    else call msg 'E', 'Unknown PARM option:' tk.i.raw,
                       '(allowed: TRACE(x))'
  end
  return

setTrace: procedure expose (gx)
  parse arg lvl, src
  lvl = translate(unquote(lvl))
  if lvl == '' then do
    call msg 'E', 'TRACE: level missing, e.g. TRACE(R)'
    return
  end
  if length(lvl) <> 1 | verify(lvl, 'ACEFILNOR') > 0 then do
    call msg 'E', 'TRACE: invalid level' lvl,
                  '(allowed: N O R I A C E F L)'
    return
  end
  g.trace = lvl
  call msg 'I', '   TRACE' lvl 'set from' src
  return
