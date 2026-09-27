---
name: video-montage
description: Planning a montage with Merge Videos, including clip order, fade or dissolve transitions, and cost. Use when the user wants to join, combine, stitch or merge several video clips.
---
# Video montages

1. Order: use the order the user states. If they refer to clips by content ("the tiger clip first") and the file names do not make it clear, call ask_user with the clip files (never a text question) to ask which clip is which before merging; a merge costs credits and cannot be undone.
2. With no stated order, keep the order the clips were attached.
3. Transition:
   - `none` for fast-paced edits, tutorials, or when the user says nothing about transitions.
   - `fade` for a calm, story-like feel or when scenes change mood.
   - `dissolve` for smooth scene-to-scene blends, e.g. travel or before/after.
4. Cost grows with both clip count and total length: about 40,000 credits per minute for 2 clips, plus 10,000 per minute for each extra clip. For more than 5 clips or over 2 minutes in total, tell the user the estimated cost first and ask them to confirm.
5. After merging, state the final order in plain words ("the 6-second clip, then the 15-second clip") and the transition used.
