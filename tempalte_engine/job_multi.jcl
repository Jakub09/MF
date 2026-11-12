//TMPLMULT JOB ,'TMPLGEN MULTI',CLASS=A,MSGCLASS=H,NOTIFY=&SYSUID
//*--------------------------------------------------------------------
//* TMPLGEN - kilka szablonow (TMPLTIN1..3) w jednym przebiegu,
//*           wspolne LISTIN + VARDEF, w CMDIN wybor szablonu
//*           przez nazwe DD: STEP(TMPLTIN1), COMMAND(TMPLTIN2) ...
//*--------------------------------------------------------------------
//RUN      EXEC PGM=IRXJCL,PARM='TMPLGEN'
//SYSEXEC  DD DISP=SHR,DSN=YOUR.USERID.REXX.EXEC
//SYSTSIN  DD DUMMY
//SYSTSPRT DD SYSOUT=*
//GENOUT   DD SYSOUT=*
//SMSCMD   DD SYSOUT=*
//LISTIN   DD *
VOLSR0 1000
VOLSR1 1001
VOLSR2 1002
VOLSR5 1005
/*
//VARDEF   DD *
VOLSR UNIT
/*
//JOBCARD  DD DATA,DLM=@@
//DSSJOB   JOB ,'DSS',CLASS=A,MSGCLASS=H,NOTIFY=&SYSUID
@@
//*-- szablon 1: krok DUMP na kazdy volumen
//TMPLTIN1 DD DATA,DLM=@@
//DUMP1    EXEC PGM=ADRDSSU
//SYSPRINT DD  SYSOUT=*
//INDD     DD  DISP=SHR,UNIT=3390,VOL=SER={VOLSR}
//OUTDD    DD  DSN=BACKUP.DUMP.{VOLSR},DISP=(NEW,CATLG),
//             UNIT=SYSDA,SPACE=(CYL,(500,100),RLSE)
//SYSIN    DD  *
  DUMP FULL INDD(INDD) OUTDD(OUTDD) ALLDATA(*) ALLEXCP
/*
@@
//*-- szablon 2: komenda operatorska na kazdy volumen
//TMPLTIN2 DD *
 V {UNIT},OFFLINE
/*
//*-- szablon 3: zakresy volumenow dla SMS
//TMPLTIN3 DD *
 PREF({RNGPREF}) FROM({RNGSTART}) TO({RNGEND}) TYPE({RNGTYPE})
/*
//CMDIN    DD *
* kroki DUMP do GENOUT (job z karta JOBCARD)
  STEP(TMPLTIN1) HEADER(JOBCARD)
* komendy offline do osobnego DD
  COMMAND(TMPLTIN2) DATA(LISTIN) OUTPUT(SMSCMD)
* zakresy - tez do SMSCMD
  RANGE(LISTIN) VAR(VOLSR) PREFIX('VOLSR') TYPE(X)
  COMMAND(TMPLTIN3) OUTPUT(SMSCMD)
/*
