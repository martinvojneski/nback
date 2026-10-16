# N-Back

A Dual N-Back working memory trainer that runs in the browser and is built for phones first.

**Play:** https://martinvojneski.github.io/nback/

## How to play

Every few seconds a square lights up on a 3×3 grid and a letter is spoken.

- Tap **Position** when the square is in the same spot as **N** turns ago.
- Tap **Sound** when the letter is the same as **N** turns ago.
- Both can match on the same turn; tap both.

Score 80% or more to move up a level, under 50% to drop one. Score is `hits / (hits + misses + wrong taps)`.

Modes: Position only, Sound only, or Dual (both). Settings let you change the speed (2–3.5 s per turn), switch spoken letters for tones, and turn off instant feedback or auto-levelling. Sessions are saved on your device.

Keyboard: `A` = Position, `L` = Sound, `Esc` = pause, `Space` = start.

## iPhone

Open the link in Safari, tap **Share → Add to Home Screen**, and it launches full screen like an app and works offline. If you hear nothing, turn up the volume or flip the silent switch off, or pick **Tones** under Settings.

## Run locally

It's plain HTML, CSS and JavaScript with no build step:

```bash
python -m http.server 8765
```

Then open http://localhost:8765.
