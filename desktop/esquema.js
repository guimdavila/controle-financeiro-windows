'use strict';
/** Esquema do banco: tabelas, chaves, categorias e regras de normalização iniciais (desktop/esquema.json). */
const fs = require('node:fs');
const path = require('node:path');

const gerarEsquema = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'esquema.json'), 'utf8'));

module.exports = { gerarEsquema };
