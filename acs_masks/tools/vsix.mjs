#!/usr/bin/env node
/**
 * Pakuje rozszerzenie VS Code z katalogu vscode/ do pliku .vsix (zip) - bez pakietu @vscode/vsce,
 * tylko moduly wbudowane Node (zlib). Najpierw: npm run vscode:build (tsc -> vscode/out).
 *
 *   node tools/vsix.mjs [plik.vsix]        domyslnie vscode/acs-routines-<wersja>.vsix
 *
 * Instalacja: code --install-extension vscode/acs-routines-<wersja>.vsix
 * Kody wyjscia: 0 - OK, 1 - brak skompilowanego rozszerzenia albo blad zapisu.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'vscode');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
const main = path.join(root, pkg.main);
if (!fs.existsSync(main)) {
    process.stderr.write(`Brak ${main} - uruchom najpierw: npm run vscode:build\n`);
    process.exit(1);
}

/** Pliki rozszerzenia: manifest, konfiguracja jezyka, gramatyka, skompilowany kod. */
function collect(dir, rel = '') {
    const out = [];
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const r = path.posix.join(rel, e.name);
        if (e.isDirectory()) out.push(...collect(dir, r));
        else out.push(r);
    }
    return out;
}
const files = ['package.json', 'language-configuration.json', ...collect(root, 'syntaxes'), ...collect(root, 'out').filter(f => f.endsWith('.js'))];
if (fs.existsSync(path.join(root, 'README.md'))) files.push('README.md');

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${esc(pkg.name)}" Version="${esc(pkg.version)}" Publisher="${esc(pkg.publisher)}"/>
    <DisplayName>${esc(pkg.displayName)}</DisplayName>
    <Description xml:space="preserve">${esc(pkg.description)}</Description>
    <Tags>acs,dfsms,zos,mainframe</Tags>
    <Categories>${esc(pkg.categories.join(','))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${esc(pkg.engines.vscode)}"/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value=""/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value=""/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/>
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value=""/>
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
  </Assets>
</PackageManifest>
`;
const contentTypes = '<?xml version="1.0" encoding="utf-8"?>\n'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension=".json" ContentType="application/json"/>'
    + '<Default Extension=".js" ContentType="application/javascript"/>'
    + '<Default Extension=".md" ContentType="text/markdown"/>'
    + '<Default Extension=".vsixmanifest" ContentType="text/xml"/>'
    + '</Types>\n';

const entries = [
    ['extension.vsixmanifest', Buffer.from(manifest)],
    ['[Content_Types].xml', Buffer.from(contentTypes)],
    ...files.map(f => [`extension/${f}`, fs.readFileSync(path.join(root, f))]),
];

// --- zip (deflate), stala data - ten sam wynik dla tych samych plikow
const DOS_TIME = 0;
const DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1;
const local = [];
const central = [];
let offset = 0;
for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, 'utf-8');
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const crc = zlib.crc32(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x0800, 6);
    h.writeUInt16LE(8, 8);
    h.writeUInt16LE(DOS_TIME, 10);
    h.writeUInt16LE(DOS_DATE, 12);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(comp.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(nameBuf.length, 26);
    local.push(h, nameBuf, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt16LE(DOS_TIME, 12);
    c.writeUInt16LE(DOS_DATE, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
}
const cd = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(cd.length, 12);
end.writeUInt32LE(offset, 16);

const target = process.argv[2] ?? path.join(root, `${pkg.name}-${pkg.version}.vsix`);
fs.writeFileSync(target, Buffer.concat([...local, cd, end]));
process.stdout.write(`Zapisano ${target}: ${entries.length} plikow, ${Math.round(fs.statSync(target).size / 1024)} KB\n`);
process.stdout.write(`Instalacja: code --install-extension ${target}\n`);
