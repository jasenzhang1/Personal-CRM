/**
 * Turning usernames and messy names into "First Last".
 *
 * Instagram's followers file only has usernames (john.smith_99, jsmith, sk8rgirl), so imported
 * people often have a username for a name. Suggestions, best first:
 *   1. the name they show in your chats (Instagram / Messenger / Discord display name)
 *   2. tidying an existing name: emoji and symbols removed, "JOHN SMITH" / "john smith" → "John Smith"
 *   3. splitting the username at . _ - ("john.smith_99" → "John Smith")
 *   4. splitting a run-together username at a known first name ("johnsmith" → "John Smith")
 *   5. just a first name ("john" → "John"), which you'll want to finish yourself
 * "high" suggestions are safe to apply automatically; the others are for you to review.
 */

export type NameConfidence = 'high' | 'medium' | 'low';
export type NameReason = 'chat' | 'tidy' | 'username' | 'split' | 'first-only';
export interface NameSuggestion {
  name: string;
  confidence: NameConfidence;
  reason: NameReason;
}

export const REASON_LABELS: Record<NameReason, string> = {
  chat: 'Their name on Instagram or in chats',
  tidy: 'Fixed capitals / symbols',
  username: 'From their username',
  split: 'Guessed from their username',
  'first-only': 'First name only, add a last name',
};

// Lowercase surname particles: "Ana de la Cruz", "Vincent van Gogh".
const PARTICLES = new Set(['de', 'da', 'das', 'do', 'dos', 'del', 'della', 'der', 'den', 'di', 'du', 'la', 'le', 'van', 'von', 'bin', 'binti', 'al', 'el', 'y', 'e']);
// Bits people wrap usernames in: its.john.smith, real_john, johnsmith.official
const DECORATIONS = new Set(['its', 'im', 'iam', 'the', 'real', 'official', 'xx', 'xo', 'x', 'mr', 'mrs', 'ms', 'dr', 'hey', 'yo', 'tv', 'art', 'photo', 'photos', 'photography', 'music', 'fit', 'eats']);
const TITLES = new Set(['dr', 'mr', 'mrs', 'ms', 'prof']);
const PREFIXES = ['its', 'iam', 'im', 'the', 'real', 'hey'];
const SUFFIXES = ['official', 'xo', 'xx', 'tv'];

const hasCase = (s: string) => /\p{Lu}|\p{Ll}/u.test(s);

