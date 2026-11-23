//DCRPTPUR JOB (ACCT),'DCOLLECT MASK PURITY',CLASS=A,MSGCLASS=X,
//             NOTIFY=&SYSUID
//*-------------------------------------------------------------------
//* RAPORT 6: CZYSTOSC (PURITY) PODANYCH MASEK
//*
//* WEJSCIE : WYNIK IDCAMS DCOLLECT (UZYWANE SA REKORDY TYPU 'D')
//*           DD MASKI - MASKI, JEDNA W LINII (IN-STREAM ALBO FB 80)
//* SYMBOLE : DCOL32.SYM (HEADER, TYPED) + DCRWORK, DCRQLF (RPTSYM)
//*           TE SAME CO W DCRPTQLF, BEZ ZMIAN
//* WYNIK   : DD RPT6  - DLA KAZDEJ MASKI: LICZBA MALYCH I DUZYCH
//*                      ZBIOROW, % PURITY, SUMA ALOKACJI W MB
//*           DD RPT6E - MASKI NIEOBSLUGIWANE (WTEDY RC 4)
//*
//* PARAMETRY (SET):
//*   PROG, PROGOP, PROGSP, USTRK, USOP - JAK W DCRPTQLF. ZBIOR 'MALY':
//*           SCIEZKI(PROGSP) PROGOP PROG I UZYCIE_TRK USOP USTRK
//*           TU: ALOKACJA 315 TRK I UZYCIE DO 3 TRK
//*   BIGTRK- ZBIOR 'DUZY': NIE MALY I UZYCIE_TRK >= BIGTRK
//*           0 = KAZDY, KTORY NIE JEST MALY (JAK W DCRPTQLF)
//*           315 = TYLKO UZYWAJACE 21 CYL I WIECEJ; RESZTA JEST
//*           NEUTRALNA: LICZY SIE W 'ZBIOROW', NIE W PURITY
//*
//* - PURITY = MALE * 100 / (MALE + DUZE), W DOL (100 = BRAK DUZYCH)
//* - MB = SUMA ALOKACJI (NIE UZYCIA), KB / 1024, ZAOKRAGLONE
//* - TYLKO ZBIORY SEKWENCYJNE (PS) SMS - WARUNEK W EXT1CNTL
//* - KAZDA MASKA LICZONA NIEZALEZNIE; ZBIOR MOZE PASOWAC DO KILKU
//* - ZBIOR WIELOWOLUMENOWY LICZONY RAZ (SUMA ZE WSZYSTKICH VOLUMENOW)
//*
//* MASKI (JAK W FILTLIST):
//*   ABCD.FGF.**      ABCD.*.GFGF.**      ABCD.**.FG      ABCD.X.Y
//*   AB%%.%B.**.#G
//*   W KWALIFIKATORZE: LITERAL, *, ABC*, % W DOWOLNYM MIEJSCU
//*   '**' TYLKO RAZ: NA KONCU ALBO PRZED OSTATNIM KWALIFIKATOREM
//*   NAJWYZEJ 6 KWALIFIKATOROW PRZED '**' (LUB W MASCE BEZ '**')
//*   NIEOBSLUGIWANE: *ABC, A*C, A%*, A.**.B.**, A.**.B.C, **.LLQ
//*   * LUB % W PIERWSZYM KWALIFIKATORZE: KAZDY ZBIOR POROWNYWANY Z
//*   KAZDA TAKA MASKA - WOLNIEJ, WPISUJ ICH MALO
//*   LINIA '* ...' = KOMENTARZ; PO MASCE MOZE BYC DOWOLNY TEKST
//*-------------------------------------------------------------------
//* EXPORT: BEZ NIEGO SYMBOLS=JCLONLY NIE PODSTAWIA &PROG ITD.
//* W DANYCH IN-STREAM (SYMNAMES, KARTY, TOOLIN). MUSI BYC PRZED SET.
//         EXPORT SYMLIST=(PROG,PROGOP,PROGSP,USTRK,USOP,BIGTRK)
//         SET DCOLDSN='HLQ.DCOLLECT.OUTPUT'
//         SET SYMLIB='HLQ.DCOL32.SYM'
//         SET RPTSYM=&SYMLIB    BIBLIOTEKA DCRWORK/DCRQLF
//         SET PROG=315
//         SET PROGOP=EQ
//         SET PROGSP=ALL
//         SET USTRK=3
//         SET USOP=LE
//         SET BIGTRK=0
//*
//* WSPOLNE KARTY ZLACZEN JNP1 I JNP2 (WARUNEK DOPASOWANIA MASKI)
//* REKORD: 1-256 ZBIOR (DSNL), 257-516 MASKA (JAK W MSKS),
//* 517-546 ALOKACJA KB MALY / DUZY (DSNL 257-286),
//* 547-618 TEKST POL MASKI: KWALIFIKATORY 1-6, 7, LLQ (DLA %)
//* POLE: DOLNA <= KWALIFIKATOR <= GORNA; GDY W MASCE JEST %: DLUGOSC
//* TA SAMA I KAZDY ZNAK ROWNY ALBO % W MASCE
//* QX (FB 148): Q_* (1-115), 116-118 MIEJSCE NA Q_PCT,
//* 119-133 ALOKACJA MALYCH, 134-148 ALOKACJA DUZYCH
//GENJ     EXEC PGM=IEBGENER
//SYSPRINT DD SYSOUT=*
//SYSIN    DD DUMMY
//SYSUT2   DD DSN=&&JNPC,DISP=(NEW,PASS),UNIT=SYSDA,
//            SPACE=(TRK,(1,1)),DCB=(RECFM=FB,LRECL=80)
//SYSUT1   DD *
  REFORMAT FIELDS=(F1:1,256,F2:257,260,F1:257,30,F2:1,54,167,18)
  INCLUDE COND=(D_Q1,GE,301,9,CH,AND,D_Q1,LE,373,9,CH,AND,
                (445,9,CH,EQ,C' ',OR,
                 (445,9,CH,EQ,185,9,CH,AND,
                  (547,1,CH,EQ,C'%',OR,547,1,CH,EQ,1,1,CH),AND,
                  (548,1,CH,EQ,C'%',OR,548,1,CH,EQ,2,1,CH),AND,
                  (549,1,CH,EQ,C'%',OR,549,1,CH,EQ,3,1,CH),AND,
                  (550,1,CH,EQ,C'%',OR,550,1,CH,EQ,4,1,CH),AND,
                  (551,1,CH,EQ,C'%',OR,551,1,CH,EQ,5,1,CH),AND,
                  (552,1,CH,EQ,C'%',OR,552,1,CH,EQ,6,1,CH),AND,
                  (553,1,CH,EQ,C'%',OR,553,1,CH,EQ,7,1,CH),AND,
                  (554,1,CH,EQ,C'%',OR,554,1,CH,EQ,8,1,CH))),AND,
                D_Q2,GE,310,9,CH,AND,D_Q2,LE,382,9,CH,AND,
                (454,9,CH,EQ,C' ',OR,
                 (454,9,CH,EQ,194,9,CH,AND,
                  (556,1,CH,EQ,C'%',OR,556,1,CH,EQ,10,1,CH),AND,
                  (557,1,CH,EQ,C'%',OR,557,1,CH,EQ,11,1,CH),AND,
                  (558,1,CH,EQ,C'%',OR,558,1,CH,EQ,12,1,CH),AND,
                  (559,1,CH,EQ,C'%',OR,559,1,CH,EQ,13,1,CH),AND,
                  (560,1,CH,EQ,C'%',OR,560,1,CH,EQ,14,1,CH),AND,
                  (561,1,CH,EQ,C'%',OR,561,1,CH,EQ,15,1,CH),AND,
                  (562,1,CH,EQ,C'%',OR,562,1,CH,EQ,16,1,CH),AND,
                  (563,1,CH,EQ,C'%',OR,563,1,CH,EQ,17,1,CH))),AND,
                D_Q3,GE,319,9,CH,AND,D_Q3,LE,391,9,CH,AND,
                (463,9,CH,EQ,C' ',OR,
                 (463,9,CH,EQ,203,9,CH,AND,
                  (565,1,CH,EQ,C'%',OR,565,1,CH,EQ,19,1,CH),AND,
                  (566,1,CH,EQ,C'%',OR,566,1,CH,EQ,20,1,CH),AND,
                  (567,1,CH,EQ,C'%',OR,567,1,CH,EQ,21,1,CH),AND,
                  (568,1,CH,EQ,C'%',OR,568,1,CH,EQ,22,1,CH),AND,
                  (569,1,CH,EQ,C'%',OR,569,1,CH,EQ,23,1,CH),AND,
                  (570,1,CH,EQ,C'%',OR,570,1,CH,EQ,24,1,CH),AND,
                  (571,1,CH,EQ,C'%',OR,571,1,CH,EQ,25,1,CH),AND,
                  (572,1,CH,EQ,C'%',OR,572,1,CH,EQ,26,1,CH))),AND,
                D_Q4,GE,328,9,CH,AND,D_Q4,LE,400,9,CH,AND,
                (472,9,CH,EQ,C' ',OR,
                 (472,9,CH,EQ,212,9,CH,AND,
                  (574,1,CH,EQ,C'%',OR,574,1,CH,EQ,28,1,CH),AND,
                  (575,1,CH,EQ,C'%',OR,575,1,CH,EQ,29,1,CH),AND,
                  (576,1,CH,EQ,C'%',OR,576,1,CH,EQ,30,1,CH),AND,
                  (577,1,CH,EQ,C'%',OR,577,1,CH,EQ,31,1,CH),AND,
                  (578,1,CH,EQ,C'%',OR,578,1,CH,EQ,32,1,CH),AND,
                  (579,1,CH,EQ,C'%',OR,579,1,CH,EQ,33,1,CH),AND,
                  (580,1,CH,EQ,C'%',OR,580,1,CH,EQ,34,1,CH),AND,
                  (581,1,CH,EQ,C'%',OR,581,1,CH,EQ,35,1,CH))),AND,
                D_Q5,GE,337,9,CH,AND,D_Q5,LE,409,9,CH,AND,
                (481,9,CH,EQ,C' ',OR,
                 (481,9,CH,EQ,221,9,CH,AND,
                  (583,1,CH,EQ,C'%',OR,583,1,CH,EQ,37,1,CH),AND,
                  (584,1,CH,EQ,C'%',OR,584,1,CH,EQ,38,1,CH),AND,
                  (585,1,CH,EQ,C'%',OR,585,1,CH,EQ,39,1,CH),AND,
                  (586,1,CH,EQ,C'%',OR,586,1,CH,EQ,40,1,CH),AND,
                  (587,1,CH,EQ,C'%',OR,587,1,CH,EQ,41,1,CH),AND,
                  (588,1,CH,EQ,C'%',OR,588,1,CH,EQ,42,1,CH),AND,
                  (589,1,CH,EQ,C'%',OR,589,1,CH,EQ,43,1,CH),AND,
                  (590,1,CH,EQ,C'%',OR,590,1,CH,EQ,44,1,CH))),AND,
                D_Q6,GE,346,9,CH,AND,D_Q6,LE,418,9,CH,AND,
                (490,9,CH,EQ,C' ',OR,
                 (490,9,CH,EQ,230,9,CH,AND,
                  (592,1,CH,EQ,C'%',OR,592,1,CH,EQ,46,1,CH),AND,
                  (593,1,CH,EQ,C'%',OR,593,1,CH,EQ,47,1,CH),AND,
                  (594,1,CH,EQ,C'%',OR,594,1,CH,EQ,48,1,CH),AND,
                  (595,1,CH,EQ,C'%',OR,595,1,CH,EQ,49,1,CH),AND,
                  (596,1,CH,EQ,C'%',OR,596,1,CH,EQ,50,1,CH),AND,
                  (597,1,CH,EQ,C'%',OR,597,1,CH,EQ,51,1,CH),AND,
                  (598,1,CH,EQ,C'%',OR,598,1,CH,EQ,52,1,CH),AND,
                  (599,1,CH,EQ,C'%',OR,599,1,CH,EQ,53,1,CH))),AND,
                167,9,CH,GE,355,9,CH,AND,167,9,CH,LE,427,9,CH,AND,
                176,9,CH,GE,364,9,CH,AND,176,9,CH,LE,436,9,CH,AND,
                (508,9,CH,EQ,C' ',OR,
                 (508,9,CH,EQ,248,9,CH,AND,
                  (610,1,CH,EQ,C'%',OR,610,1,CH,EQ,176,1,CH),AND,
                  (611,1,CH,EQ,C'%',OR,611,1,CH,EQ,177,1,CH),AND,
                  (612,1,CH,EQ,C'%',OR,612,1,CH,EQ,178,1,CH),AND,
                  (613,1,CH,EQ,C'%',OR,613,1,CH,EQ,179,1,CH),AND,
                  (614,1,CH,EQ,C'%',OR,614,1,CH,EQ,180,1,CH),AND,
                  (615,1,CH,EQ,C'%',OR,615,1,CH,EQ,181,1,CH),AND,
                  (616,1,CH,EQ,C'%',OR,616,1,CH,EQ,182,1,CH),AND,
                  (617,1,CH,EQ,C'%',OR,617,1,CH,EQ,183,1,CH))))
  OUTFIL FNAMES=QX,
    BUILD=(257,44,16X,C'00',8X,D_SMALL,D_LARGE,ZD15_1,
           C'000',517,30)
