'use strict';
/* Edição desktop: página gerada por desktop/build.js rodando no jsdom, falando com o banco SQLite (desktop/db.js)
   pelo mesmo caminho do app real (shim de google.script.run -> window.desktop.rpc, que no Electron é o preload) */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { carregarFront } = require('./helpers/carregar-front');
const { montarHtmlDesktop, verificar } = require('../desktop/build');
const { abrir } = require('../desktop/db');
const { gerarEsquema } = require('../desktop/esquema');

const html = montarHtmlDesktop();
const esquema = gerarEsquema();
const J = (v) => JSON.parse(JSON.stringify(v));

/* sobe o app desktop sobre um banco (o mesmo banco pode ser reaberto por outra "janela") */
async function subir(banco) {
  const app = await carregarFront({
    html, boot: true, agora: '2026-06-15T12:00:00',
    antes(w) { w.desktop = { rpc: async (fn, args) => J(banco[fn](...J(args))) }; },
  });
  await app.drenar(20);
  return app;
}
/* deixa o save() (debounce de 700 ms) gravar no banco */
async function gravar(app) { app.relogio.avancar(1000); await app.drenar(20); }

describe('edição desktop', () => {
  let banco, app;
  before(async () => { banco = abrir(':memory:', esquema); app = await subir(banco); });
  after(() => app.fechar());

  test('DSK-01 a página funciona offline e não aponta para planilhas do Google', () => {
    assert.deepEqual(verificar(html), []);
    assert.ok(!/fonts\.googleapis|cdnjs\.cloudflare\.com\/ajax\/libs\/xlsx/.test(html), 'sem CDN: o app funciona offline');
    assert.equal(app.run('EDICAO'), 'desktop');
  });

  test('DSK-02 boot no banco vazio cria o ano corrente sem nenhum valor preenchido', () => {
    assert.equal(app.run('Y'), 2026);
    assert.deepEqual(app.run('Object.values(S.vals).flat().filter(v => v != null && v !== "")'), []);
    assert.deepEqual(app.run('S.tx.length + S.outx.length + S.outex.length'), 0);
    assert.deepEqual(app.erros, []);
  });

  test('DSK-03 Mês a mês: entradas e saídas base pedidas', () => {
    assert.deepEqual(app.run('T.ent.rows.filter(r => r.k === "in").map(r => r.l)'), ['Salário pessoa 1', '13º pessoa 1', 'Férias pessoa 1', 'Outros']);
    assert.deepEqual(app.run('T.sai.rows.filter(r => r.k === "in").map(r => r.l)'), ['Cartão de crédito', 'Financiamento', 'Luz', 'Internet', 'Plano de saúde']);
    assert.ok(!app.run('T.ent.rows.some(r => r.id === "totEV")'), '"Total + vale" some sem linhas de VR');
    assert.deepEqual(app.run('S.cards'), ['itau']);
  });

  test('DSK-04 Reservas: Poupança banco 1; Bitcoin oculto (módulo e linha); FGTS: Pessoa 1', () => {
    assert.deepEqual(app.run('T.res.rows.map(r => r.l)'), ['Poupança banco 1', 'Total']);
    assert.equal(app.run('S.mods.btc.hidden'), true);
    assert.deepEqual(app.run('T.pes.rows.map(r => r.l)'), ['Pessoa 1', 'Saldo atual']);
    app.clicar('[data-act="tab"][data-t="pat"]');
    const pat = app.document.querySelector('#view-pat').innerHTML;
    assert.ok(pat.includes('Poupança banco 1') && pat.includes('Pessoa 1'));
    assert.ok(!pat.includes('Rendimento (%)') && !pat.includes('Bitcoin (saldo atual)'), 'Bitcoin não aparece');
    assert.ok(pat.includes('Pessoa 2'), 'FGTS e reservas extras continuam restauráveis');
  });

  test('DSK-09 Mês a mês não lista as linhas base fora da estrutura inicial como "Linhas excluídas"', () => {
    app.clicar('[data-act="tab"][data-t="mes"]');
    const mes = app.document.querySelector('#view-mes') || app.document.body;
    assert.ok(!mes.innerHTML.includes('Linhas excluídas'));
    app.run('S.del.push("luz"); applyCustom(); render()');
    assert.ok(mes.innerHTML.includes('Linhas excluídas') && mes.innerHTML.includes('↺ Luz'), 'linha base excluída pelo usuário continua restaurável');
    app.run('S.del = S.del.filter(i => i !== "luz"); applyCustom(); render()');
  });

  test('DSK-05 reativar o Bitcoin pelo lápis traz o módulo e a linha nas reservas', () => {
    const chk = app.bruto('(() => { const d = document.createElement("div"); d.innerHTML = modsHTML(); document.body.appendChild(d); return d.querySelector("[data-mv=btc]") })()');
    chk.checked = true;
    chk.dispatchEvent(new app.window.Event('change', { bubbles: true }));
    assert.equal(app.run('S.mods.btc.hidden'), false);
    assert.ok(app.run('RES.includes("btc") && T.res.rows.some(r => r.id === "btc")'));
    chk.checked = false;
    chk.dispatchEvent(new app.window.Event('change', { bubbles: true }));
    assert.ok(!app.run('RES.includes("btc")'));
  });

  test('DSK-06 Metas a comprar vazias; categorias sem "Trabalho (doula)"; todas as regras de normalização', () => {
    assert.deepEqual(app.run('S.pend'), []);
    const cats = app.run('[...ALLCATS, ...EXTRA]');
    assert.ok(!cats.includes('Trabalho (doula)'));
    assert.ok(!cats.some((c) => /Ita[uú]|Nubank/.test(c)));
    assert.equal(app.run('NORM.length'), esquema.normalizacoes.length);
  });

  test('DSK-07 o que é salvo vai para o banco e volta igual ao reabrir o app', async () => {
    await gravar(app);
    app.run('S.vals.sg[0] = 1234.5; S.vals.luz[2] = "=100+20"; S.pend.push({ id: "p1", n: "Geladeira", v: 3000, o: "", ok: false }); save()');
    await gravar(app);
    const d = banco.getData();
    assert.deepEqual(d.anos, [2026]);
    assert.ok(d.linhasAno.some((r) => r.id_linha === 'sn' && r.excluida), 'linhas fora da estrutura base ficam excluídas no banco');
    const outro = await subir(banco);
    try {
      assert.equal(outro.run('S.vals.sg[0]'), 1234.5);
      assert.equal(outro.run('S.vals.luz[2]'), '=100+20');
      assert.equal(outro.run('S.pend[0].n'), 'Geladeira');
      assert.deepEqual(outro.run('T.ent.rows.filter(r => r.k === "in").map(r => r.l)'), ['Salário pessoa 1', '13º pessoa 1', 'Férias pessoa 1', 'Outros']);
      assert.equal(outro.run('S.mods.btc.hidden'), true);
    } finally { outro.fechar(); }
  });

  test('DSK-08 status e textos falam do computador, não da planilha', () => {
    assert.match(app.document.querySelector('#saved').textContent, /^Salvo às /);
    assert.ok(!/planilha/i.test(app.document.body.innerHTML.replace(/<script[\s\S]*?<\/script>/g, '')), 'nenhum texto visível menciona planilha');
  });
});
