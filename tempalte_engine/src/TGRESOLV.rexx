/*-------------------------------------------------------------------*/
/* TGRESOLV - Podstawianie zmiennych {NAZWA:mod}                     */
/*            czesc TMPLGEN - skladane przez jcl/BUILD i jcl/BLDITn  */
/*-------------------------------------------------------------------*/

subst: procedure expose (gx)
  parse arg s, r, data
  o = ''
  do forever
    p = pos(g.dO, s)
    if p = 0 then leave
    if substr(s, p + 1, 1) == g.dO then do
      o = o || left(s, p)
      s = substr(s, p + 2)
      iterate
    end
    q = pos(g.dC, s, p + 1)
    if q = 0 then do
      call msg 'W', 'Unterminated variable in line:' s
      leave
    end
    o = o || left(s, p - 1) || resolve(substr(s, p + 1, q - p - 1),,
        r, data)
    s = substr(s, q + 1)
  end
  return o || s

resolve: procedure expose (gx)
  parse arg ex, r, data
  parse var ex nm ':' mods
  nm = translate(strip(nm))
  found = 1
  select
    when r > 0 & wordpos(nm, tbl.data.vlist) > 0 then v = val.data.r.nm
    when nm = '_SEQ' then v = r
    when nm = '_COUNT' then v = g.count
    when nm = '_JOBSEQ' then v = g.jobseq
    when nm = '_DATE' then v = date('S')
    when nm = '_TIME' then v = time()
    when wordpos(nm, g.globals) > 0 then v = glob.nm
    otherwise found = 0
  end
  if found = 0 then do
    if wordpos(nm, g.unk) = 0 then do
      g.unk = g.unk nm
      if r = 0 & wordpos(nm, tbl.data.vlist) > 0 then
        call msg 'E', 'Variable' nm 'not available in HEADER/TRAILER',
                      '(only SET and built-in variables)'
      else call msg 'E', 'Unknown variable {'ex'}'
    end
    return g.dO || ex || g.dC
  end
  do while mods <> ''
    parse var mods md ':' mods
    md = translate(strip(md))
    select
      when md == '' then nop
      when md == 'U' then v = translate(v)
      when md == 'L' then
        v = translate(v, 'abcdefghijklmnopqrstuvwxyz',,
                         'ABCDEFGHIJKLMNOPQRSTUVWXYZ')
      when datatype(md, 'W') then do
        if md >= 1 & md <= 255 then do
          if datatype(v, 'W') then v = right(v, md, '0')
          else v = left(v, md)
        end
        else call badModifier md
      end
      otherwise call badModifier md
    end
  end
  return v

/* Bledny modyfikator - komunikat tylko raz, wartosc bez zmian       */
badModifier: procedure expose (gx)
  parse arg md
  if wordpos('MOD:'md, g.unk) = 0 then do
    g.unk = g.unk 'MOD:'md
    call msg 'E', 'Unknown modifier :'md '(U, L, length 1-255)'
  end
  return

