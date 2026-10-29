// A plain Error subclass thrown by post-processing when the agent output is unusable.
export class BadOutput extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'BadOutput';
  }
}

function firstBalancedObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function extractJson(text) {
  let value = String(text ?? '').trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(value);
  if (fence) value = fence[1].trim();
  try {
    return JSON.parse(value);
  } catch {
    /* fall through to the balanced scan */
  }
  const candidate = firstBalancedObject(value);
  if (candidate) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* fall through */
    }
  }
  throw new BadOutput('no JSON object in the reply');
}
