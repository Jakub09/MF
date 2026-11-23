#!/usr/bin/env node
/**
 * Szukanie masek wg kryteriow (src/auto.ts) jako jeden plik JS bez zaleznosci: acs-masks-auto.cjs.
 * Do uruchomienia wystarczy Node.js >= 18.3 (bez npm i bez node_modules).
 *
 *   node tools/standalone.mjs [plik-wynikowy]
 *
 * Plik jest generowany z src/ (komentarze zostaja) - nie edytowac recznie. Potrzebny TypeScript z devDependencies.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function buildStandalone() {
    const parts = [];
    const seen = new Set();
    const add = name => {
        if (seen.has(name)) return;
        seen.add(name);
        const src = fs.readFileSync(path.join(ROOT, 'src', `${name}.ts`), 'utf-8').replace(/^#!.*\n/, '');
        const { outputText } = ts.transpileModule(src, {
            compilerOptions: {
                target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
            },
        });
        const deps = [];
        const code = outputText.replace(/require\("([^"]+)"\)/g, (m, spec) => {
            if (spec.startsWith('node:')) return m;
            if (!spec.startsWith('./')) throw new Error(`${name}.ts: zaleznosc spoza projektu "${spec}"`);
            deps.push(spec.slice(2));
            return m;
        });
        deps.forEach(add);
        parts.push(`// ${'='.repeat(20)} src/${name}.ts\n`
            + `MODULES["./${name}"] = function (exports, require, module) {\n${code.trimEnd()}\n};\n`);
    };
    add('auto');
    return [
        '#!/usr/bin/env node',
        '// Szukanie masek DSN wg kryteriow z CSV DCOLLECT (job ACMCSV). Jeden plik, bez npm; Node.js >= 18.3.',
        '// WYGENEROWANE z src/ przez tools/standalone.mjs - nie edytowac recznie.',
        '//   node acs-masks-auto.cjs DCOLLECT.CSV [opcje] - opis opcji: --help',
        'const MODULES = {};',
        'const LOADED = {};',
        'function load(name) {',
        '    if (!MODULES[name]) return require(name);',
        '    if (!LOADED[name]) {',
        '        LOADED[name] = {};',
        '        MODULES[name](LOADED[name], load, module);',
        '    }',
        '    return LOADED[name];',
        '}',
        'load.main = require.main;',
        '',
        ...parts,
        'module.exports = load("./auto");',
        '',
    ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const out = path.resolve(process.argv[2] ?? path.join(ROOT, 'acs-masks-auto.cjs'));
    fs.writeFileSync(out, buildStandalone());
    console.log(`Zapisano: ${out} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
}
