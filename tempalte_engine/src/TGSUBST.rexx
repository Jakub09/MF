/*-------------------------------------------------------------------*/
/* TGSUBST  - SUBSTITUTE / STEP / JOB / COMMAND                      */
/*            czesc TMPLGEN - skladane przez jcl/BUILD i jcl/BLDITn  */
/*-------------------------------------------------------------------*/

doSubst: procedure expose (gx)
  parse arg tdd, short
  if short <> '' then mode = short
  else mode = translate(getOpt('MODE', 'COMMAND'))
  if mode = 'CMD' then mode = 'COMMAND'
  if wordpos(mode, 'COMMAND STEP JOB') = 0 then do
    call msg 'E', 'Unknown MODE:' mode '(COMMAND, STEP, JOB)'
    return
  end
  allowed = 'DATA OUTPUT HEADER TRAILER DELIM'
  if short = '' then allowed = 'MODE' allowed
  if mode = 'STEP' then allowed = allowed 'MAXSTEPS NORENAME'
  if mode = 'COMMAND' then allowed = allowed 'MAXCMD'
  if checkOpts(allowed) = 0 then return
  tdd = translate(tdd)
  if tdd = '' then tdd = 'TMPLTIN'
  data = translate(getOpt('DATA', ''))
  if data = '' then data = g.cur
  if data = '' then data = 'LISTIN'
  if ensureTable(data) = 0 then return
  outdd = translate(getOpt('OUTPUT', 'GENOUT'))
  hdr = translate(getOpt('HEADER', ''))
  trl = translate(getOpt('TRAILER', ''))
  maxst = getOpt('MAXSTEPS', 255)
  if datatype(maxst, 'W') = 0 then maxst = 0
  if maxst < 1 | maxst > 255 then do
    call msg 'E', 'MAXSTEPS must be 1-255'
    return
  end
  maxcmd = getOpt('MAXCMD', 0)
  if datatype(maxcmd, 'W') = 0 then maxcmd = -1
  if maxcmd < 0 | (hasOpt('MAXCMD') & maxcmd = 0) then do
    call msg 'E', 'MAXCMD must be a number > 0'
    return
  end
  if maxcmd > 0 & hdr = '' & trl = '' then
    call msg 'W', 'MAXCMD without HEADER/TRAILER - block split',
                  'will not be visible in output'
  dl = getOpt('DELIM', '{}')
  if length(dl) <> 2 | left(dl, 1) == right(dl, 1) then do
    call msg 'E', 'DELIM needs 2 different characters,',
                  'e.g. DELIM(''{}'')'
    return
  end
  g.dO = left(dl, 1)
  g.dC = right(dl, 1)
  rename = (hasOpt('NORENAME') = 0) & mode = 'STEP'

  if loadTpl(tdd) = 0 then return
  if hdr <> '' then if loadTpl(hdr) = 0 then return
  if trl <> '' then if loadTpl(trl) = 0 then return

  execs = 0
  do i = 1 to tpl.tdd.0
    if isJcl(tpl.tdd.i, 'EXEC') then execs = execs + 1
  end
  if mode = 'STEP' & execs = 0 then
    call msg 'W', 'MODE(STEP), but template' tdd 'has no EXEC'
  if mode = 'JOB' then do
    jc = 0
    do i = 1 to tpl.tdd.0
      if isJcl(tpl.tdd.i, 'JOB') then jc = 1
    end
    if hdr <> '' then do i = 1 to tpl.hdr.0
      if isJcl(tpl.hdr.i, 'JOB') then jc = 1
    end
    if jc = 0 then
      call msg 'W', 'MODE(JOB), but neither template nor HEADER',
                    'contains a JOB card'
  end

  rows = tbl.data.0
  g.count = rows
  g.unk = ''
  g.jobseq = 1
  if g.stepno.outdd = '' then g.stepno.outdd = 0
  g.stepw = max(3, length(g.stepno.outdd + rows * execs))
  if rows = 0 then do
    call msg 'W', 'Table' data 'is empty - nothing generated'
    return
  end
  before = outCount(outdd)
  jcl = (mode <> 'COMMAND')
  jobs = 0

  select
    when mode = 'COMMAND' then do
      blks = 1
      if hdr <> '' then call emitTpl hdr, 0, data, outdd, 0, jcl
      inBlk = 0
      do r = 1 to rows
        if maxcmd > 0 & inBlk >= maxcmd then do
          if trl <> '' then call emitTpl trl, 0, data, outdd, 0, jcl
          blks = blks + 1
          g.jobseq = blks
          if hdr <> '' then call emitTpl hdr, 0, data, outdd, 0, jcl
          inBlk = 0
        end
        call emitTpl tdd, r, data, outdd, 0, jcl
        inBlk = inBlk + 1
      end
      if trl <> '' then call emitTpl trl, 0, data, outdd, 0, jcl
    end
    when mode = 'STEP' then do
      jobs = 1
      if hdr <> '' then call emitTpl hdr, 0, data, outdd, 0, jcl
      inJob = 0
      warned = 0
      do r = 1 to rows
        if inJob > 0 & inJob + execs > maxst then do
          if hdr = '' then do
            if warned = 0 then call msg 'W', 'More than',
               maxst 'steps in job and no HEADER (JOB card)',
               '- cannot split into multiple jobs'
            warned = 1
          end
          else do
            if trl <> '' then call emitTpl trl, 0, data, outdd, 0, jcl
            jobs = jobs + 1
            g.jobseq = jobs
            call emitTpl hdr, 0, data, outdd, 0, jcl
            inJob = 0
          end
        end
        call emitTpl tdd, r, data, outdd, rename, jcl
        inJob = inJob + execs
      end
      if trl <> '' then call emitTpl trl, 0, data, outdd, 0, jcl
    end
    when mode = 'JOB' then do
      do r = 1 to rows
        jobs = r
        g.jobseq = r
        if hdr <> '' then call emitTpl hdr, r, data, outdd, 0, jcl
        call emitTpl tdd, r, data, outdd, 0, jcl
        if trl <> '' then call emitTpl trl, r, data, outdd, 0, jcl
      end
    end
  end
  msgj = ''
  if jobs > 0 then msgj = ',' jobs 'job(s)'
  if mode = 'COMMAND' & maxcmd > 0 then msgj = ',' blks 'block(s)'
  call msg 'I', '   MODE('mode')' tdd '+' data '('rows 'rec.) ->',
                outdd':' outCount(outdd) - before 'lines' || msgj
  return

