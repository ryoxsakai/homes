// Homes serves pages with a strict script CSP, which ignores inline on* handlers.
// Works' Memo markup keeps its declarative calls as data-on* attributes, and this
// dispatcher runs them: only named window functions, with JSON or event/this args.
const CALL = /^\s*([A-Za-z_$][\w$]*)\((.*)\)\s*;?\s*$/s;

function splitArgs(source) {
  const args = [];
  let depth = 0, quote = '', start = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && !depth) { args.push(source.slice(start, i)); start = i + 1; }
  }
  const last = source.slice(start);
  if (last.trim()) args.push(last);
  return args.map(a => a.trim());
}

function parseArg(text, event, element) {
  if (text === 'event') return event;
  if (text === 'this') return element;
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
  return JSON.parse(text);
}

export function runHandler(expression, event, element) {
  const match = CALL.exec(expression || '');
  if (!match) throw new Error('Unsupported handler: ' + expression);
  const fn = window[match[1]];
  if (typeof fn !== 'function') throw new Error('Missing handler: ' + match[1]);
  return fn.apply(element, splitArgs(match[2]).map(arg => parseArg(arg, event, element)));
}

export function installInlineHandlers(types = ['click', 'keydown', 'input', 'change']) {
  for (const type of types) {
    const attribute = 'data-on' + type;
    document.addEventListener(type, event => {
      for (const element of event.composedPath()) {
        if (!(element instanceof Element)) continue;
        if (element.hasAttribute(attribute)) runHandler(element.getAttribute(attribute), event, element);
        if (event.cancelBubble) break;
      }
    });
  }
}
