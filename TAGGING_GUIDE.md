# Image Tagging Feature Documentation

## Overview

The app now includes automatic image recognition and tagging using OpenAI's CLIP (Contrastive Language-Image Pre-training) model. When you upload images, the system automatically analyzes them and applies relevant tags based on their content.

## How It Works

1. **Upload**: When you upload an image, the app automatically analyzes it
2. **AI Analysis**: CLIP model examines the image content
3. **Tag Generation**: Generates descriptive tags (e.g., "person", "outdoor", "sunset", "portrait")
4. **Storage**: Tags are stored in `data/tags.json` for persistence
5. **Display**: Tags appear on gallery images when you hover over them

## Tag Categories

The system recognizes content in multiple categories:

### Subjects
- People: person, people, group, portrait, selfie
- Animals: pet, dog, cat, bird, wildlife
- Nature: landscape, mountain, ocean, forest, sky, sunset, sunrise
- Architecture: building, architecture, city, urban, street
- Food: food, meal, dessert, drink
- Vehicles: car, motorcycle, bicycle, airplane
- And more...

### Styles
- Photo types: photo, realistic, illustration, cartoon, anime
- Artistic: abstract, minimalist, vintage, modern
- Color: black and white, colorful, vibrant, muted
- Perspective: close-up, wide angle, aerial view, macro

### Moods
- happy, peaceful, dramatic, romantic, mysterious
- energetic, calm, dark, bright, warm, cool

### AI Detection
- AI generated vs. real photo detection
- Digital art vs. authentic photograph

## API Endpoints

### Get Tags for an Image
```http
GET /api/tags/<collection>/<filename>
```
Returns tags for a specific image.

**Response:**
```json
{
  "success": true,
  "tags": ["person", "outdoor", "portrait"],
  "detailed": [
    {"tag": "person", "confidence": 0.85},
    {"tag": "outdoor", "confidence": 0.72}
  ]
}
```

### Get All Tags
```http
GET /api/tags
```
Returns tags for all images.

### Update Tags Manually
```http
PUT /api/tags/<collection>/<filename>
Content-Type: application/json

{
  "tags": ["custom", "tag", "list"]
}
```

### Re-analyze an Image
```http
POST /api/retag/<collection>/<filename>
```
Forces re-analysis and updates tags.

### Search by Tag
```http
GET /api/search-by-tag?tag=sunset
```

**Response:**
```json
{
  "tag": "sunset",
  "count": 5,
  "images": [
    {
      "url": "/static/uploads/Real/image1.jpg",
      "tags": ["sunset", "ocean", "landscape"],
      "key": "Real/image1.jpg"
    }
  ]
}
```

## Using the Feature

### Automatic Tagging on Upload
1. Go to any collection gallery
2. Click "Upload Image" or drag and drop
3. Tags are automatically generated and saved
4. Hover over images to see their tags

### Viewing Tags
- **Gallery View**: Hover over any image to see up to 4 primary tags
- **Tag Badges**: Click on tags (future: filter by tag)

### Manual Tag Management
Use the API endpoints to:
- View detailed tag confidence scores
- Update tags manually if needed
- Re-analyze existing images

## Technical Details

### Model
- **Name**: CLIP (openai/clip-vit-base-patch32)
- **Type**: Vision-Language model
- **Size**: ~600MB (downloads on first use)
- **Performance**: Fast inference on CPU or GPU

### Storage
Tags are stored in `data/tags.json`:
```json
{
  "Real/image.jpg": {
    "tags": ["person", "outdoor"],
    "detailed": [
      {"tag": "person", "confidence": 0.85},
      {"tag": "outdoor", "confidence": 0.72}
    ]
  }
}
```

### Configuration
Edit `image_tagger.py` to customize:
- `TAG_CATEGORIES`: Add or remove tag categories
- `top_k`: Number of tags to return (default: 8)
- `threshold`: Minimum confidence (default: 0.15)

## Performance

- **First Run**: Model downloads (~600MB) - one-time only
- **Subsequent Runs**: Fast inference (1-3 seconds per image on CPU)
- **GPU Acceleration**: Automatically uses GPU if available (much faster)

## Examples

### Example Tags for Different Images

**Portrait Photo:**
- person, portrait, indoor, close-up, photo

**Landscape:**
- landscape, mountain, outdoor, nature, scenic

**Food Photo:**
- food, meal, close-up, colorful, indoor

**AI Art:**
- AI generated, digital art, illustration, colorful, abstract

**Pet Photo:**
- pet, dog, animal, indoor, portrait

## Troubleshooting

### Model Download Issues
If the model fails to download:
1. Check internet connection
2. Clear cache: `rm -rf ~/.cache/huggingface/`
3. Try again

### Performance Issues
- First inference is slower (model loading)
- Use GPU for faster processing
- Reduce `top_k` for faster results

### Tag Accuracy
- CLIP is trained on general web images
- Works best with common subjects
- May need manual adjustment for niche content

## Future Enhancements

Planned features:
- [ ] Tag-based search and filtering in UI
- [ ] Tag editing interface in gallery
- [ ] Batch re-tagging for existing images
- [ ] Custom tag training
- [ ] Tag-based image recommendations
- [ ] Multi-language tag support

## Dependencies

```
torch>=2.0.0
torchvision>=0.15.0
transformers>=4.30.0
Pillow>=10.0.0
```

All dependencies are listed in `requirements.txt`.
