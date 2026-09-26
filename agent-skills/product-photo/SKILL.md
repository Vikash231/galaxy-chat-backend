---
name: product-photo
description: Clean e-commerce product shots with GPT Image 2. Use when the user wants a product photo, a white or studio background, a catalog or listing image, or to place a product in a lifestyle scene.
---
# Product photos

1. If the user attached a product photo, edit it (gpt_image_2 with the image in `images`) so the real product stays the same. Only create from text when there is no photo.
2. Build the prompt from `prompt-recipes.md` (read it with read_skill_asset): pick the recipe that matches the request and fill in the product.
3. Always say in the prompt what must NOT change: "keep the product's shape, colour, logo and text exactly as in the photo".
4. Use `quality: "low"` unless the user asks for higher quality; medium costs about 9x more.
5. For a transparent background, set `background: "transparent"`.
6. Reply in one sentence naming the style used, e.g. "Placed your sneaker on a clean white studio background."
