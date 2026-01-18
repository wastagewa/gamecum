# Retag Features - Lock Tags & Copy Tags

## Overview
Two new features have been added to the retagging system to provide more control over image tagging:

1. **Lock Tags** - Prevent an image's tags from being modified during "Retag All" operations
2. **Copy Tags** - Copy tags from one image to another during retagging

## Features

### 1. Lock Tags for an Image

#### What it does:
- Locks the tags for a specific image so they won't be changed when using the "Auto-Tag All Images" button
- Individual images can still be retagged manually even if their tags are locked
- The lock can be toggled at any time

#### How to use:
1. Go to **Manage Collections** > Select a collection > Click **Retag**
2. In the retag modal, each image card now shows a lock/unlock button (bottom right)
3. Click the lock icon to lock the image's tags (icon changes to locked state)
4. When using "Auto-Tag All Images", locked images will be skipped
5. Click the lock again to unlock and allow retagging

#### Technical Details:
- Tags are stored in a new format in `data/tags.json`:
  ```json
  {
    "collection/filename": {
      "tags": ["tag1", "tag2"],
      "locked": false
    }
  }
  ```
- Old format (simple list) is automatically converted on first use
- Lock status is preserved when updating tags manually
- The "Auto-Tag All" operation reports how many locked images were skipped

#### API Endpoints:
- `POST /api/images/<collection>/<filename>/lock` - Lock an image
- `POST /api/images/<collection>/<filename>/unlock` - Unlock an image
- `GET /api/images/<collection>/<filename>/lock-status` - Get lock status

---

### 2. Copy Tags from Another Image

#### What it does:
- Copy tags from one image to another during the retagging process
- Select a source image and copy its tags to a target image
- Tags can then be manually edited if needed
- Useful for images that are similar or part of the same scene

#### How to use:
1. Go to **Manage Collections** > Select a collection > Click **Retag**
2. Click the **"Copy To"** button on any image card
3. A modal will appear showing all other images in the collection
4. Click on an image to select it as the source
5. The tags from that source image will be displayed
6. Click **"Copy Selected Tags"** to copy the tags to the target image

#### Features:
- Visual feedback showing which image is selected as the source
- Preview of tags before copying
- Quick way to handle similar images
- Can copy to multiple images from the same source

#### Technical Details:
- Source image tags are fetched and copied to target image
- Preserves the target image's lock status
- Works with both locked and unlocked images as sources

#### API Endpoint:
- `POST /api/images/<collection>/<source_filename>/copy-tags/<target_filename>` - Copy tags from source to target

---

## Updated API Endpoints

### Retag All (Now skips locked images)
```
POST /api/collections/<collection_name>/retag-all
```

Response includes:
- `processed`: Number of images retagged
- `errors`: Number of errors
- `skipped_locked`: Number of locked images skipped (NEW)
- `message`: Status message

### Get Collection Images (Now includes lock status)
```
GET /api/collections/<collection_name>/images
```

Each image object now includes:
```json
{
  "filename": "image.jpg",
  "url": "/static/uploads/collection/image.jpg",
  "tags": ["tag1", "tag2"],
  "locked": false
}
```

---

## Data Structure

Tags file (`data/tags.json`) now uses this structure:

### New Format (Recommended):
```json
{
  "Real/image1.jpg": {
    "tags": ["person", "outdoor", "portrait"],
    "locked": false
  },
  "Real/image2.jpg": {
    "tags": ["landscape", "mountain", "sunset"],
    "locked": true
  }
}
```

### Old Format (Auto-converted):
```json
{
  "Real/image1.jpg": ["person", "outdoor", "portrait"]
}
```

Old entries are automatically converted to the new format on first use.

---

## UI Components

### Lock/Unlock Button
- Located in each image card in the retag modal
- Shows lock/unlock icon based on current state
- Locked images show a lock badge next to their filename

### Copy Tags Button
- Located in each image card alongside other buttons
- Opens a modal showing all other images as sources
- Visual grid layout for easy selection

### Copy Tags Modal
- Shows all images except the target
- Click to select source image
- Displays tags from selected source
- Confirm button to copy tags

---

## Examples

### Scenario 1: Batch tag similar images
1. Auto-tag the first image in a series
2. Use "Copy To" to copy its tags to the next image
3. Edit tags if needed
4. Repeat for remaining images

### Scenario 2: Protect important tags
1. Manually tag an image with specific descriptors
2. Lock the image to protect those tags
3. Run "Auto-Tag All" - that image will be skipped
4. Manually review and update other images as needed

### Scenario 3: Partial auto-tagging
1. Auto-tag all images
2. For images with incorrect tags, unlock and manually fix
3. For correct tags, lock to prevent future changes
4. Future "Auto-Tag All" operations will preserve your manual work

---

## Migration Notes

- Existing tags are automatically converted to the new format
- No manual action required
- Old format still works (converted on access)
- Backward compatible with existing workflows

---

## Troubleshooting

### Q: I don't see the lock button
A: Make sure you've reloaded the page and are viewing the retag modal for a collection

### Q: My tags disappeared
A: Check `data/tags.json` exists and has proper JSON formatting. Tags are preserved during migration.

### Q: Copy Tags button doesn't work
A: Ensure both source and target images exist in the same collection and the page has loaded all images

### Q: How do I migrate old tags.json?
A: Just access any image through the retag modal and the system will automatically normalize the format on first access.

---

## Future Enhancements

Possible improvements:
- Bulk lock/unlock operations
- Copy tags from templates
- Tag presets
- Conditional retag (e.g., only retag images without tags)
- Import/export tag sets
