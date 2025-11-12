# Tag-Based Quote System Implementation

## Overview
Converted the quote system from a simple text file to a JSON-based tag-aware system that selects quotes based on image tags with flexible matching.

## Changes Made

### 1. Created `static/quotes.json`
- Converted from `static/quotes.txt` (still exists as backup)
- Structured as: `{ "tag_key": ["quote1", "quote2", ...], ... }`
- Added tag categories:
  - `woman`, `sitting`, `standing`, `lying` (subjects & poses)
  - `breast`, `butt`, `pussy` (body parts)
  - `black_hair`, `long_hair` (hair attributes)
  - `white`, `background`, `room`, `bed`, `stool`, `mirror` (setting)
  - `smiling`, `looking` (expressions/actions)
  - `default` (fallback quotes)

### 2. Updated Backend (`app.py`)

#### Modified `/get-quote` Endpoint
- Now accepts query parameters: `collection` and `filename`
- Looks up image tags from `data/tags.json`
- Sorts tags by confidence (highest first)
- Attempts to match each tag against quote keys using flexible matching
- Falls back to `default` quotes if no match found

#### Added `_find_matching_quote_key()` Helper
Flexible tag matching logic:
1. **Exact match** (normalized): `"black hair"` matches `"black_hair"`
2. **Tag contains key**: tag=`"long black hair"` matches key=`"black_hair"`
3. **Key contains tag**: tag=`"black"` matches key=`"black_hair"`

Normalization:
- Converts underscores and hyphens to spaces
- Lowercases everything
- Trims whitespace

### 3. Updated Frontend (`static/js/gallery.js`)

#### Modified `fetchRandomQuote(collection, filename)`
- Now accepts collection and filename parameters
- Passes them to `/get-quote` endpoint via query string
- Maintains fallback for errors

#### Modified `updateSlideshowImage()`
- Extracts collection and filename from image URL
- Passes them to `fetchRandomQuote()`
- Quote now matches the current image's tags

## How It Works

### Example Flow:
1. Image has tags (sorted by confidence):
   - `woman` (0.95)
   - `sitting` (0.83)
   - `black hair` (0.72)
   - `stool` (0.60)

2. System tries each tag in order:
   - Check `woman` → **Match found!** in `quotes.json`
   - Select random quote from `quotes.json["woman"]` array
   - Return quote

3. If no match found for any tag:
   - Use `quotes.json["default"]` array
   - Select random quote

### Matching Examples:
- Image tag: `"black hair"` → Matches key: `"black_hair"` ✓
- Image tag: `"black_hair"` → Matches key: `"black_hair"` ✓ (exact)
- Image tag: `"black"` → Matches key: `"black_hair"` ✓ (partial)
- Image tag: `"long black hair"` → Matches key: `"black_hair"` ✓ (contains)
- Image tag: `"woman sitting"` → Matches key: `"woman"` ✓ (contains)

## Benefits
1. **Contextual quotes**: Quotes match the image content
2. **Flexible matching**: Works with variations in tag naming
3. **Weighted selection**: Uses highest-confidence tags first
4. **Graceful fallback**: Always has default quotes available
5. **Easy expansion**: Add new tag categories to `quotes.json`

## Files Modified
- ✅ `static/quotes.json` (created)
- ✅ `app.py` (updated `/get-quote` endpoint, added helper function)
- ✅ `static/js/gallery.js` (updated quote fetching logic)

## Testing
1. Open slideshow for Real collection images
2. Quotes should now relate to image content (e.g., images with "woman" tag get woman-related quotes)
3. Check browser console for matched tag info (returned in JSON response)

## Future Enhancements
- Add more specific tag categories (hair colors, clothing, poses, etc.)
- Track which quotes have been shown recently to avoid repetition
- Allow users to add custom tag-quote mappings
- Show matched tag in UI for debugging
