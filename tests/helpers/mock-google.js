'use strict';
/**
 * Simula google.script.run: withSuccessHandler(ok).withFailureHandler(ko).<funcao>(...args)
 * Cada função do servidor é um handler em `handlers`. Retorno síncrono => sucesso; throw => falha.
 * Todas as chamadas ficam registradas em `chamadas`.
 */
function criarMockGoogle(handlers = {}) {
  const chamadas = [];
  const h = { applyChanges: () => true, saveNormalizacoes: () => true, ...handlers };

  const cadeia = (ok, ko) =>
    new Proxy({}, {
      get(_, fn) {
        if (fn === 'withSuccessHandler') return (f) => cadeia(f, ko);
        if (fn === 'withFailureHandler') return (f) => cadeia(ok, f);
        return (...args) => {
          /* cópia JSON: os argumentos vêm de outro "realm" (jsdom) e o deepEqual do Node os rejeitaria */
          chamadas.push({ fn, args: JSON.parse(JSON.stringify(args)) });
          Promise.resolve().then(async () => {
            try {
              if (!h[fn]) throw new Error('função do servidor não simulada: ' + fn);
              const r = await h[fn](...args);
              if (ok) ok(r);
            } catch (e) { if (ko) ko(e); }
          });
        };
      },
    });

  return {
    run: cadeia(null, null),
    chamadas,
    /** chamadas de uma função do servidor */
    de: (fn) => chamadas.filter((c) => c.fn === fn),
    /** troca (ou adiciona) o comportamento de uma função do servidor */
    definir: (fn, impl) => { h[fn] = impl; },
  };
}

module.exports = { criarMockGoogle };
