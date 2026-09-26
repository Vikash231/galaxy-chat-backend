---
name: social-media-sizes
description: Exact image sizes for Instagram, Facebook, X, LinkedIn, YouTube, TikTok and Pinterest. Use when the user wants an image to fit a platform, a post, story, reel, thumbnail, banner or cover.
---
# Sizing images for social platforms

1. Find the platform and format in `sizes.json` (read it with read_skill_asset). If the user names only the platform, use its most common format (Instagram → post) and say which one you picked.
2. For an existing image, call crop_image with `unit: "pixels"` and the exact width and height. Omit x and y so the crop is centred, unless the user says which part to keep.
3. If the image is smaller than the target size, crop to the target *aspect ratio* in percent units instead, and tell the user the result is smaller than the platform's recommended size.
4. To create a new image for a platform, call gpt_image_2 with the closest preset size (portrait targets → 1024x1536, landscape → 1536x1024, square → 1024x1024), then crop to the exact size.
5. In the reply, name the platform, the format and the final size, e.g. "Cropped to 1080×1920 for an Instagram story."
