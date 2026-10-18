'use strict';
/** Dados FICTÍCIOS para os testes. */
const { gerarEsquema } = require('../../desktop/esquema');

/** resposta de getData() de um banco vazio (só categorias) */
function dadosVazios() {
  return {
    anos: [], categorias: gerarEsquema().categorias.map((c) => ({ nome: c[1], cor: c[2], grupo: c[3], ativo: c[4] })),
    linhasAno: [], valores: [], lancamentos: [], pendencias: [], notas: [], normalizacoes: [],
  };
}

module.exports = { dadosVazios };
