/*-------------------------------------------------------------------*/
/* TGIO     - Warstwa I/O z/OS (EXECIO, BPXWDYN)                     */
/*            czesc TMPLGEN - skladane przez jcl/BUILD i jcl/BLDITn  */
/*-------------------------------------------------------------------*/

ddExists: procedure expose (gx)
  parse arg dd
  return (bpxwdyn('INFO FI('translate(dd)')') = 0)

/* Informacja o alokacji DD (BPXWDYN INFO). Zwraca tekst             */
/* 'rc;dsn;member;dsorg;typ' - dsorg np. PS, PO, puste = nieznane;   */
/* typ: puste = dataset, SYSOUT, DUMMY, TERM, SYSIN                  */
ddInfo: procedure expose (gx)
  parse arg dd
  tgidsn = ''
  tgimem = ''
  tgiorg = ''
  tgityp = ''
  r = bpxwdyn('INFO FI('translate(dd)') INRTDSN(TGIDSN)',
              'INRTMEM(TGIMEM) INRTORG(TGIORG) INRTTYP(TGITYP)')
  return r';'strip(tgidsn)';'strip(tgimem)';'strip(tgiorg)';',
         || strip(tgityp)

readDD: procedure expose (gx)
  parse arg dd
  dd = translate(dd)
  drop rd.
  rd.0 = 0
  address MVS 'EXECIO * DISKR' dd '(STEM RD. FINIS'
  if rc <> 0 then do
    call msg 'S', 'EXECIO DISKR' dd 'RC='rc
    rd.0 = 0
  end
  do i = 1 to rd.0
    rd.i = strip(rd.i, 'T')
  end
  return

writeDD: procedure expose (gx)
  parse arg dd
  if ddExists(dd) = 0 then do
    call msg 'S', 'DD' dd '(output) not allocated'
    return
  end
  if wr.0 = 0 then address MVS 'EXECIO 0 DISKW' dd '(OPEN FINIS'
  else address MVS 'EXECIO' wr.0 'DISKW' dd '(STEM WR. FINIS'
  if rc <> 0 then call msg 'S', 'EXECIO DISKW' dd 'RC='rc
  else call msg 'I', wr.0 'lines written to DD' dd
  return

/* Czy dataset da sie zaalokowac po nazwie (katalog, uprawnienia)    */
canAlloc: procedure expose (gx)
  parse arg dsn
  r = bpxwdyn("ALLOC FI(TGCHECK) DA('"dsn"') SHR REUSE")
  if r <> 0 then return 0
  call bpxwdyn 'FREE FI(TGCHECK)'
  return 1

/* Zapis wr. do membra dsn(mem): dynamiczna alokacja BPXWDYN pod DD  */
/* TGMEMBR, EXECIO DISKW, zwolnienie. Member jest zastepowany.       */
writeMember: procedure expose (gx)
  parse arg dsn, mem
  s99msg.0 = 0
  r = bpxwdyn("ALLOC FI(TGMEMBR) DA('"dsn"("mem")') SHR REUSE")
  if r <> 0 then do
    call msg 'S', 'Cannot allocate' dsn'('mem') - BPXWDYN RC='r
    do i = 1 to s99msg.0
      call msg 'S', '  ' s99msg.i
    end
    return
  end
  address MVS 'EXECIO' wr.0 'DISKW TGMEMBR (STEM WR. FINIS'
  erc = rc
  call bpxwdyn 'FREE FI(TGMEMBR)'
  if erc <> 0 then call msg 'S', 'EXECIO DISKW' dsn'('mem') RC='erc
  else call msg 'I', wr.0 'lines written to' dsn'('mem')'
  return
