"""
Test script for image tagging functionality.
Usage: python test_tagging.py [path_to_image]
"""

import sys
import os

# Add parent directory to path to import image_tagger
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from image_tagger import analyze_image, get_primary_tags

def test_tagging(image_path=None):
    """Test the image tagging functionality."""
    
    if image_path and os.path.exists(image_path):
        print(f"\n{'='*60}")
        print(f"Testing Image Tagging: {image_path}")
        print(f"{'='*60}\n")
        
        # Test detailed analysis
        print("Analyzing image...")
        tags = analyze_image(image_path, top_k=10, threshold=0.1)
        
        if tags:
            print(f"\n✓ Found {len(tags)} tags:\n")
            for i, tag_info in enumerate(tags, 1):
                confidence_pct = tag_info['confidence'] * 100
                bar = '█' * int(confidence_pct / 5)
                print(f"  {i:2d}. {tag_info['tag']:20s} {bar} {confidence_pct:5.1f}%")
            
            print("\n" + "="*60)
            print("Primary tags (for display):")
            primary = get_primary_tags(image_path, max_tags=5)
            print(f"  {', '.join(primary)}")
            print("="*60 + "\n")
            
            return True
        else:
            print("✗ No tags generated (check if model is loading correctly)\n")
            return False
    else:
        print("\n" + "="*60)
        print("Image Tagging System - Quick Test")
        print("="*60)
        print("\nNo image provided for testing.")
        print("\nUsage:")
        print("  python test_tagging.py <path_to_image>")
        print("\nExample:")
        print("  python test_tagging.py static/uploads/Real/sample.jpg")
        print("\n" + "="*60)
        print("\nNote: On first run, the CLIP model (~600MB) will be downloaded.")
        print("This is a one-time download and will be cached locally.")
        print("="*60 + "\n")
        return False

if __name__ == "__main__":
    image_path = sys.argv[1] if len(sys.argv) > 1 else None
    
    try:
        success = test_tagging(image_path)
        sys.exit(0 if success else 1)
    except Exception as e:
        print(f"\n✗ Error: {e}\n")
        import traceback
        traceback.print_exc()
        sys.exit(1)
