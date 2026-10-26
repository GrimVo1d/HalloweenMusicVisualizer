// =====================================================================
//  VISUALIZER SETTINGS
//  Change, save, reload the page (Cmd+Shift+R).
// =====================================================================

window.VIZ_CONFIG = {

  // Characters across the screen. More is finer and more detailed, but heavier for the laptop
  columns: 150,

  // Modes and their order. Remove some or reorder them:
  // 'bars' spectrum, 'art' skulls/pumpkins, 'scope' oscilloscope
  modes: ['bars', 'art', 'scope'],

  modeSeconds: 30,        // switch mode every N seconds (0 = keys only)

  sensitivity: 1,         // sound sensitivity from 0.2 to 1, 1 is max (↑ ↓ change it live)

  // Words that flash on screen in huge letters
  words: ['HAPPY HALLOWEEN', 'TRICK OR TREAT', 'BOO!', 'SPOOKY SEASON', 'BEWARE', 'RIP'],
  wordEveryBeats: 32,     // flash a word every N beats (0 = W key only)
  textLimit: 40,          // max length of your own text (T key)

  // Figures for the 'art' mode, from art.js:
  // skull, pumpkin, ghost, bat, spider, eye, tombstone, witch
  arts: ['skull', 'spider', 'pumpkin', 'eye', 'ghost', 'tombstone', 'bat', 'witch'],
  artBeats: 16,           // beats a figure holds before it explodes and the next one assembles

  shakeOnBeat: true,      // the screen jolts on strong beats
};
