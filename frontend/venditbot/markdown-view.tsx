/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
import type * as ReactTypes from 'react';
import { markdownBlocks, inlineParts } from './markdown';
const React: typeof ReactTypes = window.React;
function Inline({ text }: { text: string }) {
  return <>{inlineParts(text).map((part, index) => part.type === 'code' ? <code key={index} className="inline-code bg-background-base-subtle typo-c2/m">{part.text}</code> : part.type === 'strong' ? <strong key={index}>{part.text}</strong> : part.type === 'em' ? <em key={index}>{part.text}</em> : part.type === 'link' ? <span key={index} className="text-glyph-vendit-heading">{part.text} <span className="typo-l1/r">({part.url})</span></span> : <React.Fragment key={index}>{part.text}</React.Fragment>)}</>;
}
export function MarkdownContent({ text }: { text: string }) {
  return <div className="markdown">{markdownBlocks(text).map((block, index) => {
    if (block.type === 'code') return <div key={index} className="code-block bg-background-base-subtle border border-solid border-line-outline-stroke rounded-lg"><div className="code-language typo-l2/r text-glyph-gray-caption">{block.language || '코드'}</div><pre className="typo-c2/m text-glyph-gray-body"><code>{block.text}</code></pre></div>;
    if (block.type === 'heading') return <h3 key={index} className={`${(block.level ?? 1) <= 2 ? 'typo-h3/b' : 'typo-b1/sb'} text-glyph-gray-heading`}><Inline text={block.text} /></h3>;
    if (block.type === 'quote') return <blockquote key={index} className="border-l border-solid border-line-outline-stroke text-glyph-gray-description"><Inline text={block.text} /></blockquote>;
    if (block.type === 'rule') return <hr key={index} className="border-t border-solid border-line-separator-stroke" />;
    if (block.type === 'list') return block.ordered ? <ol key={index}>{block.items.map((item, at) => <li key={at}><Inline text={item} /></li>)}</ol> : <ul key={index}>{block.items.map((item, at) => <li key={at}><Inline text={item} /></li>)}</ul>;
    if (block.type === 'table') return <div key={index} className="markdown-table"><table className="border border-solid border-line-outline-stroke"><thead><tr>{block.headers.map((header, at) => <th key={at} className="bg-background-base-subtle"><Inline text={header} /></th>)}</tr></thead><tbody>{block.rows.map((row, at) => <tr key={at}>{block.headers.map((_, column) => <td key={column} className="border-t border-solid border-line-separator-stroke"><Inline text={row[column] ?? ''} /></td>)}</tr>)}</tbody></table></div>;
    return <p key={index}><Inline text={block.text} /></p>;
  })}</div>;
}

/** Native session snapshots may clone older messages; text equality still skips parsing. */
export const Markdown = React.memo(MarkdownContent, (previous, next) => previous.text === next.text);
