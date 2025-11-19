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
    except Exception:
        return {}

def _save_tags(tags: dict):
    """Save image tags to JSON file."""
    try:
        with open(TAGS_FILE, 'w') as f:
            json.dump(tags, f, indent=2)
    except Exception:
        pass

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
            image_tags[filename] = tags_data[image_key].get('tags', [])

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
            image_data = all_tags.get(image_key, {})
            detailed_tags = image_data.get('detailed', [])
            
            if detailed_tags:
                # Extract just the tag names from detailed tags
                image_tag_names = [tag_obj.get('tag', '').lower().strip() for tag_obj in detailed_tags if tag_obj.get('tag')]
                
                # Iterate through quote keys in order (preserving JSON order)
                # Skip 'default' key in priority matching
                for quote_key in quotes_data.keys():
                    if quote_key == 'default':
                        continue
                    
                    # Check if any image tag matches this quote key
                    for tag in image_tag_names:
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
    """Accept a finished game score and compute/persist top scores per collection.
    Expects JSON: { collection: str, time: int, wrong: int, moves: int, username: str, pairs: int, matchSize: int }
    Stores top 10 scores per collection (leaderboard).
    """
    try:
        data = request.get_json() or {}
        collection = _safe_collection_name(str(data.get('collection') or ''))
        if not collection:
            return jsonify({'error': 'Invalid or missing collection'}), 400
        time_val = int(data.get('time', 0))
        wrong_val = int(data.get('wrong', 0))
        moves_val = int(data.get('moves', 0))
        pairs = int(data.get('pairs', 8))
        match_size = int(data.get('matchSize', 2))
        username = str(data.get('username') or 'Anonymous').strip()[:30]

        # Compute score
        score = _calculate_score(time_val, wrong_val, pairs, match_size)

        entry = {
            'score': score,
            'time': time_val,
            'wrong': wrong_val,
            'moves': moves_val,
            'pairs': pairs,
            'matchSize': match_size,
            'username': username
        }

        scores_data = _load_scores()
        # Each collection now holds a list of top entries
        if collection not in scores_data:
            scores_data[collection] = []
        
        leaderboard = scores_data[collection]
        if not isinstance(leaderboard, list):
            leaderboard = []
        
        leaderboard.append(entry)
        # Sort by score descending, then by time ascending (tie-breaker)
        leaderboard.sort(key=lambda x: (-x.get('score', 0), x.get('time', 10**9)))
        # Keep top 10
        leaderboard = leaderboard[:10]
        scores_data[collection] = leaderboard
        _save_scores(scores_data)

        # Check if this entry is in top 5 (considered "new best" for UI feedback)
        is_top = any(e == entry for e in leaderboard[:5])

        return jsonify({'success': True, 'updated': is_top, 'score': score, 'leaderboard': leaderboard[:5]})
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
    folder = os.path.join(app.config['UPLOAD_FOLDER'], collection)
    images = []
    try:
        for filename in os.listdir(folder):
            if any(filename.lower().endswith(ext) for ext in ALLOWED_EXTENSIONS):
                images.append(filename)
    except FileNotFoundError:
        images = []
    image_urls = [f"/static/uploads/{collection}/{fn}" for fn in images]
    return render_template('game.html', images=image_urls, collection=collection)


@app.route('/puzzle')
def puzzle():
    """Render the puzzle slider game page."""
    return redirect(url_for('collection_puzzle', collection_name='Real'))


@app.route('/collection/<collection_name>/puzzle')
def collection_puzzle(collection_name):
    """Render the puzzle slider game for a specific collection."""
    collection = _safe_collection_name(collection_name)
    folder = os.path.join(app.config['UPLOAD_FOLDER'], collection)
    images = []
    try:
        for filename in os.listdir(folder):
            if any(filename.lower().endswith(ext) for ext in ALLOWED_EXTENSIONS):
                images.append(filename)
    except FileNotFoundError:
        images = []
    image_urls = [f"/static/uploads/{collection}/{fn}" for fn in images]
    return render_template('puzzle.html', images=image_urls, collection=collection)


@app.route('/collection/<collection_name>/sequence')
def collection_sequence(collection_name):
    """Render the sequence memory game for a specific collection."""
    collection = _safe_collection_name(collection_name)
    folder = os.path.join(app.config['UPLOAD_FOLDER'], collection)
    images = []
    try:
        for filename in os.listdir(folder):
            if any(filename.lower().endswith(ext) for ext in ALLOWED_EXTENSIONS):
                images.append(filename)
    except FileNotFoundError:
        images = []
    return render_template('sequence.html', images=images, collection=collection)


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
        return jsonify({
            'success': True,
            'tags': tags_data[image_key].get('tags', []),
            'detailed': tags_data[image_key].get('detailed', [])
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


if __name__ == '__main__':
    os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
    # Ensure default collections exist (Real and AI)
    os.makedirs(os.path.join(app.config['UPLOAD_FOLDER'], 'Real'), exist_ok=True)
    os.makedirs(os.path.join(app.config['UPLOAD_FOLDER'], 'AI'), exist_ok=True)
    _ensure_scores_file()
    app.run(debug=True)