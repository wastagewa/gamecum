from flask import Flask, render_template, request, jsonify, send_from_directory, redirect, url_for
import os
import json
from werkzeug.utils import secure_filename
import uuid
import random
import re
from image_tagger import analyze_image, get_primary_tags, set_tagger_config

app = Flask(__name__)
app.config['UPLOAD_FOLDER'] = os.path.join('static', 'uploads')
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # 16MB max file size
ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif', 'webp'}
SCORES_DIR = 'data'
SCORES_FILE = os.path.join(SCORES_DIR, 'scores.json')
TAGS_FILE = os.path.join(SCORES_DIR, 'tags.json')
IMAGE_METADATA_FILE = os.path.join(SCORES_DIR, 'image_metadata.json')

def _ensure_scores_file():
    os.makedirs(SCORES_DIR, exist_ok=True)
    if not os.path.exists(SCORES_FILE):
        try:
            with open(SCORES_FILE, 'w') as f:
                json.dump({}, f)
        except Exception:
            pass

def _load_scores():
    _ensure_scores_file()
    try:
        with open(SCORES_FILE, 'r') as f:
            data = json.load(f)
            if isinstance(data, dict):
                return data
    except Exception:
        pass
    return {}

def _load_image_metadata():
    """Load image metadata (names, descriptions) from JSON file."""
    _ensure_scores_file()
    if not os.path.exists(IMAGE_METADATA_FILE):
        return {}
    try:
        with open(IMAGE_METADATA_FILE, 'r') as f:
            return json.load(f)
    except Exception:
        return {}

def _save_image_metadata(metadata: dict):
    """Save image metadata to JSON file."""
    try:
        _ensure_scores_file()
        with open(IMAGE_METADATA_FILE, 'w') as f:
            json.dump(metadata, f)
    except Exception:
        pass

def _save_scores(scores: dict):
    try:
        with open(SCORES_FILE, 'w') as f:
            json.dump(scores, f)
    except Exception:
        pass

def _load_tags():
    """Load image tags from JSON file."""
    _ensure_scores_file()  # Ensure data dir exists
    if not os.path.exists(TAGS_FILE):
        return {}
    try:
        with open(TAGS_FILE, 'r') as f:
            return json.load(f)
    except Exception as e:
        print(f"ERROR loading tags: {e}")
        return {}

def _save_tags(tags: dict):
    """Save image tags to JSON file."""
    try:
        # Ensure directory exists
        os.makedirs(os.path.dirname(TAGS_FILE), exist_ok=True)
        with open(TAGS_FILE, 'w') as f:
            json.dump(tags, f, indent=2)
    except Exception as e:
        print(f"ERROR saving tags: {e}")
        import traceback
        traceback.print_exc()

def _cleanup_tags():
    """Clean up malformed tags data (convert dict objects to string lists), preserving locked status."""
    tags_data = _load_tags()
    cleaned = False
    
    for key, value in tags_data.items():
        if isinstance(value, list):
            # Check if list contains dicts instead of strings
            if value and isinstance(value[0], dict):
                # Extract 'tag' field from each dict
                tags_data[key] = [item.get('tag', str(item)) for item in value if isinstance(item, dict)]
                cleaned = True
            else:
                # Ensure all items are strings
                tags_data[key] = [str(item) for item in value if isinstance(item, (str, int, float))]
        elif isinstance(value, dict):
            # New format: {'tags': [...], 'locked': bool} - preserve it
            if 'tags' in value:
                # Ensure it's in the new normalized format
                tags_data[key] = {
                    'tags': value['tags'] if isinstance(value['tags'], list) else [],
                    'locked': value.get('locked', False)
                }
            else:
                # Old format: Dict with tag/confidence structure, convert to new format
                tags_data[key] = {
                    'tags': [value.get('tag', str(value))],
                    'locked': False
                }
                cleaned = True
    
    if cleaned:
        _save_tags(tags_data)
    
    return tags_data

def _normalize_tags_entry(entry):
    """Normalize tags entry to new format: {'tags': [...], 'locked': bool}."""
    if isinstance(entry, list):
        # Old format: list of tags
        return {'tags': entry, 'locked': False}
    elif isinstance(entry, dict):
        # Could be new format or old dict format
        if 'tags' in entry:
            # Already has tags key, ensure locked key exists
            return {
                'tags': entry['tags'] if isinstance(entry['tags'], list) else [],
                'locked': entry.get('locked', False)
            }
        elif 'tag' in entry:
            # Old single tag dict
            return {'tags': [entry['tag']], 'locked': False}
        else:
            # Try to extract all string values as tags
            return {'tags': [str(v) for v in entry.values() if isinstance(v, str)], 'locked': False}
    else:
        return {'tags': [], 'locked': False}

def _get_image_tags(collection: str, filename: str):
    """Get tags for an image. Returns list of tags."""
    image_key = _get_image_key(collection, filename)
    tags_data = _load_tags()
    entry = tags_data.get(image_key, {})
    normalized = _normalize_tags_entry(entry)
    return normalized['tags']

def _get_image_locked_status(collection: str, filename: str):
    """Get locked status for an image."""
    image_key = _get_image_key(collection, filename)
    tags_data = _load_tags()
    entry = tags_data.get(image_key, {})
    normalized = _normalize_tags_entry(entry)
    return normalized.get('locked', False)

def _set_image_tags(collection: str, filename: str, tags: list, locked: bool = None):
    """Set tags for an image, optionally updating locked status."""
    image_key = _get_image_key(collection, filename)
    tags_data = _load_tags()
    
    # Get existing entry and normalize it
    existing = tags_data.get(image_key, {})
    normalized = _normalize_tags_entry(existing)
    
    # Update tags
    normalized['tags'] = [str(t).strip() for t in tags if t]
    
    # Update locked status if provided
    if locked is not None:
        normalized['locked'] = locked
    
    tags_data[image_key] = normalized
    _save_tags(tags_data)

