/*-------------------------------------------------------------------*/
/* TGLIST   - LIST(tabela) - wydruk tabeli do logu                   */
/*            czesc TMPLGEN - skladane przez jcl/BUILD i jcl/BLDITn  */
/*-------------------------------------------------------------------*/

doList: procedure expose (gx)
  parse arg t
  t = translate(t)
  if t = '' then t = g.cur
  if t = '' then t = 'LISTIN'
  if ensureTable(t) = 0 then return
  call msg 'I', '   Table' t '('tbl.t.0 'rec.):' tbl.t.vlist
  do r = 1 to tbl.t.0
    l = ''
    do k = 1 to words(tbl.t.vlist)
      vn = word(tbl.t.vlist, k)
      l = l vn'='val.t.r.vn
    end
    call msg 'I', '   ' right(r, 5)':' l
  end
  return

