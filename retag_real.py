#!/usr/bin/env python3
"""Retag Real collection with BLIP (realistic image tagger)"""
import os
import json
import sys

# Ensure current directory is in path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from image_tagger import analyze_image
from app import _get_image_key, ALLOWED_EXTENSIONS

def main():
    base = os.path.join('static', 'uploads')
    os.makedirs('data', exist_ok=True)
    
    # Load existing tags
    tags_file = os.path.join('data', 'tags.json')
    try:
        with open(tags_file, 'r', encoding='utf-8') as f:
            all_tags = json.load(f)
    except FileNotFoundError:
        all_tags = {}
    
    count = 0
    real_folder = os.path.join(base, 'Real')
    
    print("Retagging Real collection with BLIP (realistic image tagger)...")
    print("Parameters: top_k=25, threshold=0.20 (enhanced detail mode)\n")
    
    if os.path.isdir(real_folder):
        files = [f for f in os.listdir(real_folder) 
                 if os.path.isfile(os.path.join(real_folder, f)) 
                 and any(f.lower().endswith(ext) for ext in ALLOWED_EXTENSIONS)]
        
        total = len(files)
        print(f"Found {total} images\n")
        
        for filename in files:
            full_path = os.path.join(real_folder, filename)
            res = analyze_image(full_path, top_k=25, threshold=0.20)
            tags = [t['tag'] for t in res]
            key = _get_image_key('Real', filename)
            all_tags[key] = {'tags': tags, 'detailed': res}
            count += 1
            
            # Progress updates
            if count % 10 == 0:
                print(f"Progress: {count}/{total} images...")
            
            # Show first 3 samples
            if count <= 3:
                print(f"  {filename}: {', '.join(tags[:5])}")
    
    # Save updated tags
    with open(tags_file, 'w', encoding='utf-8') as f:
        json.dump(all_tags, f, indent=2)
    
    print(f"\n=== Complete ===")
    print(f"Tagged {count} images in Real collection")
    print(f"Saved to {tags_file}")

if __name__ == '__main__':
    main()
