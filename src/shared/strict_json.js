// Recursive parsing preserves duplicate-key detection before object construction.
export function strictJson(text) {
  const error = code => { throw Object.assign(new Error(code), {code}); };
  if (typeof text !== 'string' || text.startsWith('\uFEFF')) error('invalid_json');
  let pos = 0, duplicate = false;
  const whitespace = () => { while (/[\x20\t\r\n]/.test(text[pos] ?? '') && pos < text.length) pos++; };
  const string = () => {
    const start = pos++;
    while (pos < text.length) {
      const ch = text[pos++];
      if (ch === '"') return JSON.parse(text.slice(start, pos));
      if (ch === '\\') pos++;
    }
    error('invalid_json');
  };
  const value = () => {
    whitespace();
    if (text[pos] === '"') return string();
    if (text[pos] === '{' || text[pos] === '[') {
      const object = text[pos++] === '{', end = object ? '}' : ']';
      const result = object ? Object.create(null) : [];
      whitespace();
      if (text[pos] === end) { pos++; return result; }
      while (pos < text.length) {
        whitespace();
        if (object) {
          if (text[pos] !== '"') error('invalid_json');
          const key = string();
          whitespace();
          if (text[pos++] !== ':') error('invalid_json');
          if (Object.hasOwn(result, key)) duplicate = true;
          result[key] = value();
        } else result.push(value());
        whitespace();
        if (text[pos] === end) { pos++; return result; }
        if (text[pos++] !== ',') error('invalid_json');
      }
      error('invalid_json');
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(pos));
    if (!token) error('invalid_json');
    pos += token[0].length;
    const result = JSON.parse(token[0]);
    if (typeof result === 'number' && !Number.isFinite(result)) error('invalid_json');
    return result;
  };
  try {
    const result = value();
    whitespace();
    if (pos !== text.length) error('invalid_json');
    if (duplicate) error('duplicate_key');
    return result;
  } catch (err) {
    if (err.code) throw err;
    error('invalid_json');
  }
}
