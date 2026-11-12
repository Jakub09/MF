//TGTST1   JOB ,'TMPLGEN TEST IT1',CLASS=A,MSGCLASS=H,NOTIFY=&SYSUID
//*====================================================================
//* TMPLGEN - TESTY INTEGRACYJNE ITERACJI 1 (rdzen: CMDIN, SET, TRACE)
//*
//* Testuje exec &TGEXEC (domyslnie TGIT1 z BLDIT1). Mozna wpisac
//* TGIT2, TGIT3 albo TMPLGEN - testy rdzenia maja dalej przechodzic.
//* Kazdy krok: PARM='TGRUN exec oczekiwany-RC <argumenty dla exec>'
//*   RC kroku 0  = test zaliczony
//*   RC kroku 12 = test nieudany (SYSTSPRT: komunikaty TGRUN-E)
//*====================================================================
//         SET TSTLIB=YOUR.USERID.REXX.TEST
//         SET EXECLIB=YOUR.USERID.REXX.EXEC
//         SET TGEXEC=TGIT1
//*
//*-- T01: komentarze, kontynuacje, SET, obie skladnie -> RC=0
//T01      EXEC PGM=IRXJCL,PARM='TGRUN &TGEXEC 0'
//SYSEXEC  DD DISP=SHR,DSN=&EXECLIB
//         DD DISP=SHR,DSN=&TSTLIB
//SYSTSIN  DD DUMMY
//SYSTSPRT DD SYSOUT=*
//CMDIN    DD *
* komentarz w kolumnie 1
  SET HLQ(SYS1)                      /* komentarz REXX */
  SET DESC('DWA SLOWA') -
      OWNER(JAN)
  SET(TEAM(MF))
/*
//*
//*-- T02: nieznane polecenie -> RC=8
//T02      EXEC PGM=IRXJCL,PARM='TGRUN &TGEXEC 8'
//SYSEXEC  DD DISP=SHR,DSN=&EXECLIB
//         DD DISP=SHR,DSN=&TSTLIB
//SYSTSIN  DD DUMMY
//SYSTSPRT DD SYSOUT=*
//CMDIN    DD *
  SET HLQ(SYS1)
  GENERATE ALL
/*
//*
//*-- T03: niezamkniety nawias -> RC=8
//T03      EXEC PGM=IRXJCL,PARM='TGRUN &TGEXEC 8'
//SYSEXEC  DD DISP=SHR,DSN=&EXECLIB
//         DD DISP=SHR,DSN=&TSTLIB
//SYSTSIN  DD DUMMY
//SYSTSPRT DD SYSOUT=*
//CMDIN    DD *
  SET HLQ(SYS1
/*
//*
//*-- T04: TRACE z PARM -> RC=0 (slad REXX w SYSTSPRT)
//T04      EXEC PGM=IRXJCL,PARM='TGRUN &TGEXEC 0 TRACE(R)'
//SYSEXEC  DD DISP=SHR,DSN=&EXECLIB
//         DD DISP=SHR,DSN=&TSTLIB
//SYSTSIN  DD DUMMY
//SYSTSPRT DD SYSOUT=*
//CMDIN    DD *
  SET HLQ(SYS1)
/*
//*
//*-- T05: TRACE w CMDIN, poprawne i bledne poziomy -> RC=8
//T05      EXEC PGM=IRXJCL,PARM='TGRUN &TGEXEC 8'
//SYSEXEC  DD DISP=SHR,DSN=&EXECLIB
//         DD DISP=SHR,DSN=&TSTLIB
//SYSTSIN  DD DUMMY
//SYSTSPRT DD SYSOUT=*
//CMDIN    DD *
  TRACE(R)
  SET A(1)
  TRACE O
  TRACE(Q)
/*
//*
//*-- T06: pusty CMDIN -> ostrzezenie RC=4
//T06      EXEC PGM=IRXJCL,PARM='TGRUN &TGEXEC 4'
//SYSEXEC  DD DISP=SHR,DSN=&EXECLIB
//         DD DISP=SHR,DSN=&TSTLIB
//SYSTSIN  DD DUMMY
//SYSTSPRT DD SYSOUT=*
//CMDIN    DD DUMMY
