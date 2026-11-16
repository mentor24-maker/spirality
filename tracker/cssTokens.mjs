// Reading tracker/web/app.css's tokens (docs/UI_DOCTRINE.md section 2, SP-320):
// its declarations rule by rule, the tokens :root defines, and a token's
// colour. Used by the checks that keep the page on its tokens, and by tests
// that measure a colour's contrast.

/**
 * Every declaration in `css`, as { selector, property, value }, with comments
 * removed. A rule inside an at-rule (`@media`) keeps its own selector; a
 * `@keyframes` step's selector is its step ("0%, 75%").
 */
export function declarationsOf(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const found = [];
  const stack = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '{') {
      stack.push(text.slice(start, i).trim());
      start = i + 1;
    } else if (text[i] === '}') {
      const selector = stack.pop() ?? '';
      const body = text.slice(start, i);
      if (!selector.startsWith('@')) {
        for (const part of splitDeclarations(body)) {
          const colon = part.indexOf(':');
          if (colon > 0) found.push({ selector, property: part.slice(0, colon).trim(), value: part.slice(colon + 1).trim() });
        }
      }
      start = i + 1;
    }
  }
  return found;
}

/** `body` split on the semicolons that end declarations (not one inside brackets or quotes). */
function splitDeclarations(body) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let from = 0;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (c === ';' && depth === 0) { parts.push(body.slice(from, i)); from = i + 1; }
  }
  parts.push(body.slice(from));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** The tokens `:root` defines, name to value. */
export function rootTokens(css) {
  return new Map(declarationsOf(css).filter((d) => d.selector === ':root' && d.property.startsWith('--')).map((d) => [d.property, d.value]));
}

/** `value` with its token followed to a literal (`var(--ink-error)` → `#cc0000`), or null when a token is not defined. */
export function resolveColour(css, value) {
  const tokens = rootTokens(css);
  let out = String(value).trim();
  for (let hops = 0; hops < 10; hops += 1) {
    const m = /^var\((--[\w-]+)\)$/.exec(out);
    if (!m) return out;
    if (!tokens.has(m[1])) return null;
    out = tokens.get(m[1]);
  }
  return null;
}

/**
 * `css` with every `var(--x)` below :root replaced by the value :root gives
 * it, followed through tokens that name tokens: what the browser would draw.
 * For a test that measures a colour's contrast or a size; a token :root does
 * not define (one the page sets at run time) is left as it is.
 */
export function withTokensResolved(css) {
  const tokens = rootTokens(css);
  const end = css.indexOf('}', css.search(/^:root \{/m));
  const resolve = (text, depth = 0) => (depth > 10 ? text
    : text.replace(/var\((--[\w-]+)\)/g, (m, name) => (tokens.has(name) ? resolve(tokens.get(name), depth + 1) : m)));
  return css.slice(0, end + 1) + resolve(css.slice(end + 1));
}
