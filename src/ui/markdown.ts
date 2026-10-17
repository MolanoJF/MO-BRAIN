import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { wikiToLinks } from './lib.ts';

export function renderMarkdown(md: string, source: string): string {
  const html = marked.parse(wikiToLinks(md, source), { async: false, gfm: true }) as string;
  return DOMPurify.sanitize(html);
}
