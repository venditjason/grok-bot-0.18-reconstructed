/** Intentionally small Markdown subset. Raw HTML and links are always inert text. */
export type MarkdownBlock = { type: 'paragraph' | 'heading' | 'quote'; text: string; level?: number } | { type: 'code'; text: string; language: string } | { type: 'list'; items: string[]; ordered: boolean } | { type: 'rule' } | { type: 'table'; headers: string[]; rows: string[][] };
export type InlinePart = { type: 'text' | 'code' | 'strong' | 'em'; text: string } | { type: 'link'; text: string; url: string };
export function inlineParts(text: string): InlinePart[] {
  const tokens: InlinePart[] = [];
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^\)\n]+\))/g;
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index!; if (index > start) tokens.push({ type: 'text', text: text.slice(start, index) });
    const value = match[0];
    if (value.startsWith('`')) tokens.push({ type: 'code', text: value.slice(1, -1) });
    else if (value.startsWith('**')) tokens.push({ type: 'strong', text: value.slice(2, -2) });
    else if (value.startsWith('*')) tokens.push({ type: 'em', text: value.slice(1, -1) });
    else { const end = value.indexOf(']('); tokens.push({ type: 'link', text: value.slice(1, end), url: value.slice(end + 2, -1) }); }
    start = index + value.length;
  }
  if (start < text.length) tokens.push({ type: 'text', text: text.slice(start) });
  return tokens;
}
function cells(line: string): string[] { return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim()); }
export function markdownBlocks(text: string): MarkdownBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n'), blocks: MarkdownBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) { index++; continue; }
    const code = /^\s*(```+|~~~+)\s*(.*)$/.exec(line);
    if (code) {
      const fence = code[1]!, body: string[] = []; index++;
      while (index < lines.length && !lines[index]!.trim().startsWith(fence)) body.push(lines[index++]!);
      if (index < lines.length) index++;
      blocks.push({ type: 'code', language: code[2]!.trim(), text: body.join('\n') }); continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) { blocks.push({ type: 'heading', text: heading[2]!, level: heading[1]!.length }); index++; continue; }
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) { blocks.push({ type: 'rule' }); index++; continue; }
    if (line.includes('|') && index + 1 < lines.length && /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(lines[index + 1]!.trim())) {
      const headers = cells(line), rows: string[][] = []; index += 2;
      while (index < lines.length && lines[index]!.includes('|') && lines[index]!.trim()) rows.push(cells(lines[index++]!));
      blocks.push({ type: 'table', headers, rows }); continue;
    }
    const list = /^\s*(?:([-*+])|(\d+)[.)])\s+(.+)$/.exec(line);
    if (list) {
      const items = [list[3]!], ordered = !!list[2]; index++;
      while (index < lines.length) { const next = /^\s*(?:([-*+])|(\d+)[.)])\s+(.+)$/.exec(lines[index]!); if (!next || !!next[2] !== ordered) break; items.push(next[3]!); index++; }
      blocks.push({ type: 'list', ordered, items }); continue;
    }
    if (/^>\s?/.test(line)) { const quote: string[] = []; while (index < lines.length && /^>\s?/.test(lines[index]!)) quote.push(lines[index++]!.replace(/^>\s?/, '')); blocks.push({ type: 'quote', text: quote.join('\n') }); continue; }
    const body = [line]; index++;
    while (index < lines.length && lines[index]!.trim() && !/^(?:#{1,6}\s|\s*```|\s*~~~|>|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[index]!)) body.push(lines[index++]!);
    blocks.push({ type: 'paragraph', text: body.join('\n') });
  }
  return blocks;
}
