// parse.js -- a fast, dependency-free Markdown-to-HTML renderer.
//
// parse(markdown) returns exactly the HTML that marked 18.1.3 produces with
// its default options (gfm: true, breaks: false, pedantic: false), for every
// input. The parsing decisions follow the CommonMark 0.31.2 + GFM 0.29
// behaviour that marked implements, including its departures from the spec:
// the same block grammar, the same inline grammar, the same output shapes.
//
// The implementation is organised for speed: the block scanner tries cheap
// necessary-condition checks before the large grammar regexes, the inline
// scanner works on the original string with shared state instead of building
// intermediate strings, and rendering walks the token tree once, appending
// to a single output string per token list.

// ---------------------------------------------------------------------------
// Small string helpers
// ---------------------------------------------------------------------------

const escapeReplacements = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const escapeTest = /[&<>"']/;
const escapeReplace = /[&<>"']/g;
const escapeTestNoEncode = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const escapeReplaceNoEncode = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Escape HTML special characters. With `encode` set, every special character
// is escaped; without it, an ampersand that already begins a character
// reference is left alone.
function escapeHtml(str, encode) {
  if (encode) {
    if (escapeTest.test(str)) {
      return str.replace(escapeReplace, (ch) => escapeReplacements[ch]);
    }
  } else if (escapeTestNoEncode.test(str)) {
    return str.replace(escapeReplaceNoEncode, (ch) => escapeReplacements[ch]);
  }
  return str;
}

const numericRefTest = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const numericRefReplace = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Resolve numeric character references in a text run, the way marked does:
// an out-of-range or surrogate code point becomes U+FFFD, an ampersand code
// point becomes the literal text "&amp;", and a bare ampersand that does not
// form a reference is written out as "&amp;" so later escaping keeps it.
function unescapeNumeric(str) {
  if (!numericRefTest.test(str)) return str;
  return str.replace(numericRefReplace, (match, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) {
      return '�';
    }
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

// encodeURI an href, undoing the encoding of a literal percent sign; returns
// null when the href cannot be encoded (the link then renders as its text).
function encodeHref(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Remove trailing occurrences of `ch` (or, with `invert`, trailing characters
// that are not `ch`).
function rtrimChar(str, ch, invert) {
  const len = str.length;
  if (len === 0) return '';
  let count = 0;
  while (count < len) {
    const c = str.charAt(len - count - 1);
    if (invert ? c !== ch : c === ch) count++;
    else break;
  }
  return str.slice(0, len - count);
}

const blankLineRe = /^[ \t]*$/;

// Drop trailing blank lines of a block, keeping the text untouched when at
// most two lines follow the last non-blank one.
function trimBlankTail(text) {
  const lines = text.split('\n');
  let last = lines.length - 1;
  while (last >= 0 && blankLineRe.test(lines[last])) last--;
  return lines.length - last <= 2 ? text : lines.slice(0, last + 1).join('\n');
}

// Expand tabs to spaces, four-column stops, starting at column `startCol`.
function expandTabs(str, startCol = 0) {
  let col = startCol;
  let out = '';
  for (const ch of str) {
    if (ch === '\t') {
      const pad = 4 - (col % 4);
      out += ' '.repeat(pad);
      col += pad;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// Find an unescaped closing bracket of `pair` ("()" or "[]") in `str`:
// returns its index, -1 when the brackets balance (or none occur), and -2
// when an opener is never closed.
function checkBrackets(str, pair) {
  if (str.indexOf(pair[0]) === -1 && str.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === pair[0]) depth++;
    else if (str[i] === pair[1] && (depth--, depth < 0)) return i;
  }
  return depth > 0 ? -2 : -1;
}

// Normalise a link reference label for lookup.
function normalizeLabel(str) {
  return str.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

const findPipeRe = /\|/g;
const splitPipeRe = / \|/;
const slashPipeRe = /\\\|/g;

// Split a table row into cells on unescaped pipes; with `limit`, extra cells
// are dropped and missing ones padded with empty strings.
function splitCells(str, limit) {
  const replaced = str.replace(findPipeRe, (match, offset, full) => {
    let escaped = false;
    let p = offset;
    while (--p >= 0 && full[p] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = replaced.split(splitPipeRe);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (limit) {
    if (cells.length > limit) cells.splice(limit);
    else while (cells.length < limit) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) {
    cells[i] = cells[i].trim().replace(slashPipeRe, '|');
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Shared regular expressions (the "other" table)
// ---------------------------------------------------------------------------

const re = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  leadingSpaceTab: /^[ \t]+/,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
};

// Regex factories parameterised by a list indent. The indent is clamped the
// way marked clamps it (indent - 1 into [0, 3]) and results are cached.
function indentFactory(build) {
  const cache = [];
  return (indent) => {
    const n = Math.max(0, Math.min(3, indent - 1));
    return cache[n] || (cache[n] = build(n));
  };
}
const listItemRegex = (bull) => new RegExp(`^( {0,3}${bull})((?:[\t ][^\\n]*)?(?:\\n|$))`);
const nextBulletRegex = indentFactory((a) => new RegExp(`^ {0,${a}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`));
const hrBeginRegex = indentFactory((a) => new RegExp(`^ {0,${a}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`));
const fencesBeginRegex = indentFactory((a) => new RegExp(`^ {0,${a}}(?:\`\`\`|~~~)`));
const headingBeginRegex = indentFactory((a) => new RegExp(`^ {0,${a}}#{1,6}(?:\\s|$)`));
const blockquoteBeginRegex = indentFactory((a) => new RegExp(`^ {0,${a}}>`));

const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const htmlBeginRegex = indentFactory((a) => new RegExp(`^ {0,${a}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));

// Compose a grammar regex from a template by first-occurrence substitution,
// the way marked builds its paragraph, table, setext-heading and blockquote
// rules out of shared parts. A RegExp replacement contributes its source
// with every caret removed (a caret not preceded by '['), exactly the
// interpolation marked's own builder performs.
function composeRegex(template, steps) {
  let src = template.source;
  for (const [search, replacement] of steps) {
    let rep = replacement instanceof RegExp ? replacement.source : replacement;
    rep = rep.replace(/(^|[^\[])\^/g, '$1');
    src = src.replace(search, rep);
  }
  return new RegExp(src);
}

const headingPattern = ' {0,3}#{1,6}(?:\\s|$)';
const fencesPattern = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';
const htmlPattern = ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';

// The table rule, shared by the table tokenizer and the paragraph rule.
const tableTemplate = /^ *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n|hr|heading|blockquote|code|fences|list|html).*(?:\n|$))*)\n*|$)/;
const blockTableComposed = composeRegex(tableTemplate, [
  ['hr', /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/],
  ['heading', headingPattern],
  ['blockquote', ' {0,3}>'],
  ['code', '(?: {4}| {0,3}\t)[^\\n]'],
  ['fences', fencesPattern],
  ['list', ' {0,3}(?:[*+-]|1[.)])[ \\t]'],
  ['html', htmlPattern],
  ['tag', BLOCK_TAGS],
]);

// The paragraph rule template: a run of lines none of which starts one of
// the interrupting constructs named in its lookahead.
const paragraphTemplate = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
function composeParagraph(listPattern, tableRule) {
  return composeRegex(paragraphTemplate, [
    ['hr', /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/],
    ['heading', headingPattern],
    ['|lheading', ''],
    ...(tableRule ? [['table', tableRule]] : [['|table', '']]),
    ['blockquote', ' {0,3}>'],
    ['fences', fencesPattern],
    ['list', listPattern],
    ['html', htmlPattern],
    ['tag', BLOCK_TAGS],
  ]);
}

// ---------------------------------------------------------------------------
// Block grammar (GFM)
// ---------------------------------------------------------------------------

const blockNewline = /^(?:[ \t]*(?:\n|$))+/;
const blockCode = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const blockFences = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const blockHeading = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const blockHr = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const blockquoteInnerParagraph = composeParagraph(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/, null);
const blockBlockquote = composeRegex(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/, [['paragraph', blockquoteInnerParagraph]]);
const blockHtml = /^ {0,3}(?:<(script|pre|style|textarea)[\s>][\s\S]*?(?:<\/\1>[^\n]*\n*|$)|<!--(?:-?>|[\s\S]*?(?:-->|$))[^\n]*(\n+|$)|<\?[\s\S]*?(?:\?>[^\n]*\n*|$)|<![A-Z][\s\S]*?(?:>[^\n]*\n*|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>[^\n]*\n*|$)|<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]+|\n|\/?>|$)[\s\S]*?(?:(?:\n[ 	]*)+\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?)*? *\/?>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ 	]*)+\n|$)|<\/[a-z][a-z0-9-]*\s*>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ 	]*)+\n|$))/i;
const blockDef = /^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))))? *(?:\n+|$)/;
const blockList = /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/;
const blockTable = blockTableComposed;
const blockLheading = composeRegex(/^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/, [
  [/bull/g, / {0,3}(?:[*+-]|\d{1,9}[.)])/],
  [/blockCode/g, /(?: {4}| {0,3}\t)/],
  [/fences/g, ' {0,3}(?:`{3,}|~{3,})'],
  [/blockquote/g, ' {0,3}>'],
  [/heading/g, headingPattern],
  [/hr/g, ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)'],
  [/html/g, ' {0,3}<[^\\n>]+>\\n'],
  [/table/g, ' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n'],
]);
const blockParagraph = composeParagraph(' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]', blockTableComposed);
const blockText = /^[^\n]+/;


// ---------------------------------------------------------------------------
// Inline grammar (GFM)
// ---------------------------------------------------------------------------

const inlineEscape = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const inlineTag = /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/;
const inlineLink = /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\([ \t\n]*(<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\)))(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)))?[ \t\n]*\)/;
const inlineReflink = /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]/;
const inlineNolink = /^!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\](?:\[\])?/;
const inlineCode = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const inlineBr = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const inlineAutolink = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;
const inlineUrl = /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const inlineBackpedal = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const inlineDel = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;
const inlineText = /^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/;
const inlinePunctuation = /^((?![*_])[\s\p{P}\p{S}])/u;
const inlineAnyPunctuation = /\\([\p{P}\p{S}])/gu;
const inlineAnyPunctuationOutsideCode = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const inlineBlockSkip = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
const inlineReflinkSearch = /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g;
const inlineEmStrongLDelim = /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u;
const inlineEmStrongRDelimAst = /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu;
const inlineEmStrongRDelimUnd = /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu;
const inlineDelLDelim = /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u;
const inlineDelRDelim = /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu;

// ---------------------------------------------------------------------------
// Lexer state
// ---------------------------------------------------------------------------

// One lexer context per parse() call: the link definitions collected from
// the document, the inline state shared across the whole document, the queue
// of inline runs waiting to be tokenised (block tokenisers queue their text
// and the queue is worked off in order), and the stack of emphasis-closer
// scans belonging to the inline runs currently being processed.
function createLexer() {
  return {
    links: Object.create(null),
    state: { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true },
    inlineQueue: [],
    closerStack: [],
  };
}

function queueInline(L, src) {
  const tokens = [];
  L.inlineQueue.push({ src, tokens });
  return tokens;
}

// ---------------------------------------------------------------------------
// Block tokenisers. Each returns a token or undefined; the caller advances
// past token.raw, whose length is part of the behaviour (several tokens
// report a raw shorter than the text their grammar matched).
// ---------------------------------------------------------------------------

function tokSpace(L, src) {
  const m = blockNewline.exec(src);
  if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
}

function tokCode(L, src) {
  const m = blockCode.exec(src);
  if (m) {
    const raw = trimBlankTail(m[0]);
    return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(re.codeRemoveIndent, '') };
  }
}

// Remove the indentation a fenced block's opening line lends to its content
// (the compensation marked applies when the fence itself is indented).
function fenceIndentCompensation(raw, text) {
  const m = raw.match(re.indentCodeCompensation);
  if (m === null) return text;
  const indent = m[1];
  return text
    .split('\n')
    .map((line) => {
      const lead = line.match(re.beginningSpace);
      if (lead === null) return line;
      return line.slice(Math.min(lead[0].length, indent.length));
    })
    .join('\n');
}

function tokFences(L, src) {
  const m = blockFences.exec(src);
  if (m) {
    return {
      type: 'code',
      raw: m[0],
      lang: m[2] ? m[2].trim().replace(inlineAnyPunctuation, '$1') : m[2],
      text: fenceIndentCompensation(m[0], m[3] || ''),
    };
  }
}

function tokHeading(L, src) {
  const m = blockHeading.exec(src);
  if (m) {
    let text = m[2].trim();
    if (re.endingHash.test(text)) {
      const stripped = rtrimChar(text, '#');
      if (!stripped || re.endingSpaceTabChar.test(stripped)) text = stripped.trim();
    }
    return { type: 'heading', raw: rtrimChar(m[0], '\n'), depth: m[1].length, text, tokens: queueInline(L, text) };
  }
}

function tokHr(L, src) {
  const m = blockHr.exec(src);
  if (m) return { type: 'hr', raw: rtrimChar(m[0], '\n') };
}

function tokBlockquote(L, src) {
  const m = blockBlockquote.exec(src);
  if (!m) return;
  let lines = rtrimChar(m[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];
  while (lines.length > 0) {
    let hitMarker = false;
    const chunk = [];
    let p;
    for (p = 0; p < lines.length; p++) {
      if (re.blockquoteStart.test(lines[p])) {
        chunk.push(lines[p]);
        hitMarker = true;
      } else if (!hitMarker) {
        chunk.push(lines[p]);
      } else break;
    }
    lines = lines.slice(p);
    const chunkRaw = chunk.join('\n');
    const chunkText = chunkRaw
      .replace(re.blockquoteMarkerWhitespace, (g, marker, ws) => marker + expandTabs(ws, marker.length))
      .replace(re.blockquoteSetextReplace, '\n    $1')
      .replace(re.blockquoteSetextReplace2, '');
    raw = raw ? raw + '\n' + chunkRaw : chunkRaw;
    text = text ? text + '\n' + chunkText : chunkText;
    const prevTop = L.state.top;
    L.state.top = true;
    lexBlock(L, chunkText, tokens, true);
    L.state.top = prevTop;
    if (lines.length === 0) break;
    const last = tokens[tokens.length - 1];
    if (last && (last.type === 'code' || last.type === 'heading' || last.type === 'hr' || last.type === 'html' || last.type === 'table')) break;
    if (last && last.type === 'blockquote') {
      const joined = lines.join('\n');
      const mergedSrc = last.raw + '\n' + joined.replace(re.blockquoteSetextReplace2, '');
      const merged = tokBlockquote(L, mergedSrc);
      tokens[tokens.length - 1] = merged;
      const rest = mergedSrc.substring(merged.raw.length).replace(/^\n/, '');
      const restCount = rest ? rest.split('\n').length : 0;
      const used = restCount ? lines.slice(0, -restCount) : lines;
      if (used.length > 0) raw = raw + '\n' + used.join('\n');
      text = text.substring(0, text.length - last.text.length) + merged.text;
      lines = lines.slice(used.length);
      if (lines.length > 0 && re.blockquoteStart.test(lines[0])) continue;
      break;
    } else if (last && last.type === 'list') {
      const joined = lines.join('\n');
      const mergedSrc = last.raw + '\n' + joined;
      const merged = tokList(L, mergedSrc);
      tokens[tokens.length - 1] = merged;
      const extra = merged.raw.length > last.raw.length
        ? mergedSrc.slice(last.raw.length + 1, merged.raw.length).split('\n').length
        : 0;
      if (extra > 0) {
        const usedText = lines.slice(0, extra).join('\n');
        raw = raw + '\n' + usedText;
        text = text + '\n' + usedText;
      }
      lines = lines.slice(extra);
      continue;
    }
  }
  return { type: 'blockquote', raw, tokens, text };
}

// The per-indent "next construct begins here" grammars used by the list
// item scan are compiled once and shared (they are only ever tested, never
// exec'd, so their lastIndex stays at zero).
const beginCache = new Map();
function beginRegexes(indent) {
  let r = beginCache.get(indent);
  if (!r) {
    r = {
      nextBullet: nextBulletRegex(indent),
      hr: hrBeginRegex(indent),
      fences: fencesBeginRegex(indent),
      heading: headingBeginRegex(indent),
      html: htmlBeginRegex(indent),
      bq: blockquoteBeginRegex(indent),
    };
    beginCache.set(indent, r);
  }
  return r;
}

const itemReCache = new Map();
function itemRegex(bulletPattern) {
  let r = itemReCache.get(bulletPattern);
  if (!r) {
    r = listItemRegex(bulletPattern);
    itemReCache.set(bulletPattern, r);
  }
  return r;
}

function firstLineOf(s) {
  const i = s.indexOf('\n');
  return i === -1 ? s : s.slice(0, i);
}

// Index of the first character that is not a space, or -1 (the semantics
// of String.search with the non-space pattern).
function firstNonSpace(s) {
  let i = 0;
  while (s.charCodeAt(i) === 32) i++;
  return i < s.length ? i : -1;
}

// Whether any of the "a new construct begins here" grammars matches str.
// All of them need, after at most maxSpaces spaces, one of a small set of
// trigger characters; anything else is rejected without running them. When
// a trigger is present the grammars themselves decide, in grammar order.
function beginTrigger(str, maxSpaces) {
  let s = 0;
  while (str.charCodeAt(s) === 32) s++;
  if (s > maxSpaces) return -1;
  const c = str.charCodeAt(s);
  return (c === 96 || c === 126 || c === 35 || c === 60 || c === 62 || c === 42 ||
    c === 43 || c === 45 || c === 95 || (c >= 48 && c <= 57)) ? c : -1;
}

function anyBeginTest(begins, str, maxSpaces) {
  if (beginTrigger(str, maxSpaces) === -1) return false;
  return begins.fences.test(str) || begins.heading.test(str) || begins.html.test(str) ||
    begins.bq.test(str) || begins.nextBullet.test(str) || begins.hr.test(str);
}

function anyBeginTestNoBullet(begins, str, maxSpaces) {
  if (beginTrigger(str, maxSpaces) === -1) return false;
  return begins.fences.test(str) || begins.heading.test(str) ||
    begins.html.test(str) || begins.hr.test(str);
}

// Expand tabs in a line's leading whitespace, starting the tab stops at
// column `col`. A leading run without tabs expands to itself.
function expandLeading(line, col) {
  let i = 0;
  while (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9) i++;
  if (i === 0) return line;
  const lead = line.slice(0, i);
  if (!lead.includes('\t')) return line;
  return expandTabs(lead, col) + line.slice(i);
}

function tokList(L, src) {
  const first = blockList.exec(src);
  if (!first) return;
  const fullSrc = src;
  let rest = src;
  const consumed = () => fullSrc.length - rest.length;
  const bullet = first[1].trim();
  const ordered = bullet.length > 1;
  const list = {
    type: 'list',
    raw: '',
    ordered,
    start: ordered ? +bullet.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  const bulletPattern = ordered ? `\\d{1,9}\\${bullet.slice(-1)}` : `\\${bullet}`;
  const itemRe = itemRegex(bulletPattern);
  let prevItemBlank = false;
  let m;
  while (rest) {
    let blankConsumed = false;
    let itemText = '';
    m = itemRe.exec(rest);
    if (!m || blockHr.test(rest)) break;
    const itemStart = consumed();
    rest = rest.substring(m[0].length);
    const firstLine = firstLineOf(m[2]);
    const bulletLen = m[1].length;
    let lineContent = expandLeading(firstLine, bulletLen);
    let nextLine = firstLineOf(rest);
    let blank = !lineContent.trim();
    let indent;
    if (blank) {
      indent = bulletLen + 1;
    } else {
      indent = lineContent.search(re.nonSpaceChar);
      if (indent > 4) indent = 1;
      itemText = lineContent.slice(indent);
      indent += bulletLen;
    }
    if (blank && re.blankLine.test(nextLine)) {
      rest = rest.substring(nextLine.length + 1);
      blankConsumed = true;
    }
    if (!blankConsumed) {
      const begins = beginRegexes(indent);
      const maxBeginSpaces = Math.min(indent - 1, 3);
      while (rest) {
        const line = firstLineOf(rest);
        const expanded = expandLeading(line, 0);
        if (anyBeginTest(begins, line, maxBeginSpaces)) break;
        if (firstNonSpace(expanded) >= indent || !line.trim()) {
          itemText += '\n' + expanded.slice(indent);
        } else {
          if (
            blank ||
            lineContent.replace(/\t/g, '    ').search(re.nonSpaceChar) >= 4 ||
            anyBeginTestNoBullet(begins, lineContent, maxBeginSpaces)
          ) break;
          const outLine = /^ {0,3}(?:=+|-+) *$/.test(line) && blockLheading.test(lineContent + '\n' + line)
            ? '    ' + expanded.replace(/^ {0,3}/, '')
            : line;
          itemText += '\n' + outLine;
        }
        blank = !line.trim();
        rest = rest.substring(line.length + 1);
        lineContent = expanded.slice(indent);
      }
    }
    const itemRaw = fullSrc.slice(itemStart, consumed());
    if (!list.loose) {
      if (prevItemBlank) list.loose = true;
      else if (re.doubleBlankLine.test(itemRaw)) prevItemBlank = true;
    }
    list.items.push({
      type: 'list_item',
      raw: itemRaw,
      task: re.listIsTask.test(itemText),
      loose: false,
      text: itemText,
      tokens: [],
    });
  }
  const lastItem = list.items[list.items.length - 1];
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else return;
  list.raw = fullSrc.slice(0, consumed()).trimEnd();
  for (const item of list.items) {
    L.state.top = false;
    item.tokens = lexBlock(L, item.text, []);
    if (!list.loose) {
      const spaces = item.tokens.filter((t) => t.type === 'space');
      if (spaces.length > 0 && spaces.some((t) => re.anyLine.test(t.raw))) list.loose = true;
    }
  }
  for (const item of list.items) {
    const firstTok = item.tokens[0];
    if (item.task && firstTok && (firstTok.type === 'text' || firstTok.type === 'paragraph')) {
      item.text = item.text.replace(re.listReplaceTask, '');
      firstTok.raw = firstTok.raw.replace(re.listReplaceTask, '');
      firstTok.text = firstTok.text.replace(re.listReplaceTask, '');
      for (let g = L.inlineQueue.length - 1; g >= 0; g--) {
        if (re.listIsTask.test(L.inlineQueue[g].src)) {
          L.inlineQueue[g].src = L.inlineQueue[g].src.replace(re.listReplaceTask, '');
          break;
        }
      }
      const cb = re.listTaskCheckbox.exec(item.raw);
      if (cb) {
        const checkbox = { type: 'checkbox', raw: cb[0] + ' ', checked: cb[0] !== '[ ]' };
        item.checked = checkbox.checked;
        if (list.loose) {
          const head = item.tokens[0];
          if (head && (head.type === 'paragraph' || head.type === 'text') && head.tokens) {
            head.raw = checkbox.raw + head.raw;
            head.text = checkbox.raw + head.text;
            head.tokens.unshift(checkbox);
          } else {
            item.tokens.unshift({ type: 'paragraph', raw: checkbox.raw, text: checkbox.raw, tokens: [checkbox] });
          }
        } else {
          item.tokens.unshift(checkbox);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const t of item.tokens) if (t.type === 'text') t.type = 'paragraph';
    }
  }
  return list;
}

function tokHtmlBlock(L, src) {
  const m = blockHtml.exec(src);
  if (m) {
    const text = trimBlankTail(m[0]);
    return { type: 'html', block: true, raw: text, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style', text };
  }
}

function tokDef(L, src) {
  const m = blockDef.exec(src);
  if (m) {
    if (!re.startAngleBracket.test(m[2]) && checkBrackets(m[2], '()') !== -1) return;
    return {
      type: 'def',
      tag: normalizeLabel(m[1]),
      raw: rtrimChar(m[0], '\n'),
      href: m[2] ? m[2].replace(re.hrefBrackets, '$1').replace(inlineAnyPunctuation, '$1') : '',
      title: m[3] ? m[3].substring(1, m[3].length - 1).replace(inlineAnyPunctuation, '$1') : m[3],
    };
  }
}

function tokTable(L, src) {
  const m = blockTable.exec(src);
  if (!m || !re.tableDelimiter.test(m[2])) return;
  const headerCells = splitCells(m[1]);
  const alignRow = m[2].replace(re.tableAlignChars, '').split('|');
  const rowLines = m[3] && m[3].trim() ? m[3].replace(re.tableRowBlankLine, '').split('\n') : [];
  if (headerCells.length !== alignRow.length) return;
  const table = { type: 'table', raw: rtrimChar(m[0], '\n'), header: [], align: [], rows: [] };
  for (const cell of alignRow) {
    table.align.push(
      re.tableAlignRight.test(cell) ? 'right'
        : re.tableAlignCenter.test(cell) ? 'center'
        : re.tableAlignLeft.test(cell) ? 'left'
        : null
    );
  }
  for (let i = 0; i < headerCells.length; i++) {
    table.header.push({ text: headerCells[i], tokens: queueInline(L, headerCells[i]), header: true, align: table.align[i] });
  }
  for (const rowText of rowLines) {
    table.rows.push(
      splitCells(rowText, headerCells.length).map((cell, j) => ({
        text: cell,
        tokens: queueInline(L, cell),
        header: false,
        align: table.align[j],
      }))
    );
  }
  return table;
}

function tokLheading(L, src) {
  const m = blockLheading.exec(src);
  if (m) {
    const text = m[1].trim();
    return { type: 'heading', raw: rtrimChar(m[0], '\n'), depth: m[2].charAt(0) === '=' ? 1 : 2, text, tokens: queueInline(L, text) };
  }
}

function tokParagraph(L, src) {
  const m = blockParagraph.exec(src);
  if (m) {
    const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
    return { type: 'paragraph', raw: m[0], text, tokens: queueInline(L, text) };
  }
}

function tokText(L, src) {
  const m = blockText.exec(src);
  if (m) return { type: 'text', raw: m[0], text: m[0], tokens: queueInline(L, m[0]) };
}

// ---------------------------------------------------------------------------
// The block lexer: try each block tokeniser in grammar order and merge the
// tokens the grammar merges (a definition or an indented code block that
// follows a paragraph joins it; consecutive text lines join).
// ---------------------------------------------------------------------------

// Necessary-condition gates for the two most expensive block grammars.
// A table needs a delimiter row as its second line: only pipes, colons,
// dashes and spaces, with at least one pipe.
function tablePossible(src) {
  const nl = src.indexOf('\n');
  if (nl === -1) return false;
  let end = src.indexOf('\n', nl + 1);
  if (end === -1) end = src.length;
  let hasPipe = false;
  for (let i = nl + 1; i < end; i++) {
    const c = src.charCodeAt(i);
    if (c === 124) hasPipe = true;
    else if (c !== 58 && c !== 45 && c !== 32) return false;
  }
  return hasPipe;
}

// A setext heading needs an underline line (only '=' or only '-', up to
// three leading spaces) before the first blank line: the heading text
// cannot cross a blank line.
function lheadingPossible(src) {
  let lineStart = 0;
  for (;;) {
    const nl = src.indexOf('\n', lineStart);
    if (nl === -1) return false;
    let j = nl + 1;
    let spaces = 0;
    while (src.charCodeAt(j) === 32 && spaces < 4) { j++; spaces++; }
    const ch = src.charCodeAt(j);
    if (ch === 61 || ch === 45) {
      let k = j;
      while (src.charCodeAt(k) === ch) k++;
      let t = k;
      while (src.charCodeAt(t) === 32 || src.charCodeAt(t) === 9) t++;
      if (t >= src.length || src.charCodeAt(t) === 10) return true;
    }
    // Is the line starting at nl + 1 blank? Then no underline can follow.
    let b = nl + 1;
    while (src.charCodeAt(b) === 32 || src.charCodeAt(b) === 9) b++;
    if (b >= src.length || src.charCodeAt(b) === 10) return false;
    lineStart = nl + 1;
  }
}

function lexBlock(L, src, tokens, clipped = false) {
  let lastLen = Infinity;
  while (src) {
    if (src.length < lastLen) lastLen = src.length;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    let tok;
    // Dispatch: most block grammars can only match when the first line
    // starts (after up to three spaces) with a specific character. Skipping
    // the ones that cannot match leaves the grammar order unchanged.
    const c0 = src.charCodeAt(0);
    let i0 = 0;
    while (i0 < 3 && src.charCodeAt(i0) === 32) i0++;
    const fc = src.charCodeAt(i0);
    // The space grammar matches runs of blank lines, whose first line may
    // carry leading spaces or tabs.
    let spacePossible = c0 === 10;
    if (!spacePossible && (c0 === 32 || c0 === 9)) {
      let j = 0;
      while (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9) j++;
      spacePossible = j >= src.length || src.charCodeAt(j) === 10;
    }
    if (spacePossible && (tok = tokSpace(L, src))) {
      src = src.substring(tok.raw.length);
      const last = tokens[tokens.length - 1];
      if (tok.raw.length === 1 && last !== undefined) last.raw += '\n';
      else tokens.push(tok);
      continue;
    }
    if ((c0 === 32 || c0 === 9) && (tok = tokCode(L, src))) {
      src = src.substring(tok.raw.length);
      const last = tokens[tokens.length - 1];
      if (last && (last.type === 'paragraph' || last.type === 'text')) {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        last.text += '\n' + tok.text;
        L.inlineQueue[L.inlineQueue.length - 1].src = last.text;
      } else tokens.push(tok);
      continue;
    }
    if ((fc === 96 || fc === 126) && (tok = tokFences(L, src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if (fc === 35 && (tok = tokHeading(L, src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((fc === 45 || fc === 42 || fc === 95) && (tok = tokHr(L, src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if (fc === 62 && (tok = tokBlockquote(L, src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((fc === 45 || fc === 42 || fc === 43 || (fc >= 48 && fc <= 57)) && (tok = tokList(L, src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if (fc === 60 && (tok = tokHtmlBlock(L, src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if (fc === 91 && (tok = tokDef(L, src))) {
      src = src.substring(tok.raw.length);
      const last = tokens[tokens.length - 1];
      if (last && (last.type === 'paragraph' || last.type === 'text')) {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        last.text += '\n' + tok.raw;
        L.inlineQueue[L.inlineQueue.length - 1].src = last.text;
      } else {
        if (!Object.hasOwn(L.links, tok.tag)) L.links[tok.tag] = { href: tok.href, title: tok.title };
        tokens.push(tok);
      }
      continue;
    }
    if (tablePossible(src) && (tok = tokTable(L, src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if (lheadingPossible(src) && (tok = tokLheading(L, src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if (L.state.top && (tok = tokParagraph(L, src))) {
      const last = tokens[tokens.length - 1];
      if (clipped && last && last.type === 'paragraph') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        last.text += '\n' + tok.text;
        L.inlineQueue.pop();
        L.inlineQueue[L.inlineQueue.length - 1].src = last.text;
      } else tokens.push(tok);
      clipped = false;
      src = src.substring(tok.raw.length);
      continue;
    }
    if ((tok = tokText(L, src))) {
      src = src.substring(tok.raw.length);
      const last = tokens[tokens.length - 1];
      if (last && last.type === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        last.text += '\n' + tok.text;
        L.inlineQueue.pop();
        L.inlineQueue[L.inlineQueue.length - 1].src = last.text;
      } else tokens.push(tok);
      continue;
    }
    if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  L.state.top = true;
  return tokens;
}

// ---------------------------------------------------------------------------
// Emphasis support: masking and closer scans.
//
// Before inline tokenising, a copy of the source is masked: reference links
// that resolve, code spans, link destinations and raw HTML are blanked to
// runs of "a" (and escaped punctuation to "+"), so delimiter runs inside
// them cannot be mistaken for emphasis closers. The masked copy has the same
// length as the original, so indices line up.
// ---------------------------------------------------------------------------

function linkInText(L, text) {
  if (!text.includes('[')) return false;
  for (const m of text.matchAll(inlineBlockSkip)) {
    if (inlineLink.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of text.matchAll(inlineReflinkSearch)) {
    const s = m[0];
    const r = s.lastIndexOf('[');
    const resolves = s.charAt(0) !== '!' && Object.hasOwn(L.links, normalizeLabel(s.slice(r + 1, -1)));
    if (resolves && !(r > 1 && linkInText(L, s.slice(1, r - 1)))) return true;
  }
  return false;
}

function maskSource(L, src) {
  let t = src;
  if (L.links && Object.keys(L.links).length > 0 && src.includes('[')) {
    const maskRef = (r) => {
      const o = r.lastIndexOf('[');
      if (!Object.hasOwn(L.links, normalizeLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const inner = r.slice(1, o - 1);
        if (linkInText(L, inner)) {
          return '[' + inner.replace(inlineReflinkSearch, maskRef) + '][' + 'a'.repeat(r.length - o - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(inlineReflinkSearch, maskRef);
  }
  if (src.includes('\\') || src.includes('`')) {
    t = t.replace(inlineAnyPunctuationOutsideCode, (match, code, esc) =>
      esc ? '+'.repeat(match.length)
        : code ? code + match.slice(code.length, -code.length).replace(/`/g, '+') + code
        : match
    );
  }
  if (src.includes('[') || src.includes('<') || src.includes('`')) {
    t = t.replace(inlineBlockSkip, (match, g1, g2) => {
      const o = g2 ? g2.length : 0;
      return match.slice(0, o) + '[' + 'a'.repeat(match.length - o - 2) + ']';
    });
  }
  return t;
}

// Scan a (masked) inline source for the last run of each emphasis delimiter
// that could close an emphasis span: a run whose preceding character is not
// whitespace.
function scanClosers(a) {
  const lastEm = { '*': -1, _: -1 };
  let lastDel = -1;
  const n = a.length;
  for (let s = 0; s < n; s++) {
    const r = a[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const prev = s === 0 ? '\n' : a[s - 1];
    let i = s + 1;
    while (i < n && a[i] === r) i++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (r === '~') lastDel = s;
      else lastEm[r] = s;
    }
    s = i - 1;
  }
  return { maskedSrc: a, lastEm, lastDel };
}

function lastEmCloser(L, masked, ch) {
  const top = L.closerStack[L.closerStack.length - 1];
  return top && top.maskedSrc === masked ? top.lastEm[ch] : scanClosers(masked).lastEm[ch];
}

function lastDelCloser(L, masked) {
  const top = L.closerStack[L.closerStack.length - 1];
  return top && top.maskedSrc === masked ? top.lastDel : scanClosers(masked).lastDel;
}

// ---------------------------------------------------------------------------
// Inline tokenisers
// ---------------------------------------------------------------------------

function tokEscape(L, src) {
  const m = inlineEscape.exec(src);
  if (m) return { type: 'escape', raw: m[0], text: m[1] };
}

function tokTag(L, src) {
  const m = inlineTag.exec(src);
  if (m) {
    if (!L.state.inLink && re.startATag.test(m[0])) L.state.inLink = true;
    else if (L.state.inLink && re.endATag.test(m[0])) L.state.inLink = false;
    if (!L.state.inRawBlock && re.startPreScriptTag.test(m[0])) L.state.inRawBlock = true;
    else if (L.state.inRawBlock && re.endPreScriptTag.test(m[0])) L.state.inRawBlock = false;
    return { type: 'html', raw: m[0], inLink: L.state.inLink, inRawBlock: L.state.inRawBlock, block: false, text: m[0] };
  }
}

// Whether a link label holds a "<" that opens a tag or autolink reaching
// past the label's end (in which case the link does not form).
function labelHasOpenTag(fullSrc, label, labelOffset) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') { s++; continue; }
    if (label[s] === '`') {
      const m = inlineCode.exec(label.slice(s));
      if (m) { s += m[0].length - 1; continue; }
    }
    if (label[s] !== '<') continue;
    const m = inlineTag.exec(fullSrc.slice(labelOffset + s)) || inlineAutolink.exec(fullSrc.slice(labelOffset + s));
    if (m) {
      if (m[0].length > label.length - s) return true;
      s += m[0].length - 1;
    }
  }
  return false;
}

// Build the link or image token for a matched link, tokenising its label.
// Returns undefined when the label itself emitted a link (a link cannot
// contain a link, so the outer one does not form).
function outputLink(L, match, link, raw) {
  const href = link.href;
  const title = link.title || null;
  const text = match[1].replace(re.outputLinkReplace, '$1');
  const isImage = match[0].charAt(0) === '!';
  const prevInLink = L.state.inLink;
  const prevEmitted = L.state.linkEmitted;
  const prevRawBlock = L.state.inRawBlock;
  L.state.inLink = true;
  L.state.linkEmitted = false;
  const tokens = inlineTokens(L, text);
  const emitted = L.state.linkEmitted;
  L.state.linkEmitted = prevEmitted;
  L.state.inLink = prevInLink;
  if (!isImage) {
    if (emitted) {
      L.state.inRawBlock = prevRawBlock;
      return;
    }
    L.state.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
}

function tokLink(L, src) {
  if (L.state.linkParenPossible === false) return;
  const m = inlineLink.exec(src);
  if (m) {
    const labelOffset = m[0].charAt(0) === '!' ? 2 : 1;
    if (labelHasOpenTag(src, m[1], labelOffset)) return;
    const hrefTrimmed = m[2].trim();
    if (re.startAngleBracket.test(hrefTrimmed)) {
      if (!re.endAngleBracket.test(hrefTrimmed)) return;
      const stripped = rtrimChar(hrefTrimmed.slice(0, -1), '\\');
      if ((hrefTrimmed.length - stripped.length) % 2 === 0) return;
    } else {
      const parenIdx = checkBrackets(m[2], '()');
      if (parenIdx === -2) return;
      if (parenIdx > -1) {
        const end = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + parenIdx;
        m[2] = m[2].substring(0, parenIdx);
        m[0] = m[0].substring(0, end).trim();
        m[3] = '';
      }
    }
    const beforeClose = rtrimChar(m[0].slice(0, -1), '\\');
    if ((m[0].length - beforeClose.length) % 2 === 0) return;
    let href = m[2];
    const title = m[3] ? m[3].slice(1, -1) : '';
    href = href.trim();
    if (re.startAngleBracket.test(href)) href = href.slice(1, -1);
    return outputLink(L, m, {
      href: href && href.replace(inlineAnyPunctuation, '$1'),
      title: title && title.replace(inlineAnyPunctuation, '$1'),
    }, m[0]);
  }
}

function tokReflink(L, src) {
  let m;
  if ((m = inlineReflink.exec(src)) || (m = inlineNolink.exec(src))) {
    const labelOffset = m[0].charAt(0) === '!' ? 2 : 1;
    if (labelHasOpenTag(src, m[1], labelOffset)) return;
    const link = L.links[normalizeLabel(m[2] || m[1])];
    if (!link) {
      const ch = m[0].charAt(0);
      return { type: 'text', raw: ch, text: ch };
    }
    return outputLink(L, m, link, m[0]);
  }
}

function tokEmStrong(L, src, masked, prevChar) {
  let m = inlineEmStrongLDelim.exec(src);
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return;
  const delim = m[0][0];
  const onlyStrong = prevChar === delim;
  const offset = masked.length - src.length;
  let back = offset;
  while (back > 0 && masked[back - 1] === delim) back--;
  const before = [...masked.slice(Math.max(0, back - 2), back)].at(-1) ?? '';
  const beforeIsPunct = before === '*' || before === '_' || !!inlinePunctuation.exec(before);
  if (back < offset) prevChar = before;
  const prevIsPunct = back < offset ? beforeIsPunct : !!inlinePunctuation.exec(prevChar);
  if (m[4] && prevChar.match(re.unicodeAlphaNumeric)) return;
  const punctAfter = m[1] || m[3] || '';
  if (!punctAfter || !prevChar || prevIsPunct) {
    const openLen = [...m[0]].length - 1;
    let openerLeft = openLen;
    let closerCredit = 0;
    const openRun = offset - back + openLen;
    const canShortCircuit = !!before.trim() && (!!punctAfter || (delim === '*' && !beforeIsPunct));
    if (delim !== '*' && delim !== '_') return;
    const rDelim = delim === '*' ? inlineEmStrongRDelimAst : inlineEmStrongRDelimUnd;
    const lastCloser = lastEmCloser(L, masked, delim);
    const startPos = offset + openLen;
    if (lastCloser < startPos) return;
    const rest = masked.slice(startPos);
    const maxIndex = lastCloser - startPos;
    rDelim.lastIndex = 0;
    while ((m = rDelim.exec(rest)) !== null && !(m.index > maxIndex)) {
      const run = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
      if (!run) continue;
      let runLen = [...run].length;
      if (m[3] || m[4]) {
        openerLeft += runLen;
        continue;
      } else if (m[5] || m[6] || canShortCircuit) {
        if (onlyStrong && (m[5] || m[6])) break;
        if (openRun % 3 && !((openRun + runLen) % 3)) {
          closerCredit += runLen;
          continue;
        }
      }
      openerLeft -= runLen;
      if (openerLeft > 0) continue;
      runLen = Math.min(runLen, runLen + openerLeft + closerCredit);
      const firstCpLen = [...m[0]][0].length;
      const raw = src.slice(0, openLen + m.index + firstCpLen + runLen);
      if (Math.min(openLen, runLen) % 2) {
        const text = raw.slice(1, -1);
        return { type: 'em', raw, text, tokens: inlineTokens(L, text) };
      }
      const text = raw.slice(2, -2);
      return { type: 'strong', raw, text, tokens: inlineTokens(L, text) };
    }
  }
}

function tokCodespan(L, src) {
  const m = inlineCode.exec(src);
  if (m) {
    let text = m[2].replace(/\n/g, ' ');
    const hasNonSpace = re.nonSpaceChar.test(text);
    const surrounded = /^ /.test(text) && / $/.test(text);
    if (hasNonSpace && surrounded) text = text.substring(1, text.length - 1);
    return { type: 'codespan', raw: m[0], text };
  }
}

function tokBr(L, src) {
  const m = inlineBr.exec(src);
  if (m) return { type: 'br', raw: m[0] };
}

function tokDel(L, src, masked, prevChar) {
  let m = inlineDelLDelim.exec(src);
  if (!m) return;
  if (!(m[1] || '') || !prevChar || inlinePunctuation.exec(prevChar)) {
    const openLen = [...m[0]].length - 1;
    let openerLeft = openLen;
    const lastCloser = lastDelCloser(L, masked);
    const startPos = masked.length - src.length + openLen;
    if (lastCloser < startPos) return;
    const rest = masked.slice(startPos);
    const maxIndex = lastCloser - startPos;
    inlineDelRDelim.lastIndex = 0;
    while ((m = inlineDelRDelim.exec(rest)) !== null && !(m.index > maxIndex)) {
      const run = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
      if (!run) continue;
      let runLen = [...run].length;
      if (runLen !== openLen) continue;
      if (m[3] || m[4]) {
        openerLeft += runLen;
        continue;
      }
      openerLeft -= runLen;
      if (openerLeft > 0) continue;
      runLen = Math.min(runLen, runLen + openerLeft);
      const firstCpLen = [...m[0]][0].length;
      const raw = src.slice(0, openLen + m.index + firstCpLen + runLen);
      const text = raw.slice(openLen, -openLen);
      return { type: 'del', raw, text, tokens: inlineTokens(L, text) };
    }
  }
}

function tokAutolink(L, src) {
  const m = inlineAutolink.exec(src);
  if (m) {
    let text, href;
    if (m[2] === '@') {
      text = m[1];
      href = 'mailto:' + text;
    } else {
      text = m[1];
      href = text;
    }
    return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
  }
}

function tokUrl(L, src) {
  const m = inlineUrl.exec(src);
  if (m) {
    let text, href;
    if (m[2] === '@') {
      text = m[0];
      href = 'mailto:' + m[0];
    } else {
      let prev;
      do {
        prev = m[0];
        m[0] = inlineBackpedal.exec(m[0])?.[0] ?? '';
      } while (prev !== m[0]);
      text = m[0];
      href = m[1] === 'www.' ? 'http://' + m[0] : m[0];
    }
    return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
  }
}

function tokInlineText(L, src) {
  const m = inlineText.exec(src);
  if (m) {
    const inRaw = L.state.inRawBlock;
    return { type: 'text', raw: m[0], text: inRaw ? m[0] : unescapeNumeric(m[0]), escaped: inRaw };
  }
}

// ---------------------------------------------------------------------------
// The inline lexer
// ---------------------------------------------------------------------------

function inlineTokens(L, src, tokens = []) {
  const prevParenPossible = L.state.linkParenPossible;
  L.state.linkParenPossible = prevParenPossible && src.includes(')');
  try {
    return inlineTokensMasked(L, src, tokens);
  } finally {
    L.state.linkParenPossible = prevParenPossible;
  }
}

function inlineTokensMasked(L, src, tokens) {
  const needsMask = src.includes('*') || src.includes('_') || src.includes('~');
  const masked = needsMask ? maskSource(L, src) : src;
  L.closerStack.push(scanClosers(masked));
  try {
    return inlineLoop(L, src, masked, tokens);
  } finally {
    L.closerStack.pop();
  }
}

// Whether the bare-url grammar can match at the start of src. Its
// alternatives are: a "mailto:" or "xmpp:" prefixed address, an
// http/https/ftp URL, a "www." address, or a bare email address whose
// local part is [A-Za-z0-9._+-]+. c is the first character code, already
// known to be alphanumeric.
function urlPossible(src, c) {
  if (c === 109 && src.startsWith('mailto:')) return true;
  if (c === 120 && src.startsWith('xmpp:')) return true;
  if (c === 119 && src.startsWith('www.')) return true;
  if (c === 104 || c === 72 || c === 102 || c === 70) {
    const head = src.slice(0, 8).toLowerCase();
    if (head.startsWith('http://') || head.startsWith('https://') || head.startsWith('ftp://')) return true;
  }
  let i = 0;
  for (;;) {
    const ch = src.charCodeAt(i);
    if ((ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || (ch >= 48 && ch <= 57) ||
      ch === 46 || ch === 95 || ch === 43 || ch === 45) i++;
    else break;
  }
  return i > 0 && src.charCodeAt(i) === 64;
}

function inlineLoop(L, src, masked, tokens) {
  let prevWasText = false;
  let prevChar = '';
  let lastLen = Infinity;
  while (src) {
    if (src.length < lastLen) lastLen = src.length;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    if (!prevWasText) prevChar = '';
    prevWasText = false;
    let tok;
    // Dispatch on the first character: every inline grammar is anchored and
    // can only match when the position starts with its trigger character(s),
    // so the attempts below are exactly the ones the grammar order allows.
    const c = src.charCodeAt(0);
    if (c === 92) { // backslash: escape, or a backslash line break
      if ((tok = tokEscape(L, src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = tokBr(L, src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    } else if (c === 60) { // '<': html tag, then autolink
      if ((tok = tokTag(L, src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = tokAutolink(L, src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    } else if (c === 91 || (c === 33 && src.charCodeAt(1) === 91)) { // '[' or '![', link then reflink
      if ((tok = tokLink(L, src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = tokReflink(L, src))) {
        src = src.substring(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (tok.type === 'text' && last && last.type === 'text') {
          last.raw += tok.raw;
          last.text += tok.text;
        } else tokens.push(tok);
        continue;
      }
    } else if (c === 42 || c === 95) { // '*' or '_'
      if ((tok = tokEmStrong(L, src, masked, prevChar))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    } else if (c === 96) { // backtick
      if ((tok = tokCodespan(L, src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    } else if (c === 126) { // '~'
      if ((tok = tokDel(L, src, masked, prevChar))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    } else if (c === 32) { // space: a two-space line break, else text
      if ((tok = tokBr(L, src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    } else if (!L.state.inLink && ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) && urlPossible(src, c)) {
      if ((tok = tokUrl(L, src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    }
    if ((tok = tokInlineText(L, src))) {
      src = src.substring(tok.raw.length);
      if (tok.raw.slice(-1) !== '_') prevChar = tok.raw.slice(-1);
      prevWasText = true;
      const last = tokens[tokens.length - 1];
      if (last && last.type === 'text') {
        last.raw += tok.raw;
        last.text += tok.text;
      } else tokens.push(tok);
      continue;
    }
    if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Renderer: walk the token tree once, building the HTML string. The
// text-only variant renders a token list as plain text (used for image alt
// attributes), the way marked's text renderer does.
// ---------------------------------------------------------------------------

function renderTextToken(tok, textOnly) {
  if (textOnly) return tok.tokens ? renderInline(tok.tokens, true) : tok.text;
  if (tok.tokens) return renderInline(tok.tokens, false);
  return tok.escaped ? tok.text : escapeHtml(tok.text);
}

function renderLink(tok, textOnly) {
  if (textOnly) return tok.tokens ? renderInline(tok.tokens, true) : tok.text;
  const text = tok.autolink ? escapeHtml(tok.text, true) : renderInline(tok.tokens, false);
  const href = encodeHref(tok.href);
  if (href === null) return text;
  let out = '<a href="' + escapeHtml(href, tok.autolink) + '"';
  if (tok.title) out += ' title="' + escapeHtml(tok.title) + '"';
  return out + '>' + text + '</a>';
}

function renderImage(tok, textOnly) {
  if (textOnly) return tok.tokens ? renderInline(tok.tokens, true) : tok.text;
  let text = tok.text;
  if (tok.tokens) text = renderInline(tok.tokens, true);
  const href = encodeHref(tok.href);
  if (href === null) return escapeHtml(text);
  let out = '<img src="' + escapeHtml(href) + '" alt="' + escapeHtml(text) + '"';
  if (tok.title) out += ' title="' + escapeHtml(tok.title) + '"';
  return out + '>';
}

function renderCheckbox(tok, textOnly) {
  if (textOnly) return tok.raw;
  return '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function renderInline(tokens, textOnly) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'escape': out += renderTextToken(tok, textOnly); break;
      case 'html': out += tok.text; break;
      case 'link': out += renderLink(tok, textOnly); break;
      case 'image': out += renderImage(tok, textOnly); break;
      case 'checkbox': out += renderCheckbox(tok, textOnly); break;
      case 'strong': out += textOnly ? renderInline(tok.tokens, true) : '<strong>' + renderInline(tok.tokens, false) + '</strong>'; break;
      case 'em': out += textOnly ? renderInline(tok.tokens, true) : '<em>' + renderInline(tok.tokens, false) + '</em>'; break;
      case 'codespan': out += textOnly ? tok.text : '<code>' + escapeHtml(tok.text, true) + '</code>'; break;
      case 'br': out += textOnly ? '' : '<br>'; break;
      case 'del': out += textOnly ? renderInline(tok.tokens, true) : '<del>' + renderInline(tok.tokens, false) + '</del>'; break;
      case 'text': out += renderTextToken(tok, textOnly); break;
      default: throw new Error('Token with "' + tok.type + '" type was not found.');
    }
  }
  return out;
}

function renderTableCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  return (cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`) + renderInline(cell.tokens, false) + `</${tag}>\n`;
}

function renderTable(tok) {
  let header = '';
  for (const cell of tok.header) header += renderTableCell(cell);
  let out = '<table>\n<thead>\n<tr>\n' + header + '</tr>\n</thead>\n';
  let body = '';
  for (const row of tok.rows) {
    let rowHtml = '';
    for (const cell of row) rowHtml += renderTableCell(cell);
    body += '<tr>\n' + rowHtml + '</tr>\n';
  }
  if (body) out += '<tbody>' + body + '</tbody>';
  return out + '</table>\n';
}

function renderCode(tok) {
  const lang = (tok.lang || '').match(re.notSpaceStart)?.[0];
  const text = tok.text ? tok.text.replace(re.endingNewline, '') + '\n' : '';
  const body = escapeHtml(text, true);
  return lang
    ? '<pre><code class="language-' + escapeHtml(lang) + '">' + body + '</code></pre>\n'
    : '<pre><code>' + body + '</code></pre>\n';
}

function renderList(tok) {
  let body = '';
  for (const item of tok.items) body += '<li>' + renderBlock(item.tokens) + '</li>\n';
  const tag = tok.ordered ? 'ol' : 'ul';
  const start = tok.ordered && tok.start !== 1 ? ' start="' + tok.start + '"' : '';
  return '<' + tag + start + '>\n' + body + '</' + tag + '>\n';
}

function renderBlock(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'space': break;
      case 'hr': out += '<hr>\n'; break;
      case 'heading': out += '<h' + tok.depth + '>' + renderInline(tok.tokens, false) + '</h' + tok.depth + '>\n'; break;
      case 'code': out += renderCode(tok); break;
      case 'table': out += renderTable(tok); break;
      case 'blockquote': out += '<blockquote>\n' + renderBlock(tok.tokens) + '</blockquote>\n'; break;
      case 'list': out += renderList(tok); break;
      case 'checkbox': out += renderCheckbox(tok, false); break;
      case 'html': out += tok.text; break;
      case 'def': break;
      case 'paragraph': out += '<p>' + renderInline(tok.tokens, false) + '</p>\n'; break;
      case 'text': out += renderTextToken(tok, false); break;
      default: throw new Error('Token with "' + tok.type + '" type was not found.');
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** The HTML marked 18.1.3 renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  const L = createLexer();
  const src = markdown.includes('\r') ? markdown.replace(/\r\n|\r/g, '\n') : markdown;
  const tokens = lexBlock(L, src, []);
  for (let i = 0; i < L.inlineQueue.length; i++) {
    const entry = L.inlineQueue[i];
    L.state.inRawBlock = false;
    inlineTokens(L, entry.src, entry.tokens);
  }
  return renderBlock(tokens);
}

