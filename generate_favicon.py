#!/usr/bin/env python3
"""Generate PNG favicon from SVG"""
try:
    from PIL import Image, ImageDraw
    import io
    
    # Create a 32x32 favicon with a romantic/kinky heart design
    size = 32
    img = Image.new('RGBA', (size, size), (26, 26, 26, 255))
    draw = ImageDraw.Draw(img)
    
    # Draw heart shape (simple polygon approximation)
    heart_points = [
        (16, 8),   # top middle
        (10, 5),   # left top curve
        (5, 8),    # left side
        (5, 12),   # left bottom curve
        (16, 26),  # bottom point
        (27, 12),  # right bottom curve
        (27, 8),   # right side
        (22, 5),   # right top curve
    ]
    
    # Draw filled heart with gradient effect (simulate with multiple fills)
    draw.polygon(heart_points, fill=(255, 61, 113, 255))
    
    # Add highlight/sparkle
    draw.ellipse([8, 8, 10, 10], fill=(255, 255, 255, 200))
    
    # Save as PNG
    img.save('static/favicon.png')
    print("✓ Created static/favicon.png")
    
    # Also create 16x16 version
    img_small = img.resize((16, 16), Image.LANCZOS)
    img_small.save('static/favicon-16.png')
    print("✓ Created static/favicon-16.png")
    
    # Create ICO file with multiple sizes
    img.save('static/favicon.ico', format='ICO', sizes=[(16,16), (32,32)])
    print("✓ Created static/favicon.ico")
    
except ImportError:
    print("⚠ PIL/Pillow not installed. Using SVG favicon only.")
    print("Install with: pip install Pillow")
