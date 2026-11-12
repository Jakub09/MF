/*-------------------------------------------------------------------*/
/* TGRANGE  - RANGE - zwijanie wartosci w zakresy                    */
/*            czesc TMPLGEN - skladane przez jcl/BUILD i jcl/BLDITn  */
/*-------------------------------------------------------------------*/

doRange: procedure expose (gx)
  parse arg src
  numeric digits 40
  ok = checkOpts('VAR PREFIX SUFFIX DIGITS MAX GAPS NOGAPS BASE TYPE',
                 'INTO')
  if ok = 0 then return
  src = translate(src)
  if src == '' then src = g.lastdata
  if src == '' then src = 'LISTIN'
  if ensureTable(src) = 0 then return
  t = src
  vars = tbl.t.vlist
  var = translate(getOpt('VAR', word(vars, 1)))
  if wordpos(var, vars) = 0 then do
    call msg 'E', 'RANGE: variable' var 'does not exist in' t
    return
  end
  hasP = hasOpt('PREFIX')
  pref = getOpt('PREFIX', '')
  suff = getOpt('SUFFIX', '')
  dig = getOpt('DIGITS', '')
  mx = getOpt('MAX', 0)
  base = translate(getOpt('BASE', 'AUTO'))
  if hasOpt('TYPE') then do
    if hasOpt('BASE') then do
      call msg 'E', 'RANGE: specify TYPE or BASE, not both'
      return
    end
    typ = translate(getOpt('TYPE', ''))
    select
      when typ == 'X' then base = 16
      when typ == 'N' | typ == 'D' then base = 10
      otherwise do
        call msg 'E', 'RANGE: TYPE must be X (hex) or N (decimal)'
        return
      end
    end
  end
  into = translate(getOpt('INTO', 'RANGES'))
  if hasOpt('GAPS') & hasOpt('NOGAPS') then do
    call msg 'E', 'RANGE: GAPS and NOGAPS are mutually exclusive'
    return
  end
  gaps = hasOpt('GAPS')
  if datatype(mx, 'W') = 0 then mx = -1
  if mx < 0 then do
    call msg 'E', 'RANGE: MAX must be a whole number >= 0:',
                  getOpt('MAX', '')
    return
  end
  if dig <> '' then do
    if datatype(dig, 'W') = 0 then dig = 0
    if dig < 1 | dig > 20 then do
      call msg 'E', 'RANGE: DIGITS must be 1-20:' getOpt('DIGITS', '')
      return
    end
  end
  if hasP & dig <> '' then do
    call msg 'E', 'RANGE: specify PREFIX or DIGITS, not both'
    return
  end
  if base <> 'AUTO' & base <> 10 & hasP = 0 & dig == '' then do
    call msg 'E', 'RANGE: TYPE(X) / BASE<>10 requires PREFIX or',
                  'DIGITS (variable part is ambiguous)'
    return
  end
  if validName(into) = 0 then do
    call msg 'E', 'RANGE: invalid INTO name:' into
    return
  end
  if into == t then do
    call msg 'E', 'RANGE: INTO('into') must differ from source table'
    return
  end

  /* 1. rozbicie wartosci na prefix / czesc zmienna / suffix */
  m = 0
  do r = 1 to tbl.t.0
    v = val.t.r.var
    if v == '' then iterate
    xsf = ''
    core = v
    if suff <> '' then do
      ls = length(suff)
      ok = 0
      if length(v) > ls then
        ok = (translate(right(v, ls)) == translate(suff))
      if ok = 0 then do
        call msg 'W', 'RANGE: skipping' v '- no suffix' suff
        iterate
      end
      xsf = right(v, ls)
      core = left(v, length(v) - ls)
    end
    select
      when hasP then do
        lp = length(pref)
        ok = 0
        if length(core) > lp then
          ok = (translate(left(core, lp)) == translate(pref))
        if ok = 0 then do
          call msg 'W', 'RANGE: skipping' v '- no prefix' pref
          iterate
        end
        xpf = left(core, lp)
        xmd = substr(core, lp + 1)
      end
      when dig <> '' then do
        if length(core) < dig then do
          call msg 'W', 'RANGE: skipping' v '- shorter than DIGITS'
          iterate
        end
        xpf = left(core, length(core) - dig)
        xmd = right(core, dig)
      end
      otherwise do
        p = verify(reverse(core), '0123456789')
        if p = 0 then p = length(core) + 1
        if p = 1 then do
          call msg 'W', 'RANGE: skipping' v '- no trailing digits',
                        '(use PREFIX or DIGITS)'
          iterate
        end
        xmd = right(core, p - 1)
        xpf = left(core, length(core) - (p - 1))
      end
    end
    if length(xmd) > 20 then do
      call msg 'W', 'RANGE: skipping' v '- variable part longer',
                    'than 20 characters'
      iterate
    end
    m = m + 1
    rk.m.row = r
    rk.m.full = v
    rk.m.pf = xpf
    rk.m.md = xmd
    rk.m.sf = xsf
  end

  /* 2. podstawa liczbowa */
  digs = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  if base == 'AUTO' then do
    base = 10
    if hasP | dig <> '' then do
      do j = 1 to m
        u = translate(rk.j.md)
        if verify(u, left(digs, 16)) > 0 then do
          base = 36
          leave
        end
        if verify(u, left(digs, 10)) > 0 then base = 16
      end
    end
  end
  if datatype(base, 'W') = 0 then base = 0
  if base < 2 | base > 36 then do
    call msg 'E', 'RANGE: BASE must be 2-36 or AUTO'
    return
  end
  dset = left(digs, base)
  rtyp = ''
  if base = 16 then rtyp = 'X'

  /* 3. wartosci liczbowe + klucze sortowania */
  sep = '00'x
  k = 0
  do j = 1 to m
    u = translate(rk.j.md)
    if verify(u, dset) > 0 then do
      call msg 'W', 'RANGE: skipping' rk.j.full '-' rk.j.md,
                    'is not a base' base 'number'
      iterate
    end
    nv = 0
    do c = 1 to length(u)
      nv = nv * base + pos(substr(u, c, 1), dset) - 1
    end
    k = k + 1
    ix.k = j
    rk.j.num = nv
    rk.j.grp = translate(rk.j.pf) || sep || translate(rk.j.sf) ||,
               sep || right(length(u), 3, '0') || sep
    rk.j.key = rk.j.grp || right(nv, 40, '0')
  end
  ix.0 = k

  /* 4. sortowanie (shell sort po kluczu) */
  gap = ix.0 % 2
  do while gap > 0
    do i = gap + 1 to ix.0
      tmp = ix.i
      tkey = rk.tmp.key
      j = i
      do while j > gap
        jg = j - gap
        a = ix.jg
        if rk.a.key >> tkey then do
          ix.j = a
          j = jg
        end
        else leave
      end
      ix.j = tmp
    end
    gap = gap % 2
  end

  /* 5. budowa zakresow */
  o = into
  nr = 0
  prevkey = ''
  prevgrp = ''
  lastn = 0
  startn = 0
  do i = 1 to ix.0
    j = ix.i
    if rk.j.key == prevkey then do
      call msg 'W', 'RANGE: duplicate' rk.j.full '- skipped'
      iterate
    end
    nv = rk.j.num
    newr = (nr = 0)
    if newr = 0 then newr = ((rk.j.grp == prevgrp) = 0)
    if newr = 0 & gaps = 0 then newr = (nv <> lastn + 1)
    if newr = 0 & mx > 0 then newr = (nv - startn + 1 > mx)
    if newr then do
      nr = nr + 1
      r0 = rk.j.row
      do c = 1 to words(vars)
        vn = word(vars, c)
        val.o.nr.vn = val.t.r0.vn
      end
      call setv o, nr, 'RNGPREF', rk.j.pf
      call setv o, nr, 'RNGSUFF', rk.j.sf
      call setv o, nr, 'RNGSTART', rk.j.md
      call setv o, nr, 'RNGFIRST', rk.j.full
      call setv o, nr, 'RNGCOUNT', 0
      call setv o, nr, 'RNGTYPE', rtyp
      startn = nv
    end
    call setv o, nr, 'RNGEND', rk.j.md
    call setv o, nr, 'RNGLAST', rk.j.full
    call setv o, nr, 'RNGCOUNT', getv(o, nr, 'RNGCOUNT') + 1
    lastn = nv
    prevkey = rk.j.key
    prevgrp = rk.j.grp
  end
  ovars = vars
  do c = 1 to 8
    vn = word('RNGPREF RNGSTART RNGEND RNGSUFF RNGCOUNT RNGFIRST',
              'RNGLAST RNGTYPE', c)
    if wordpos(vn, ovars) = 0 then ovars = ovars vn
  end
  tbl.o.0 = nr
  tbl.o.vlist = ovars
  if wordpos(o, g.tables) = 0 then g.tables = g.tables o
  g.cur = o
  tinfo = ''
  if rtyp <> '' then tinfo = ', TYPE('rtyp')'
  call msg 'I', '   RANGE' t'.'var '(base' base || tinfo'):' ix.0,
                'values ->' nr 'ranges in table' o
  do r = 1 to nr
    call msg 'I', '     ' right(r, 4)':' getv(o, r, 'RNGFIRST'),
         '-' getv(o, r, 'RNGLAST') '('getv(o, r, 'RNGCOUNT')')'
  end
  return

