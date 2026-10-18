'use strict';
/**
 * Monta desktop/app/ (o que vai dentro do instalador):
 *   index.html   — index.html da raiz com os include() resolvidos, CDNs trocados por arquivos locais
 *                  (funciona offline) e o shim de google.script.run que fala com o banco local
 *   esquema.json — tabelas e seeds do banco
 *   vendor/      — xlsx, pdf.js e fontes copiados de node_modules
 * Uso: node desktop/build.js
 */
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.resolve(__dirname, '..');
const APP = path.join(__dirname, 'app');
const NM = path.join(RAIZ, 'node_modules');

const FONTES = [
  ['Bricolage Grotesque', 'bricolage-grotesque', [500, 700, 800]],
  ['IBM Plex Sans', 'ibm-plex-sans', [400, 500, 600]],
];

/* google.script.run da edição desktop: mesma API encadeável, chamando o processo principal (preload.js) */
const SHIM = `<script>
    window.PDFJS_BASE = 'vendor/pdfjs/';
    window.google = { script: { run: (function mk(ok, ko) {
      return new Proxy({}, { get: (_, k) => k === 'withSuccessHandler' ? f => mk(f, ko) : k === 'withFailureHandler' ? f => mk(ok, f)
        : (...a) => { window.desktop.rpc(String(k), a).then(r => ok && ok(r), e => ko && ko(new Error(String(e && e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')))) } })
    })() } };
  </script>`;

const ler = (n) => fs.readFileSync(path.join(RAIZ, n + '.html'), 'utf8');

/** HTML do app (sem copiar arquivos); usado pelo build e pelos testes */
function montarHtmlDesktop() {
  let h = ler('index').replace(/<\?!= include\('([^']+)'\) \?>/g, (_, n) => ler(n));
  const troca = (de, para) => {
    if (!h.includes(de)) throw new Error('build desktop: trecho não encontrado: ' + de.slice(0, 80));
    h = h.split(de).join(para);
  };
  h = h.replace(/<base target="_top">\r?\n/, '');
  h = h.replace(/\s*<link rel="preconnect"[^>]*>\s*<link href="https:\/\/fonts\.googleapis\.com[^>]*>/, '\n  <link rel="stylesheet" href="vendor/fontes.css">');
  troca('<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>', '<script src="vendor/xlsx.full.min.js"></script>');
  troca('<body>', '<body>\n  ' + SHIM);
  return h;
}

/** o app não pode depender de rede nem apontar para planilhas do Google */
function verificar(h) {
  return [/fonts\.googleapis\.com/, /cdnjs\.cloudflare\.com\/ajax\/libs\/xlsx/, /docs\.google\.com\/spreadsheets/, /SpreadsheetApp/]
    .filter((re) => re.test(h)).map(String);
}

function copiar(de, para) { fs.mkdirSync(path.dirname(para), { recursive: true }); fs.copyFileSync(de, para); }

function build() {
  fs.rmSync(APP, { recursive: true, force: true });
  fs.mkdirSync(APP, { recursive: true });
  const h = montarHtmlDesktop();
  const ruins = verificar(h);
  if (ruins.length) throw new Error('build desktop: ' + ruins.join(', '));
  fs.writeFileSync(path.join(APP, 'index.html'), h);
  copiar(path.join(__dirname, 'esquema.json'), path.join(APP, 'esquema.json'));
  copiar(path.join(NM, 'xlsx/dist/xlsx.full.min.js'), path.join(APP, 'vendor/xlsx.full.min.js'));
  ['pdf.min.js', 'pdf.worker.min.js'].forEach((f) => copiar(path.join(NM, 'pdfjs-dist/build', f), path.join(APP, 'vendor/pdfjs', f)));
  const css = [];
  FONTES.forEach(([familia, pacote, pesos]) => pesos.forEach((p) => {
    const arq = `${pacote}-latin-${p}-normal.woff2`;
    copiar(path.join(NM, '@fontsource', pacote, 'files', arq), path.join(APP, 'vendor/fontes', arq));
    css.push(`@font-face{font-family:'${familia}';font-style:normal;font-display:swap;font-weight:${p};src:url(fontes/${arq}) format('woff2')}`);
  }));
  fs.writeFileSync(path.join(APP, 'vendor/fontes.css'), css.join('\n') + '\n');
  console.log('desktop/app pronto (' + Math.round(h.length / 1024) + ' KB de HTML)');
}

if (require.main === module) build();

module.exports = { montarHtmlDesktop, verificar, build };