def _set_image_locked(collection: str, filename: str, locked: bool):
    """Set locked status for an image."""
    image_key = _get_image_key(collection, filename)
    tags_data = _load_tags()
    
    # Get existing entry and normalize it
    existing = tags_data.get(image_key, {})
    normalized = _normalize_tags_entry(existing)
    
    # Update locked status
    normalized['locked'] = locked
    
    tags_data[image_key] = normalized
    _save_tags(tags_data)

def _get_image_key(collection: str, filename: str):
    """Generate a unique key for an image."""
    return f"{collection}/{filename}" if collection else filename

def _is_better_score(candidate: dict, current: dict):
    """Return True if candidate is better than current.
    Ranking: fastest time first, then least wrong steps."""
    if not current:
        return True
    ct = current.get('time', 10**9)
    cw = current.get('wrong', 10**9)
    nt = candidate.get('time', 10**9)
    nw = candidate.get('wrong', 10**9)
    if nt < ct:
        return True
    if nt == ct and nw < cw:
        return True
    return False

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def _get_collection_image_urls(collection: str):
    """Return image URLs for a collection."""
    folder = os.path.join(app.config['UPLOAD_FOLDER'], collection)
    images = []
    try:
        for filename in os.listdir(folder):
            if any(filename.lower().endswith(ext) for ext in ALLOWED_EXTENSIONS):
                images.append(filename)
    except FileNotFoundError:
        images = []
    return [f"/static/uploads/{collection}/{fn}" for fn in images]

@app.route('/')
def index():
    # Render a home page that lists collections and image counts, plus top scores.
    base = app.config['UPLOAD_FOLDER']
    collections = {}
    scores_data = _load_scores()
    # Build top 5 leaderboard per collection
    leaderboards = {}
    for coll, entries in scores_data.items():
        if isinstance(entries, list):
            leaderboards[coll] = entries[:5]
        else:
            # Old format (single best) - skip or convert
            leaderboards[coll] = []
    
    try:
        # top-level files count as 'root' if any
        root_count = 0
        for filename in os.listdir(base):
            full = os.path.join(base, filename)
            if os.path.isfile(full) and any(filename.lower().endswith(ext) for ext in ALLOWED_EXTENSIONS):
                root_count += 1
        if root_count:
            collections['root'] = root_count

        for name in os.listdir(base):
            folder = os.path.join(base, name)
            if os.path.isdir(folder):
                imgs = 0
                for filename in os.listdir(folder):
                    if any(filename.lower().endswith(ext) for ext in ALLOWED_EXTENSIONS):
                        imgs += 1
                collections[name] = imgs
    except Exception:
        collections = {}
    return render_template('home.html', collections=collections, leaderboards=leaderboards)


def _safe_collection_name(name: str):
    # allow alphanumeric, dash, underscore only
    if not name:
        return ''
    if re.match(r'^[A-Za-z0-9_-]+$', name):
        return name
    return ''


@app.route('/collection/<collection_name>')
def collection_view(collection_name):
    collection = _safe_collection_name(collection_name)
    folder = os.path.join(app.config['UPLOAD_FOLDER'], collection)
    images = []
    try:
        for filename in os.listdir(folder):
            if any(filename.lower().endswith(ext) for ext in ALLOWED_EXTENSIONS):
                images.append(filename)
    except FileNotFoundError:
        images = []

    # Load tags for all images
    tags_data = _load_tags()
    image_tags = {}
    for filename in images:
        image_key = _get_image_key(collection, filename)
        if image_key in tags_data:
            # Tags are stored directly as a list, not as {'tags': [...]}
            tags = tags_data[image_key]
            if isinstance(tags, list):
                # Ensure all items in the list are strings, not dicts
                image_tags[filename] = [str(tag) for tag in tags if isinstance(tag, (str, int, float))]
            elif isinstance(tags, dict) and 'tags' in tags:
                # Handle old format where tags were stored as {'tags': [...]}
                image_tags[filename] = tags['tags'] if isinstance(tags['tags'], list) else []
            else:
                image_tags[filename] = []

    return render_template('index.html', images=images, collection=collection, image_tags=image_tags)

@app.route('/upload', methods=['POST'])
@app.route('/upload/<collection>', methods=['POST'])
def upload_file(collection=None):
    if 'file' not in request.files:
        return jsonify({'error': 'No file part'}), 400

    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No selected file'}), 400

    if file and allowed_file(file.filename):
        # Handle collection from path parameter
        collection = _safe_collection_name(collection or '')
        save_folder = os.path.join(app.config['UPLOAD_FOLDER'], collection) if collection else app.config['UPLOAD_FOLDER']
        os.makedirs(save_folder, exist_ok=True)
        # Generate unique filename
        filename = str(uuid.uuid4()) + os.path.splitext(secure_filename(file.filename))[1]
        file_path = os.path.join(save_folder, filename)
        file.save(file_path)

        # Analyze image and extract tags
        # BLIP produces natural, descriptive tags for realistic images
        try:
            tags_result = analyze_image(file_path, top_k=25, threshold=0.20)
            tags = [t['tag'] for t in tags_result]

            # Store tags
            all_tags = _load_tags()
            image_key = _get_image_key(collection, filename)
            all_tags[image_key] = {
                'tags': tags,
                'detailed': tags_result
            }
            _save_tags(all_tags)
        except Exception as e:
            print(f"Error tagging image: {e}")
            tags = []
        
        url_path = f'/static/uploads/{collection}/{filename}' if collection else f'/static/uploads/{filename}'
        return jsonify({
            'success': True,
            'filename': filename,
            'url': url_path,
            'tags': tags
        })
    
    return jsonify({'error': 'Invalid file type'}), 400

