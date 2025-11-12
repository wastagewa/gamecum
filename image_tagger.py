"""
Image tagging service with pluggable backends.

Backends supported:
- CLIP (default, zero-shot via Hugging Face)
- WD14-style tagger via ONNXRuntime (anime-focused, local model path from CivitAI)
- BLIP (realistic image captioning and tagging for real photographs)

This module exposes a unified API:
- analyze_image(image_path, top_k, threshold) -> List[{tag, confidence}]
- get_primary_tags(image_path, max_tags) -> List[str]
- set_tagger_config(dict) -> configure backend at runtime
"""

import os
import json
from typing import List, Dict, Tuple, Optional

from PIL import Image

# Optional deps; imported lazily when used
_torch = None
_clip_model = None
_clip_processor = None

_ort = None
_wd14_session = None
_wd14_labels: Optional[List[str]] = None

_blip_model = None
_blip_processor = None
_blip_vision_model = None

# Runtime config (persisted in data/tagger_config.json)
CONFIG_PATH = os.path.join('data', 'tagger_config.json')
_config = {
    'backend': 'blip',           # 'clip' | 'wd14' | 'blip'
    'model_path': None,          # path to onnx model (for wd14)
    'labels_path': None,         # path to labels.csv/tags.txt (for wd14)
    # Optional per-collection overrides: { 'Real': 'blip', 'AI': 'wd14' }
    'backend_overrides': {}
}

# Tags to filter out (overly generic or anime-specific that don't add value)
FILTERED_TAGS = {
    'general', 'sensitive', 'questionable', 'explicit',  # Rating tags
    'comic', 'silent_comic', '3koma', '4koma', '6koma',  # Comic format
    'negative_space', 'spot_color', 'high_contrast', 'still_life',  # Overly generic
    'no_humans', 'solo',  # Usually not informative
}


def _load_config_file():
    global _config
    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
                data = json.load(f)
                if isinstance(data, dict):
                    _config.update(data)
        except Exception:
            pass

def _save_config_file():
    try:
        with open(CONFIG_PATH, 'w', encoding='utf-8') as f:
            json.dump(_config, f, indent=2)
    except Exception:
        pass

def set_tagger_config(new_conf: Dict):
    """Update runtime configuration and reset backends if needed."""
    global _config, _clip_model, _clip_processor, _wd14_session, _wd14_labels, _blip_model, _blip_processor, _blip_vision_model
    _config.update({k: new_conf[k] for k in ['backend','model_path','labels_path','backend_overrides'] if k in new_conf})
    _save_config_file()
    # reset loaded models; lazy-reload on next call
    _clip_model = None
    _clip_processor = None
    _wd14_session = None
    _wd14_labels = None
    _blip_model = None
    _blip_processor = None
    _blip_vision_model = None


_load_config_file()

def _try_autoconfigure_wd14():
    """If a local WD14 model exists in image_recognition_model/, auto-configure it.
    Looks for model.onnx and selected_tags.csv (or other common names).
    Only runs if no backend is configured yet or if backend is already wd14.
    """
    try:
        base_dir = os.path.join(os.path.dirname(__file__), 'image_recognition_model')
        if not os.path.isdir(base_dir):
            return
        
        # Only auto-configure if:
        # 1. Backend is not set (default) OR
        # 2. Backend is already 'wd14' but paths are missing
        current_backend = _config.get('backend', 'blip')
        if current_backend not in ['clip', 'wd14']:
            # Don't override BLIP or other backends
            return
            
        # If already configured properly, do nothing
        if (_config.get('backend') == 'wd14' and
            _config.get('model_path') and os.path.exists(_config.get('model_path')) and
            _config.get('labels_path') and os.path.exists(_config.get('labels_path'))):
            return

        # Pick model
        candidate_models = [
            'model.onnx', 'wd14_tagger.onnx', 'wd14.onnx'
        ]
        model_path = None
        for name in candidate_models:
            p = os.path.join(base_dir, name)
            if os.path.exists(p):
                model_path = p
                break
        if model_path is None:
            # Fallback: first .onnx in folder
            for fname in os.listdir(base_dir):
                if fname.lower().endswith('.onnx'):
                    model_path = os.path.join(base_dir, fname)
                    break

        # Pick labels
        candidate_labels = [
            'selected_tags.csv', 'tags.csv', 'labels.csv', 'taglist.txt', 'class_list.txt'
        ]
        labels_path = None
        for name in candidate_labels:
            p = os.path.join(base_dir, name)
            if os.path.exists(p):
                labels_path = p
                break
        if labels_path is None:
            # Fallback: any .csv or .txt
            for fname in os.listdir(base_dir):
                low = fname.lower()
                if low.endswith('.csv') or low.endswith('.txt'):
                    labels_path = os.path.join(base_dir, fname)
                    break

        if model_path and labels_path:
            set_tagger_config({'backend': 'wd14', 'model_path': model_path, 'labels_path': labels_path})
            print(f"[tagger] Auto-configured WD14 backend: model={model_path}, labels={labels_path}")
    except Exception as e:
        print(f"[tagger] Auto-config WD14 failed: {e}")

