// Cherche dans l'arbre React du room-builder le Provider qui expose plannerApi (window.__pl).
exports.findPl = () => {
  const root = document.querySelector("#___gatsby") || document.body;
  const k = Object.keys(root).find((k) => k.startsWith("__reactContainer"));
  const st = [root[k]];
  while (st.length) {
    const f = st.pop();
    if (!f) continue;
    const v = f.memoizedProps && f.memoizedProps.value;
    if (v && v.plannerApi) {
      window.__pl = v.plannerApi;
      return true;
    }
    if (f.child) st.push(f.child);
    if (f.sibling) st.push(f.sibling);
  }
  return false;
};