@app.route('/get-quote')
def get_quote():
    """
    Get a quote based on image tags with flexible matching.
    Expects query param 'collection' and 'filename' to look up tags.
    Falls back to random quote from 'default' if no tags or no match.
    Uses gquotes.json for collections starting with 'G', otherwise quotes.json.
    """
    try:
        # Try to get image tags
        collection = request.args.get('collection', '')
        
        # Load quotes from JSON - use gquotes.json for collections starting with 'G'
        if collection and collection.startswith('G'):
            quotes_path = os.path.join('static', 'gquotes.json')
        else:
            quotes_path = os.path.join('static', 'quotes.json')
        
        with open(quotes_path, 'r', encoding='utf-8') as f:
            quotes_data = json.load(f)
        filename = request.args.get('filename', '')
        
        if collection and filename:
            all_tags = _load_tags()
            image_key = _get_image_key(collection, filename)
            image_data = all_tags.get(image_key)
            
            # Handle both new format (list of strings) and old format (dict with 'detailed')
            image_tag_names = []
            if isinstance(image_data, list):
                # New format: direct list of tag strings
                image_tag_names = [tag.lower().strip() for tag in image_data if isinstance(tag, str)]
            elif isinstance(image_data, dict):
                # Old format: dict with 'detailed' or 'tags' key
                detailed_tags = image_data.get('detailed', [])
                if detailed_tags:
                    image_tag_names = [tag_obj.get('tag', '').lower().strip() for tag_obj in detailed_tags if tag_obj.get('tag')]
                else:
                    # Fallback to 'tags' key if 'detailed' is empty
                    simple_tags = image_data.get('tags', [])
                    image_tag_names = [tag.lower().strip() for tag in simple_tags if isinstance(tag, str)]
            
            if image_tag_names:
                # Filter out internal tags (those starting with prefixes like "c ", "sn ", "n ", etc.)
                # Internal tags are used for classification but shouldn't be matched to quotes
                internal_prefixes = ('c ', 'sn ', 'n ', 'c_', 'sn_', 'n_')
                filtered_tags = [
                    tag for tag in image_tag_names 
                    if not any(tag.startswith(prefix) for prefix in internal_prefixes)
                ]
                
                # If all tags are internal, use them anyway to try to find a match
                tags_to_match = filtered_tags if filtered_tags else image_tag_names
                
                # Iterate through quote keys in order (preserving JSON order)
                # Skip 'default' key in priority matching
                for quote_key in quotes_data.keys():
                    if quote_key == 'default':
                        continue
                    
                    # Check if any image tag matches this quote key
                    for tag in tags_to_match:
                        if _tags_match(tag, quote_key):
                            quote = random.choice(quotes_data[quote_key])
                            return jsonify({'quote': quote, 'matched_tag': quote_key})
        
        # Fall back to default
        if 'default' in quotes_data:
            quote = random.choice(quotes_data['default'])
            return jsonify({'quote': quote, 'matched_tag': 'default'})
        
        return jsonify({'quote': 'No quotes available.'}), 404
        
    except Exception as e:
        print(f"[get-quote] Error: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


def _tags_match(tag, quote_key):
    """
    Check if a tag matches a quote key using flexible matching:
    1. Exact match (normalized: spaces/underscores/hyphens)
    2. Tag contains quote key
    3. Quote key contains tag
    Returns True if match found, False otherwise.
    """
    # Normalize for comparison
    tag_normalized = tag.replace('_', ' ').replace('-', ' ').lower().strip()
    key_normalized = quote_key.replace('_', ' ').replace('-', ' ').lower().strip()
    
    # Exact match
    if tag_normalized == key_normalized:
        return True
    
    # Tag contains key (e.g., tag="long black hair", key="black hair")
    if key_normalized in tag_normalized:
        return True
    
    # Key contains tag (e.g., tag="black", key="black_hair")
    if tag_normalized in key_normalized:
        return True
    
    return False

def _find_matching_quote_key(tag, quote_keys):
    """
    Flexible tag matching:
    1. Exact match (normalized: spaces/underscores)
    2. Tag contains quote key
    3. Quote key contains tag
    Returns the first matching quote key or None.
    """
    # Normalize for comparison
    tag_normalized = tag.replace('_', ' ').replace('-', ' ').lower().strip()
    
    for key in quote_keys:
        if key == 'default':
            continue
            
        key_normalized = key.replace('_', ' ').replace('-', ' ').lower().strip()
        
        # Exact match
        if tag_normalized == key_normalized:
            return key
        
        # Tag contains key (e.g., tag="long black hair", key="black hair")
        if key_normalized in tag_normalized:
            return key
        
        # Key contains tag (e.g., tag="black", key="black_hair")
        if tag_normalized in key_normalized:
            return key
    
    return None


@app.route('/create-collection', methods=['POST'])
def create_collection():
    try:
        data = request.get_json() or {}
        name = data.get('name') or request.form.get('name')
        if not name:
            return jsonify({'error': 'Collection name required'}), 400
        safe = _safe_collection_name(name)
        if not safe:
            return jsonify({'error': 'Invalid collection name'}), 400
        folder = os.path.join(app.config['UPLOAD_FOLDER'], safe)
        if not os.path.exists(folder):
            os.makedirs(folder, exist_ok=True)
            return jsonify({'success': True, 'name': safe})
        return jsonify({'error': 'Collection already exists'}), 409
    except Exception as e:
        return jsonify({'error': str(e)}), 500

def _calculate_score(time_val: int, wrong_val: int, pairs: int, match_size: int):
    """Calculate score based on game parameters.
    Formula:
    - Base: pairs × match_size × 1000 (reward difficulty and match complexity)
    - Time penalty: -time in seconds
    - Wrong penalty: -wrong × 50
    - Minimum score: 0
    Higher difficulty (more pairs) and larger match sizes yield higher scores.
    Faster times and fewer mistakes maximize score.
    """
    base_score = pairs * match_size * 1000
    time_penalty = time_val
    wrong_penalty = wrong_val * 50
    final_score = max(0, base_score - time_penalty - wrong_penalty)
    return final_score

@app.route('/api/submit-score', methods=['POST'])
def submit_score():
    """Accept a finished game score and compute/persist top scores per collection per game type.
    Expects JSON: { collection: str, gameType: str, time: int, wrong: int, moves: int, username: str, pairs: int, matchSize: int, score: int, level: int }
    Stores top 10 scores per collection per game type (leaderboard).
    """
    try:
        data = request.get_json() or {}
        collection = _safe_collection_name(str(data.get('collection') or ''))
        if not collection:
            return jsonify({'error': 'Invalid or missing collection'}), 400
        
        game_type = str(data.get('gameType', 'memory')).lower()
        allowed_games = ['memory', 'flashcards', 'hunt', 'puzzle', 'sequence', 'zoom', 'whack', 'recall', 'missing', 'trail', 'remix', 'tag-match']
        if game_type not in allowed_games:
            game_type = 'memory'
        
        username = str(data.get('username') or 'Anonymous').strip()[:30]

        # Build entry based on game type
        entry = {
            'username': username,
            'gameType': game_type
        }

        # Add game-specific metrics
        if game_type == 'memory':
            time_val = int(data.get('time', 0))
            wrong_val = int(data.get('wrong', 0))
            moves_val = int(data.get('moves', 0))
            pairs = int(data.get('pairs', 8))
            match_size = int(data.get('matchSize', 2))
            score = _calculate_score(time_val, wrong_val, pairs, match_size)
            entry.update({
                'score': score,
                'time': time_val,
                'wrong': wrong_val,
                'moves': moves_val,
                'pairs': pairs,
                'matchSize': match_size
            })
        elif game_type == 'flashcards':
            score = int(data.get('score', 0))
            level = int(data.get('level', 1))
            time_val = int(data.get('time', 0))
            entry.update({
                'score': score,
                'level': level,
                'time': time_val
            })
        elif game_type == 'hunt':
            score = int(data.get('score', 0))
            time_val = int(data.get('time', 0))
            entry.update({
                'score': score,
                'time': time_val
            })
        elif game_type == 'zoom':
            score = int(data.get('score', 0))
            rounds = int(data.get('rounds', 0))
            time_val = int(data.get('time', 0))
            entry.update({
                'score': score,
                'rounds': rounds,
                'time': time_val
            })
        elif game_type == 'whack':
            score = int(data.get('score', 0))
            time_val = int(data.get('time', 0))
            clicks = int(data.get('clicks', 0))
            entry.update({
                'score': score,
                'time': time_val,
                'clicks': clicks
            })
        else:  # puzzle, sequence, etc.
            score = int(data.get('score', 0))
            time_val = int(data.get('time', 0))
            entry.update({
                'score': score,
                'time': time_val
            })

        scores_data = _load_scores()
        # Structure: { collection: { gameType: [entries], ... }, ... }
        if collection not in scores_data:
            scores_data[collection] = {}
        
        if not isinstance(scores_data[collection], dict):
            scores_data[collection] = {}
        
        if game_type not in scores_data[collection]:
            scores_data[collection][game_type] = []
        
        leaderboard = scores_data[collection][game_type]
        if not isinstance(leaderboard, list):
            leaderboard = []
        
        leaderboard.append(entry)
        # Sort by score descending, then by time ascending (tie-breaker)
        leaderboard.sort(key=lambda x: (-x.get('score', 0), x.get('time', 10**9)))
        # Keep top 10
        leaderboard = leaderboard[:10]
        scores_data[collection][game_type] = leaderboard
        _save_scores(scores_data)

        # Check if this entry is in top 5 (considered "new best" for UI feedback)
        is_top = any(e == entry for e in leaderboard[:5])

        return jsonify({'success': True, 'updated': is_top, 'score': entry.get('score', 0), 'leaderboard': leaderboard[:5]})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/high-scores/<collection>')
def get_high_scores(collection):
    """Get high scores for all games in a collection.
    Returns: { gameType: [top 3 entries], ... }
    """
    try:
        collection = _safe_collection_name(collection)
        if not collection:
            return jsonify({'error': 'Invalid collection'}), 400
        
        scores_data = _load_scores()
        result = {}
        
        if collection in scores_data:
            collection_scores = scores_data[collection]
            if isinstance(collection_scores, dict):
                # New format: { gameType: [entries], ... }
                for game_type, leaderboard in collection_scores.items():
                    if isinstance(leaderboard, list):
                        result[game_type] = leaderboard[:3]  # Top 3 per game
            else:
                # Old format: list of entries - assume all memory game
                result['memory'] = collection_scores[:3] if isinstance(collection_scores, list) else []
        
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/delete-image/<filename>', methods=['DELETE'])
def delete_image(filename):
    try:
        file_path = os.path.join(app.config['UPLOAD_FOLDER'], filename)
        if os.path.exists(file_path):
            os.remove(file_path)
            return jsonify({'success': True})
        return jsonify({'error': 'File not found'}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/delete-image/<collection>/<filename>', methods=['DELETE'])
def delete_image_in_collection(collection, filename):
    collection = _safe_collection_name(collection)
    try:
        file_path = os.path.join(app.config['UPLOAD_FOLDER'], collection, filename)
        if os.path.exists(file_path):
            os.remove(file_path)
            return jsonify({'success': True})
        return jsonify({'error': 'File not found'}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/game')
def game():
    """Render the memory game page using uploaded images.
    We'll pass the list of upload filenames to the template. The template/JS will
    duplicate and shuffle them to build pairs.
    """
    # Default game should show the "Real" collection
    return redirect(url_for('collection_game', collection_name='Real'))


@app.route('/collection/<collection_name>/game')
def collection_game(collection_name):
    collection = _safe_collection_name(collection_name)
    image_urls = _get_collection_image_urls(collection)
    return render_template('game.html', images=image_urls, collection=collection)


@app.route('/puzzle')
def puzzle():
    """Render the puzzle slider game page."""
    return redirect(url_for('collection_puzzle', collection_name='Real'))


@app.route('/collection/<collection_name>/puzzle')
def collection_puzzle(collection_name):
    """Render the puzzle slider game for a specific collection."""
    collection = _safe_collection_name(collection_name)
    image_urls = _get_collection_image_urls(collection)
    return render_template('puzzle.html', images=image_urls, collection=collection)


@app.route('/collection/<collection_name>/sequence')
def collection_sequence(collection_name):
    """Render the sequence memory game for a specific collection."""
    collection = _safe_collection_name(collection_name)
    image_urls = _get_collection_image_urls(collection)
    return render_template('sequence.html', images=image_urls, collection=collection)


@app.route('/collection/<collection_name>/flashcards')
def collection_flashcards(collection_name):
    """Render the flashcards memory game for a specific collection."""
    collection = _safe_collection_name(collection_name)
    image_urls = _get_collection_image_urls(collection)
    return render_template('flashcards.html', images=image_urls, collection=collection)


@app.route('/collection/<collection_name>/hunt')
def collection_hunt(collection_name):
    """Simple Image Hunt game: show target image, player must find it in a grid."""
    collection = _safe_collection_name(collection_name)
    image_urls = _get_collection_image_urls(collection)
    return render_template('hunt.html', images=image_urls, collection=collection)


@app.route('/collection/<collection_name>/zoom')
def collection_zoom(collection_name):
    """Zoom Challenge game: show zoomed-in portion of image, identify which full image it is."""
    collection = _safe_collection_name(collection_name)
    image_urls = _get_collection_image_urls(collection)
    return render_template('zoom.html', images=image_urls, collection=collection)


@app.route('/collection/<collection_name>/whack')
def collection_whack(collection_name):
    """Whack-a-Mole game: click images as they appear on screen."""
    collection = _safe_collection_name(collection_name)
    image_urls = _get_collection_image_urls(collection)
    return render_template('whack.html', images=image_urls, collection=collection)


@app.route('/collection/<collection_name>/recall')
def collection_recall(collection_name):
    """Recall Grid game: memorize image positions and select the original spot."""
    collection = _safe_collection_name(collection_name)
    image_urls = _get_collection_image_urls(collection)
    return render_template('recall.html', images=image_urls, collection=collection)


@app.route('/collection/<collection_name>/missing')
def collection_missing(collection_name):
    """Missing Piece game: identify which image disappeared from the shown grid."""
    collection = _safe_collection_name(collection_name)
    image_urls = _get_collection_image_urls(collection)
    return render_template('missing.html', images=image_urls, collection=collection)


@app.route('/collection/<collection_name>/trail')
def collection_trail(collection_name):
    """Trail Trace game: follow a route through a memorized image grid."""
    collection = _safe_collection_name(collection_name)
    image_urls = _get_collection_image_urls(collection)
    return render_template('trail.html', images=image_urls, collection=collection)


@app.route('/collection/<collection_name>/remix')
def collection_remix(collection_name):
    """Remix Match game: identify which stylized remix belongs to the target image."""
    collection = _safe_collection_name(collection_name)
    image_urls = _get_collection_image_urls(collection)
    return render_template('remix.html', images=image_urls, collection=collection)


@app.route('/tag-match')
def tag_match():
    """Render the Tag Match memory game page using the Real collection."""
    return redirect(url_for('collection_tag_match', collection_name='Real'))


@app.route('/collection/<collection_name>/tag-match')
def collection_tag_match(collection_name):
    """Render the Tag Match memory game for a specific collection."""
    collection = _safe_collection_name(collection_name)
    return render_template('tag-match.html', collection=collection)





@app.route('/api/images')
def api_images_all():
    """Return a JSON list of all image URLs across the uploads folder and its collections."""
    result = []
    base = app.config['UPLOAD_FOLDER']
    try:
        # Top-level files
        for filename in os.listdir(base):
            full = os.path.join(base, filename)
            if os.path.isfile(full) and any(filename.lower().endswith(ext) for ext in ALLOWED_EXTENSIONS):
                result.append(f"/static/uploads/{filename}")
        # Subfolders (collections)
        for name in os.listdir(base):
            folder = os.path.join(base, name)
            if os.path.isdir(folder):
                for filename in os.listdir(folder):
                    if any(filename.lower().endswith(ext) for ext in ALLOWED_EXTENSIONS):
                        result.append(f"/static/uploads/{name}/{filename}")
    except Exception:
        # On any error return empty list
        result = []
    return jsonify({'images': result})


@app.route('/manage-collections')
def manage_collections():
    """Render collection management page."""
    base = app.config['UPLOAD_FOLDER']
    collections = {}
    try:
        for name in os.listdir(base):
            folder = os.path.join(base, name)
            if os.path.isdir(folder):
                imgs = 0
                for filename in os.listdir(folder):
                    if any(filename.lower().endswith(ext) for ext in ALLOWED_EXTENSIONS):
                        imgs += 1
                collections[name] = imgs
    except Exception:
        collections = {}
    return render_template('manage-collections.html', collections=collections)


@app.route('/api/collections/create', methods=['POST'])
def api_create_collection():
    """Create a new collection folder."""
    data = request.get_json()
    name = data.get('name', '').strip()
    
    if not name:
        return jsonify({'success': False, 'error': 'Collection name required'}), 400
    
    safe_name = _safe_collection_name(name)
    if not safe_name or safe_name != name:
        return jsonify({'success': False, 'error': 'Invalid collection name. Use only letters, numbers, hyphens, and underscores'}), 400
    
    folder_path = os.path.join(app.config['UPLOAD_FOLDER'], safe_name)
    
    if os.path.exists(folder_path):
        return jsonify({'success': False, 'error': 'Collection already exists'}), 400
    
    try:
        os.makedirs(folder_path, exist_ok=True)
        return jsonify({'success': True, 'message': 'Collection created'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/collections/rename', methods=['POST'])
def api_rename_collection():
    """Rename a collection folder."""
    data = request.get_json()
    old_name = data.get('old_name', '').strip()
    new_name = data.get('new_name', '').strip()
    
    if not old_name or not new_name:
        return jsonify({'success': False, 'error': 'Both names required'}), 400
    
    safe_old = _safe_collection_name(old_name)
    safe_new = _safe_collection_name(new_name)
    
    if not safe_new or safe_new != new_name:
        return jsonify({'success': False, 'error': 'Invalid new name'}), 400
    
    old_path = os.path.join(app.config['UPLOAD_FOLDER'], safe_old)
    new_path = os.path.join(app.config['UPLOAD_FOLDER'], safe_new)
    
    if not os.path.exists(old_path):
        return jsonify({'success': False, 'error': 'Collection not found'}), 404
    
    if os.path.exists(new_path):
        return jsonify({'success': False, 'error': 'Target name already exists'}), 400
    
    try:
        os.rename(old_path, new_path)
        
        # Update tags file
        tags_data = _load_tags()
        updated_tags = {}
        for key, value in tags_data.items():
            if key.startswith(f"{safe_old}/"):
                new_key = key.replace(f"{safe_old}/", f"{safe_new}/", 1)
                updated_tags[new_key] = value
            else:
                updated_tags[key] = value
        _save_tags(updated_tags)
        
        return jsonify({'success': True, 'message': 'Collection renamed'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/collections/delete', methods=['POST'])
def api_delete_collection():
    """Delete a collection folder and all its contents."""
    data = request.get_json()
    name = data.get('name', '').strip()
    
    if not name:
        return jsonify({'success': False, 'error': 'Collection name required'}), 400
    
    safe_name = _safe_collection_name(name)
    folder_path = os.path.join(app.config['UPLOAD_FOLDER'], safe_name)
    
    if not os.path.exists(folder_path):
        return jsonify({'success': False, 'error': 'Collection not found'}), 404
    
    try:
        import shutil
        shutil.rmtree(folder_path)
        
        # Remove tags for deleted images
        tags_data = _load_tags()
        updated_tags = {k: v for k, v in tags_data.items() if not k.startswith(f"{safe_name}/")}
        _save_tags(updated_tags)
        
        return jsonify({'success': True, 'message': 'Collection deleted'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/collections/<collection_name>/images', methods=['GET'])
def api_collection_images(collection_name):
    """Get all images in a collection with their tags and lock status, sorted by upload time."""
    safe_name = _safe_collection_name(collection_name)
    folder_path = os.path.join(app.config['UPLOAD_FOLDER'], safe_name)
    
    if not os.path.exists(folder_path):
        return jsonify({'success': False, 'error': 'Collection not found'}), 404
    
    images = []
    tags_data = _load_tags()
    
    for filename in os.listdir(folder_path):
        if any(filename.lower().endswith(ext) for ext in ALLOWED_EXTENSIONS):
            image_key = _get_image_key(safe_name, filename)
            entry = tags_data.get(image_key, {})
            
            # Normalize the entry
            normalized = _normalize_tags_entry(entry)
            image_tags = normalized['tags']
            locked = normalized.get('locked', False)
            
            # Get file modification time for sorting
            file_path = os.path.join(folder_path, filename)
            try:
                mod_time = os.path.getmtime(file_path)
            except:
                mod_time = 0
            
            images.append({
                'filename': filename,
                'url': url_for('static', filename=f'uploads/{safe_name}/{filename}'),
                'tags': image_tags,
                'locked': locked,
                'upload_time': mod_time
            })
    
    # Sort images by upload time (oldest first)
    images.sort(key=lambda x: x['upload_time'])
    
    # Remove upload_time from response (it's only for sorting)
    for img in images:
        del img['upload_time']
    
    return jsonify({'success': True, 'images': images})


@app.route('/api/images/<collection_name>/<filename>/tags', methods=['POST'])
def api_update_image_tags(collection_name, filename):
    """Update tags for a specific image."""
    data = request.get_json()
    tags = data.get('tags', [])
    
    if not isinstance(tags, list):
        return jsonify({'success': False, 'error': 'Tags must be an array'}), 400
    
    # Validate tags (remove empty strings and duplicates)
    tags = [t.strip() for t in tags if t.strip()]
    tags = list(set(tags))  # Remove duplicates
    
    safe_name = _safe_collection_name(collection_name)
    
    # Use new function to set tags while preserving locked status
    _set_image_tags(safe_name, filename, tags)
    
    return jsonify({'success': True, 'tags': tags})


@app.route('/api/images/<collection_name>/<filename>/retag', methods=['POST'])
def api_retag_image(collection_name, filename):
    """Auto-generate tags for a specific image."""
    safe_name = _safe_collection_name(collection_name)
    file_path = os.path.join(app.config['UPLOAD_FOLDER'], safe_name, filename)
    
    if not os.path.exists(file_path):
        return jsonify({'success': False, 'error': 'Image not found'}), 404
    
    try:
        # Use the image tagger to get primary tags (returns list of strings)
        from image_tagger import get_primary_tags
        tags = get_primary_tags(file_path, max_tags=10)
        
        # Save the tags
        image_key = _get_image_key(safe_name, filename)
        tags_data = _load_tags()
        tags_data[image_key] = tags
        _save_tags(tags_data)
        
        return jsonify({'success': True, 'tags': tags})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/collections/<collection_name>/retag-all', methods=['POST'])
def api_retag_all_images(collection_name):
    """Auto-generate tags for all images in a collection, skipping locked images."""
    safe_name = _safe_collection_name(collection_name)
    folder_path = os.path.join(app.config['UPLOAD_FOLDER'], safe_name)
    
    if not os.path.exists(folder_path):
        return jsonify({'success': False, 'error': 'Collection not found'}), 404
    
    try:
        from image_tagger import get_primary_tags
        tags_data = _load_tags()
        processed = 0
        errors = 0
        skipped_locked = 0
        
        for filename in os.listdir(folder_path):
            if any(filename.lower().endswith(ext) for ext in ALLOWED_EXTENSIONS):
                # Check if image is locked
                if _get_image_locked_status(safe_name, filename):
                    skipped_locked += 1
                    continue
                
                try:
                    file_path = os.path.join(folder_path, filename)
                    # Use get_primary_tags to get list of strings instead of dicts
                    tags = get_primary_tags(file_path, max_tags=10)
                    
                    # Use the new function to set tags while preserving locked status
                    _set_image_tags(safe_name, filename, tags)
                    processed += 1
                except Exception as e:
                    errors += 1
        
        return jsonify({
            'success': True,
            'processed': processed,
            'errors': errors,
            'skipped_locked': skipped_locked,
            'message': f'Processed {processed} images with {errors} errors ({skipped_locked} locked images skipped)'
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/images/<collection_name>/<filename>/lock', methods=['POST'])
def api_lock_image(collection_name, filename):
    """Lock an image so it won't be retagged during retag-all."""
    safe_name = _safe_collection_name(collection_name)
    file_path = os.path.join(app.config['UPLOAD_FOLDER'], safe_name, filename)
    
    if not os.path.exists(file_path):
        return jsonify({'success': False, 'error': 'Image not found'}), 404
    
    _set_image_locked(safe_name, filename, True)
    return jsonify({'success': True, 'locked': True, 'message': 'Image locked'})


@app.route('/api/images/<collection_name>/<filename>/unlock', methods=['POST'])
def api_unlock_image(collection_name, filename):
    """Unlock an image so it can be retagged."""
    safe_name = _safe_collection_name(collection_name)
    file_path = os.path.join(app.config['UPLOAD_FOLDER'], safe_name, filename)
    
    if not os.path.exists(file_path):
        return jsonify({'success': False, 'error': 'Image not found'}), 404
    
    _set_image_locked(safe_name, filename, False)
    return jsonify({'success': True, 'locked': False, 'message': 'Image unlocked'})


@app.route('/api/images/<collection_name>/<filename>/lock-status', methods=['GET'])
def api_get_lock_status(collection_name, filename):
    """Get lock status for an image."""
    safe_name = _safe_collection_name(collection_name)
    locked = _get_image_locked_status(safe_name, filename)
    tags = _get_image_tags(safe_name, filename)
    return jsonify({'success': True, 'locked': locked, 'tags': tags})


@app.route('/api/images/<collection_name>/<source_filename>/copy-tags/<target_filename>', methods=['POST'])
def api_copy_image_tags(collection_name, source_filename, target_filename):
    """Copy tags from source image to target image."""
    safe_name = _safe_collection_name(collection_name)
    
    source_path = os.path.join(app.config['UPLOAD_FOLDER'], safe_name, source_filename)
    target_path = os.path.join(app.config['UPLOAD_FOLDER'], safe_name, target_filename)
    
    if not os.path.exists(source_path):
        return jsonify({'success': False, 'error': 'Source image not found'}), 404
    if not os.path.exists(target_path):
        return jsonify({'success': False, 'error': 'Target image not found'}), 404
    
    # Get tags from source image
    source_tags = _get_image_tags(safe_name, source_filename)
    
    # Set tags on target image (preserving target's locked status)
    _set_image_tags(safe_name, target_filename, source_tags)
    
    return jsonify({'success': True, 'tags': source_tags, 'message': f'Copied {len(source_tags)} tags to target image'})


@app.route('/api/collections')
def api_collections():
    """Return a JSON mapping of collection name -> list of image URLs.
    Top-level files are returned under the key 'root'.
    """
    result = {}
    base = app.config['UPLOAD_FOLDER']
    try:
        # top-level files
        root_imgs = []
        for filename in os.listdir(base):
            full = os.path.join(base, filename)
            if os.path.isfile(full) and any(filename.lower().endswith(ext) for ext in ALLOWED_EXTENSIONS):
                root_imgs.append(f"/static/uploads/{filename}")
        if root_imgs:
            result['root'] = root_imgs

        # subfolders
        for name in os.listdir(base):
            folder = os.path.join(base, name)
            if os.path.isdir(folder):
                imgs = []
                for filename in os.listdir(folder):
                    if any(filename.lower().endswith(ext) for ext in ALLOWED_EXTENSIONS):
                        imgs.append(f"/static/uploads/{name}/{filename}")
                result[name] = imgs
    except Exception:
        result = {}
    return jsonify({'collections': result})


@app.route('/api/tags')
def api_all_tags():
    """Return all image tags."""
    tags_data = _load_tags()
    return jsonify({'tags': tags_data})


@app.route('/api/tags/<collection>/<filename>')
def api_image_tags(collection, filename):
    """Get tags for a specific image."""
    collection = _safe_collection_name(collection)
    image_key = _get_image_key(collection, filename)
    tags_data = _load_tags()
    
    if image_key in tags_data:
        tags = tags_data[image_key]
        # Handle both formats: list of strings or dict with 'tags' key
        if isinstance(tags, list):
            return jsonify({
                'success': True,
                'tags': tags,
                'detailed': []
            })
        elif isinstance(tags, dict):
            return jsonify({
                'success': True,
                'tags': tags.get('tags', []),
                'detailed': tags.get('detailed', [])
            })
    return jsonify({'success': False, 'tags': []}), 404


@app.route('/api/tags/<collection>/<filename>', methods=['PUT'])
def update_image_tags(collection, filename):
    """Manually update tags for an image."""
    collection = _safe_collection_name(collection)
    image_key = _get_image_key(collection, filename)
    
    try:
        data = request.get_json() or {}
        new_tags = data.get('tags', [])
        
        if not isinstance(new_tags, list):
            return jsonify({'error': 'Tags must be a list'}), 400
        
        tags_data = _load_tags()
        if image_key not in tags_data:
            tags_data[image_key] = {}
        
        tags_data[image_key]['tags'] = new_tags
        _save_tags(tags_data)
        
        return jsonify({'success': True, 'tags': new_tags})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/retag/<collection>/<filename>', methods=['POST'])
def retag_image(collection, filename):
    """Re-analyze and update tags for an existing image."""
    collection = _safe_collection_name(collection)
    file_path = os.path.join(app.config['UPLOAD_FOLDER'], collection, filename)
    
    if not os.path.exists(file_path):
        return jsonify({'error': 'Image not found'}), 404
    
    try:
        # BLIP produces natural, descriptive tags for realistic images
        tags_result = analyze_image(file_path, top_k=25, threshold=0.20)
        tags = [t['tag'] for t in tags_result]
        
        all_tags = _load_tags()
        image_key = _get_image_key(collection, filename)
        all_tags[image_key] = {
            'tags': tags,
            'detailed': tags_result
        }
        _save_tags(all_tags)
        
        return jsonify({
            'success': True,
            'tags': tags,
            'detailed': tags_result
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/search-by-tag')
def search_by_tag():
    """Search images by tag. Query param: tag=<tag_name>"""
    search_tag = request.args.get('tag', '').lower()
    if not search_tag:
        return jsonify({'error': 'Tag parameter required'}), 400
    
    tags_data = _load_tags()
    matching_images = []
    
    for image_key, tag_info in tags_data.items():
        image_tags = [t.lower() for t in tag_info.get('tags', [])]
        if search_tag in image_tags:
            # Parse collection and filename from key
            if '/' in image_key:
                collection, filename = image_key.split('/', 1)
                url = f"/static/uploads/{collection}/{filename}"
            else:
                url = f"/static/uploads/{image_key}"
            
            matching_images.append({
                'url': url,
                'tags': tag_info.get('tags', []),
                'key': image_key
            })
    
    return jsonify({
        'tag': search_tag,
        'count': len(matching_images),
        'images': matching_images
    })


@app.route('/api/tagger-config', methods=['GET', 'POST'])
def api_tagger_config():
    """Configure or read the tagger backend.
    GET -> returns info message (paths not exposed for security)
    POST JSON: { backend: 'clip'|'wd14', modelPath: str, labelsPath: str, backendOverrides: { <collection>: 'clip'|'wd14', ... } }
    Stores configuration for WD14 local model usage.
    """
    try:
        if request.method == 'GET':
            # Only expose backend type to clients; paths are sensitive
            # Read current backend from the config file via image_tagger (no direct file read here)
            # We can't import private state; provide a generic ok and hint backend is configurable.
            return jsonify({'success': True, 'message': 'Use POST to set backend to clip or wd14. Optional: backendOverrides per collection.'})
        data = request.get_json() or {}
        backend = str(data.get('backend', 'clip')).lower()
        conf = {'backend': backend}
        if backend == 'wd14':
            model_path = data.get('modelPath')
            labels_path = data.get('labelsPath')
            if not model_path or not labels_path:
                return jsonify({'error': 'modelPath and labelsPath required for wd14 backend'}), 400
            conf['model_path'] = model_path
            conf['labels_path'] = labels_path
        # Optional per-collection backend overrides
        if 'backendOverrides' in data and isinstance(data.get('backendOverrides'), dict):
            conf['backend_overrides'] = data['backendOverrides']
        set_tagger_config(conf)
        return jsonify({'success': True, 'backend': backend})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/tags')
def tags_view():
    """Display all tags with image counts."""
    return render_template('tag-browser.html')


@app.route('/api/tags-with-counts')
def api_tags_with_counts():
    """Return all tags grouped by collection with image counts."""
    tags_data = _load_tags()
    tag_counts = {}  # {tag: {collections: {collection: count}, total: count}}
    
    # Iterate through all tagged images
    for image_key, tags_info in tags_data.items():
        # Extract collection name from image_key (format: collection/filename)
        parts = image_key.split('/')
        if len(parts) < 2:
            continue
        
        collection = parts[0]
        
        # Extract tags
        tags = []
        if isinstance(tags_info, list):
            tags = tags_info
        elif isinstance(tags_info, dict):
            tags = tags_info.get('tags', [])
        
        # Count each tag
        for tag in tags:
            if tag not in tag_counts:
                tag_counts[tag] = {'collections': {}, 'total': 0}
            
            if collection not in tag_counts[tag]['collections']:
                tag_counts[tag]['collections'][collection] = 0
            
            tag_counts[tag]['collections'][collection] += 1
            tag_counts[tag]['total'] += 1
    
    # Sort by total count (descending)
    sorted_tags = sorted(tag_counts.items(), key=lambda x: x[1]['total'], reverse=True)
    
    return jsonify({
        'success': True,
        'tags': [{'tag': tag, 'counts': data} for tag, data in sorted_tags]
    })


@app.route('/api/images-by-tags')
def api_images_by_tags():
    """Get images filtered by specific tags."""
    tags_filter = request.args.getlist('tags')  # Multiple tags can be passed
    match_all = request.args.get('matchAll', 'false').lower() == 'true'
    
    if not tags_filter:
        return jsonify({'success': False, 'error': 'No tags provided'}), 400
    
    tags_data = _load_tags()
    matching_images = []
    
    # Iterate through all tagged images
    for image_key, tags_info in tags_data.items():
        # Extract collection and filename (format: collection/filename)
        parts = image_key.split('/')
        if len(parts) < 2:
            continue
        
        collection = parts[0]
        filename = '/'.join(parts[1:])  # Handle filenames with slashes
        
        # Extract tags
        tags = []
        if isinstance(tags_info, list):
            tags = tags_info
        elif isinstance(tags_info, dict):
            tags = tags_info.get('tags', [])
        
        # Check if image matches filter
        if match_all:
            # Image must have all requested tags
            if all(tag in tags for tag in tags_filter):
                matching_images.append({
                    'filename': filename,
                    'collection': collection,
                    'url': f'/static/uploads/{collection}/{filename}',
                    'tags': tags
                })
        else:
            # Image must have at least one of the requested tags
            if any(tag in tags for tag in tags_filter):
                matching_images.append({
                    'filename': filename,
                    'collection': collection,
                    'url': f'/static/uploads/{collection}/{filename}',
                    'tags': tags
                })
    
    return jsonify({'success': True, 'images': matching_images, 'count': len(matching_images)})


if __name__ == '__main__':
    os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
    # Ensure default collections exist (Real and AI)
    os.makedirs(os.path.join(app.config['UPLOAD_FOLDER'], 'Real'), exist_ok=True)
    os.makedirs(os.path.join(app.config['UPLOAD_FOLDER'], 'AI'), exist_ok=True)
    _ensure_scores_file()
    # Clean up any malformed tags data from old format
    print("Cleaning up tags data...")
    _cleanup_tags()
    print("Tags cleanup complete!")
    app.run(debug=True)