_try_autoconfigure_wd14()

# Comprehensive tag categories for CLIP zero-shot classification
TAG_CATEGORIES = {
    "subjects": [
        "person", "people", "group", "portrait", "selfie",
        "animal", "pet", "dog", "cat", "bird", "wildlife",
        "nature", "landscape", "mountain", "ocean", "forest", "sky", "sunset", "sunrise",
        "building", "architecture", "city", "urban", "street",
        "food", "meal", "dessert", "drink",
        "vehicle", "car", "motorcycle", "bicycle", "airplane",
        "indoor", "outdoor", "room", "office", "home",
        "technology", "computer", "phone", "device",
        "art", "painting", "drawing", "sculpture",
        "sport", "game", "activity",
        "flower", "plant", "garden",
        "water", "beach", "lake", "river"
    ],
    "styles": [
        "photo", "realistic", "illustration", "cartoon", "anime",
        "abstract", "minimalist", "vintage", "modern",
        "black and white", "colorful", "vibrant", "muted",
        "close-up", "wide angle", "aerial view", "macro"
    ],
    "moods": [
        "happy", "peaceful", "dramatic", "romantic", "mysterious",
        "energetic", "calm", "dark", "bright", "warm", "cool"
    ],
    "ai_detection": [
        "AI generated", "digital art", "computer graphics",
        "real photo", "authentic photograph"
    ]
}

# Flatten all tags for CLIP processing
ALL_TAGS = []
for category_tags in TAG_CATEGORIES.values():
    ALL_TAGS.extend(category_tags)

def _load_clip_model():
    """Lazy-load CLIP model and processor."""
    global _torch, _clip_model, _clip_processor
    if _clip_model is None:
        print("[tagger] Loading CLIP model (first run may take a moment)...")
        from transformers import CLIPProcessor, CLIPModel
        import torch as _t
        _torch = _t
        _clip_model = CLIPModel.from_pretrained("openai/clip-vit-base-patch32")
        _clip_processor = CLIPProcessor.from_pretrained("openai/clip-vit-base-patch32")
        _clip_model.eval()
        print("[tagger] CLIP model loaded.")
    return _clip_model, _clip_processor