/*
//*
//RPTPUR   EXEC PGM=ICETOOL,COND=(0,NE,GENJ)
//* MASKI ZE ZBIORU (FB 80): //MASKI DD DISP=SHR,DSN=HLQ.MASKI
//MASKI    DD *
* TU WPISZ MASKI
ABCD.FGF.**
ABCD.*.GFGF.**
ABCD.**.FG
/*
//TOOLMSG  DD SYSOUT=*
//DFSMSG   DD SYSOUT=*
//SYMNOUT  DD SYSOUT=*
//SYMNAMES DD DISP=SHR,DSN=&SYMLIB(HEADER)
//         DD DISP=SHR,DSN=&SYMLIB(TYPED)
//         DD DISP=SHR,DSN=&RPTSYM(DCRWORK)
//         DD DISP=SHR,DSN=&RPTSYM(DCRQLF)
//         DD *,SYMBOLS=JCLONLY
* PARAMETRY Z JCL (SET), NAZWY JAK W DCRPTQLF
P_TRK,+&PROG
P_USTRK,+&USTRK
//DCOLIN   DD DISP=SHR,DSN=&DCOLDSN
//EXTR     DD DSN=&&EXTR,DISP=(NEW,DELETE,DELETE),UNIT=SYSDA,
//            SPACE=(CYL,(10,50),RLSE)
//DSNL     DD DSN=&&DSNL,DISP=(NEW,DELETE,DELETE),UNIT=SYSDA,
//            SPACE=(CYL,(20,100),RLSE)
//MSKS     DD DSN=&&MSKS,DISP=(NEW,DELETE,DELETE),UNIT=SYSDA,
//            SPACE=(TRK,(5,15),RLSE)
//MSKW     DD DSN=&&MSKW,DISP=(NEW,DELETE,DELETE),UNIT=SYSDA,
//            SPACE=(TRK,(5,15),RLSE)
//BADM     DD DSN=&&BADM,DISP=(NEW,DELETE,DELETE),UNIT=SYSDA,
//            SPACE=(TRK,(1,5),RLSE)
//* QX: NAJPIERW MASKI Z ZERAMI, POTEM DOPISANE PARY (DLATEGO MOD)
//QX       DD DSN=&&QX,DISP=(MOD,DELETE,DELETE),UNIT=SYSDA,
//            SPACE=(CYL,(10,100),RLSE)
//QSUM     DD DSN=&&QSUM,DISP=(NEW,DELETE,DELETE),UNIT=SYSDA,
//            SPACE=(TRK,(5,15),RLSE)
//QSRT     DD DSN=&&QSRT,DISP=(NEW,DELETE,DELETE),UNIT=SYSDA,
//            SPACE=(TRK,(5,15),RLSE)
//RPT6     DD SYSOUT=*
//RPT6E    DD SYSOUT=*
//TOOLIN   DD *,SYMBOLS=JCLONLY
* 1. REKORDY 'D' -> JEDEN REKORD NA ZBIOR (EXTR)
  SORT FROM(DCOLIN) USING(EXT1)
* 2. KWALIFIKATORY + ZNACZNIK MALY/DUZY DLA ZBIORU (DSNL)
  COPY FROM(EXTR) USING(DSN1)
* 3. MASKI -> ZAKRESY NA KWALIFIKATOR (MSKS; MSKW = WIELOZNACZNIK W
*    PIERWSZYM KWALIFIKATORZE), ZERA (QX), BLEDY (BADM)
  SORT FROM(MASKI) USING(MSK1)
* 4. PARY MASKA-ZBIOR DOPISANE DO QX
  COPY JKFROM USING(JNP1)
  COPY JKFROM USING(JNP2)
* 5. SUMY I PURITY WG MASKI (RPT6)
  SORT FROM(QX) USING(QSM1)
  SORT FROM(QSUM) TO(QSRT) USING(QSR1)
  DISPLAY FROM(QSRT) LIST(RPT6) -
    TITLE('PURITY: &PROGSP &PROGOP &PROG I USE &USOP &USTRK') -
    DATE TIME PAGE BLANK WIDTH(180) -
    HEADER('Maska')     ON(Q_MASK) -
    HEADER('Malych')    ON(Q_SMALL) -
    HEADER('Duzych')    ON(Q_LARGE) -
    HEADER('% purity')  ON(Q_PCT) -
    HEADER('Malych MB') ON(119,15,ZD) -
    HEADER('Duzych MB') ON(134,15,ZD) -
    HEADER('Zbiorow')   ON(Q_TOTAL)
* 6. MASKI NIEOBSLUGIWANE: RAPORT I RC 4
  DISPLAY FROM(BADM) LIST(RPT6E) -
    TITLE('MASKI NIEOBSLUGIWANE - POPRAW DD MASKI') -
    DATE TIME PAGE BLANK -
    HEADER('Maska') ON(1,44,CH)
  COUNT FROM(BADM) HIGHER(0) RC4
/*
//EXT1CNTL DD *
* TYLKO REKORDY AKTYWNYCH ZBIOROW (TYP 'D'), SEKWENCYJNE, SMS
  INCLUDE COND=(DCURCTYP,EQ,DCUDATAT,AND,
                DCDDSOR0,EQ,DCDDSGPS,AND,
                DCDFLAG1,EQ,DCDSMSM)
* UKLAD ROBOCZY + WYBOR POLA PRZESTRZENI: 63-BIT / 31-BIT / 0
  INREC IFTHEN=(WHEN=INIT,
          BUILD=(1,4,5:ZD15_0,20:ZD15_0,35:DCDMGTCL,65:DCDDSNAM,
                 109:DCDFLAG2,110:DCDFLAG5,111:DCDALLSP,115:DCDUSESP,
                 119:DCDALLSX,127:DCDUSESX)),
        IFTHEN=(WHEN=(W_FLAG5,EQ,DCDALLFX),
          OVERLAY=(5:W_ALLSX,TO=ZD,LENGTH=15),HIT=NEXT),
        IFTHEN=(WHEN=(W_FLAG5,NE,DCDALLFX,AND,W_FLAG2,EQ,DCDALLFG),
          OVERLAY=(5:W_ALLSP,TO=ZD,LENGTH=15),HIT=NEXT),
        IFTHEN=(WHEN=(W_FLAG5,EQ,DCDUSEFX),
          OVERLAY=(20:W_USESX,TO=ZD,LENGTH=15),HIT=NEXT),
        IFTHEN=(WHEN=(W_FLAG5,NE,DCDUSEFX,AND,W_FLAG2,EQ,DCDUSEFG),
          OVERLAY=(20:W_USESP,TO=ZD,LENGTH=15))
* ZBIOR WIELOWOLUMENOWY -> JEDEN REKORD, PRZESTRZEN ZSUMOWANA
  SORT FIELDS=(W_DSNAM,A)
  SUM FIELDS=(W_ALLKB,W_USEKB)
* VB -> FB 104
  OUTFIL FNAMES=EXTR,VTOF,BUILD=(5,104)
/*
//*
//* DSNL (FB 286): 1-166 JAK W DCRPTQLF (D_*), OPROCZ D_MASK
//*   167-175 KWALIFIKATOR 7, 176-184 OSTATNI KWALIFIKATOR (LLQ)
//*   185-256 DLUGOSCI: KWALIFIKATORY 1-7 I LLQ, KAZDY ZNAK = X
//*   257-271 ALOKACJA KB, GDY MALY; 272-286 ALOKACJA KB, GDY DUZY
//*   287-345 ROBOCZO: NAZWA DOSUNIETA DO PRAWEJ, ALOKACJA KB
//DSN1CNTL DD *,SYMBOLS=JCLONLY
* A-Z 0-9 $ # @ - { % -> X (TRAN=ALTSEQ)
  ALTSEQ CODE=(5BE7,60E7,6CE7,7BE7,7CE7,C0E7,C1E7,C2E7,C3E7,C4E7,C5E7,
               C6E7,C7E7,C8E7,C9E7,D1E7,D2E7,D3E7,D4E7,D5E7,D6E7,D7E7,
               D8E7,D9E7,E2E7,E3E7,E4E7,E5E7,E6E7,E8E7,E9E7,F0E7,F1E7,
               F2E7,F3E7,F4E7,F5E7,F6E7,F7E7,F8E7,F9E7)
* SCIEZKI: D_TRKALL Z ALOKACJI (ZAOKR.), D_TRKUSE Z UZYCIA (W GORE).
* MALY: D_SMALL=1; DUZY: D_LARGE=1; NEUTRALNY: OBA 0.
* LLQ: PIERWSZA KROPKA OD PRAWEJ (OSTATNIE IFTHEN, BEZ HIT=NEXT)
  INREC IFTHEN=(WHEN=INIT,
          PARSE=(%01=(ABSPOS=61,ENDBEFR=C'.',FIXLEN=9),
                 %02=(ENDBEFR=C'.',FIXLEN=9),
                 %03=(ENDBEFR=C'.',FIXLEN=9),
                 %04=(ENDBEFR=C'.',FIXLEN=9),
                 %05=(ENDBEFR=C'.',FIXLEN=9),
                 %06=(ENDBEFR=C'.',FIXLEN=9),
                 %07=(ENDBEFR=C'.',FIXLEN=9)),
          BUILD=(1:%01,%02,%03,%04,%05,%06,55:8X,
                 63:(X_USEKB,MUL,+1024,ADD,+56663),DIV,+56664,
                    TO=ZD,LENGTH=15,
                 78:(X_ALLKB,MUL,+1024,ADD,+28332),DIV,+56664,
                    TO=ZD,LENGTH=15,
                 93:ZD15_0,108:ZD15_0,123:X_DSNAM,
                 167:%07,176:81X,
                 257:ZD15_0,272:ZD15_0,
                 287:X_DSNAM,JFY=(SHIFT=RIGHT),331:X_ALLKB)),
        IFTHEN=(WHEN=(D_TRK&PROGSP,&PROGOP,P_TRK,AND,
                      D_TRKUSE,&USOP,P_USTRK),
          OVERLAY=(93:ZD15_1,257:331,15),HIT=NEXT),
        IFTHEN=(WHEN=(D_SMALL,EQ,+0,AND,D_TRKUSE,GE,+&BIGTRK),
          OVERLAY=(108:ZD15_1,272:331,15),HIT=NEXT),
        IFTHEN=(WHEN=(329,1,CH,EQ,C'.'),OVERLAY=(176:330,1)),
        IFTHEN=(WHEN=(328,1,CH,EQ,C'.'),OVERLAY=(176:329,2)),
        IFTHEN=(WHEN=(327,1,CH,EQ,C'.'),OVERLAY=(176:328,3)),
        IFTHEN=(WHEN=(326,1,CH,EQ,C'.'),OVERLAY=(176:327,4)),
        IFTHEN=(WHEN=(325,1,CH,EQ,C'.'),OVERLAY=(176:326,5)),
        IFTHEN=(WHEN=(324,1,CH,EQ,C'.'),OVERLAY=(176:325,6)),
        IFTHEN=(WHEN=(323,1,CH,EQ,C'.'),OVERLAY=(176:324,7)),
        IFTHEN=(WHEN=(322,1,CH,EQ,C'.'),OVERLAY=(176:323,8))
  OUTREC OVERLAY=(185:1,54,TRAN=ALTSEQ,239:167,18,TRAN=ALTSEQ)
  OUTFIL FNAMES=DSNL,BUILD=(1,286)
/*
//*
//* MSKS (FB 516): MASKA ROZBITA NA 8 POL PO 9 ZNAKOW: KWALIFIKATORY
//* 1-6 (D_Q1-D_Q6), 7 (167-175), LLQ (176-184). W POLU '**' =
//* COKOLWIEK LUB BRAK, '*' = KWALIFIKATOR MUSI ISTNIEC.
//*   101-127 ROBOCZO: KWALIFIKATORY MASKI 7-9, D_VALID = Y/N
//*   257-300 TEKST MASKI
//*   301-372 DOLNA GRANICA POLA    373-444 GORNA GRANICA POLA
//*   445-516 WYMAGANA DLUGOSC (XXX, GDY JEST %) ALBO SPACJE
//*   517-588 I 589-660 ROBOCZO
//* ZBIOR PASUJE, GDY KAZDE POLE: DOLNA <= KWALIFIKATOR <= GORNA
//* (DLA % TAKZE ZNAKI - KROK GENJ). GRANICE W KOLEJNOSCI EBCDIC
//* ($ NAJNIZSZY, 9 NAJWYZSZY ZNAK NAZWY): ABC* -> 'ABC' DO 'ABC999999'
//MSK1CNTL DD *
  ALTSEQ CODE=(5BE7,60E7,6CE7,7BE7,7CE7,C0E7,C1E7,C2E7,C3E7,C4E7,C5E7,
               C6E7,C7E7,C8E7,C9E7,D1E7,D2E7,D3E7,D4E7,D5E7,D6E7,D7E7,
               D8E7,D9E7,E2E7,E3E7,E4E7,E5E7,E6E7,E8E7,E9E7,F0E7,F1E7,
               F2E7,F3E7,F4E7,F5E7,F6E7,F7E7,F8E7,F9E7)
  OMIT COND=(C_MASK,EQ,C' ',OR,1,2,CH,EQ,C'* ')
* INREC: MALE LITERY -> WIELKIE, ROZBICIE MASKI, POTEM KONTROLA
* (D_VALID = N -> RPT6E):
*   1. PIERWSZY KWALIFIKATOR PUSTY LUB '**', WIECEJ NIZ 8 POL
*   2. KWALIFIKATOR DLUZSZY NIZ 8 ZNAKOW
*   3. PUSTY KWALIFIKATOR W SRODKU (A..B)
*   4. PO '**' NAJWYZEJ JEDEN KWALIFIKATOR, NIE '**'
*   5. BEZ '**' NAJWYZEJ 6 KWALIFIKATOROW
*   6. '*' I '%' RAZEM ALBO '**' WEWNATRZ KWALIFIKATORA
* NASTEPNIE: KWALIFIKATOR PO '**' -> POLE LLQ; '**' NA POLU P:
* BEZ LLQ - POLA P-7 = '**', Z LLQ - POLE P = '*', DALSZE '**'
  INREC IFTHEN=(WHEN=INIT,
          PARSE=(%00=(STARTAT=NONBLANK,ENDBEFR=C' ',FIXLEN=44)),
          BUILD=(61X,C'Y',194X,%00)),
        IFTHEN=(WHEN=INIT,OVERLAY=(257:257,44,TRAN=LTOU)),
        IFTHEN=(WHEN=INIT,
          PARSE=(%01=(ABSPOS=257,ENDBEFR=C'.',FIXLEN=9),
                 %02=(ENDBEFR=C'.',FIXLEN=9),
                 %03=(ENDBEFR=C'.',FIXLEN=9),
                 %04=(ENDBEFR=C'.',FIXLEN=9),
                 %05=(ENDBEFR=C'.',FIXLEN=9),
                 %06=(ENDBEFR=C'.',FIXLEN=9),
                 %07=(ENDBEFR=C'.',FIXLEN=9),
                 %08=(ENDBEFR=C'.',FIXLEN=9),
                 %09=(ENDBEFR=C'.',FIXLEN=9)),
          OVERLAY=(1:%01,%02,%03,%04,%05,%06,101:%07,%08,%09,
                   176:C'**       ')),
        IFTHEN=(WHEN=(D_Q1,EQ,C' ',OR,D_Q1,EQ,C'**',OR,
                      119,9,CH,NE,C' '),
          OVERLAY=(62:C'N'),HIT=NEXT),
        IFTHEN=(WHEN=(9,1,CH,NE,C' ',OR,18,1,CH,NE,C' ',OR,
                      27,1,CH,NE,C' ',OR,36,1,CH,NE,C' ',OR,
                      45,1,CH,NE,C' ',OR,54,1,CH,NE,C' ',OR,
                      109,1,CH,NE,C' ',OR,118,1,CH,NE,C' '),
          OVERLAY=(62:C'N'),HIT=NEXT),
        IFTHEN=(WHEN=((D_Q1,EQ,C' ',AND,D_Q2,NE,C' '),OR,
                      (D_Q2,EQ,C' ',AND,D_Q3,NE,C' '),OR,
                      (D_Q3,EQ,C' ',AND,D_Q4,NE,C' '),OR,
                      (D_Q4,EQ,C' ',AND,D_Q5,NE,C' '),OR,
                      (D_Q5,EQ,C' ',AND,D_Q6,NE,C' '),OR,
                      (D_Q6,EQ,C' ',AND,101,9,CH,NE,C' '),OR,
                      (101,9,CH,EQ,C' ',AND,110,9,CH,NE,C' ')),
          OVERLAY=(62:C'N'),HIT=NEXT),
        IFTHEN=(WHEN=((D_Q2,EQ,C'**',AND,D_Q4,NE,C' '),OR,
                      (D_Q3,EQ,C'**',AND,D_Q5,NE,C' '),OR,
                      (D_Q4,EQ,C'**',AND,D_Q6,NE,C' '),OR,
                      (D_Q5,EQ,C'**',AND,101,9,CH,NE,C' '),OR,
                      (D_Q6,EQ,C'**',AND,110,9,CH,NE,C' '),OR,
                      (D_Q2,EQ,C'**',AND,D_Q3,EQ,C'**'),OR,
                      (D_Q3,EQ,C'**',AND,D_Q4,EQ,C'**'),OR,
                      (D_Q4,EQ,C'**',AND,D_Q5,EQ,C'**'),OR,
                      (D_Q5,EQ,C'**',AND,D_Q6,EQ,C'**'),OR,
                      (D_Q6,EQ,C'**',AND,101,9,CH,EQ,C'**'),OR,
                      (101,9,CH,EQ,C'**',AND,110,9,CH,EQ,C'**')),
          OVERLAY=(62:C'N'),HIT=NEXT),
        IFTHEN=(WHEN=((101,9,CH,NE,C' ',AND,101,9,CH,NE,C'**',AND,
                       D_Q6,NE,C'**'),OR,
                      (110,9,CH,NE,C' ',AND,101,9,CH,NE,C'**')),
          OVERLAY=(62:C'N'),HIT=NEXT),
        IFTHEN=(WHEN=((D_Q1,SS,EQ,C'*',AND,D_Q1,SS,EQ,C'%'),OR,
                      (D_Q2,SS,EQ,C'*',AND,D_Q2,SS,EQ,C'%'),OR,
                      (D_Q3,SS,EQ,C'*',AND,D_Q3,SS,EQ,C'%'),OR,
                      (D_Q4,SS,EQ,C'*',AND,D_Q4,SS,EQ,C'%'),OR,
                      (D_Q5,SS,EQ,C'*',AND,D_Q5,SS,EQ,C'%'),OR,
                      (D_Q6,SS,EQ,C'*',AND,D_Q6,SS,EQ,C'%'),OR,
                      (101,9,SS,EQ,C'*',AND,101,9,SS,EQ,C'%'),OR,
                      (110,9,SS,EQ,C'*',AND,110,9,SS,EQ,C'%'),OR,
                      (D_Q1,NE,C'**',AND,D_Q1,SS,EQ,C'**'),OR,
                      (D_Q2,NE,C'**',AND,D_Q2,SS,EQ,C'**'),OR,
                      (D_Q3,NE,C'**',AND,D_Q3,SS,EQ,C'**'),OR,
                      (D_Q4,NE,C'**',AND,D_Q4,SS,EQ,C'**'),OR,
                      (D_Q5,NE,C'**',AND,D_Q5,SS,EQ,C'**'),OR,
                      (D_Q6,NE,C'**',AND,D_Q6,SS,EQ,C'**'),OR,
                      (101,9,CH,NE,C'**',AND,101,9,SS,EQ,C'**'),OR,
                      (110,9,CH,NE,C'**',AND,110,9,SS,EQ,C'**')),
          OVERLAY=(62:C'N'),HIT=NEXT),
        IFTHEN=(WHEN=(D_Q2,EQ,C'**',AND,D_Q3,NE,C' '),
          OVERLAY=(176:D_Q3),HIT=NEXT),
        IFTHEN=(WHEN=(D_Q3,EQ,C'**',AND,D_Q4,NE,C' '),
          OVERLAY=(176:D_Q4),HIT=NEXT),
        IFTHEN=(WHEN=(D_Q4,EQ,C'**',AND,D_Q5,NE,C' '),
          OVERLAY=(176:D_Q5),HIT=NEXT),
        IFTHEN=(WHEN=(D_Q5,EQ,C'**',AND,D_Q6,NE,C' '),
          OVERLAY=(176:D_Q6),HIT=NEXT),
        IFTHEN=(WHEN=(D_Q6,EQ,C'**',AND,101,9,CH,NE,C' '),
          OVERLAY=(176:101,9),HIT=NEXT),
        IFTHEN=(WHEN=(101,9,CH,EQ,C'**',AND,110,9,CH,NE,C' '),
          OVERLAY=(176:110,9),HIT=NEXT),
        IFTHEN=(WHEN=(101,9,CH,EQ,C'**',AND,176,9,CH,EQ,C'**'),
          OVERLAY=(167:C'**       '),HIT=NEXT),
        IFTHEN=(WHEN=(101,9,CH,EQ,C'**',AND,176,9,CH,NE,C'**'),
          OVERLAY=(167:C'*        '),HIT=NEXT),
        IFTHEN=(WHEN=(D_Q6,EQ,C'**',AND,176,9,CH,EQ,C'**'),
          OVERLAY=(46:C'**       ',167:C'**       '),HIT=NEXT),
        IFTHEN=(WHEN=(D_Q6,EQ,C'**',AND,176,9,CH,NE,C'**'),
          OVERLAY=(46:C'*        ',167:C'**       '),HIT=NEXT),
        IFTHEN=(WHEN=(D_Q5,EQ,C'**',AND,176,9,CH,EQ,C'**'),
          OVERLAY=(37:2C'**       ',167:C'**       '),HIT=NEXT),
        IFTHEN=(WHEN=(D_Q5,EQ,C'**',AND,176,9,CH,NE,C'**'),
          OVERLAY=(37:C'*        ',C'**       ',
                   167:C'**       '),HIT=NEXT),
        IFTHEN=(WHEN=(D_Q4,EQ,C'**',AND,176,9,CH,EQ,C'**'),
          OVERLAY=(28:3C'**       ',167:C'**       '),HIT=NEXT),
        IFTHEN=(WHEN=(D_Q4,EQ,C'**',AND,176,9,CH,NE,C'**'),
          OVERLAY=(28:C'*        ',2C'**       ',
                   167:C'**       '),HIT=NEXT),
        IFTHEN=(WHEN=(D_Q3,EQ,C'**',AND,176,9,CH,EQ,C'**'),
          OVERLAY=(19:4C'**       ',167:C'**       '),HIT=NEXT),
        IFTHEN=(WHEN=(D_Q3,EQ,C'**',AND,176,9,CH,NE,C'**'),
          OVERLAY=(19:C'*        ',3C'**       ',
                   167:C'**       '),HIT=NEXT),
        IFTHEN=(WHEN=(D_Q2,EQ,C'**',AND,176,9,CH,EQ,C'**'),
          OVERLAY=(10:5C'**       ',167:C'**       '),HIT=NEXT),
        IFTHEN=(WHEN=(D_Q2,EQ,C'**',AND,176,9,CH,NE,C'**'),
          OVERLAY=(10:C'*        ',4C'**       ',167:C'**       '))
* POWTORZONA MASKA LICZONA RAZ
  SORT FIELDS=(257,44,CH,A)
  SUM FIELDS=NONE
* OUTREC: GRANICE - MASKA BEZ '*' I '%' (DOLNA), DOPELNIONA 9 (GORNA);
* KONTROLA: '*' TYLKO NA KONCU (NIE A*C, *ABC);
* POLE Z '*' / '%': GORNA Z 9, PUSTA DOLNA -> '$'; DLUGOSC TYLKO '%'
  OUTREC IFTHEN=(WHEN=INIT,
          OVERLAY=(301:1,54,167,18,445:1,54,TRAN=ALTSEQ,
                   499:167,18,TRAN=ALTSEQ)),
        IFTHEN=(WHEN=INIT,
          FINDREP=(INOUT=(C'*',C' ',C'%',C' '),
                   STARTPOS=301,ENDPOS=372)),
        IFTHEN=(WHEN=INIT,
          OVERLAY=(373:301,72,
                   517:301,9,SQZ=(SHIFT=LEFT),
                   526:310,9,SQZ=(SHIFT=LEFT),
                   535:319,9,SQZ=(SHIFT=LEFT),
                   544:328,9,SQZ=(SHIFT=LEFT),
                   553:337,9,SQZ=(SHIFT=LEFT),
                   562:346,9,SQZ=(SHIFT=LEFT),
                   571:355,9,SQZ=(SHIFT=LEFT),
                   580:364,9,SQZ=(SHIFT=LEFT),
                   589:301,72)),
        IFTHEN=(WHEN=INIT,
          FINDREP=(IN=C' ',OUT=C'9',STARTPOS=589,ENDPOS=660)),
        IFTHEN=(WHEN=((D_Q1,SS,EQ,C'*',AND,301,9,CH,NE,517,9,CH),OR,
                      (D_Q2,SS,EQ,C'*',AND,310,9,CH,NE,526,9,CH),OR,
                      (D_Q3,SS,EQ,C'*',AND,319,9,CH,NE,535,9,CH),OR,
                      (D_Q4,SS,EQ,C'*',AND,328,9,CH,NE,544,9,CH),OR,
                      (D_Q5,SS,EQ,C'*',AND,337,9,CH,NE,553,9,CH),OR,
                      (D_Q6,SS,EQ,C'*',AND,346,9,CH,NE,562,9,CH),OR,
                      (167,9,SS,EQ,C'*',AND,355,9,CH,NE,571,9,CH),OR,
                      (176,9,SS,EQ,C'*',AND,364,9,CH,NE,580,9,CH)),
          OVERLAY=(62:C'N'),HIT=NEXT),
        IFTHEN=(WHEN=(D_Q1,SS,EQ,C'*',OR,D_Q1,SS,EQ,C'%'),
          OVERLAY=(373:589,9),HIT=NEXT),
        IFTHEN=(WHEN=(D_Q1,NE,C' ',AND,D_Q1,NE,C'**',AND,
                      301,9,CH,EQ,C' '),
          OVERLAY=(301:C'$'),HIT=NEXT),
        IFTHEN=(WHEN=(D_Q1,SS,NE,C'%'),OVERLAY=(445:9X),HIT=NEXT),
        IFTHEN=(WHEN=(D_Q2,SS,EQ,C'*',OR,D_Q2,SS,EQ,C'%'),
          OVERLAY=(382:598,9),HIT=NEXT),
        IFTHEN=(WHEN=(D_Q2,NE,C' ',AND,D_Q2,NE,C'**',AND,
                      310,9,CH,EQ,C' '),
          OVERLAY=(310:C'$'),HIT=NEXT),
        IFTHEN=(WHEN=(D_Q2,SS,NE,C'%'),OVERLAY=(454:9X),HIT=NEXT),
        IFTHEN=(WHEN=(D_Q3,SS,EQ,C'*',OR,D_Q3,SS,EQ,C'%'),
          OVERLAY=(391:607,9),HIT=NEXT),
        IFTHEN=(WHEN=(D_Q3,NE,C' ',AND,D_Q3,NE,C'**',AND,
                      319,9,CH,EQ,C' '),
          OVERLAY=(319:C'$'),HIT=NEXT),
        IFTHEN=(WHEN=(D_Q3,SS,NE,C'%'),OVERLAY=(463:9X),HIT=NEXT),
        IFTHEN=(WHEN=(D_Q4,SS,EQ,C'*',OR,D_Q4,SS,EQ,C'%'),
          OVERLAY=(400:616,9),HIT=NEXT),
        IFTHEN=(WHEN=(D_Q4,NE,C' ',AND,D_Q4,NE,C'**',AND,
                      328,9,CH,EQ,C' '),
          OVERLAY=(328:C'$'),HIT=NEXT),
        IFTHEN=(WHEN=(D_Q4,SS,NE,C'%'),OVERLAY=(472:9X),HIT=NEXT),
        IFTHEN=(WHEN=(D_Q5,SS,EQ,C'*',OR,D_Q5,SS,EQ,C'%'),
          OVERLAY=(409:625,9),HIT=NEXT),
        IFTHEN=(WHEN=(D_Q5,NE,C' ',AND,D_Q5,NE,C'**',AND,
                      337,9,CH,EQ,C' '),
          OVERLAY=(337:C'$'),HIT=NEXT),
        IFTHEN=(WHEN=(D_Q5,SS,NE,C'%'),OVERLAY=(481:9X),HIT=NEXT),
        IFTHEN=(WHEN=(D_Q6,SS,EQ,C'*',OR,D_Q6,SS,EQ,C'%'),
          OVERLAY=(418:634,9),HIT=NEXT),
        IFTHEN=(WHEN=(D_Q6,NE,C' ',AND,D_Q6,NE,C'**',AND,
                      346,9,CH,EQ,C' '),
          OVERLAY=(346:C'$'),HIT=NEXT),
        IFTHEN=(WHEN=(D_Q6,SS,NE,C'%'),OVERLAY=(490:9X),HIT=NEXT),
        IFTHEN=(WHEN=(167,9,SS,EQ,C'*',OR,167,9,SS,EQ,C'%'),
          OVERLAY=(427:643,9),HIT=NEXT),
        IFTHEN=(WHEN=(167,9,CH,NE,C' ',AND,167,9,CH,NE,C'**',AND,
                      355,9,CH,EQ,C' '),
          OVERLAY=(355:C'$'),HIT=NEXT),
        IFTHEN=(WHEN=(167,9,SS,NE,C'%'),OVERLAY=(499:9X),HIT=NEXT),
        IFTHEN=(WHEN=(176,9,SS,EQ,C'*',OR,176,9,SS,EQ,C'%'),
          OVERLAY=(436:652,9),HIT=NEXT),
        IFTHEN=(WHEN=(176,9,CH,NE,C' ',AND,176,9,CH,NE,C'**',AND,
                      364,9,CH,EQ,C' '),
          OVERLAY=(364:C'$'),HIT=NEXT),
        IFTHEN=(WHEN=(176,9,SS,NE,C'%'),OVERLAY=(508:9X))
  OUTFIL FNAMES=MSKS,BUILD=(1,516),
    INCLUDE=(D_VALID,EQ,C'Y',AND,D_Q1,SS,NE,C'*',AND,
             D_Q1,SS,NE,C'%')
  OUTFIL FNAMES=MSKW,BUILD=(1,516),
    INCLUDE=(D_VALID,EQ,C'Y',AND,
             (D_Q1,SS,EQ,C'*',OR,D_Q1,SS,EQ,C'%'))
  OUTFIL FNAMES=BADM,INCLUDE=(D_VALID,EQ,C'N'),BUILD=(257,44,36X)
* KAZDA POPRAWNA MASKA Z ZERAMI - BEZ TEGO ZNIKA, GDY NIC NIE PASUJE
  OUTFIL FNAMES=QX,INCLUDE=(D_VALID,EQ,C'Y'),
    BUILD=(257,44,16X,C'00',8X,ZD15_0,ZD15_0,ZD15_0,
           C'000',ZD15_0,ZD15_0)
/*
//*
//JNP1CNTL DD *
* MASKI Z LITERALNYM PIERWSZYM KWALIFIKATOREM (KLUCZ)
  JOINKEYS F1=DSNL,FIELDS=(1,9,A)
  JOINKEYS F2=MSKS,FIELDS=(1,9,A)
//         DD DSN=&&JNPC,DISP=(OLD,PASS)
//JNP2CNTL DD *
* WIELOZNACZNIK W PIERWSZYM KWALIFIKATORZE: KAZDY ZBIOR Z KAZDA MASKA
* (KLUCZ STALY: KOL. 55 JEST PUSTA W DSNL I W MSKW)
  JOINKEYS F1=DSNL,FIELDS=(55,1,A),SORTED,NOSEQCK
  JOINKEYS F2=MSKW,FIELDS=(55,1,A),SORTED,NOSEQCK
//         DD DSN=&&JNPC,DISP=(OLD,PASS)
//QSM1CNTL DD *
* SUMY WG MASKI; KB -> MB PO ZSUMOWANIU
  SORT FIELDS=(Q_MASK,A)
  SUM FIELDS=(Q_SMALL,Q_LARGE,Q_TOTAL,119,15,ZD,134,15,ZD)
  OUTREC IFTHEN=(WHEN=INIT,
          OVERLAY=(119:(119,15,ZD,ADD,+512),DIV,+1024,
                       TO=ZD,LENGTH=15,
                   134:(134,15,ZD,ADD,+512),DIV,+1024,
                       TO=ZD,LENGTH=15)),
        IFTHEN=(WHEN=(Q_SMALL,GT,+0,OR,Q_LARGE,GT,+0),
          OVERLAY=(116:(Q_SMALL,MUL,+100),DIV,
                       (Q_SMALL,ADD,Q_LARGE),TO=ZD,LENGTH=3))
  OUTFIL FNAMES=QSUM
/*
//QSR1CNTL DD *
* NAJWIECEJ MALYCH ZBIOROW NA GORZE
  SORT FIELDS=(Q_SMALL,D,Q_MASK,A)
/*
