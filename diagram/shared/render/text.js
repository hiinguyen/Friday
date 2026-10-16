export function wrapText(fontSet, text, { size, weight, maxWidth, maxLines, minScale = 0.75 }) {
  const clean = String(text ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
  if (clean === '') return { lines: [], size, truncated: false };
  const words = clean.split(' ');

  const breakWord = (currentSize, word) => {
    const chunks = [];
    let rest = word;
    while (rest.length > 0) {
      let chunk = '';
      let index = 0;
      while (index < rest.length && fontSet.measure(chunk + rest[index], currentSize, weight) <= maxWidth) {
        chunk += rest[index];
        index += 1;
      }
      if (chunk === '') chunk = rest[0];
      chunks.push(chunk);
      rest = rest.slice(chunk.length);
    }
    return chunks;
  };

  const greedy = (currentSize) => {
    const lines = [];
    let line = '';
    for (const word of words) {
      if (word === '') continue;
      if (fontSet.measure(word, currentSize, weight) > maxWidth) {
        if (line !== '') {
          lines.push(line);
          line = '';
        }
        const chunks = breakWord(currentSize, word);
        for (let i = 0; i < chunks.length - 1; i += 1) lines.push(chunks[i]);
        line = chunks[chunks.length - 1];
        continue;
      }
      if (line === '') {
        line = word;
        continue;
      }
      const candidate = `${line} ${word}`;
      if (fontSet.measure(candidate, currentSize, weight) <= maxWidth) line = candidate;
      else {
        lines.push(line);
        line = word;
      }
    }
    if (line !== '') lines.push(line);
    return lines;
  };

  const floor = Math.round(size * minScale * 2) / 2;
  const steps = Math.max(0, Math.round((size - floor) * 2));
  for (let step = 0; step <= steps; step += 1) {
    const current = size - step / 2;
    const lines = greedy(current);
    if (lines.length <= maxLines) return { lines, size: current, truncated: false };
  }

  const kept = greedy(floor).slice(0, maxLines);
  if (kept.length === 0) kept.push('…');
  else {
    let last = kept[kept.length - 1];
    while (last.length > 0 && fontSet.measure(`${last}…`, floor, weight) > maxWidth) {
      last = last.slice(0, -1).replace(/\s+$/, '');
    }
    kept[kept.length - 1] = `${last}…`;
  }
  return { lines: kept, size: floor, truncated: true };
}