def _load_wd14(model_path: str, labels_path: str):
    """Lazy-load WD14 ONNX model and labels from local paths."""
    global _ort, _wd14_session, _wd14_labels
    if _wd14_session is None:
        print(f"[tagger] Loading WD14 tagger from {model_path}\n         labels: {labels_path}")
        import onnxruntime as ort
        _ort = ort
        _wd14_session = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])  # CPU by default
        # Load labels (CSV or one-per-line) with robust Windows-friendly decoding
        labels = []
        def _read_lines(path):
            # Try a few common encodings: UTF-8 with BOM, UTF-8, Windows-1252, Latin-1
            encodings = ('utf-8-sig', 'utf-8', 'cp1252', 'latin-1')
            last_err = None
            for enc in encodings:
                try:
                    with open(path, 'r', encoding=enc, errors='strict') as fh:
                        return fh.readlines()
                except Exception as e:
                    last_err = e
                    continue
            # Fallback: binary read with replacement to avoid hard failure
            try:
                with open(path, 'rb') as fh:
                    raw = fh.read()
                text = raw.decode('utf-8', errors='replace')
                return text.splitlines()
            except Exception:
                # Re-raise the last decoding error if all attempts failed
                raise last_err

        lines = [ln.strip() for ln in _read_lines(labels_path) if ln.strip()]
        # If looks like CSV, prefer a header column named 'name' (common in wd14 selected_tags.csv)
        if any(',' in ln for ln in lines):
            import csv
            reader = csv.reader(lines)
            rows = list(reader)
            if rows:
                header = [h.strip().lower() for h in rows[0]]
                header_like = any(h in {'name','tag','label','class','tag_name'} for h in header)
                start_idx = 1 if header_like else 0
                if header_like:
                    col_candidates = ['name','tag','label','class','tag_name']
                    col_idx = None
                    for cname in col_candidates:
                        if cname in header:
                            col_idx = header.index(cname)
                            break
                    if col_idx is None and rows:
                        for ci, val in enumerate(rows[start_idx]):
                            v = val.strip()
                            if not v.isdigit() and any(ch.isalpha() for ch in v):
                                col_idx = ci
                                break
                        if col_idx is None:
                            col_idx = 0
                else:
                    sample = rows[0]
                    col_idx = 0
                    for ci, val in enumerate(sample):
                        v = val.strip()
                        if not v.isdigit() and any(ch.isalpha() for ch in v):
                            col_idx = ci
                            break

                for r in rows[start_idx:]:
                    if not r:
                        continue
                    try:
                        tag = r[col_idx].strip()
                        if tag:
                            labels.append(tag)
                    except Exception:
                        continue
        else:
            # Plain tag list, one per line
            for line in lines:
                labels.append(line)
        _wd14_labels = labels
        print(f"[tagger] WD14 tagger loaded with {len(_wd14_labels)} labels.")
    return _wd14_session, _wd14_labels


def _analyze_clip(image_path: str, top_k: int = 10, threshold: float = 0.15) -> List[Dict[str, any]]:
    """
    Analyze an image and return relevant tags with confidence scores.
    
    Args:
        image_path: Path to the image file
        top_k: Number of top tags to return
        threshold: Minimum confidence threshold (0-1)
    
    Returns:
        List of dicts with 'tag' and 'confidence' keys, sorted by confidence
    """
    try:
        model, processor = _load_clip_model()
        
        # Load and preprocess image
        image = Image.open(image_path).convert("RGB")
        
        # Prepare inputs for CLIP
        inputs = processor(
            text=[f"a photo of {tag}" for tag in ALL_TAGS],
            images=image,
            return_tensors="pt",
            padding=True
        )
        
        # Get predictions
        with _torch.no_grad():
            outputs = model(**inputs)
            logits_per_image = outputs.logits_per_image
            probs = logits_per_image.softmax(dim=1)[0]
        
        # Extract top tags
        results = []
        for idx, prob in enumerate(probs):
            confidence = float(prob.item())
            if confidence >= threshold:
                results.append({
                    'tag': ALL_TAGS[idx],
                    'confidence': round(confidence, 3)
                })
        
        # Sort by confidence and return top_k
        results.sort(key=lambda x: x['confidence'], reverse=True)
        return results[:top_k]
        
    except Exception as e:
        print(f"[tagger] Error (CLIP) analyzing image {image_path}: {e}")
        return []

def _preprocess_wd14(image: Image.Image):
    """Preprocess PIL image for WD14 ONNX (ConvNeXt 448x448)."""
    import numpy as np
    img = image.convert('RGB').resize((448, 448), Image.BICUBIC)
    arr = np.asarray(img).astype('float32') / 255.0
    # Normalize to [-1, 1]
    arr = (arr - 0.5) / 0.5
    # Keep NHWC layout as expected by many WD14 ONNX models (1, 448, 448, 3)
    # Add batch dimension
    arr = arr[None, :, :, :]
    return arr


