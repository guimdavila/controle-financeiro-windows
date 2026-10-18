'use strict';
/* ---------- processo principal da edição desktop (Electron) ----------
   Abre a janela com desktop/app/index.html (gerado por desktop/build.js) e atende as chamadas
   google.script.run do front com o banco SQLite local (desktop/db.js). */
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { abrir } = require('./db');

const APP_DIR = path.join(__dirname, 'app');
const ESQUEMA = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'esquema.json'), 'utf8'));
const FUNCOES = ['getData', 'applyChanges', 'saveNormalizacoes'];

let db = null, win = null;
const arquivoDb = () => path.join(app.getPath('userData'), 'financeiro.db');
const abrirDb = () => { db = abrir(arquivoDb(), ESQUEMA); };

/* só uma janela/processo escrevendo no banco */
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

ipcMain.handle('rpc', (_e, fn, args) => {
  if (!FUNCOES.includes(fn)) throw new Error('Função desconhecida: ' + fn);
  return db[fn](...(Array.isArray(args) ? args : []));
});

async function exportarBanco() {
  const hoje = new Date().toISOString().slice(0, 10);
  const r = await dialog.showSaveDialog(win, {
    title: 'Exportar banco de dados', defaultPath: path.join(app.getPath('documents'), `controle-financeiro-${hoje}.db`),
    filters: [{ name: 'Banco de dados', extensions: ['db'] }],
  });
  if (r.canceled || !r.filePath) return;
  db.exportar(r.filePath);
  dialog.showMessageBox(win, { type: 'info', message: 'Banco exportado', detail: r.filePath });
}

async function importarBanco() {
  const r = await dialog.showOpenDialog(win, { title: 'Importar banco de dados', properties: ['openFile'], filters: [{ name: 'Banco de dados', extensions: ['db'] }] });
  if (r.canceled || !r.filePaths[0]) return;
  const origem = r.filePaths[0];
  try {
    const t = new DatabaseSync(origem, { readOnly: true });
    try { t.prepare("SELECT valor FROM meta WHERE chave = 'versao'").get(); } finally { t.close(); }
  } catch (e) {
    dialog.showMessageBox(win, { type: 'error', message: 'Este arquivo não é um banco do Controle financeiro.', detail: String(e.message || e) });
    return;
  }
  const ok = await dialog.showMessageBox(win, {
    type: 'warning', buttons: ['Substituir', 'Cancelar'], defaultId: 1, cancelId: 1,
    message: 'Substituir TODOS os dados deste computador pelos do arquivo escolhido?', detail: 'Não dá para desfazer. Exporte o banco atual antes se tiver dúvida.',
  });
  if (ok.response !== 0) return;
  const destino = arquivoDb();
  db.fechar();
  ['', '-wal', '-shm'].forEach((s) => fs.rmSync(destino + s, { force: true }));
  fs.copyFileSync(origem, destino);
  abrirDb();
  win.webContents.reloadIgnoringCache();
}

function menu() {
  const dev = !app.isPackaged;
  const tpl = [
    { label: 'Arquivo', submenu: [
      { label: 'Exportar banco de dados…', click: exportarBanco },
      { label: 'Importar banco de dados…', click: importarBanco },
      { label: 'Abrir pasta dos dados', click: () => shell.openPath(app.getPath('userData')) },
      { type: 'separator' },
      { role: 'quit', label: 'Sair' },
    ] },
    { label: 'Editar', submenu: [
      { role: 'undo', label: 'Desfazer' }, { role: 'redo', label: 'Refazer' }, { type: 'separator' },
      { role: 'cut', label: 'Recortar' }, { role: 'copy', label: 'Copiar' }, { role: 'paste', label: 'Colar' }, { role: 'selectAll', label: 'Selecionar tudo' },
    ] },
    { label: 'Exibir', submenu: [
      { role: 'reload', label: 'Recarregar' }, { type: 'separator' },
      { role: 'resetZoom', label: 'Tamanho normal' }, { role: 'zoomIn', label: 'Aumentar' }, { role: 'zoomOut', label: 'Diminuir' },
      { type: 'separator' }, { role: 'togglefullscreen', label: 'Tela cheia' },
      ...(dev ? [{ role: 'toggleDevTools', label: 'Ferramentas do desenvolvedor' }] : []),
    ] },
  ];
  if (process.platform === 'darwin') tpl.unshift({ role: 'appMenu' });
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

function criarJanela() {
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 380, minHeight: 500, show: false, backgroundColor: '#121110',
    title: 'Controle financeiro',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  win.once('ready-to-show', () => win.show());
  /* links externos abrem no navegador; a janela nunca sai do app */
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) e.preventDefault(); });
  /* o front bloqueia a saída enquanto há gravação pendente (beforeunload): pergunta em vez de travar */
  win.webContents.on('will-prevent-unload', (e) => {
    const r = dialog.showMessageBoxSync(win, {
      type: 'question', buttons: ['Sair mesmo assim', 'Esperar'], defaultId: 1, cancelId: 1,
      message: 'Ainda há alterações sendo salvas.', detail: 'Espere um instante para não perder o que acabou de digitar.',
    });
    if (r === 0) e.preventDefault();
  });
  win.loadFile(path.join(APP_DIR, 'index.html'));
}

app.whenReady().then(() => {
  abrirDb();
  menu();
  criarJanela();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) criarJanela(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('will-quit', () => { if (db) db.fechar(); });
