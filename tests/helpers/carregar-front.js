'use strict';
/**
 * Monta o front completo (index.html + includes) dentro de um jsdom, do mesmo jeito
 * que o Apps Script faz em runtime, mas com tudo que é externo simulado:
 *  - google.script.run  -> mock encadeável (ver mock-google.js)
 *  - relógio            -> congelado e controlável (Date, setTimeout, clearTimeout)
 *  - confirm/prompt/dialog/createObjectURL -> stubs
 *
 * Uso:
 *   const app = await carregarFront({ boot: false });
 *   app.run('parseBR("1,5")');          // avalia no escopo global da página (enxerga let/const)
 *   app.set('S', objeto);               // atribui a uma variável global (let/const reatribuível)
 */
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { criarMockGoogle } = require('./mock-google');
const { dadosVazios } = require('./fixtures');

const RAIZ = path.resolve(__dirname, '..', '..');
const ler = (n) => fs.readFileSync(path.join(RAIZ, n + '.html'), 'utf8');

/** index.html com os <?!= include('x') ?> resolvidos e sem recursos de rede */
function montarHtml({ boot, html }) {
  let h = html || ler('index').replace(/<\?!= include\('([^']+)'\) \?>/g, (_, n) => ler(n));
  h = h
    .replace('<base target="_top">', '')
    .replace(/<link[^>]*fonts\.g[^>]*>/g, '')
    .replace(/<script src="https:[^>]*><\/script>/g, '')
    .replace(/<script src="vendor\/[^>]*><\/script>/g, '')
    .replace(/<link rel="stylesheet" href="vendor\/[^>]*>/g, '');
  if (!boot) h = h.replace(/<script>\s*migrate\(\);\s*boot\(\);\s*<\/script>/, '');
  return h;
}

/** Ordem em que os arquivos são incluídos (contrato implícito do projeto) */
function ordemDosIncludes() {
  const src = fs.readFileSync(path.join(RAIZ, 'index.html'), 'utf8');
  return [...src.matchAll(/<\?!= include\('([^']+)'\) \?>/g)].map((m) => m[1]);
}

function criarRelogio(window, inicio) {
  const base = new Date(inicio).getTime();
  let t = 0, seq = 0;
  const fila = new Map();
  const RealDate = window.Date;
  class DataFixa extends RealDate {
    constructor(...a) { if (a.length === 0) super(base + t); else super(...a); }
    static now() { return base + t; }
  }
  window.Date = DataFixa;
  window.setTimeout = (fn, ms = 0) => { const id = ++seq; fila.set(id, { fn, at: t + Math.max(0, ms) }); return id; };
  window.clearTimeout = (id) => { fila.delete(id); };
  return {
    /** avança o relógio e dispara os timers vencidos, em ordem */
    avancar(ms) {
      const alvo = t + ms;
      for (;;) {
        const prox = [...fila.entries()].filter(([, v]) => v.at <= alvo).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!prox) break;
        fila.delete(prox[0]); t = Math.max(t, prox[1].at); prox[1].fn();
      }
      t = alvo;
    },
    pendentes: () => fila.size,
  };
}

/** deixa as microtarefas/promises (rpc, filas) terminarem */
const drenar = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

async function carregarFront(opts = {}) {
  /* html: página já montada (ex.: edição desktop, desktop/build.js) no lugar do index.html da web */
  const { boot = false, agora = '2026-06-15T12:00:00', dados, handlers = {}, largura = 1280, html } = opts;
  const erros = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => erros.push(e));
  vc.on('error', (...a) => erros.push(a.join(' ')));

  const mock = criarMockGoogle({ getData: () => dados || dadosVazios(), ...handlers });
  let relogio;

  const dom = new JSDOM(montarHtml({ boot, html }), {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      relogio = criarRelogio(window, agora);
      Object.defineProperty(window, 'innerWidth', { value: largura, configurable: true });
      window.google = { script: { run: mock.run } };
      window.confirm = () => true;
      window.prompt = () => null;
      window.scrollTo = () => {};
      window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
      window.HTMLElement.prototype.scrollIntoView = function () {};
      window.URL.createObjectURL = () => 'blob:teste';
      window.URL.revokeObjectURL = () => {};
      const D = window.HTMLDialogElement && window.HTMLDialogElement.prototype;
      if (D) {
        D.showModal = function () { this.setAttribute('open', ''); };
        D.show = D.showModal;
        D.close = function () { this.removeAttribute('open'); };
      }
      if (opts.antes) opts.antes(window);
    },
  });

  const { window } = dom;
  const app = {
    window,
    document: window.document,
    mock,
    relogio,
    erros,
    drenar,
    /** avalia código no escopo global da página (enxerga const/let de topo).
     *  Objetos/arrays voltam como cópia JSON (o jsdom tem outro "realm" e deepEqual falharia). */
    run(codigo) {
      const r = window.eval(codigo);
      if (r === null || typeof r !== 'object') return r;
      try { return JSON.parse(JSON.stringify(r)); } catch { return r; }
    },
    /** igual a run(), sem converter o resultado (elementos DOM, funções) */
    bruto: (codigo) => window.eval(codigo),
    /** atribui um valor (JSON-serializável ou função via `fn`) a uma variável global */
    set(nome, valor) { window.__v = valor; window.eval(`${nome} = window.__v; delete window.__v;`); },
    /** estado do ano corrente zerado e consistente (S, DB, Y) */
    setEstado(estado, ano = 2026) {
      window.__v = JSON.parse(JSON.stringify(estado));
      window.eval(`Y = ${ano}; S = window.__v; delete window.__v; DB = { v: 2, cur: Y, years: { [Y]: S } }; curM = curMonth(); migrate();`);
    },
    clicar(seletor) {
      const el = window.document.querySelector(seletor);
      if (!el) throw new Error('elemento não encontrado: ' + seletor);
      el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
      return el;
    },
    fechar: () => window.close(),
  };
  if (boot) await drenar();
  return app;
}

module.exports = { carregarFront, montarHtml, ordemDosIncludes, drenar, RAIZ };
