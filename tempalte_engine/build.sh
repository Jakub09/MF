#!/bin/sh
# Lokalny odpowiednik jcl/BUILD.jcl (bez testow): skleja TGMAIN + moduly
# z kroku BODY w jeden plik TMPLGEN.rexx - do wgrania jako jeden member.
# Kolejnosc modulow czytana z jcl/BUILD.jcl (jedno zrodlo prawdy).
cd "$(dirname "$0")" || exit 1
jcl=jcl/BUILD.jcl
mods=$(sed -n 's/.*DSN=&SRCLIB(\([A-Z0-9#@$]*\)).*/\1/p' "$jcl" | grep -v '^TGMAIN$')
[ -n "$mods" ] || { echo "brak modulow w $jcl" >&2; exit 1; }
out=TMPLGEN.rexx
: > "$out"
for m in TGMAIN $mods; do
  [ -f "src/$m.rexx" ] || { echo "brak src/$m.rexx" >&2; exit 1; }
  cat "src/$m.rexx" >> "$out"
done
bad=$(awk 'length($0)>72 {print FILENAME":"FNR}' src/*.rexx test/*.rexx)
[ -z "$bad" ] || { echo "linie dluzsze niz 72 kolumny:"; echo "$bad"; exit 4; }
echo "zbudowano $out z: TGMAIN $(echo $mods) ($(wc -l < "$out") linii)"
