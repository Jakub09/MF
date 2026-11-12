/* REXX */
/*-------------------------------------------------------------------*/
/* TMPLGEN - prosty silnik szablonow (JCL, kroki, komendy)           */
/*                                                                   */
/* DD:                                                               */
/*   LISTIN   - dane, jeden rekord = jedna linia, kolumny = slowa    */
/*              (puste linie i '*' w kolumnie 1 sa pomijane)         */
/*   VARDEF   - nazwy kolumn LISTIN, np.  VOLSER UNIT                */
/*              (ostatnia zmienna dostaje reszte linii)              */
/*   TMPLTIN  - szablon; zmienne jako {NAZWA} lub {NAZWA:mod}        */
/*              (JCL w szablonie: uzyj DD DATA,DLM=@@)                */
/*   CMDIN    - polecenia (kolumny 1-72, '*' w kol.1 = komentarz)    */
/*   GENOUT   - wynik (domyslnie), np. SYSOUT=* lub SYSOUT=(A,INTRDR)*/
/*              albo PDS bez membra: 1 job = 1 member (nazwa joba)   */
/*   SYSTSPRT - log                                                  */
/*                                                                   */
/* Polecenia CMDIN (parametry mozna podac tez w nawiasie verbu,      */
/* np. RANGE(LISTIN, VAR(X) MAX(10)) == RANGE(LISTIN) VAR(X) MAX(10))*/
/*                                                                   */
/*   SET  nazwa(wartosc) ...      - zmienne globalne                 */
/*   LOAD(dd) VARS(a b c)         - wczytaj dane (domyslnie VARDEF)  */
/*   RANGE(dd) VAR(v) PREFIX('p') SUFFIX('s') DIGITS(n) MAX(n)       */
/*        NOGAPS|GAPS TYPE(X|N) BASE(10|16|36|AUTO) INTO(nazwa)      */
/*        TYPE(X) zakresy hex (jak TYPE w ISMF), TYPE(N) dziesietne  */
/*        - zwija wartosci zmiennej v w zakresy. Nowa tabela ma      */
/*          zmienne: RNGPREF RNGSTART RNGEND RNGSUFF RNGCOUNT        */
/*          RNGFIRST RNGLAST RNGTYPE (X dla hex, puste dla innych)   */
/*          + kolumny pierwszego rekordu zakresu                     */
/*   SUBSTITUTE(tmpldd) MODE(COMMAND|STEP|JOB) DATA(tab)             */
/*        OUTPUT(dd) HEADER(dd) TRAILER(dd) DELIM('{}')              */
/*        MAXSTEPS(n) NORENAME - tylko STEP: max krokow w jobie      */
/*          (1-255, domyslnie 255), po przekroczeniu nowy job        */
/*          (TRAILER + HEADER)                                       */
/*        MAXCMD(n)           - tylko COMMAND: max rekordow w bloku, */
/*          po przekroczeniu TRAILER + HEADER (nowy blok)            */
/*   STEP / JOB / COMMAND (tmpldd) ... - skrot SUBSTITUTE MODE(x)    */
/*        tmpldd = dowolny DD z szablonem (domyslnie TMPLTIN), wiec   */
/*        mozna miec kilka: STEP(TMPLTIN1), COMMAND(TMPLTIN2) ...    */
/*        Dane: domyslnie biezaca tabela (po RANGE = zakresy),       */
/*        DATA(LISTIN) wraca do danych z LISTIN. VARDEF jest wspolny.*/
/*   LIST(tab)                    - wypisz tabele do logu            */
/*   OUTPUT(dd) SPLIT(JOB) | MEMBER(nazwa) - zapis do PDS            */
/*        SPLIT(JOB) - kazdy job do osobnego membra (domyslne, gdy   */
/*        DSORG=PO), MEMBER(x) - wszystko do jednego membra x.       */
/*        PDS musi byc skatalogowany. Gdy DSORG nieznany (brak       */
/*        DSORG= na DD), podaj DSORG=PO/PS albo OUTPUT(...).         */
/*   TRACE(x) lub TRACE x         - REXX TRACE od nastepnego polec.  */
/*        x = N (normal), O (off), R (results), I, A, C, E, F, L     */
/*                                                                   */
/* Zmienne wbudowane: _SEQ _COUNT _JOBSEQ _DATE _TIME                */
/*   (_JOBSEQ = numer joba w STEP/JOB, numer bloku w COMMAND)        */
/* Modyfikatory: {X:U} duze, {X:L} male, {X:5} dopelnij do 5 znakow  */
/*   (liczby zerami z lewej, tekst spacjami z prawej). {{ = '{'      */
/*                                                                   */
/* Uruchomienie: EXEC PGM=IRXJCL,PARM='TMPLGEN' (lub IKJEFT01)      */
/*   PARM='TMPLGEN TRACE(R)' - REXX TRACE dla calego przebiegu       */
/*   (wynik TRACE idzie do SYSTSPRT)                                 */
/* RC: 0 OK, 4 ostrzezenia, 8 bledy, 12 blad krytyczny (I/O, REXX)  */
/*   Przy RC>=8 wyniki (GENOUT itd.) NIE sa zapisywane.              */
/*                                                                   */
/* Budowa: TGMAIN (ten member, zawsze pierwszy) + moduly TG*:        */
/*   jcl/BLDIT1..3 - buildy iteracyjne TGIT1..3 + testy jednostkowe  */
/*   jcl/BUILD     - pelny build TMPLGEN + testy jednostkowe         */
/*   jcl/TSTIT1..4 - przykladowe testy integracyjne                  */
/* Zmienne globalne: opis w TGHELP.                                  */
/*-------------------------------------------------------------------*/
parse arg parm
signal on syntax name tgFatal
signal on novalue name tgFatal
call tgInit
call msg 'I', 'TMPLGEN start' date() time() '- exec' g.pgm
if strip(parm) <> '' then call parseParm parm
trace value g.trace
call readCommands
do si = 1 to cmd.0
  if g.maxrc >= 12 then leave
  call msg 'I', '>>' cmd.si
  call execStatement cmd.si
end
if g.maxrc < 8 then call writeOutputs
else if g.outs <> '' then
  call msg 'E', 'Errors found - outputs NOT written:' space(g.outs)
call msg 'I', 'TMPLGEN end, MAXRC='g.maxrc
exit g.maxrc
