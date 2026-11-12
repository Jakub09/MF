//TGBLD2   JOB ,'TMPLGEN IT2',CLASS=A,MSGCLASS=H,NOTIFY=&SYSUID
//*====================================================================
//* TMPLGEN - BUILD ITERACJI 2: + dane (LOAD, LIST) -> TGIT2
//*
//* Przygotowanie (raz) - 3 biblioteki PDS, RECFM=FB, LRECL=80:
//*   SRCLIB  - moduly TG*            (katalog src/)
//*   TSTLIB  - testy TT*, TTLIB, TGRUN (katalog test/)
//*   EXECLIB - gotowe exec: TGIT1..3, TMPLGEN
//*   W ISPF EDIT: NUMBER OFF (kolumny 73-80 to tez kod REXX).
//*
//* Iteracje (kazda ma swoj job, kazda zawiera poprzednie moduly):
//*   BLDIT1 IT1 rdzen    TGMAIN TGHELP TGIO           -> TGIT1
//*                       TGPARSE TGSET TGOUT
//*   BLDIT2 IT2 dane     + TGLOAD TGLIST              -> TGIT2
//*   BLDIT3 IT3 zakresy  + TGRANGE                    -> TGIT3
//*   BUILD  IT4 pelny    + TGRESOLV TGSUBST           -> TMPLGEN
//*
//* Kroki:
//*   BODY    - skleja moduly iteracji (bez TGMAIN) w &&BODY
//*   ALLOC   - tymczasowa biblioteka exec &&TEXEC
//*   MKEXEC  - TGMAIN + &&BODY -> &&TEXEC(TGIT2)
//*   TTxxxx  - test jednostkowy: TTxxxx + TTLIB + &&BODY (proc UT)
//*   SMOKE   - uruchomienie TGIT2 przez TGRUN (sprawdza wynik)
//*   PROMOTE - tylko gdy WSZYSTKIE kroki RC=0: &EXECLIB(TGIT2)
//* Wynik: wszystkie kroki RC=0. Szczegoly: SYSTSPRT krokow RUN/SMOKE
//* (TTST-P = test OK, TTST-F = test nieudany).
//*====================================================================
//         SET SRCLIB=YOUR.USERID.REXX.SRC
//         SET TSTLIB=YOUR.USERID.REXX.TEST
//         SET EXECLIB=YOUR.USERID.REXX.EXEC
//*
//*-- UT: buduje exec testu &T (driver + TTLIB + BODY) i uruchamia go
//UT       PROC T=
//BLD      EXEC PGM=IEBGENER
//SYSPRINT DD SYSOUT=*
//SYSIN    DD DUMMY
//SYSUT1   DD DISP=SHR,DSN=&TSTLIB(&T)
//         DD DISP=SHR,DSN=&TSTLIB(TTLIB)
//         DD DISP=(OLD,PASS),DSN=&&BODY
//SYSUT2   DD DISP=(OLD,PASS),DSN=&&TEXEC(&T)
//RUN      EXEC PGM=IRXJCL,PARM=&T,COND=(0,NE,BLD)
//SYSEXEC  DD DISP=(OLD,PASS),DSN=&&TEXEC
//SYSTSIN  DD DUMMY
//SYSTSPRT DD SYSOUT=*
//         PEND
//*
//BODY     EXEC PGM=IEBGENER
//SYSPRINT DD SYSOUT=*
//SYSIN    DD DUMMY
//SYSUT1   DD DISP=SHR,DSN=&SRCLIB(TGHELP)
//         DD DISP=SHR,DSN=&SRCLIB(TGIO)
//         DD DISP=SHR,DSN=&SRCLIB(TGPARSE)
//         DD DISP=SHR,DSN=&SRCLIB(TGSET)
//         DD DISP=SHR,DSN=&SRCLIB(TGOUT)
//         DD DISP=SHR,DSN=&SRCLIB(TGLOAD)
//         DD DISP=SHR,DSN=&SRCLIB(TGLIST)
//SYSUT2   DD DSN=&&BODY,DISP=(NEW,PASS),UNIT=SYSDA,
//            SPACE=(TRK,(15,15)),RECFM=FB,LRECL=80
//*
//ALLOC    EXEC PGM=IEFBR14
//TEXEC    DD DSN=&&TEXEC,DISP=(NEW,PASS),UNIT=SYSDA,
//            SPACE=(TRK,(60,30,20)),RECFM=FB,LRECL=80,DSORG=PO
//*
//MKEXEC   EXEC PGM=IEBGENER,COND=(0,NE,BODY)
//SYSPRINT DD SYSOUT=*
//SYSIN    DD DUMMY
//SYSUT1   DD DISP=SHR,DSN=&SRCLIB(TGMAIN)
//         DD DISP=(OLD,PASS),DSN=&&BODY
//SYSUT2   DD DISP=(OLD,PASS),DSN=&&TEXEC(TGIT2)
//*
//*-- testy jednostkowe modulow iteracji 1-2
//TTHELP   EXEC UT,T=TTHELP
//TTIO     EXEC UT,T=TTIO
//RUN.TTIN DD *
LINE ONE
  LINE TWO

/*
//RUN.TTOUT DD DSN=&&TTOUT,DISP=(NEW,DELETE),UNIT=SYSDA,
//            SPACE=(TRK,(1,1)),RECFM=FB,LRECL=80,DSORG=PS
//TTPARSE  EXEC UT,T=TTPARSE
//TTSET    EXEC UT,T=TTSET
//TTOUT    EXEC UT,T=TTOUT
//TTLOAD   EXEC UT,T=TTLOAD
//RUN.LISTIN DD *
VOLSR0 1000
VOLSR1 1001
VOLSR2 1002
/*
//RUN.VARDEF DD *
VOLSR UNIT
/*
//TTLIST   EXEC UT,T=TTLIST
//*
//*-- smoke test: TGIT2 przez TGRUN (RC=0)
//SMOKE    EXEC PGM=IRXJCL,PARM='TGRUN TGIT2 0'
//SYSEXEC  DD DISP=(OLD,PASS),DSN=&&TEXEC
//         DD DISP=SHR,DSN=&TSTLIB
//SYSTSIN  DD DUMMY
//SYSTSPRT DD SYSOUT=*
//LISTIN   DD *
VOLSR0 1000
VOLSR1 1001
/*
//VARDEF   DD *
VOLSR UNIT
/*
//CMDIN    DD *
  LOAD(LISTIN)
  LIST
/*
//*
//*-- promocja tylko gdy wszystkie kroki skonczyly sie RC=0
//OK       IF (RC = 0) THEN
//PROMOTE  EXEC PGM=IEBGENER
//SYSPRINT DD SYSOUT=*
//SYSIN    DD DUMMY
//SYSUT1   DD DISP=(OLD,PASS),DSN=&&TEXEC(TGIT2)
//SYSUT2   DD DISP=SHR,DSN=&EXECLIB(TGIT2)
//         ENDIF