/** Is this already a proper "First Last" name? Names in scripts without capitals (中文, 한국어) count as fine. */
export function looksStandard(name: string): boolean {
  const n = name.trim();
  if (!n || !/\p{L}/u.test(n)) return false;
  if (/[\d_@#]/.test(n) || /\p{Extended_Pictographic}/u.test(n)) return false;
  if (!hasCase(n)) return true;
  const words = n.split(/\s+/);
  if (words.length < 2) return false;
  return words.every((w, i) => {
    if (i > 0 && PARTICLES.has(w)) return true;
    if (!/^\p{Lu}/u.test(w)) return false; // must start with a capital
    const letters = w.replace(/[^\p{L}]/gu, '');
    // ALL CAPS words longer than 3 letters ("SMITH") aren't standard; "DJ", "JR", "AJ" are fine.
    return letters.length <= 3 || /\p{Ll}/u.test(letters);
  });
}

/** "o'brien" → "O'Brien", "mary-jane" → "Mary-Jane", "mcdonald" → "McDonald". */
export function capitalizeWord(w: string, first = true): string {
  const lower = w.toLowerCase();
  if (!first && PARTICLES.has(lower)) return lower;
  const cap = lower.replace(/(^|[-'’])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
  return /^mc\p{L}{2,}/u.test(lower) ? 'Mc' + cap.charAt(2).toUpperCase() + cap.slice(3) : cap;
}

const titleCase = (words: string[]) => words.map((w, i) => capitalizeWord(w, i === 0)).join(' ');

/** Remove emoji, digits and symbols; fix ALL CAPS or all-lowercase. Keeps deliberate mixed case like "DeShawn". */
export function tidyName(s: string): string {
  const words = s.replace(/[\uFE0E\uFE0F\u200D]/g, '').replace(/[^\p{L}\p{M}\s'’.-]/gu, ' ').replace(/\s+/g, ' ').trim().split(' ').filter((w) => w && w !== '.' && w !== '-');
  while (words.length > 2 && TITLES.has(words[0].toLowerCase().replace(/\.$/, ''))) words.shift();
  if (!words.length) return '';
  const joined = words.join(' ');
  const letters = joined.replace(/[^\p{L}]/gu, '');
  const oneCase = letters === letters.toLowerCase() || letters === letters.toUpperCase();
  return oneCase && hasCase(letters) ? titleCase(words) : words.map((w) => (/^\p{Ll}/u.test(w) && !PARTICLES.has(w) ? capitalizeWord(w) : w)).join(' ');
}

/** Split a username into name parts, or [] if it doesn't look like a name. */
function usernameParts(username: string): string[] {
  const u = username.trim().replace(/^@/, '').toLowerCase();
  // "skylarrr" → "skylar", "huuu" → "hu"
  let parts = u.split(/[._\-\s]+|\d+/).map((p) => p.replace(/(\p{L})\1{2,}/gu, '$1')).filter(Boolean);
  parts = parts.filter((p) => !DECORATIONS.has(p));
  // Middle/last initials ("edwin.m.yang", "mya_yun.h") don't belong in "First Last".
  if (parts.length > 1) parts = parts.filter((p) => p.length > 1);
  return parts;
}

/**
 * Split a run-together username: "johnsmith" → John Smith, "zongyundeng" → Zongyun Deng.
 * Uses known first names at the start and known last names at the end. `sure` = both matched.
 */
function splitRunTogether(word: string): { parts: string[]; sure: boolean } | null {
  // Try the username as is first, then without "its"/"im"/"official" wrappers; prefer a sure split.
  // ("imani..." stays Imani instead of losing "im".)
  let w = word;
  for (const suf of SUFFIXES) if (w.endsWith(suf) && w.length - suf.length >= 5) w = w.slice(0, -suf.length);
  const tries = [w, ...PREFIXES.filter((p) => w.startsWith(p) && w.length - p.length >= 5).map((p) => w.slice(p.length))];
  const results = tries.map(splitCore).filter((r): r is { parts: string[]; sure: boolean } => !!r);
  return results.find((r) => r.sure) ?? results[0] ?? null;
}

function splitCore(w: string): { parts: string[]; sure: boolean } | null {
  if (FIRST_NAMES.has(w)) return null; // "matthew" is a first name, not "Matt Hew"
  const first = firstNameAt(w);
  const last = lastNameAt(w, first);
  if (first && last) {
    const middle = w.slice(first.length, w.length - last.length);
    if (middle.length === 0) return { parts: [first, last], sure: true };
    if (middle.length === 1) return { parts: [first, last], sure: false }; // "jeremyjszeto": a middle initial
  }
  if (last && w.length - last.length >= 3) return { parts: [w.slice(0, -last.length), last], sure: false };
  if (first && w.length - first.length >= 3) return { parts: [first, w.slice(first.length)], sure: false };
  return null;
}

/** Longest known first name at the start of `w`, leaving at least `rest` letters. */
function firstNameAt(w: string, rest = 2): string | null {
  for (let len = Math.min(w.length - rest, 11); len >= 3; len--) {
    const head = w.slice(0, len);
    if (FIRST_NAMES.has(head)) return head;
  }
  return null;
}

/**
 * Longest known last name at the end of `w`, leaving at least 3 letters for a first name.
 * Two-letter last names (Li, Wu, Ho) only count when what's left is a known first name.
 */
function lastNameAt(w: string, knownFirst?: string | null): string | null {
  for (let len = Math.min(w.length - 3, 12); len >= 2; len--) {
    const tail = w.slice(w.length - len);
    if (!LAST_NAMES.has(tail)) continue;
    const head = w.slice(0, -len);
    if (len === 2 && !FIRST_NAMES.has(head) && knownFirst !== head) continue;
    return tail;
  }
  return null;
}

export function suggestName(opts: { name: string; usernames?: string[]; chatNames?: string[] }): NameSuggestion | null {
  const name = opts.name.trim();
  if (looksStandard(name)) return null;
  const differs = (n: string) => n && n !== name;

  for (const chat of opts.chatNames ?? []) {
    const t = tidyName(chat);
    if (looksStandard(t) && differs(t)) return { name: t, confidence: 'high', reason: 'chat' };
  }

  // A real name that's just badly written ("JOHN SMITH", "john smith 🌸").
  if (/\s/.test(name.replace(/[^\p{L}\s]/gu, '').trim())) {
    const t = tidyName(name);
    if (looksStandard(t) && differs(t)) return { name: t, confidence: 'high', reason: 'tidy' };
  }

  const handles = [name, ...(opts.usernames ?? [])].filter((h) => !/\s/.test(h.trim()));
  for (const h of handles) {
    const parts = usernameParts(h);
    if (parts.length >= 2 && parts.length <= 4 && parts.every((p) => p.length >= 2 && /^\p{L}+$/u.test(p))) {
      const s = titleCase(parts);
      // Sure only when it reads as a real first name + real last name ("eileen_chen7").
      const sure = parts.length <= 3 && FIRST_NAMES.has(parts[0]) && LAST_NAMES.has(parts[parts.length - 1]);
      if (differs(s)) return { name: s, confidence: sure ? 'high' : 'medium', reason: 'username' };
    }
    if (parts.length === 1 && /^\p{L}+$/u.test(parts[0])) {
      const split = splitRunTogether(parts[0]);
      if (split) return { name: titleCase(split.parts), confidence: split.sure ? 'high' : 'medium', reason: 'split' };
    }
  }
  for (const h of handles) {
    const parts = usernameParts(h);
    // "eric_y12", "nathanv09" → just the first name, for you to finish.
    const first = parts.length >= 1 ? (FIRST_NAMES.has(parts[0]) ? parts[0] : firstNameAt(parts[0], 1)) : null;
    if (first && parts[0].length - first.length <= 2) {
      const s = capitalizeWord(first);
      if (differs(s)) return { name: s, confidence: 'low', reason: 'first-only' };
    }
  }
  return null;
}

/** Common first names (lowercase), used only to split run-together usernames. */
export const FIRST_NAMES = new Set(
  `mindy cathy cathleen denny indy lucia isabel kaitlin caitlin kristy christy winnie vivi kiana selina varsha kobi elaine
  aaron abby abdul abe abigail abraham ada adam adeline aditi aditya adrian adriana adrienne ahmad ahmed aidan aiden aimee aisha alan alana albert alberto alejandra alejandro alex alexa
  alexander alexandra alexis alfred ali alice alicia alina alisha alison alissa allen allie allison alma alyssa amanda amber amelia amir amit amy ana anastasia andre andrea andres andrew
  andy angel angela angelica angelina angie anita ann anna annabel annabelle anne annie anthony antonio anya april arabella archer ari aria ariana ariel arjun arnav arthur arun asher ashley
  ashton aubrey audrey austin ava avery axel ayesha bailey barbara barry beau bella ben benjamin bennett bernard beth bethany betty bianca bill billy blair blake bob bobby bonnie brad
  bradley brady brandon brayden brenda brendan brent brett brian briana brianna bridget brittany brody brooke brooklyn bruce bruno bryan bryce caleb cameron camila camille candice cara
  carl carla carlos carmen carol caroline carolyn carson carter casey cassandra cassie catherine cecilia celeste celia chad chance chandler charles charlie charlotte chase chelsea cheryl
  chloe chris christian christina christine christopher cindy claire clara clark claudia clay cody colby cole colin colleen connor conor cooper cora corey courtney craig cristina crystal
  cynthia daisy dakota dale dallas damian damon dan dana daniel daniela danielle danny daphne darius darren dave david dawn dean deanna debbie deborah declan deepak delaney denise dennis
  derek desmond destiny devin devon diana diane diego dimitri dominic dominique donald donna dora doris dorothy drew dustin dylan eddie eden edgar edith edward edwin eileen elaine eleanor
  elena eli elias elijah elisa elise eliza elizabeth ella ellen ellie eloise elsa emanuel emerson emil emilia emilio emily emma emmanuel eric erica erik erin esther ethan eugene eva evan
  evelyn everett faith farah fatima felicia felix fernando fiona finn frances francesca francis francisco frank franklin fred freddie gabe gabriel gabriela gabriella gabrielle gail gary
  gavin gemma gene george georgia gerald gia gianna gil gina giovanni giselle glen glenn gloria grace gracie graham grant greg gregory greta griffin gwen hailey haley hannah hans harper
  harrison harry harvey hassan hayden hazel heather hector heidi helen helena henry hinata holly hope hudson hugh hugo hunter ian imani ingrid irene iris isaac isabel isabella isabelle
  isaiah isla ivan ivy jack jackie jackson jacob jacqueline jade jaden jake jamal james jamie jan jane janelle janet janice jared jasmine jason jasper javier jay jayden jean jeff jeffrey
  jen jenna jennifer jenny jeremiah jeremy jerry jesse jessica jessie jesus jill jim jimmy jin joan joanna joanne joaquin jocelyn joe joel joey johanna john johnny jon jonah jonathan
  jordan jorge jose joseph josephine josh joshua josie joy joyce juan judith judy jules julia julian juliana julie juliet julio june justin kai kaitlyn kara karen karina karl kat kate
  katelyn katherine kathleen kathryn kathy katie katrina kayla kaylee keith kelly kelsey ken kendall kenji kenneth kenny kevin khalid kim kimberly kira kirk kristen kristin krystal kumar
  kurt kyle lana lance landon lara laura lauren laurie lawrence layla leah lee leila leo leon leonardo leslie levi lewis liam lila lily lina linda lindsay lindsey lisa liz liza logan
  lois lola lorena lorenzo lori louis louise luca lucas lucia luciana lucy luis luke luna lydia lyla mackenzie macy madeline madison maggie maia malik mandy manuel mara marc marco marcus
  margaret maria mariah mariana marie marina mario marisa marissa mark marley marshall martha martin marvin mary mason mateo matt matthew maura maureen max maxwell maya megan meghan mei
  melanie melissa melody mercedes meredith mia micah michael michaela michelle miguel mika mike mila miles milo mina miranda miriam misha mitchell mohamed mohammad mohammed molly monica
  morgan muhammad mya nadia nancy naomi natalia natalie nate nathan nathaniel neha neil nelson nia nicholas nick nicole nikhil nikki nina noah noel nolan nora norah oliver olivia omar
  oscar owen paige pamela parker patricia patrick paul paula pedro penelope peter peyton philip phillip phoebe pierce piper pooja preston priya quinn rachel rafael rahul raj ralph ramon
  randy raphael raquel raul ravi ray raymond reagan rebecca reed reese regina reid renee rhea ricardo richard rick ricky riley rita rob robert roberto robin rocco rodrigo rohan roman
  ron ronald rosa rose rosie ross ruby russell ruth ryan sabrina sadie sage sahil sam samantha samir samuel sandra sara sarah sasha saul savannah scarlett scott sean sebastian selena
  serena seth shane shannon sharon shawn shayla sheila shelby sherry shirley shreya sid sidney sienna sierra simon simone skylar skyler sofia sonia sophia sophie spencer stacy stanley
  stella stephanie stephen steve steven stuart summer susan sydney sylvia tanya tara taylor ted teresa terry tessa theo theodore theresa thomas tiffany tim timothy tina toby todd tom
  tommy tony tori tracy travis trevor trinity tristan troy tyler valentina valeria valerie vanessa vera veronica victor victoria vikram vincent violet virginia vivian wade walker walter
  warren wayne wendy wesley will william willow wilson wyatt xavier yasmin yusuf yvonne zach zachary zane zara zoe zoey
  wei jun hao yu xin ming jie li lin yan hui ying jing chen xiao tian min yi lei kai hong hyun jiwoo minjun seojun jisoo yuna haruto yuki sakura kenta takumi hiroshi akira
  ahn anh linh minh thu trang tuan huy quang duc khanh thanh lan mai hoa long nam phuong vy
  aarav arnav ishaan karan krishna manish nisha pranav priyanka rajesh rakesh ritu rohit sanjay shiv shruti siddharth sneha sunil suresh tanvi varun vijay vivek
  ahmet emre mehmet yusuf zeynep elif omer hamza bilal tariq zainab layla noor yara rania
  jose luis carlos diego mateo santiago valentina camila sofia isabella ximena lucia mariana gabriela fernanda paola alejandro andres camilo felipe sebastian`
    .split(/\s+/)
    .filter(Boolean),
);

/** Common last names (lowercase), used to split run-together usernames and to judge how sure a split is. */
export const LAST_NAMES = new Set(
  `smith johnson williams brown jones miller davis wilson anderson taylor thomas moore martin jackson thompson white harris clark lewis robinson walker young allen king
  wright scott hill green adams baker nelson carter mitchell roberts turner phillips campbell parker evans edwards collins stewart morris murphy cook rogers morgan cooper peterson
  bailey reed kelly howard ward cox richardson wood watson brooks bennett gray james hughes price sanders myers long ross foster powell jenkins perry russell sullivan bell coleman
  butler henderson barnes fisher hayes graham reynolds washington ellis wallace griffin west cole hamilton jordan simmons palmer gibson black wells hunt stone meyer mason oconnell
  oconnor obrien kennedy murray ryan walsh doyle schmidt mueller weber wagner becker hoffman klein wolf schneider fischer
  garcia rodriguez martinez hernandez lopez gonzalez perez sanchez ramirez torres flores rivera gomez diaz reyes morales cruz ortiz gutierrez chavez ramos ruiz alvarez mendoza
  castillo jimenez moreno romero herrera medina aguilar vargas castro guzman fernandez silva santos nunez rojas soto delgado vega leon pena navarro salazar cortez rios
  wang zhang liu chen yang huang zhao zhou xu sun zhu guo gao lin luo zheng liang xie song tang han feng deng cao peng zeng xiao tian dong pan yuan cai jiang du cheng wei su
  ding ren shen yao jin fu zhong dai fan fang shi tan liao zou xiong qiu qin jia hou meng bai qian duan lei long tao kong mao hao gu yan yin xue chang zhuang wan jiao lai wen
  chu chiang tsai hsu kuo chao chou hsieh yeh tseng hung chuang kao jen chien chiu lien
  wong chan cheung leung lau yip tsang kwok chow tam mak fung kwan szeto yeung tse lam choi siu tong fong poon hui yuen chung lui ngai kam mok
  kim lee park jung kang yoon jang lim shin kwon hwang ahn yoo hong jeon moon son bae baek heo noh kwak sung chae joo woo min ryu yeo kweon seo
  nguyen tran pham hoang huynh phan dang bui ngo duong truong dinh trinh luong doan
  sato suzuki takahashi tanaka watanabe ito yamamoto nakamura kobayashi kato yoshida yamada sasaki yamaguchi matsumoto inoue kimura hayashi shimizu mori ikeda hashimoto
  ishikawa ogawa okada goto hasegawa murakami kondo saito sakamoto endo aoki fujii nishimura fukuda miura fujiwara okamoto matsuda nakagawa nakano harada tamura takeuchi
  kaneko wada nakayama ishida ueda morita shibata sakai kudo yokoyama miyazaki miyamoto uchida takagi ando taniguchi maruyama imai fujita kawamura murata
  patel shah singh kumar sharma gupta mehta reddy iyer nair menon joshi desai agarwal kapoor malhotra chopra bhat pillai verma jain chaudhary mishra pandey khan
  ahmed hussain rahman islam hossain chowdhury perera
  li wu hu ma he yu lu ye ho ng lo ko oh ha le vo vu do ly ta cho yi`
    .split(/\s+/)
    .filter(Boolean),
);
