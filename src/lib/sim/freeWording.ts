/*
  Free wording: an instruction said in everyday words, rewritten as the standard phrase the parser knows ("reduce altitude
  to three thousand feet" -> "descend to three thousand feet"). Only ever tried after the sentence failed to parse as it
  stands (commands.ts parseText), and only its result is parsed again, so nothing here can send what the grammar would not.

  Rules stay on the safe side: the numbers are never touched, a question or a negation is never rewritten, and a value has
  to look like what the verb asks for (an altitude is thousands, a flight level or "feet"; a heading three figures).
*/

const N1 = '(?:zero|oh|one|two|three|tree|four|fower|five|fife|six|seven|eight|nine|niner|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|\\d[\\d,]*)';
const NUM = `${N1}(?:[ -]${N1})*`;
/** A value that can only be an altitude / a speed / a heading. */
const ALT = `(?:flight level ${NUM}|fl ?\\d{2,3}|${NUM} thousand(?: ${NUM}(?: hundred)?)?(?: feet| ft)?|${NUM} (?:feet|ft)|\\d{1,2},?\\d{3}(?: feet| ft)?)`;
const KTS = `${NUM}(?= ?(?:knots|kts|kt)\\b)`;
const D = '(?:zero|oh|one|two|three|tree|four|fower|five|fife|six|seven|eight|nine|niner|\\d)';
const HDG = `(?:${D} ${D} ${D}|[0-3]\\d\\d)(?![ ,]*(?:\\d|thousand|hundred|feet|ft|knots|kts|kt|left|right|center))`;
const RWY = `(?:(?:${D} )?${D}(?: (?:left|right|center))?|[0-3]?\\d ?[lrc]?)`;
const IT = '(?:it|her|him|that|the plane|the aircraft|yourself|your aircraft)';
const YOUR = '(?:your |the |that |you )?';
const CAN = `(?:you(?:'re| are)? (?:can|may|could|good to|free to|ok(?:ay)? to|all clear to|clear(?:ed)? to|welcome to|now)(?: go ahead and)?|you'?re good to(?: go ahead and)?|youre (?:good|clear|cleared|free|okay) to|go ahead and|feel free to|it'?s ok(?:ay)? to|you have permission to|permission to)`;

const PHONETIC: Record<string, string> = { alpha: 'A', alfa: 'A', bravo: 'B', charlie: 'C', delta: 'D', echo: 'E', foxtrot: 'F', golf: 'G', hotel: 'H', india: 'I', juliet: 'J', juliett: 'J', kilo: 'K', lima: 'L', mike: 'M', november: 'N', oscar: 'O', papa: 'P', quebec: 'Q', romeo: 'R', sierra: 'S', tango: 'T', uniform: 'U', victor: 'V', whiskey: 'W', whisky: 'W', xray: 'X', yankee: 'Y', zulu: 'Z' };
const DIGIT: Record<string, string> = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', niner: '9', zero: '0' };
const TWY = `(?:taxiway )?((?:${Object.keys(PHONETIC).join('|')}|[a-z])(?: ?(?:${Object.keys(DIGIT).join('|')}|\\d{1,2}))?)`;

type Rule = [RegExp, string | ((...m: string[]) => string)];
const R = (s: string) => new RegExp(`\\b${s}`, 'g');

