# Quick Start Guide - Retag Features

## New Features Overview

Two powerful new features have been added to make retagging easier and more controlled:

### 1. 🔒 Lock Tags
Prevent an image's tags from being changed during bulk retag operations.

### 2. 📋 Copy Tags
Quickly copy tags from one image to another.

---

## How to Use

### Opening the Retag Interface

1. Go to **Manage Collections** (top navigation)
2. Click the **Retag** button on any collection
3. A modal will open showing all images in that collection

---

## Feature 1: Lock Tags

### What it does
Locks the tags for an image so they won't be changed when you click "Auto-Tag All Images". You can still manually edit or retag individual locked images.

### How to lock/unlock an image

1. In the retag modal, find the image you want to lock
2. Look for the **lock icon button** (bottom right of each image card)
3. Click to toggle between locked/unlocked states
   - **Unlocked** 🔓: Allows automatic retagging
   - **Locked** 🔒: Protects tags from auto-retagging

### Visual indicators
- Images with locked tags show a **lock badge** 🔒 next to their filename
- The lock button shows the current state with an icon

### When to use lock tags
- ✅ You've manually corrected tags and want to keep them
- ✅ Tags are perfect and shouldn't be changed
- ✅ You want to preserve specific descriptors
- ✅ You're doing a selective retag operation

### Example workflow
```
1. Manually tag an image with specific details
2. Click the lock button to lock it
3. Click "Auto-Tag All Images" - this image will be skipped
4. Other images get retagged, but yours stays the same
```

---

## Feature 2: Copy Tags

### What it does
Copies tags from one image to another. Useful for:
- Similar images that should have the same tags
- Batch tagging images from the same scene
- Quick duplication of good tags

### How to copy tags

1. Click the **"Copy To" button** on any image card
2. A modal will appear showing all other images in the collection
3. **Select an image** to copy tags FROM
   - Click any image thumbnail to select it
   - The selected image gets a highlight
4. **Review the tags** that will be copied (shown below)
5. Click **"Copy Selected Tags"** to copy them

### What happens
- Tags from the source image are copied to your target image
- Any previous tags on the target are replaced
- The target image's lock status is preserved

### When to use copy tags
- ✅ Tagging multiple photos from the same event
- ✅ Photos of the same subject or scene
- ✅ Quick batch tagging with manual tweaks
- ✅ You've already perfectly tagged one image

### Example workflow
```
1. You have 5 similar photos to tag
2. Auto-tag just one
3. Manually perfect its tags
4. Click "Copy To" on that perfect image
5. Select each of the other 4 images
6. Click "Copy Selected Tags"
7. Now all 5 have the same tags - tweak if needed
```

---

## Tips & Tricks

### Combining Both Features

**Best practice workflow:**
```
1. Auto-tag all images in a collection
2. Find images with really good tags
3. Lock those images (protect your work)
4. For images with bad tags:
   - Option A: Manually edit tags
   - Option B: Use "Copy To" from a good example
5. Lock the corrected images
6. Next time you retag, only unlocked images get changed
```

### Quick Selection Tips

- Hold in mind which images are similar
- Use "Copy To" to speed up tagging batches
- Lock after you've got the tags right
- The grid layout makes it easy to see all images at once

### Understanding Lock Status

| State | Icon | Meaning |
|-------|------|---------|
| Locked | 🔒 | Tags won't change with "Auto-Tag All" |
| Unlocked | 🔓 | Tags can be auto-retagged |

---

## Keyboard Shortcuts

- **Enter** in "Add Tags" modal: Submit new tags
- **Click outside modal**: Close without saving
- **Click overlay**: Close modal

---

## What Changed in Tags File

The tags are now stored in a smarter format:

**Old format:**
```json
{
  "collection/image.jpg": ["tag1", "tag2"]
}
```

**New format (automatic):**
```json
{
  "collection/image.jpg": {
    "tags": ["tag1", "tag2"],
    "locked": false
  }
}
```

✅ **Good news**: This conversion happens automatically. Your old tags still work!

---

## Troubleshooting

### Q: Where are my lock/copy buttons?
A: Make sure you're in the Retag modal for a collection. The buttons appear next to each image.

### Q: Can I copy tags to a locked image?
A: Yes! Lock status is preserved when copying tags to a target image.

### Q: What happens if I lock an image then delete its tags?
A: The lock only prevents "Auto-Tag All" from changing it. Manual deletion still works.

### Q: Can I lock multiple images at once?
A: Currently you need to lock them one at a time. Just click each lock button.

### Q: How do I unlock all images at once?
A: Currently you need to unlock them one at a time. A bulk unlock button might come in the future!

### Q: Do locks persist after I close the page?
A: Yes! Lock status is saved permanently in `data/tags.json`

### Q: Can I copy tags from a locked image?
A: Yes! You can copy from any image, locked or not.

---

## API for Developers

New API endpoints are available:

```
POST   /api/images/<collection>/<filename>/lock
POST   /api/images/<collection>/<filename>/unlock
GET    /api/images/<collection>/<filename>/lock-status
POST   /api/images/<collection>/<source>/copy-tags/<target>
```

Check `IMPLEMENTATION_NOTES.md` for technical details.

---

## Need Help?

- Check `RETAG_FEATURES.md` for detailed technical documentation
- Review `IMPLEMENTATION_NOTES.md` for developer information
- See `TAGGING_GUIDE.md` for general tagging information

---

## Next Steps

1. **Try locking an image**: Go to Manage Collections, click Retag, click the lock button
2. **Try copying tags**: Click "Copy To", select another image, copy
3. **Run auto-tag**: Click "Auto-Tag All" and see locked images get skipped
4. **Check the file**: Look at `data/tags.json` to see the new format

---

Happy tagging! 🎉
