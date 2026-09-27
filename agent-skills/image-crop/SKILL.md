---
name: image-crop
description: Cropping an image to the part the user wants to keep. Use when the user asks to crop, trim, cut out, zoom in on or reframe an image, or to create an image and then crop it.
---
# Cropping images

1. If the user already said how to crop (e.g. "left half", "square", "1080x1080", "keep the tower"), crop that way. Do not ask.
2. If it is not clear how to crop, ask before any paid tool runs, so nothing is spent on a guess: call ask_user with only the question "How would you like to crop this image?". Give no options and no files: the user types the answer in their own words. Never ask a yes/no question and never offer a list of crop choices.
3. Turn the user's answer into crop_image arguments in percent units:
   - "left half" → x 0, y 0, width 50, height 100; "right half" → x 50, y 0, width 50, height 100
   - "top half" → x 0, y 0, width 100, height 50; "bottom half" → x 0, y 50, width 100, height 50
   - "square in the middle" → the largest centred square (for a 1536x1024 image: x 16.67, y 0, width 66.67, height 100)
   - "keep the middle 60%" → x 20, y 20, width 60, height 60
   - an exact size like "1080x1080" → pixel units with that width and height, x and y left out so the crop is centred
   - a subject ("keep the tower", "just the face") → a region around where it usually sits in the image, and say it is an estimate
4. If the answer is still unclear, ask once more the same way. Do not crop on a guess.
5. When the user asks to create an image and crop it, ask how to crop before creating the image.
6. After cropping, say in one sentence what was kept, e.g. "Kept the left half of the image."
