# Quick Start - Image Tagging Feature

## 🚀 Get Started in 3 Steps

### 1. Install Dependencies
```powershell
# From the Imgur directory
C:/Users/logan/Documents/Imgur/.venv/Scripts/python.exe -m pip install torch torchvision transformers Pillow
```

**Note**: First-time model download (~600MB) happens automatically on first use.

### 2. Start the App
```powershell
python app.py
```

The app starts at `http://localhost:5000`

### 3. Upload & Tag Images
1. Navigate to a collection (Real or AI)
2. Click "Upload Image"
3. Tags automatically appear! 🎉

## 📸 See It in Action

### What Happens When You Upload
```
Your Image → AI Analysis → Tags Generated → Displayed in Gallery
   ↓              ↓              ↓                    ↓
 upload.jpg   [CLIP model]   "sunset,         Hover to see:
                             ocean,            #sunset
                             beach,            #ocean
                             landscape"        #beach
                                              #landscape
```

## 🎨 Visual Example

```
┌─────────────────────┐
│                     │
│    [Your Image]     │  ← Hover over me!
│                     │
├─────────────────────┤
│ #sunset #ocean      │  ← Tags appear here
│ #beach #landscape   │
└─────────────────────┘
```

## 🧪 Test the Tagging

### Test Single Image
```powershell
python test_tagging.py static/uploads/Real/yourimage.jpg
```

**Output:**
```
Analyzing image...

✓ Found 8 tags:

   1. sunset      ████████████████ 82.5%
   2. ocean       ██████████████   71.3%
   3. beach       ████████████     65.8%
   4. landscape   ███████████      58.2%
   ...
```

### Batch-Tag All Existing Images
```powershell
# Tag all images that don't have tags yet
python batch_tag.py

# Or force re-tag everything
python batch_tag.py --force
```

## 🔍 Use the API

### Get Tags for an Image
```bash
curl http://localhost:5000/api/tags/Real/image.jpg
```

### Search by Tag
```bash
curl http://localhost:5000/api/search-by-tag?tag=sunset
```

### Re-analyze an Image
```bash
curl -X POST http://localhost:5000/api/retag/Real/image.jpg
```

## 💡 Tips

### Best Practices
- ✅ Upload clear, well-lit images for best results
- ✅ Wait a few seconds for tagging on first upload (model loading)
- ✅ Tags are cached - no re-analysis on page reload
- ✅ Use batch_tag.py for existing image collections

### Customization
Edit `image_tagger.py` to:
- Add custom tag categories
- Adjust confidence threshold
- Change number of tags generated

### Performance
- **First upload**: 5-10 seconds (model loads)
- **Subsequent uploads**: 1-3 seconds per image
- **GPU available**: Much faster (< 1 second)

## 📊 Example Tags by Image Type

| Image Type | Expected Tags |
|------------|---------------|
| Portrait | `person`, `portrait`, `indoor`, `photo`, `realistic` |
| Landscape | `landscape`, `mountain`, `outdoor`, `nature`, `sky` |
| Food | `food`, `meal`, `close-up`, `colorful`, `indoor` |
| Pet | `pet`, `dog`, `animal`, `indoor`, `portrait` |
| AI Art | `AI generated`, `digital art`, `illustration`, `abstract` |
| Sunset | `sunset`, `sky`, `ocean`, `outdoor`, `warm` |
| City | `building`, `architecture`, `city`, `urban`, `outdoor` |

## 🎯 What's Tagged

The system recognizes:
- **Subjects**: people, animals, nature, buildings, food, vehicles
- **Styles**: photo, illustration, vintage, modern, close-up
- **Moods**: happy, peaceful, dramatic, romantic
- **Quality**: AI generated vs real photo

## ❓ Troubleshooting

### "Import error: torch not found"
```powershell
# Reinstall dependencies
C:/Users/logan/Documents/Imgur/.venv/Scripts/python.exe -m pip install torch torchvision transformers Pillow
```

### "Model download failed"
- Check internet connection
- Try again (downloads resume automatically)

### "No tags generated"
- Check image is valid (PNG, JPG, JPEG, GIF, WEBP)
- Try with a different image
- Check console for error messages

### "Too slow"
- First run is slow (model loading) - this is normal
- Subsequent uploads are much faster
- Consider using GPU for instant tagging

## 📚 More Info

- **Full Documentation**: See `TAGGING_GUIDE.md`
- **Implementation Details**: See `IMPLEMENTATION_SUMMARY.md`
- **API Reference**: See `TAGGING_GUIDE.md` → API Endpoints section

## ✨ Enjoy!

Your image gallery now has AI-powered tagging. Every image uploaded is automatically analyzed and tagged with relevant keywords. Happy organizing! 🎨📸
