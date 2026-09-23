/**
 * Minimal DOM stub so the agent core inside index.html can be unit-tested
 * in plain Node, with no jsdom and no dependencies.
 * Only the surface the agent core actually touches is implemented.
 */
export function installDom() {
  const mk = () => ({
    innerHTML: "",
    textContent: "",
    value: "",
    className: "",
    style: {},
    dataset: {},
    scrollTop: 0,
    scrollHeight: 0,
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild() {},
    insertAdjacentHTML() {},
    querySelector: () => mk(),
    querySelectorAll: () => [],
    focus() {},
    onclick: null,
  });

  const cache = new Map();
  const document = {
    getElementById: (id) => {
      if (!cache.has(id)) cache.set(id, mk());
      return cache.get(id);
    },
    createElement: () => mk(),
    querySelector: () => mk(),
    querySelectorAll: () => [mk()],
  };
  return { document, cache };
}
