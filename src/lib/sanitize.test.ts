import { describe, it, expect } from 'vitest';
import { sanitizeMarkdownHtml } from './utils';

// The preview renders marked output through innerHTML, so this sanitizer is
// the only thing between a note's raw HTML and the webview. These tests pin
// the allowlist behaviour: hostile markup must never survive.

describe('sanitizeMarkdownHtml', () => {
  it('keeps safe markdown HTML untouched', () => {
    expect(sanitizeMarkdownHtml('<p>Hello <strong>world</strong></p>')).toBe(
      '<p>Hello <strong>world</strong></p>',
    );
    expect(sanitizeMarkdownHtml('<h2>Title</h2><ul><li>one</li></ul>')).toBe(
      '<h2>Title</h2><ul><li>one</li></ul>',
    );
  });

  it('drops script, style and iframe with their contents', () => {
    expect(sanitizeMarkdownHtml('<p>a</p><script>alert(1)</script>')).toBe('<p>a</p>');
    expect(sanitizeMarkdownHtml('<style>body{display:none}</style><p>x</p>')).toBe('<p>x</p>');
    expect(sanitizeMarkdownHtml('<iframe src="https://evil.example"></iframe>')).toBe('');
  });

  it('drops svg and math with their contents', () => {
    expect(sanitizeMarkdownHtml('<svg><a href="https://x"><text>hi</text></a></svg>')).toBe('');
    expect(sanitizeMarkdownHtml('<math><mi>x</mi></math>')).toBe('');
  });

  it('drops forms and form controls', () => {
    expect(sanitizeMarkdownHtml('<form action="https://evil.example"><p>fake</p></form>')).toBe('');
    expect(sanitizeMarkdownHtml('<input type="text" value="x">')).toBe('');
    expect(sanitizeMarkdownHtml('<button>Click</button>')).toBe('');
  });

  it('unwraps unknown tags but keeps their text', () => {
    expect(sanitizeMarkdownHtml('<div>keep <section>this</section></div>')).toBe('keep this');
  });

  it('strips event handlers, styles and other attributes', () => {
    expect(sanitizeMarkdownHtml('<p onclick="evil()" style="color:red">x</p>')).toBe('<p>x</p>');
    expect(sanitizeMarkdownHtml('<strong onmouseover="evil()">y</strong>')).toBe('<strong>y</strong>');
  });

  it('removes javascript: hrefs, plain and entity-encoded', () => {
    const plain = sanitizeMarkdownHtml('<a href="javascript:alert(1)">x</a>');
    expect(plain).not.toContain('javascript:');
    expect(plain).toContain('rel="noopener noreferrer"');
    const encoded = sanitizeMarkdownHtml('<a href="java&#115;cript:alert(1)">x</a>');
    expect(encoded).not.toContain('javascript:');
    expect(encoded).not.toContain('href="java');
    const mixed = sanitizeMarkdownHtml('<a href="JaVaScRiPt:alert(1)">x</a>');
    expect(mixed.toLowerCase()).not.toContain('javascript:');
  });

  it('removes other dangerous schemes from hrefs', () => {
    expect(sanitizeMarkdownHtml('<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>')).not.toContain('data:');
    expect(sanitizeMarkdownHtml('<a href="vbscript:msgbox(1)">x</a>')).not.toContain('vbscript:');
  });

  it('keeps https, http, mailto, tel and anchor hrefs, adding rel', () => {
    expect(sanitizeMarkdownHtml('<a href="https://example.com">x</a>')).toBe(
      '<a href="https://example.com" rel="noopener noreferrer">x</a>',
    );
    expect(sanitizeMarkdownHtml('<a href="mailto:a@b.c">m</a>')).toContain('href="mailto:a@b.c"');
    expect(sanitizeMarkdownHtml('<a href="tel:+123">t</a>')).toContain('href="tel:+123"');
    expect(sanitizeMarkdownHtml('<a href="#part">a</a>')).toContain('href="#part"');
  });

  it('drops remote images entirely (offline: no tracking pixels)', () => {
    expect(sanitizeMarkdownHtml('<p>a</p><img src="https://evil.example/x.png" alt="x">')).toBe('<p>a</p>');
    expect(sanitizeMarkdownHtml('<img src="//evil.example/x.png">')).toBe('');
  });

  it('keeps raster data: images, drops svg and html data URIs', () => {
    expect(sanitizeMarkdownHtml('<img src="data:image/png;base64,iVBOR" alt="dot">')).toContain(
      'src="data:image/png;base64,iVBOR"',
    );
    expect(sanitizeMarkdownHtml('<img src="data:image/svg+xml;base64,PHN2Zz4=">')).toBe('');
    expect(sanitizeMarkdownHtml('<img src="data:text/html;base64,PHNjcmlwdD4=">')).toBe('');
  });

  it('turns a marked task checkbox into a live indexed checkbox', () => {
    expect(
      sanitizeMarkdownHtml('<ul><li><input type="checkbox" disabled> todo</li></ul>'),
    ).toBe('<ul><li><input type="checkbox" data-task="0"> todo</li></ul>');
    expect(sanitizeMarkdownHtml('<input type="checkbox" disabled checked>')).toBe(
      '<input type="checkbox" data-task="0" checked>',
    );
  });

  it('drops checkboxes that are not marked task items', () => {
    expect(sanitizeMarkdownHtml('<input type="checkbox">')).toBe('');
  });

  it('escapes text nodes', () => {
    expect(sanitizeMarkdownHtml('<p>1 < 2 & 3</p>')).toBe('<p>1 &lt; 2 &amp; 3</p>');
  });

  it('drops comments', () => {
    expect(sanitizeMarkdownHtml('<p>a</p><!-- secret -->')).toBe('<p>a</p>');
  });

  it('returns an empty string for empty input', () => {
    expect(sanitizeMarkdownHtml('')).toBe('');
  });
});