def _analyze_wd14(image_path: str, top_k: int = 10, threshold: float = 0.35) -> List[Dict[str, any]]:
    try:
        model_path = _config.get('model_path')
        labels_path = _config.get('labels_path')
        if not model_path or not labels_path or not os.path.exists(model_path) or not os.path.exists(labels_path):
            print("[tagger] WD14 model/labels not configured or missing; falling back to CLIP")
            return _analyze_clip(image_path, top_k=top_k, threshold=threshold)
        session, labels = _load_wd14(model_path, labels_path)

        image = Image.open(image_path).convert('RGB')
        inp = _preprocess_wd14(image)
        input_name = session.get_inputs()[0].name
        out = session.run(None, {input_name: inp})
        if not out:
            return []
        import numpy as np
        logits = out[0].reshape(-1)
        # Sigmoid to confidence
        conf = 1 / (1 + np.exp(-logits))
        results = []
        for idx, p in enumerate(conf):
            p = float(p)
            if p >= threshold and idx < len(labels):
                results.append({'tag': labels[idx], 'confidence': round(p, 3)})
        results.sort(key=lambda x: x['confidence'], reverse=True)
        return results[:top_k]
    except Exception as e:
        print(f"[tagger] Error (WD14) analyzing image {image_path}: {e}")
        return []


def _load_blip_models():
    """Lazy-load BLIP models for realistic image tagging."""
    global _torch, _blip_model, _blip_processor, _blip_vision_model
    if _blip_model is None:
        print("[tagger] Loading BLIP models for realistic image tagging (first run may take a moment)...")
        from transformers import BlipProcessor, BlipForConditionalGeneration, BlipForImageTextRetrieval
        import torch as _t
        _torch = _t
        
        # BLIP for captioning
        _blip_processor = BlipProcessor.from_pretrained("Salesforce/blip-image-captioning-base")
        _blip_model = BlipForConditionalGeneration.from_pretrained("Salesforce/blip-image-captioning-base")
        _blip_model.eval()
        
        print("[tagger] BLIP models loaded.")
    return _blip_model, _blip_processor


