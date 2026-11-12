/*-------------------------------------------------------------------*/
/* TGSET    - SET nazwa(wartosc) - zmienne globalne                  */
/*            czesc TMPLGEN - skladane przez jcl/BUILD i jcl/BLDITn  */
/*-------------------------------------------------------------------*/

doSet: procedure expose (gx)
  do i = 1 to opt.0
    nm = opt.i.name
    if opt.i.hv = 0 | validName(nm) = 0 then do
      call msg 'E', 'SET: invalid definition' nm '- use NAME(value)'
      iterate
    end
    glob.nm = unquote(opt.i.val)
    if wordpos(nm, g.globals) = 0 then g.globals = g.globals nm
    call msg 'I', '   SET' nm'='glob.nm
  end
  return

