'use strict';
/* Edição desktop: banco SQLite (desktop/db.js) com o mesmo contrato de getData/applyChanges/saveNormalizacoes do Apps Script */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { abrir } = require('../desktop/db');
const { gerarEsquema } = require('../desktop/esquema');

const esquema = gerarEsquema();
const novo = () => abrir(':memory:', esquema);

describe('desktop/db: banco local SQLite', () => {
  test('DDB-01 banco novo: sem anos nem valores, só categorias e regras iniciais', () => {
    const d = novo().getData();
    ['anos', 'linhasAno', 'valores', 'lancamentos', 'pendencias', 'notas'].forEach((k) => assert.deepEqual(d[k], [], k));
    assert.ok(d.categorias.length > 10);
  });

  test('DDB-02 categorias: sem "Trabalho (doula)" e com um único cartão de sistema genérico', () => {
    const nomes = novo().getData().categorias.map((c) => c.nome);
    assert.ok(!nomes.includes('Trabalho (doula)'));
    assert.ok(!nomes.some((n) => /Ita[uú]|Nubank/.test(n)), nomes.join(', '));
    assert.ok(nomes.includes('Cartão de crédito (sem detalhe)'));
    ['Supermercado', 'Ecommerce', 'Moradia', 'Outros', 'Impostos e taxas', 'Saúde', 'Serviços'].forEach((n) => assert.ok(nomes.includes(n), n));
  });

  test('DDB-03 normalização: todas as regras iniciais, com categoria', () => {
    const web = esquema.normalizacoes;
    assert.equal(web.length, 20);
    const n = novo().getData().normalizacoes;
    assert.equal(n.length, web.length);
    web.forEach((s, i) => assert.deepEqual([n[i].tipo, n[i].padrao, n[i].nome, n[i].categoria], s));
  });

  test('DDB-04 roundtrip applyChanges -> getData preserva tipos (número, fórmula, booleano, vazio)', () => {
    const b = novo();
    b.applyChanges({ add: [2026], up: {
      Valores: [{ ano: 2026, id_linha: 'sg', mes: 1, valor: 10, formula: '=5+5', pago: true, comentario: 'oi' },
                { ano: 2026, id_linha: 'luz', mes: 2, valor: null, formula: '', pago: false, comentario: '' }],
      LinhasAno: [{ ano: 2026, id_linha: 'mod_btc', tipo: 'modulo', nome: '', categoria: '#123456', personalizada: false, excluida: true },
                  { ano: 2026, id_linha: 'x1', tipo: 'sai', nome: 'Academia', categoria: 'Atividade Física', personalizada: true, excluida: false }],
      LancamentosCartao: [{ ano: 2026, id_lancamento: 't1', mes: 1, descricao: 'Loja', data: '01/01', categoria: 'Categoria nova', valor: 3.5, id_linha: 'itau' }],
      Pendencias: [{ ano: 2026, id_pendencia: 'p1', descricao: 'Sofá', valor: '', observacao: '', pago: false }],
    } });
    const d = b.getData();
    assert.deepEqual(d.anos, [2026]);
    assert.deepEqual(d.valores, [
      { ano: 2026, id_linha: 'sg', mes: 1, valor: 10, formula: '=5+5', pago: true, comentario: 'oi' },
      { ano: 2026, id_linha: 'luz', mes: 2, valor: '', formula: '', pago: false, comentario: '' }]);
    assert.equal(d.linhasAno[0].categoria, '#123456');
    assert.equal(d.linhasAno[0].excluida, true);
    assert.equal(d.linhasAno[1].categoria, 'Atividade Física');
    assert.equal(d.lancamentos[0].categoria, 'Categoria nova');
    assert.ok(d.categorias.some((c) => c.nome === 'Categoria nova' && c.grupo === 'cartao'));
    assert.deepEqual(d.pendencias, [{ ano: 2026, id_pendencia: 'p1', descricao: 'Sofá', valor: '', observacao: '', pago: false }]);
  });

  test('DDB-05 atualiza pela chave sem duplicar e mantém a ordem; chave "2026" == 2026', () => {
    const b = novo();
    const v = (id, valor) => ({ ano: 2026, id_linha: id, mes: 1, valor, formula: '', pago: '', comentario: '' });
    b.applyChanges({ add: [2026], up: { Valores: [v('a', 1), v('b', 2)] } });
    b.applyChanges({ up: { Valores: [{ ...v('a', 9), ano: '2026', mes: '1' }] } });
    assert.deepEqual(b.getData().valores.map((r) => [r.id_linha, r.valor]), [['a', 9], ['b', 2]]);
  });

  test('DDB-06 apaga pela chave e delYears remove o ano em todas as tabelas', () => {
    const b = novo();
    const tx = (ano, id) => ({ ano, id_lancamento: id, mes: 1, descricao: 'x', data: '', categoria: '', valor: 1, id_linha: 'itau' });
    b.applyChanges({ add: [2025, 2026], up: { LancamentosCartao: [tx(2025, 'a'), tx(2026, 'b'), tx(2026, 'c')], Notas: [{ ano: 2025, id_nota: 'n', descricao: 'd', concluida: false }] } });
    b.applyChanges({ del: { LancamentosCartao: [{ ano: 2026, id_lancamento: 'b' }] } });
    assert.deepEqual(b.getData().lancamentos.map((r) => r.id_lancamento), ['a', 'c']);
    b.applyChanges({ delYears: [2025] });
    const d = b.getData();
    assert.deepEqual(d.anos, [2026]);
    assert.deepEqual(d.lancamentos.map((r) => r.id_lancamento), ['c']);
    assert.deepEqual(d.notas, []);
  });

  test('DDB-07 saveNormalizacoes regrava tudo e descarta regras incompletas', () => {
    const b = novo();
    b.saveNormalizacoes([{ id: 'a', tipo: 'contem', padrao: ' padaria ', nome: 'Padaria', categoria: 'Supermercado' }, { id: 'b', tipo: 'igual', padrao: '', nome: 'X', categoria: '' }]);
    assert.deepEqual(b.getData().normalizacoes, [{ id: 'a', tipo: 'contem', padrao: 'padaria', nome: 'Padaria', categoria: 'Supermercado' }]);
  });

  test('DDB-08 dados persistem no arquivo, seeds não se repetem e exportar gera cópia legível', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fin-'));
    const arq = path.join(dir, 'financeiro.db');
    let b = abrir(arq, esquema);
    b.applyChanges({ add: [2026] });
    b.saveNormalizacoes([]);
    b.exportar(path.join(dir, 'copia.db'));
    b.fechar();
    b = abrir(arq, esquema);
    assert.deepEqual(b.getData().anos, [2026]);
    assert.deepEqual(b.getData().normalizacoes, [], 'regras apagadas pelo usuário não voltam');
    b.fechar();
    const c = abrir(path.join(dir, 'copia.db'), esquema);
    assert.deepEqual(c.getData().anos, [2026]);
    c.fechar();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('DDB-09 erro no meio da gravação desfaz tudo (transação)', () => {
    const b = novo();
    assert.throws(() => b.applyChanges({ add: [2026], up: { Valores: [{ ano: 2026, id_linha: 'a', mes: 1, valor: {}, formula: '', pago: '', comentario: '' }] } }));
    assert.deepEqual(b.getData().anos, []);
  });
});