def _analyze_blip(image_path: str, top_k: int = 10, threshold: float = 0.15) -> List[Dict[str, any]]:
    """
    Analyze realistic images using BLIP to generate natural language descriptions and tags.
    Produces tags like: 'woman', 'long hair', 'sitting', 'white background', 'smiling'
    """
    try:
        model, processor = _load_blip_models()
        image = Image.open(image_path).convert("RGB")
        
        # Generate multiple diverse captions with different strategies
        inputs = processor(image, return_tensors="pt")
        
        captions = []
        
        # Strategy 1: Beam search for detailed descriptions
        with _torch.no_grad():
            out = model.generate(**inputs, max_length=60, num_beams=5, num_return_sequences=4)
        for seq in out:
            caption = processor.decode(seq, skip_special_tokens=True)
            if caption and caption not in captions:
                captions.append(caption)
        
        # Strategy 2: Sampling for more varied descriptions
        with _torch.no_grad():
            out = model.generate(**inputs, max_length=50, do_sample=True, top_k=50, top_p=0.92, num_return_sequences=2)
        for seq in out:
            caption = processor.decode(seq, skip_special_tokens=True)
            if caption and caption not in captions:
                captions.append(caption)
        
        # Extract structured information from captions with enhanced detail
        tags_dict = {}
        import re
        
        # Track attributes separately for better organization
        appearance_attrs = []
        action_attrs = []
        setting_attrs = []
        
        for caption in captions:
            caption = caption.lower().strip()
            original_caption = caption
            
            # Extract key descriptive words and phrases
            # Remove sentence starters
            caption = re.sub(r'^(a|an|the|this|that|there is|there are|image shows|photo of|picture of)\s+', '', caption)
            
            # Detect actions/poses
            action_words = ['sitting', 'standing', 'lying', 'leaning', 'posing', 'smiling', 'looking', 'holding', 'wearing', 'showing', 'facing', 'kneeling', 'bending']
            for action in action_words:
                if action in original_caption:
                    action_attrs.append(action)
                    tags_dict[action] = tags_dict.get(action, 0) + 4
            
            # Detect clothing and appearance
            clothing_patterns = [
                r'(wearing|in)\s+(a\s+)?(\w+\s+)?(dress|shirt|top|bottom|pants|jeans|skirt|jacket|coat|swimsuit|bikini|lingerie|underwear)',
                r'(\w+\s+)?(hair|eyes|skin|lips|nails)',
                r'(long|short|curly|straight|blonde|brunette|black|red|brown)\s+(hair)',
                r'(blue|green|brown|hazel|dark)\s+(eyes)'
            ]
            for pattern in clothing_patterns:
                matches = re.finditer(pattern, original_caption)
                for match in matches:
                    detail = match.group(0).strip()
                    detail = re.sub(r'\b(a|an|the|in|wearing)\b', '', detail).strip()
                    if len(detail) >= 4:
                        appearance_attrs.append(detail)
                        tags_dict[detail] = tags_dict.get(detail, 0) + 5
            
            # Detect setting/background
            setting_words = ['background', 'wall', 'floor', 'room', 'outdoor', 'indoor', 'studio', 'bedroom', 'bathroom', 'kitchen', 'office', 'beach', 'forest', 'park', 'street']
            for setting in setting_words:
                if setting in original_caption:
                    setting_attrs.append(setting)
                    tags_dict[setting] = tags_dict.get(setting, 0) + 3
            
            # Extract color descriptions
            colors = ['white', 'black', 'red', 'blue', 'green', 'yellow', 'pink', 'purple', 'grey', 'gray', 'brown', 'orange']
            for color in colors:
                if color in original_caption:
                    tags_dict[color] = tags_dict.get(color, 0) + 2
            
            # Split by common separators for general extraction
            parts = re.split(r'[,\s]+(?:with|and|in|on|at|wearing|has|having|next to|behind|front of)\s+', caption)
            
            for part in parts:
                part = part.strip()
                if not part or len(part) < 3:
                    continue
                
                # Clean up
                part = re.sub(r'\b(a|an|the|is|are|was|were)\b', '', part).strip()
                
                # Extract meaningful phrases
                words = part.split()
                if len(words) == 1 and len(words[0]) >= 4:
                    tags_dict[words[0]] = tags_dict.get(words[0], 0) + 2
                elif len(words) == 2:
                    # Two-word phrases like "long hair", "white background"
                    phrase = ' '.join(words)
                    if phrase not in tags_dict or tags_dict[phrase] < 5:  # Don't override higher scores
                        tags_dict[phrase] = tags_dict.get(phrase, 0) + 3
                elif len(words) >= 3:
                    # Take last 2-3 words for key phrases
                    phrase = ' '.join(words[-2:])
                    if len(phrase) >= 6:
                        tags_dict[phrase] = tags_dict.get(phrase, 0) + 1
                    # Also try first 2 words if they seem descriptive
                    phrase2 = ' '.join(words[:2])
                    if len(phrase2) >= 6 and any(adj in words[0] for adj in ['long', 'short', 'dark', 'light', 'large', 'small']):
                        tags_dict[phrase2] = tags_dict.get(phrase2, 0) + 2
        
        # Add human detection tags
        human_indicators = ['woman', 'man', 'person', 'people', 'girl', 'boy', 'child', 'lady', 'gentleman']
        has_human = any(indicator in ' '.join(captions).lower() for indicator in human_indicators)
        
        if has_human:
            # Extract gender/age if mentioned
            text = ' '.join(captions).lower()
            if 'woman' in text or 'lady' in text or 'girl' in text and 'boy' not in text:
                tags_dict['woman'] = tags_dict.get('woman', 0) + 5
            if 'man' in text and 'woman' not in text:
                tags_dict['man'] = tags_dict.get('man', 0) + 5
        
        # Convert to result format
        if not tags_dict:
            # Fallback: use main caption words
            main_caption = captions[0] if captions else ""
            words = [w for w in main_caption.lower().split() if len(w) >= 4]
            for w in words[:top_k]:
                tags_dict[w] = 1
        
        max_count = max(tags_dict.values()) if tags_dict else 1
        results = []
        for tag, count in tags_dict.items():
            # Filter out junk
            if tag.count("'") > 2 or tag.count('"') > 2:
                continue
            if len(tag) < 3:
                continue
                
            confidence = min(0.95, (count / max_count) * 0.7 + 0.25)
            if confidence >= threshold:
                results.append({
                    'tag': tag,
                    'confidence': round(confidence, 3)
                })
        
        # Sort by confidence and return top_k
        results.sort(key=lambda x: x['confidence'], reverse=True)
        return results[:top_k]
        
    except Exception as e:
        print(f"[tagger] Error (BLIP) analyzing image {image_path}: {e}")
        import traceback
        traceback.print_exc()
        return []


