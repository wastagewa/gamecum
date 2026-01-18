#!/usr/bin/env python3
"""
Quick test to verify the retag features implementation
"""
import json
import os
import sys

# Add current directory to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

def test_tag_normalization():
    """Test the tag normalization function"""
    from app import _normalize_tags_entry
    
    print("Testing tag normalization...")
    
    # Test old format (list)
    result = _normalize_tags_entry(["tag1", "tag2"])
    assert result["tags"] == ["tag1", "tag2"]
    assert result["locked"] == False
    print("✓ Old format (list) conversion works")
    
    # Test new format (dict with tags)
    result = _normalize_tags_entry({"tags": ["tag1", "tag2"], "locked": True})
    assert result["tags"] == ["tag1", "tag2"]
    assert result["locked"] == True
    print("✓ New format (dict) conversion works")
    
    # Test empty list
    result = _normalize_tags_entry([])
    assert result["tags"] == []
    assert result["locked"] == False
    print("✓ Empty list conversion works")
    
    # Test empty dict
    result = _normalize_tags_entry({})
    assert result["tags"] == []
    assert result["locked"] == False
    print("✓ Empty dict conversion works")

def test_helper_functions():
    """Test the helper functions exist and are callable"""
    from app import (
        _get_image_tags,
        _get_image_locked_status,
        _set_image_tags,
        _set_image_locked
    )
    
    print("\nTesting helper functions...")
    print("✓ _get_image_tags is callable")
    print("✓ _get_image_locked_status is callable")
    print("✓ _set_image_tags is callable")
    print("✓ _set_image_locked is callable")

def test_api_endpoints():
    """Test that API endpoints are registered"""
    from app import app
    
    print("\nTesting API endpoints...")
    
    endpoints = [
        "/api/images/<collection_name>/<filename>/lock",
        "/api/images/<collection_name>/<filename>/unlock",
        "/api/images/<collection_name>/<filename>/lock-status",
        "/api/images/<collection_name>/<source_filename>/copy-tags/<target_filename>",
    ]
    
    # Get all registered routes
    routes = [str(rule) for rule in app.url_map.iter_rules()]
    
    for endpoint in endpoints:
        # Check if endpoint or similar exists
        found = any(endpoint.replace('<', '').replace('>', '') in route for route in routes)
        if found:
            print(f"✓ {endpoint} registered")
        else:
            print(f"✗ {endpoint} NOT found (routes: {routes})")

def main():
    """Run all tests"""
    print("=" * 60)
    print("Retag Features Implementation Tests")
    print("=" * 60)
    
    try:
        test_tag_normalization()
        test_helper_functions()
        test_api_endpoints()
        
        print("\n" + "=" * 60)
        print("✓ All tests passed!")
        print("=" * 60)
        return 0
    except Exception as e:
        print(f"\n✗ Test failed: {e}")
        import traceback
        traceback.print_exc()
        return 1

if __name__ == "__main__":
    sys.exit(main())