const RULES: Rule[] = [
  // ── altitude ──
  [R(`(?:reduce|lower|decrease|drop|bring down|cut|come down (?:in|on)) ${YOUR}(?:altitude|level|height)(?: back)?(?: down)?(?: to)? (${ALT}|${NUM})`), 'descend to $1'],
  [R(`(?:increase|raise|bring up|boost|lift) ${YOUR}(?:altitude|level|height)(?: back)?(?: up)?(?: to)? (${ALT}|${NUM})`), 'climb to $1'],
  [R(`(?:drop|get|go|come|head|sink|ease|step|move|bring|take|push)(?: ${IT})?(?: on| right| back)? ?(?:down)(?: to| towards?)? (${ALT})`), 'descend to $1'],
  [R(`(?:drop|sink)(?: ${IT})? to (${ALT})`), 'descend to $1'],
  [R(`(?:pop|get|go|come|head|ease|step|move|bring|take|pull)(?: ${IT})?(?: on| right| back)? ?(?:up)(?: to| towards?)? (${ALT})`), 'climb to $1'],
  [R(`climb(?: on| right)? up(?: to)? (${ALT})`), 'climb to $1'],
  [R(`descend(?: on| right)? down(?: to)? (${ALT})`), 'descend to $1'],
  [R(`(?:make|set|keep|hold|have) ${YOUR}(?:altitude|level|height)(?: at| to| as)? (${ALT}|${NUM})`), 'maintain $1'],
  [R(`(?:i(?:'d| would)? (?:need|want|like)|we need|give me|let'?s (?:have|get))(?: you)?(?: down| up)?(?: at| to)? (${ALT})`), 'maintain $1'],
  [R(`(?:be at|stay at|level off at|level at|stop at|hold at|cruise at) (${ALT})`), 'maintain $1'],
  // ── speed ──
  [R(`(?:cut|reduce|drop|bring|lower|decrease|pull|ease|take)(?: back)? ${YOUR}speed(?: down| back)*(?: to)? (${NUM})(?: ?(?:knots|kts|kt))?`), 'reduce speed to $1'],
  [R(`(?:slow|bring|ease|pull|drop|take)(?: ${IT})?(?: down| back)*(?: to)? (${KTS}) ?(?:knots|kts|kt)`), 'reduce speed to $1'],
  [R(`slow ${IT}(?: down)?(?: to)? (${NUM})(?: ?(?:knots|kts|kt))?`), 'reduce speed to $1'],
  [R(`(?:increase|pick up|bring up|raise|speed|push) ${YOUR}(?:speed )?(?:up )?(?:to )?(${KTS}) ?(?:knots|kts|kt)`), 'increase speed to $1'],
  [R(`(?:i(?:'d| would)? (?:need|want|like)|give me|make it|make your speed|keep(?: it)?(?: at)?|hold|do|fly|be at)(?: you)?(?: at| to)? (${KTS}) ?(?:knots|kts|kt)`), 'maintain $1 knots'],
  // ── heading ──
  [R(`(?:take ${IT}|bring ${IT}|swing|swing ${IT}|steer|veer|bank|go|come|make a|give me a|break)(?: a)?(?: round| around)?(?: to the)? (left|right)(?: turn)?(?: on| onto)?(?: to)?(?: a)?(?: heading)?(?: of)? (${HDG})`), 'turn $1 heading $2'],
  [R(`(?:head|steer|point|aim|fly towards?|fly a|go to heading|take a|make your|make)(?: to| towards?)?(?: heading| a heading)?(?: of)? (${HDG})`), 'fly heading $1'],
  // ── approach, landing, take-off ──
  [R(`clear(?:ed)? (?:for|on|onto|to)(?: the)? (?:ils|i l s)(?: approach)?`), 'cleared ils'],
  [R(`(?:${CAN} )?(?:take|shoot|fly|do)(?: the)? (?:ils|i l s)(?: approach)?(?: for| on| to| into)?(?: runway)?(?= ${RWY})`), 'cleared ils'],
  [R(`(?:${CAN}) land(?: on| at)?(?: the)?(?: runway)?(?= ${RWY}|$|,)`), 'cleared to land'],
  [R(`(?:${CAN}) (?:take ?off|depart)(?: from| on)?(?: the)?(?: runway)?(?= ${RWY}|$|,)`), 'cleared for takeoff'],
  [R(`(?:get|go|taxi|move|roll|pull)(?: on ?to| into| on)(?: the)? (?:runway|position)(?: and| then)? (?:wait|hold)(?: there)?`), 'line up and wait'],
  // ── frequency ──
  [R(`(?:talk|speak|switch(?: over)?|change(?: over)?|go|hop|flip|over|you can (?:talk|switch|go))(?: over)? to (tower|ground|approach|departure)(?: frequency| now)*`), 'contact $1'],
  // ── on the ground ──
  [R(`(?:stop|wait|hold|stay)(?: position| right)?(?: there| here| where you are| put| your position)\\b`), 'hold position'],
  [R(`(?:continue|carry on|keep going|go|keep)(?: on)?(?: straight)(?: ahead| on)?\\b`), 'continue taxi'],
];

/** Ground movement to a taxiway: the limit of a step-by-step clearance. */
const GROUND: [RegExp, (twy: (s: string) => string | null, ...m: string[]) => string | null][] = [
  // "continue / turn right on bravo until echo", "proceed via B hold short of D", "take B up to E"
  [R(`(?:after (?:that|crossing|you cross|the crossing),? )?(?:continue|proceed|keep (?:going|on|taxiing|rolling)|carry on|go|head|taxi|follow|use|take|turn|make a|hang a)(?: straight)?(?: (?:left|right))?(?: turn)?(?: on ?to| on| along| down| up| via| at| by)? ${TWY},?(?: and| then)? ?(?:until|till|up to|to|as far as|down to|hold(?:ing)?(?: short)?(?: of| at| before)?|stop(?:ping)?(?: short)?(?: of| at| before)?|short of)(?: you (?:reach|get to))? ${TWY}\\b`),
    (t, a, b) => { const x = t(a), y = t(b); return x && y ? `taxi via ${x} hold short of ${y}` : null; }],
  // "go to bravo (and hold there / and wait)", "taxi to kilo", "move up to K"
  [R(`(?:go|proceed|taxi|move|head|roll|drive|continue|pull)(?: on| up| over| forward| down)? to ${TWY}\\b(?! (?:gate|stand|\\d))(?:,?(?: and| then)? (?:hold|wait|stop)(?: there| position| short)?)?`),
    (t, a) => { const x = t(a); return x ? `taxi hold short of ${x}` : null; }],
  // "turn left on kilo", "continue on bravo", "after crossing turn right on bravo"
  [R(`(?:after (?:that|crossing|you cross|the crossing),? )?(?:continue|proceed|keep (?:going|on|taxiing)|carry on|turn|go|head|make a|hang a)(?: straight)?(?: (?:left|right))?(?: turn)?(?: on ?to| on| along| down| via| at) ${TWY}\\b(?= ?(?:$|,|and|then|hold|cross|report))`),
    (t, a) => { const x = t(a); return x ? `taxi via ${x}` : null; }],
];

