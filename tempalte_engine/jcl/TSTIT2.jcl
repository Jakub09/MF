//TGTST2   JOB ,'TMPLGEN TEST IT2',CLASS=A,MSGCLASS=H,NOTIFY=&SYSUID
//*====================================================================
//* TMPLGEN - TESTY INTEGRACYJNE ITERACJI 2 (dane: LOAD, LIST, VARDEF)
//*
//* Testuje exec &TGEXEC (domyslnie TGIT2 z BLDIT2; moze byc tez
//* TGIT3 albo TMPLGEN). Kazdy krok: PARM='TGRUN exec oczekiwany-RC'
//*   RC kroku 0 = test zaliczony, 12 = nieudany (SYSTSPRT, TGRUN-E)
//*====================================================================
//         SET TSTLIB=YOUR.USERID.REXX.TEST
//         SET EXECLIB=YOUR.USERID.REXX.EXEC
//         SET TGEXEC=TGIT2
//*
//*-- T01: LOAD + LIST, nazwy kolumn z VARDEF -> RC=0
//T01      EXEC PGM=IRXJCL,PARM='TGRUN &TGEXEC 0'
//SYSEXEC  DD DISP=SHR,DSN=&EXECLIB
//         DD DISP=SHR,DSN=&TSTLIB
//SYSTSIN  DD DUMMY
//SYSTSPRT DD SYSOUT=*
//LISTIN   DD *
* komentarz - pomijany
VOLSR0 1000 OPIS Z SPACJAMI
VOLSR1 1001 DRUGI
/*
//VARDEF   DD *
VOLSR UNIT DESC
/*
//CMDIN    DD *
  LOAD(LISTIN)
  LIST
/*
//*
//*-- T02: dwa zbiory danych, nazwy przez VARS() -> RC=0
//T02      EXEC PGM=IRXJCL,PARM='TGRUN &TGEXEC 0'
//SYSEXEC  DD DISP=SHR,DSN=&EXECLIB
//         DD DISP=SHR,DSN=&TSTLIB
//SYSTSIN  DD DUMMY
//SYSTSPRT DD SYSOUT=*
//LISTIN   DD *
VOLSR0 1000
/*
//SGLIST   DD *
PRIMARY  SMS1
ARCHIVE  SMS2
/*
//CMDIN    DD *
  LOAD(LISTIN) VARS(VOLSR UNIT)
  LOAD(SGLIST) VARS(SG SYSNAME)
  LIST(LISTIN)
  LIST(SGLIST)
/*
//*
//*-- T03: brak DD z danymi -> RC=8
//T03      EXEC PGM=IRXJCL,PARM='TGRUN &TGEXEC 8'
//SYSEXEC  DD DISP=SHR,DSN=&EXECLIB
//         DD DISP=SHR,DSN=&TSTLIB
//SYSTSIN  DD DUMMY
//SYSTSPRT DD SYSOUT=*
//CMDIN    DD *
  LOAD(NODATA) VARS(A)
/*
//*
//*-- T04: rekord z mniejsza liczba wartosci -> ostrzezenie RC=4
//T04      EXEC PGM=IRXJCL,PARM='TGRUN &TGEXEC 4'
//SYSEXEC  DD DISP=SHR,DSN=&EXECLIB
//         DD DISP=SHR,DSN=&TSTLIB
//SYSTSIN  DD DUMMY
//SYSTSPRT DD SYSOUT=*
//LISTIN   DD *
VOLSR0 1000
VOLSR1
/*
//VARDEF   DD *
VOLSR UNIT
/*
//CMDIN    DD *
  LOAD
  LIST
/*
//*
//*-- T05: niedozwolona nazwa zmiennej w VARDEF -> RC=8
//T05      EXEC PGM=IRXJCL,PARM='TGRUN &TGEXEC 8'
//SYSEXEC  DD DISP=SHR,DSN=&EXECLIB
//         DD DISP=SHR,DSN=&TSTLIB
//SYSTSIN  DD DUMMY
//SYSTSPRT DD SYSOUT=*
//LISTIN   DD *
VOLSR0 1000
/*
//VARDEF   DD *
_VOLSR UNIT
/*
//CMDIN    DD *
  LOAD
/*
