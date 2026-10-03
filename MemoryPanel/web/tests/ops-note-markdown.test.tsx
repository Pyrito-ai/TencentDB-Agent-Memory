import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NoteMarkdown } from '../src/pages/OpsPage/NoteMarkdown';

const render = (children: string) =>
  renderToStaticMarkup(createElement(NoteMarkdown, { children }));

test('notes render general Markdown, including checklists and code', () => {
  const html = render(
    '## Next steps\n\n- [x] Read the brief\n- [ ] Review `launch.md`\n\n> Keep it short.',
  );
  assert.match(html, /<h2>Next steps<\/h2>/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /disabled=""/);
  assert.match(html, /<code>launch.md<\/code>/);
  assert.match(html, /<blockquote>/);
  assert.doesNotMatch(html, /<form|<textarea|type="email"/);
});

test('untrusted Markdown cannot execute HTML or unsafe links, or load tracking images', () => {
  const html = render(
    '<script>alert(1)</script>\n\n[Bad](javascript:alert%281%29)\n\n![Tracker](https://example.com/pixel.png)',
  );
  assert.doesNotMatch(html, /<script|javascript:|<img|<iframe/);
  assert.match(html, /href="https:\/\/example.com\/pixel.png"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test('local links stay in the app and wide tables have a focusable scroll container', () => {
  const html = render('[Tasks](/#/)\n\n| Item | Owner |\n| --- | --- |\n| Launch | Alex |');
  assert.match(html, /<a href="\/#\/" rel="noopener noreferrer">Tasks<\/a>/);
  assert.match(html, /class="ops-note-table" tabindex="0" role="region" aria-label="Note table"/);
  assert.match(html, /<table>/);
});
