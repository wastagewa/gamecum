// Unit tests for the quote post-processing in static/js/hf-client.js.
// No dependencies and no runner needed:  node tests.hf-client.js
//
// These guard the cleanup that stands between a raw model completion and what
// gets stored: preamble/think-block stripping, the English-only detector, and
// the length trim that keeps a chatty completion under the server's cap instead
// of losing it to an HTTP 400.

const fs = require('fs');
const src = fs.readFileSync('static/js/hf-client.js', 'utf8');
eval(src);

let pass = 0, fail = 0;
function check(name, actual, expected) {
    const ok = actual === expected;
    if (ok) pass++; else { fail++; console.log(`FAIL ${name}\n  got:      ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`); }
}
function checkTrue(name, v) { check(name, !!v, true); }

// normalizeQuote
check('strips wrapping double quotes',
    normalizeQuote('"You look incredible tonight."'), 'You look incredible tonight.');
check('strips curly quotes',
    normalizeQuote('\u201CSoft light, sharp lines.\u201D'), 'Soft light, sharp lines.');
check('strips preamble',
    normalizeQuote("Sure! Here's a caption: Golden hour suits you."), 'Golden hour suits you.');
check('strips think block',
    normalizeQuote('<think>hmm, tags say abs</think>Those abs are doing the talking.'),
    'Those abs are doing the talking.');
check('strips unterminated think block',
    normalizeQuote('reasoning noise</think>Clean output here.'), 'Clean output here.');
check('collapses newlines',
    normalizeQuote('Line one\nstill line one'), 'Line one still line one');
check('keeps first block when model offers options',
    normalizeQuote('Best pick here.\n\nAlternative: something else.'), 'Best pick here.');
check('strips list marker',
    normalizeQuote('- A quiet kind of confident.'), 'A quiet kind of confident.');
check('leaves a clean quote alone',
    normalizeQuote('Just the caption, thanks.'), 'Just the caption, thanks.');

// language guard
checkTrue('detects chinese', quoteHasNonEnglishScript('He looks great \u4f60\u597d today'));
checkTrue('detects korean', quoteHasNonEnglishScript('\uc548\ub155 there'));
checkTrue('detects cyrillic', quoteHasNonEnglishScript('\u041f\u0440\u0438\u0432\u0435\u0442 there'));
check('accepts plain english', quoteHasNonEnglishScript('Nothing but ASCII here.'), false);
check('accepts accented latin', quoteHasNonEnglishScript('Café au lait, naïve résumé.'), false);
check('accepts em dash and curly punctuation', quoteHasNonEnglishScript('Soft — and sure of it.'), false);

// trimming
check('short quote untouched', trimQuoteToLimit('Short and sweet.', 500), 'Short and sweet.');
const long = 'First sentence here. Second sentence here. ' + 'x'.repeat(500);
checkTrue('over-long is trimmed under limit', trimQuoteToLimit(long, 100).length <= 100);
check('trims to a sentence boundary',
    trimQuoteToLimit('First sentence here. Second sentence here. And a third one that overflows.', 45),
    'First sentence here. Second sentence here.');
checkTrue('word-trims when no sentence boundary fits',
    trimQuoteToLimit('a'.repeat(30) + ' ' + 'b'.repeat(300), 60).endsWith('\u2026'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
