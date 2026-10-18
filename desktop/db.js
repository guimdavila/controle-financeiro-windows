'use strict';
/**
 * Banco local da edição desktop (SQLite embutido do Node/Electron: node:sqlite).
 * Implementa as mesmas três funções do Apps Script, com a mesma entrada e saída
 * (ver backend/leitura.js e backend/gravacao.js): getData, applyChanges, saveNormalizacoes.
 * Cada aba da planilha vira uma tabela com as mesmas colunas e a mesma chave (esquema.tabelas).
 *
 * Tipos: o SQLite guarda o valor como veio (colunas sem tipo). Booleanos viram 'TRUE'/'FALSE'
 * (como a planilha devolve texto), vazio é '' — o front já trata esses dois formatos.
 */
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const COR_HEX = /^#[0-9a-f]{3,8}$/i;
const VERSAO = 1;

const q = (n) => '"' + n + '"';
const bool = (v) => v === true || String(v).toUpperCase() === 'TRUE';
const txt = (v) => (v === null || v === undefined ? '' : String(v));
const num = (v) => (v === '' || v === null || v === undefined ? '' : Number(v));
/* valor JS -> valor gravável no SQLite */
const cel = (v) => (v === undefined || v === null ? '' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : v);
/* colunas-chave numéricas: 2026 e "2026" são a mesma chave (como na planilha) */
const CHAVE_NUM = ['ano', 'mes', 'id_categoria'];
const celChave = (c, v) => (CHAVE_NUM.includes(c) && v !== '' && v !== null && v !== undefined && !isNaN(Number(v)) ? Number(v) : cel(v));