loadTpl: procedure expose (gx)
  parse arg dd
  if wordpos(dd, g.tpls) > 0 then return 1
  if ddExists(dd) = 0 then do
    call msg 'E', 'DD' dd '(template) not allocated'
    return 0
  end
  call readDD dd
  do i = 0 to rd.0
    tpl.dd.i = rd.i
  end
  g.tpls = g.tpls dd
  return 1

emitTpl: procedure expose (gx)
  parse arg dd, r, data, outdd, rename, jcl
  do i = 1 to tpl.dd.0
    raw = tpl.dd.i
    line = subst(raw, r, data)
    if rename then if isJcl(raw, 'EXEC') then
      if pos(g.dO, word(raw, 1)) = 0 then
        line = renameStep(line, outdd)
    call emit outdd, line, jcl
  end
  return

/* Nadaje unikalna nazwe kroku: STEP1 -> STEP001, STEP002, ...       */
renameStep: procedure expose (gx)
  parse arg line, outdd
  old = substr(word(line, 1), 3)
  g.stepno.outdd = g.stepno.outdd + 1
  w = g.stepw
  b = old
  do while b <> ''
    if datatype(right(b, 1), 'W') = 0 then leave
    b = left(b, length(b) - 1)
  end
  if length(b) > 8 - w then b = left(b, 8 - w)
  if b = '' then b = 'S'
  nl = b || right(g.stepno.outdd, w, '0')
  rest = substr(line, 3 + length(old))
  if length(nl) < length(old) then nl = left(nl, length(old))
  else if length(nl) > length(old) then do
    lead = length(rest) - length(strip(rest, 'L'))
    cut = min(length(nl) - length(old), lead - 1)
    if cut > 0 then rest = substr(rest, cut + 1)
  end
  return '//' || nl || rest

