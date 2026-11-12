//TGTST3   JOB ,'TMPLGEN TEST IT3',CLASS=A,MSGCLASS=H,NOTIFY=&SYSUID
//*====================================================================
//* TMPLGEN - TESTY INTEGRACYJNE ITERACJI 3 (zakresy: RANGE)
//*
//* Testuje exec &TGEXEC (domyslnie TGIT3 z BLDIT3; moze byc tez
//* TMPLGEN). Wynik RANGE widac w SYSTSPRT (polecenie LIST).
//* Kazdy krok: PARM='TGRUN exec oczekiwany-RC'
//*   RC kroku 0 = test zaliczony, 12 = nieudany (SYSTSPRT, TGRUN-E)
//*====================================================================
//         SET TSTLIB=YOUR.USERID.REXX.TEST
//         SET EXECLIB=YOUR.USERID.REXX.EXEC
//         SET TGEXEC=TGIT3
//*
//*-- T01: przyklad z example2 - volumeny hex, TYPE(X) -> RC=0
//*        oczekiwane zakresy: 0-2, 8-A
//T01      EXEC PGM=IRXJCL,PARM='TGRUN &TGEXEC 0'
//SYSEXEC  DD DISP=SHR,DSN=&EXECLIB
//         DD DISP=SHR,DSN=&TSTLIB
//SYSTSIN  DD DUMMY
//SYSTSPRT DD SYSOUT=*
//LISTIN   DD *
VOLSR0 1000
VOLSR1 1001
VOLSR2 1002
VOLSR8 1008
VOLSR9 1009
VOLSRA 100A
/*
//VARDEF   DD *
VOLSR UNIT
/*
//CMDIN    DD *
  RANGE(LISTIN, VAR(VOLSR) PREFIX('VOLSR') TYPE(X) MAX(100) NOGAPS)
  LIST
/*
//*
//*-- T02: dziesietne, przerwy dozwolone, MAX(5) -> RC=0
//*        oczekiwane zakresy: SYS001-SYS004 (3 vol.), SYS010
//T02      EXEC PGM=IRXJCL,PARM='TGRUN &TGEXEC 0'
//SYSEXEC  DD DISP=SHR,DSN=&EXECLIB
//         DD DISP=SHR,DSN=&TSTLIB
//SYSTSIN  DD DUMMY
//SYSTSPRT DD SYSOUT=*
//LISTIN   DD *
SYS001
SYS002
SYS004
SYS010
/*
//CMDIN    DD *
  LOAD VARS(VOL)
  RANGE VAR(VOL) GAPS MAX(5)
  LIST
/*
//*
//*-- T03: duplikaty i wartosci bez numeru -> ostrzezenia RC=4
//T03      EXEC PGM=IRXJCL,PARM='TGRUN &TGEXEC 4'
//SYSEXEC  DD DISP=SHR,DSN=&EXECLIB
//         DD DISP=SHR,DSN=&TSTLIB
//SYSTSIN  DD DUMMY
//SYSTSPRT DD SYSOUT=*
//LISTIN   DD *
SYS001
SYS001
SYSTEM
SYS002
/*
//CMDIN    DD *
  LOAD VARS(VOL)
  RANGE VAR(VOL)
  LIST
/*
//*
//*-- T04: sprzeczne parametry TYPE i BASE -> RC=8
//T04      EXEC PGM=IRXJCL,PARM='TGRUN &TGEXEC 8'
//SYSEXEC  DD DISP=SHR,DSN=&EXECLIB
//         DD DISP=SHR,DSN=&TSTLIB
//SYSTSIN  DD DUMMY
//SYSTSPRT DD SYSOUT=*
//LISTIN   DD *
VOLSR0
/*
//CMDIN    DD *
  LOAD VARS(VOLSR)
  RANGE VAR(VOLSR) PREFIX('VOLSR') TYPE(X) BASE(16)
/*