function abrir(arquivo, esquema) {
  const db = new DatabaseSync(arquivo);
  const T = esquema.tabelas, META = new Set(esquema.linhaMeta);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');

  /* ---------- criação e seeds (só na primeira abertura) ---------- */
  db.exec('CREATE TABLE IF NOT EXISTS meta (chave TEXT PRIMARY KEY, valor TEXT)');
  Object.keys(T).forEach((nome) => {
    db.exec(`CREATE TABLE IF NOT EXISTS ${q(nome)} (${T[nome].cols.map(q).join(', ')}, PRIMARY KEY (${T[nome].key.map(q).join(', ')}))`);
  });
  const meta = (k) => { const r = db.prepare('SELECT valor FROM meta WHERE chave = ?').get(k); return r ? r.valor : null; };
  const setMeta = (k, v) => db.prepare('INSERT INTO meta (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor').run(k, String(v));

  const transacao = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };

  /* ---------- acesso genérico às tabelas ---------- */
  const linhas = (nome) => db.prepare(`SELECT ${T[nome].cols.map(q).join(', ')} FROM ${q(nome)} ORDER BY rowid`).all()
    .map((o) => T[nome].cols.map((c) => o[c]));
  const upserts = {};
  const upsert = (nome, arr) => {
    const def = T[nome], resto = def.cols.filter((c) => !def.key.includes(c));
    const st = upserts[nome] || (upserts[nome] = db.prepare(
      `INSERT INTO ${q(nome)} (${def.cols.map(q).join(', ')}) VALUES (${def.cols.map(() => '?').join(', ')}) ` +
      `ON CONFLICT (${def.key.map(q).join(', ')}) DO ` + (resto.length ? `UPDATE SET ${resto.map((c) => `${q(c)} = excluded.${q(c)}`).join(', ')}` : 'NOTHING')));
    st.run(...arr.map((v, i) => celChave(def.cols[i], v)));
  };
  const apagaChave = (nome, o) => {
    const def = T[nome];
    db.prepare(`DELETE FROM ${q(nome)} WHERE ${def.key.map((c) => `${q(c)} = ?`).join(' AND ')}`).run(...def.key.map((c) => celChave(c, o[c])));
  };

  /* ---------- categorias: nome <-> id (como backend/categorias.js) ---------- */
  let cache = null;
  const cats = () => {
    if (cache) return cache;
    const byName = {}, byId = {};
    let max = 0;
    linhas('Categorias').forEach((r) => {
      if (r[0] === '') return;
      if (!COR_HEX.test(String(r[1]).trim())) byName[String(r[1]).trim().toLowerCase()] = r[0];
      byId[r[0]] = String(r[1]);
      max = Math.max(max, Number(r[0]) || 0);
    });
    return (cache = { byName, byId, max });
  };
  const metaTxt = (c, v) => (v === '' || v === null || v === undefined ? '' : typeof v === 'number' && c.byId[v] !== undefined ? c.byId[v] : String(v));
  const catId = (nome) => {
    const n = String(nome || '').trim();
    if (!n) return '';
    const c = cats(), k = n.toLowerCase();
    if (c.byName[k] !== undefined) return c.byName[k];
    const id = ++c.max;
    upsert('Categorias', [id, n, '#7B8794', 'cartao', true]);
    c.byName[k] = id; c.byId[id] = n;
    return id;
  };
  const toArr = (def, o) => def.cols.map((k) => {
    if (k === 'id_categoria') return def.cat && !META.has(o.tipo) ? catId(o.categoria) : (def.cat ? String(o.categoria === undefined ? '' : o.categoria) : (o[k] === undefined ? '' : o[k]));
    const v = o[k];
    return v === undefined || v === null ? '' : v;
  });

  /* ---------- gravação ---------- */
  function gravaNormalizacoes(lista) {
    db.exec('DELETE FROM "Normalizacoes"');
    (lista || []).filter((o) => String(o.padrao || '').trim() && String(o.nome || '').trim())
      .forEach((o) => upsert('Normalizacoes', [String(o.id), String(o.tipo), String(o.padrao).trim(), String(o.nome).trim(), catId(o.categoria)]));
  }
  function saveNormalizacoes(lista) {
    transacao(() => gravaNormalizacoes(lista));
    return true;
  }
  function applyChanges(chg) {
    chg = chg || {};
    transacao(() => {
      const add = chg.add || [], delYears = (chg.delYears || []).map(Number);
      delYears.forEach((a) => {
        db.prepare('DELETE FROM "Anos" WHERE "ano" = ?').run(a);
        esquema.porAno.forEach((nome) => db.prepare(`DELETE FROM ${q(nome)} WHERE "ano" = ?`).run(a));
      });
      add.map(Number).filter((a) => a && !delYears.includes(a)).forEach((a) => upsert('Anos', [a]));
      esquema.porAno.forEach((nome) => {
        ((chg.del || {})[nome] || []).forEach((k) => apagaChave(nome, k));
        ((chg.up || {})[nome] || []).forEach((o) => upsert(nome, toArr(T[nome], o)));
      });
    });
    return true;
  }

  /* ---------- leitura (mesmo formato de backend/leitura.js) ---------- */
  function getData() {
    cache = null;
    const c = cats(), R = (n) => linhas(n).filter((r) => r[0] !== '');
    const nomeCat = (id) => (id === '' ? '' : (c.byId[id] || ''));
    return {
      anos: R('Anos').map((r) => Number(r[0])).sort((a, b) => a - b),
      categorias: R('Categorias').filter((r) => !COR_HEX.test(String(r[1]).trim())).map((r) => ({
        nome: String(r[1]), cor: String(r[2]), grupo: String(r[3]), ativo: !(r[4] === false || String(r[4]).toUpperCase() === 'FALSE'),
      })),
      linhasAno: R('LinhasAno').map((r) => ({
        ano: Number(r[0]), id_linha: String(r[1]), tipo: String(r[2]), nome: txt(r[3]),
        categoria: META.has(String(r[2])) ? metaTxt(c, r[4]) : nomeCat(r[4]), personalizada: bool(r[5]), excluida: bool(r[6]),
      })),
      valores: R('Valores').map((r) => ({
        ano: Number(r[0]), id_linha: String(r[1]), mes: Number(r[2]), valor: num(r[3]),
        formula: typeof r[4] === 'string' ? r[4] : '', pago: r[5] === '' ? '' : bool(r[5]), comentario: txt(r[6]),
      })),
      lancamentos: R('LancamentosCartao').map((r) => ({
        ano: Number(r[0]), id_lancamento: String(r[1]), mes: Number(r[2]), descricao: txt(r[3]),
        data: txt(r[4]), categoria: nomeCat(r[5]), valor: num(r[6]), id_linha: String(r[7] || ''),
      })),
      pendencias: R('Pendencias').map((r) => ({
        ano: Number(r[0]), id_pendencia: String(r[1]), descricao: txt(r[2]), valor: num(r[3]), observacao: txt(r[4]), pago: bool(r[5]),
      })),
      notas: R('Notas').map((r) => ({ ano: Number(r[0]), id_nota: String(r[1]), descricao: txt(r[2]), concluida: bool(r[3]) })),
      normalizacoes: R('Normalizacoes').map((r) => ({
        id: String(r[0]), tipo: String(r[1]), padrao: String(r[2]), nome: String(r[3]), categoria: r[4] === '' ? '' : (c.byId[r[4]] || ''),
      })),
    };
  }

  /* banco novo: categorias e regras de normalização iniciais; nenhum ano/valor (o front cria o ano corrente) */
  if (!meta('versao')) {
    transacao(() => {
      esquema.categorias.forEach((c) => upsert('Categorias', c));
      cache = null;
      gravaNormalizacoes(esquema.normalizacoes.map((s, i) => ({ id: 'r' + (i + 1), tipo: s[0], padrao: s[1], nome: s[2], categoria: s[3] })));
      setMeta('versao', VERSAO);
    });
  }

  /* cópia consistente do banco num arquivo novo (menu Arquivo > Exportar banco) */
  const exportar = (destino) => { fs.rmSync(destino, { force: true }); db.prepare('VACUUM INTO ?').run(destino); };

  return { getData, applyChanges, saveNormalizacoes, exportar, fechar: () => db.close() };
}

module.exports = { abrir };
