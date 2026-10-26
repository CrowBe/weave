/**
 * Shared source scanner for the repository checks. Checks that match code by
 * pattern use it, so a comment marker inside a string or a template is read
 * the same way by each of them.
 */

/**
 * Blanks comments and template-literal text with spaces, keeping every newline
 * and offset. A scanner, not a regex: a `/*` or `//` inside a string or a
 * template is text, and a template's text is not code, while its `${...}`
 * expressions are. Quoted strings are kept, since `process['env']` and
 * `from 'node:process'` are matched through them. A regex literal containing a
 * quote or comment marker is not modelled.
 */
export function blankComments(source) {
  const out = source.split('');
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  // One entry per open template: the brace depth of its innermost `${` expression, or -1 in its text.
  const templates = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const inText = templates.length > 0 && templates[templates.length - 1] === -1;
    if (inText) {
      if (c === '\\') {
        blank(i, i + 2);
        i += 2;
      } else if (c === '`') {
        templates.pop();
        i += 1;
      } else if (c === '$' && source[i + 1] === '{') {
        templates[templates.length - 1] = 0;
        i += 2;
      } else {
        blank(i, i + 1);
        i += 1;
      }
      continue;
    }
    if (c === '/' && source[i + 1] === '/') {
      const stop = source.indexOf('\n', i);
      const to = stop === -1 ? source.length : stop;
      blank(i, to);
      i = to;
    } else if (c === '/' && source[i + 1] === '*') {
      const stop = source.indexOf('*/', i + 2);
      const to = stop === -1 ? source.length : stop + 2;
      blank(i, to);
      i = to;
    } else if (c === "'" || c === '"') {
      let k = i + 1;
      while (k < source.length && source[k] !== c && source[k] !== '\n') k += source[k] === '\\' ? 2 : 1;
      i = k + 1;
    } else if (c === '`') {
      templates.push(-1);
      i += 1;
    } else {
      if (templates.length > 0) {
        const top = templates.length - 1;
        if (c === '{') templates[top] += 1;
        else if (c === '}') templates[top] = templates[top] === 0 ? -1 : templates[top] - 1;
      }
      i += 1;
    }
  }
  return out.join('');
}