def analyze_image(image_path: str, top_k: int = 10, threshold: float = 0.15) -> List[Dict[str, any]]:
    """Analyze an image and return relevant tags with confidence scores using configured backend."""
    # Determine backend, honoring per-collection overrides when possible
    backend = (_config.get('backend') or 'clip').lower()
    try:
        overrides = _config.get('backend_overrides') or {}
        # Try to infer collection name from path: .../uploads/<collection>/<file>
        # Handle both Windows (\\) and POSIX (/) separators
        norm_path = image_path.replace('\\', '/').lower()
        # Find '/uploads/' segment
        marker = '/uploads/'
        if marker in norm_path:
            seg = norm_path.split(marker, 1)[1]
            parts = seg.split('/')
            if parts:
                collection = parts[0]
                # Match overrides case-insensitively
                for k, v in overrides.items():
                    if k and k.lower() == collection:
                        backend = str(v).lower()
                        break
    except Exception:
        pass
    if backend == 'wd14':
        # Use the provided threshold directly for WD14; caller can tune as needed
        raw_results = _analyze_wd14(image_path, top_k=top_k * 2, threshold=threshold)  # Get more, then filter
        # Filter out generic/irrelevant tags
        filtered = [r for r in raw_results if r['tag'] not in FILTERED_TAGS]
        return filtered[:top_k]
    elif backend == 'blip':
        # Use BLIP for realistic image tagging
        return _analyze_blip(image_path, top_k=top_k, threshold=threshold)
    return _analyze_clip(image_path, top_k=top_k, threshold=threshold)


def get_primary_tags(image_path: str, max_tags: int = 5) -> List[str]:
    """
    Get a simplified list of primary tags for an image.
    
    Args:
        image_path: Path to the image file
        max_tags: Maximum number of tags to return
    
    Returns:
        List of tag strings
    """
    results = analyze_image(image_path, top_k=max_tags, threshold=0.2)
    return [r['tag'] for r in results]


def batch_analyze_images(image_paths: List[str], top_k: int = 5) -> Dict[str, List[Dict]]:
    """
    Analyze multiple images and return tags for each.
    
    Args:
        image_paths: List of image file paths
        top_k: Number of tags per image
    
    Returns:
        Dict mapping image path to list of tag dicts
    """
    results = {}
    for path in image_paths:
        if os.path.exists(path):
            results[path] = analyze_image(path, top_k=top_k)
    return results


if __name__ == "__main__":
    # Test the tagging service
    import sys
    if len(sys.argv) > 1 and sys.argv[1] not in ("--set-wd14", "--backend"):
        test_image = sys.argv[1]
        if os.path.exists(test_image):
            print(f"\nAnalyzing: {test_image}\n")
            tags = analyze_image(test_image)
            print("Top tags:")
            for tag_info in tags:
                print(f"  {tag_info['tag']}: {tag_info['confidence']:.1%}")
        else:
            print(f"Image not found: {test_image}")
    elif len(sys.argv) > 3 and sys.argv[1] == "--set-wd14":
        # Usage: python image_tagger.py --set-wd14 <model.onnx> <labels.csv>
        set_tagger_config({'backend': 'wd14', 'model_path': sys.argv[2], 'labels_path': sys.argv[3]})
        print("Saved WD14 config:", _config)
    elif len(sys.argv) > 2 and sys.argv[1] == "--backend":
        # Usage: python image_tagger.py --backend clip|wd14
        set_tagger_config({'backend': sys.argv[2]})
        print("Saved backend:", _config)
    else:
        print("Usage: python image_tagger.py <image_path>")
        print("       python image_tagger.py --backend clip|wd14")
        print("       python image_tagger.py --set-wd14 <model.onnx> <labels.csv>")
