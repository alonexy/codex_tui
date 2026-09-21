import mermaid from 'mermaid';

// This code runs only in an opaque sandbox with no network or parent DOM access.
const config = {
  startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
  maxTextSize: 16000, maxEdges: 160, htmlLabels: false,
  theme: 'default', fontFamily: 'system-ui, sans-serif',
  flowchart: { htmlLabels: false, useMaxWidth: false },
  secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'htmlLabels', 'flowchart', 'theme', 'themeCSS', 'fontFamily'],
};
let busy = false;
window.addEventListener('message', async event => {
  const data = event.data;
  if (event.source !== parent || busy || data?.type !== 'mermaid-render' || !Number.isSafeInteger(data.id)) return;
  const { source, id } = data;
  busy = true;
  try {
    if (typeof source !== 'string' || source.length > 16000 || /^\s*---(?:\r?\n|$)/.test(source) || /%%\s*\{/.test(source)) throw Error('unsupported source');
    mermaid.initialize(config);
    const { svg } = await mermaid.render(`diagram${id}`, source);
    if (svg.length > 2000000) throw Error('large SVG');
    // Mermaid link nodes use xlink:href without always declaring the XML prefix.
    // SVG-as-image needs well-formed XML even though those links are inert.
    const xml = svg.replace(/^<svg\b([^>]*)>/, (tag, attributes) => /\bxmlns:xlink\s*=/.test(attributes)
      ? tag : tag.replace('<svg', '<svg xmlns:xlink="http://www.w3.org/1999/xlink"'));
    const document = new DOMParser().parseFromString(xml, 'image/svg+xml');
    const root = document.documentElement, size = root.getAttribute('viewBox')?.split(/[ ,]+/).map(Number);
    if (root.localName !== 'svg' || !size || size.length !== 4 || size.some(n => !Number.isFinite(n)) || size[2] <= 0 || size[3] <= 0 || Math.max(size[2], size[3]) > 30000) throw Error('invalid dimensions');
    // Explicit dimensions make SVG-as-image sizing consistent in mobile browsers.
    root.setAttribute('width', size[2]); root.setAttribute('height', size[3]);
    root.style.maxWidth = 'none'; root.style.backgroundColor = '#fff';
    parent.postMessage({ type: 'mermaid-result', id, svg: new XMLSerializer().serializeToString(root) }, '*');
  } catch {
    parent.postMessage({ type: 'mermaid-result', id, error: true }, '*');
  } finally {
    document.body.replaceChildren(); busy = false;
  }
});
parent.postMessage({ type: 'mermaid-ready' }, '*');