const QUESTION = /^(?:what|where|when|why|who|how|are you|did you|do you|have you|is (?:that|it)|was|were|confirm|verify|say|can you (?:see|hear|tell)|could you (?:see|hear|tell))\b/;
const NEGATION = /\b(?:don'?t|do not|never|not yet|not|negative|cancel|disregard|instead of|unable|wait for|unless)\b/;

/** Courtesies and filler that carry no instruction; "report" tails the pilot makes anyway on reaching a limit. */
const SOFTEN: Rule[] = [
  [/^(?:(?:okay|ok|right|yeah|so)[, ]+)*(?:(?:you can|you may|you're good to|youre good to|go ahead and|go ahead)[, ]+)*(?=taxi\b)/g, ''],
  [/\b(?:please|for me|if you (?:can|could|would|wouldn't mind)|when you (?:can|get a chance)|real quick|just|kindly|i'?d like you to|i want you to|i need you to|would you|can you|could you|let'?s|okay so|alright|all right)\b/g, ' '],
  [/(?:,| and| then)* ?(?:report|tell me|let me know|call me|call(?: me)? back|advise|give me a (?:call|shout))(?: back)?(?: to me)?(?: (?:when|once) (?:you(?:'re| are| get| reach)?|there|at|holding|in position|done|clear)[a-z ']*)?(?: (?:there|holding|holding short|in position))?\.?$/g, ''],
];

const apply = (t: string, rules: Rule[]) => rules.reduce((s, [re, to]) => s.replace(re, to as string), t);

/** The sentence in standard words, or null when there is nothing to rewrite. `words` is what follows the callsign. */
export function freeWording(words: string, taxiways: string[] | undefined, ground: boolean, gate: string | null = null): string | null {
  const src = words.toLowerCase().replace(/[.!?;]+/g, ' ').replace(/\s+/g, ' ').replace(/^[\s,]+|[\s,]+$/g, '');
  if (!src || /\?\s*$/.test(words) || QUESTION.test(src) || NEGATION.test(src)) return null;
  const set = new Set((taxiways ?? []).map((t) => t.toUpperCase()));
  const twy = (s: string): string | null => {
    const m = /^([a-z]+?)(?: ?(one|two|three|four|five|six|seven|eight|niner?|zero|\d{1,2}))?$/.exec(s.trim()); if (!m) return null;
    const l = PHONETIC[m[1]] ?? (m[1].length === 1 ? m[1].toUpperCase() : null); if (!l) return null;
    const name = l + (m[2] ? DIGIT[m[2]] ?? m[2] : '');
    return set.size && !set.has(name) ? null : name;
  };
  let t = apply(src, SOFTEN).replace(/\s+/g, ' ').replace(/^[\s,]+|[\s,]+$/g, '');
  if (ground && gate) {
    // "taxi (via A and B) to the gate": its own stand
    t = t.replace(new RegExp(`\\b(?:next |now |then )?(?:go|proceed|head|drive|roll|move|continue|taxi|off you go|make your way)(?: on| over| back)?(?:(?: to| into) (?:the |your )?(?:gate|stand|parking(?: spot| stand)?|ramp|spot))(?= ?(?:$|,|via))`, 'g'), `taxi to stand ${gate}`);
    t = t.replace(new RegExp(`\\b(?:next |now |then )?(?:go|proceed|head|continue|taxi)(?: on)? via ((?:${TWY.replace(/\((?!\?)/g, '(?:')}(?:,| and| then)* ?)+)(?:to|into) (?:the |your )?(?:gate|stand|parking|ramp)\\b`, 'g'), (_w: string, list: string) => `taxi to stand ${gate} via ${list.replace(/,| and\b| then\b|taxiway /g, ' ').trim()}`);
  }
  if (ground) for (const [re, fn] of GROUND) t = t.replace(re, (whole: string, ...m: unknown[]) => fn(twy, ...(m.filter((x) => typeof x === 'string') as string[])) ?? whole);
  t = apply(t, RULES).replace(/\s+/g, ' ').trim();
  return t && t !== src ? t : null;
}
