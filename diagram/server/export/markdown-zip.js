import JSZip from 'jszip';

function markdownFor(block) {
  if (block.kind === 'heading') return `${'#'.repeat(block.level ?? 1)} ${block.text}`;
  return block.text;
}

export async function exportMarkdownZip(project, pngsBySection, sections) {
  const zip = new JSZip();
  const lastBlockOfSection = new Map();
  for (const section of sections) {
    const last = section.blockIds[section.blockIds.length - 1];
    if (last) lastBlockOfSection.set(last, section);
  }
  const lines = [];
  for (const block of project.document.blocks) {
    lines.push(markdownFor(block));
    const section = lastBlockOfSection.get(block.id);
    if (section) lines.push(`![${section.title}](images/${section.id}.png)`);
  }
  zip.file('diagrams.md', `${lines.join('\n')}\n`);
  for (const [sectionId, png] of Object.entries(pngsBySection)) zip.file(`images/${sectionId}.png`, png);
  return zip.generateAsync({ type: 'nodebuffer' });
}
