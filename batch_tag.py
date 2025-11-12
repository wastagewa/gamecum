"""
Batch tagging utility for existing images in collections.
Re-analyzes all images and updates their tags.
"""

import os
import sys
import json
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from image_tagger import analyze_image

UPLOAD_FOLDER = os.path.join('static', 'uploads')
TAGS_FILE = os.path.join('data', 'tags.json')
ALLOWED_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.gif', '.webp'}

def load_tags():
    """Load existing tags."""
    if os.path.exists(TAGS_FILE):
        try:
            with open(TAGS_FILE, 'r') as f:
                return json.load(f)
        except Exception:
            return {}
    return {}

def save_tags(tags):
    """Save tags to file."""
    os.makedirs(os.path.dirname(TAGS_FILE), exist_ok=True)
    with open(TAGS_FILE, 'w') as f:
        json.dump(tags, f, indent=2)

def get_image_key(collection, filename):
    """Generate image key for storage."""
    return f"{collection}/{filename}" if collection else filename

def find_all_images():
    """Find all images in upload folder."""
    images = []
    
    if not os.path.exists(UPLOAD_FOLDER):
        return images
    
    # Check root level
    for file in os.listdir(UPLOAD_FOLDER):
        filepath = os.path.join(UPLOAD_FOLDER, file)
        if os.path.isfile(filepath):
            ext = os.path.splitext(file)[1].lower()
            if ext in ALLOWED_EXTENSIONS:
                images.append(('', file, filepath))
    
    # Check collections (subdirectories)
    for collection in os.listdir(UPLOAD_FOLDER):
        collection_path = os.path.join(UPLOAD_FOLDER, collection)
        if os.path.isdir(collection_path):
            for file in os.listdir(collection_path):
                filepath = os.path.join(collection_path, file)
                if os.path.isfile(filepath):
                    ext = os.path.splitext(file)[1].lower()
                    if ext in ALLOWED_EXTENSIONS:
                        images.append((collection, file, filepath))
    
    return images

def batch_tag_images(force_retag=False):
    """Tag all images in the upload folder."""
    print("\n" + "="*70)
    print("Batch Image Tagging Utility")
    print("="*70 + "\n")
    
    # Load existing tags
    all_tags = load_tags()
    print(f"Loaded {len(all_tags)} existing image tags")
    
    # Find all images
    images = find_all_images()
    print(f"Found {len(images)} images in upload folder\n")
    
    if not images:
        print("No images found. Upload some images first!")
        return
    
    # Process each image
    tagged_count = 0
    skipped_count = 0
    error_count = 0
    
    for i, (collection, filename, filepath) in enumerate(images, 1):
        image_key = get_image_key(collection, filename)
        display_name = f"{collection}/{filename}" if collection else filename
        
        # Skip if already tagged (unless force_retag)
        if not force_retag and image_key in all_tags:
            print(f"[{i}/{len(images)}] Skipped (already tagged): {display_name}")
            skipped_count += 1
            continue
        
        try:
            print(f"[{i}/{len(images)}] Analyzing: {display_name}...", end=' ')
            
            # Analyze image
            tags_result = analyze_image(filepath, top_k=8, threshold=0.15)
            tags = [t['tag'] for t in tags_result]
            
            if tags:
                all_tags[image_key] = {
                    'tags': tags,
                    'detailed': tags_result
                }
                tagged_count += 1
                print(f"Tagged: {', '.join(tags[:3])}{'...' if len(tags) > 3 else ''}")
            else:
                print("No tags generated")
                error_count += 1
                
        except Exception as e:
            print(f"Error: {e}")
            error_count += 1
    
    # Save updated tags
    if tagged_count > 0:
        save_tags(all_tags)
        print(f"\nSaved tags to {TAGS_FILE}")
    
    # Summary
    print("\n" + "="*70)
    print("Summary:")
    print(f"  Total images:     {len(images)}")
    print(f"  Newly tagged:     {tagged_count}")
    print(f"  Skipped:          {skipped_count}")
    print(f"  Errors:           {error_count}")
    print("="*70 + "\n")

if __name__ == "__main__":
    force = '--force' in sys.argv or '-f' in sys.argv
    
    if force:
        print("\nForce mode enabled - will re-tag all images\n")
    
    try:
        batch_tag_images(force_retag=force)
    except KeyboardInterrupt:
        print("\n\nInterrupted by user\n")
    except Exception as e:
        print(f"\nFatal error: {e}\n")
        import traceback
        traceback.print_exc()
