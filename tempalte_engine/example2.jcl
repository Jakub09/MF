//MYJOB    JOB ,'REXX BATCH',CLASS=1,MSGCLASS=H,NOTIFY=&SYSUID
//RUNPROG  EXEC PGM=IRXJCL,PARM='MYREXX'
//SYSEXEC  DD DSN=YOUR.USERID.REXX.EXEC,DISP=SHR
//SYSTSIN  DD DUMMY
//SYSTSPRT DD SYSOUT=*
//LISTIN DD *
volsr0 1000
volsr1 1001
volsr2 1002
volsr3 1003
volsr4 1004
volsr5 1005
volsr6 1006
volsr7 1007
volsr8 1008
volsr9 1009
volsra 100A
volsrb 100B
volsrc 100C
volsrd 100D
volsre 100E
volsrf 100F
//TMPLTIN  DD * -> tutaj wkładamy template dla którego ma być pomieniana wartość
  SCDS(MYCDS) VOL(SMS) pref({rngpref})FROM({rngstart}) TO({rngend}) SUF({rngsuff}) TYPE() SG(PRIMARY) STATUS(ENABLE)
/*
vardef DD*
volsr unit -> deklaracja zmiennych, podpisywanie że volsr=volsr0 i unit=1000 i tak dla każdej lini
//cmdin dd*
 range(LISTIN1, var(volsr) prefix('volsr') max(100) nogaps )  -> zrób z LISTIN1 zakresy, pomiń prefix w sortowaniu (dopuszczalny także suffix), zakresy nie większe niż 100, bez przerw 
 substitute(TMPLTIN,mode(command))
 
