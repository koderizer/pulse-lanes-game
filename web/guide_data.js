// First-party, local instructions. Descriptors are the seam for later viewport presets.
// R62: entries carry a book-menu group; GUIDE_FAQ names the pill row (owner: pills + read-all menu).
const entry = (title, keywords, body, preset = 'reading', assetId = null, group = 'Run') =>
  ({title, keywords: keywords.split(' '), body, render: {preset, assetId, text: title}, group});
export const GUIDE_ENTRIES = [
  entry('Hop between lanes', 'controls control hop hops lane lanes steer arrows', 'Press Left or Right, or A or D, to hop lanes. On touch screens, use the lane arrows. Space fires.', 'tunnel', null, 'Controls'),
  entry('Boost', 'boost boosts speed faster', 'Press B or W, or tap the boost button. Watch the charge ring before trying again.', 'tunnel', null, 'Controls'),
  entry('Distance and scoring', 'score scoring distance km kilometres kilometers points', 'The run summary shows distance in KM, time and loops. Destroyed obstacles, dodges and pickups appear below it.', 'reading', null, 'Run'),
  entry('Seeds', 'seed seeds course', 'A seed identifies the course. Keep the same seed and mode to practise the same run.', 'reading', null, 'Run'),
  entry('Replay a run', 'retry replay repeat again', 'Replay on game over starts the last seed. Play starts a new seed.', 'reading', null, 'Run'),
  entry('Settings', 'settings setting sound music volume motion', 'Open Game settings in the lobby to set Volume, Quality and Motion reduction.', 'reading', null, 'Run'),
  entry('Dart', 'dart', 'Dart is the balanced arrowhead. Choose it in the lobby ship selector.', 'ship', 'dart', 'Ships'),
  entry('Delta', 'delta', 'Delta has a wide swept wing and twin engines. Choose it in the lobby ship selector.', 'ship', 'delta', 'Ships'),
  entry('Wraith', 'wraith', 'Wraith has a notched stealth wing. Choose it in the lobby ship selector.', 'ship', 'wraith', 'Ships'),
  entry('Hauler', 'hauler', 'Hauler has an armoured cargo frame and four engines. Choose it in the lobby ship selector.', 'ship', 'hauler', 'Ships'),
  entry('Lance', 'lance', 'Lance has a needle nose and short canards. Choose it in the lobby ship selector.', 'ship', 'lance', 'Ships'),
  entry('Run cards', 'card cards share selfie image', 'Choose Make card after a run. Save image downloads it; Share is available on supported browsers. Selfie adds a photo locally.', 'card', null, 'Cards'),
];
export const GUIDE_FAQ = ['Hop between lanes', 'Boost', 'Distance and scoring', 'Seeds', 'Replay a run', 'Run cards'];
export function matchGuide(question) {
  const words = new Set(question.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  let best = null, score = 0;
  for (const item of GUIDE_ENTRIES) {
    const overlap = item.keywords.filter(word => words.has(word)).length;
    if (overlap > score) { best = item; score = overlap; }
  }
  return best;
}
// Replace these lists when localised answers land.
export const WHY_YES = ['yes', 'y', 'yeah', 'yup'];
export const WHY_NO = ['no', 'n', 'nope', 'nah'];
