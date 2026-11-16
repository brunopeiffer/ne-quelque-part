/* born-somewhere v2
   人生模擬遊戲：選一個出生地（172 國真實統計），從 0 歲活到當地平均壽命。
   參考原作 1in8b.life 的生命表、死因分布、決策點等核心機制。
   引擎是獨立重寫，不含原作程式碼。
*/

const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
const STORAGE_KEY = 'born-somewhere-v2';

let COUNTRIES = [];
let I18N = {};
let LANG = 'zh-Hant';
let CACHE = { countries: null, i18n: null };

/* v5.98：單一版本來源。
   原本有五份各自硬編碼的版本字串，而且全部漂移了：
     index.html footer        v5.97   （每次上線手動維護）
     sw.js CACHE_NAME/VERSION v5.97   （同上）
     app.js APP_VERSION       5.19.0  ← 更新說明標題、意見回報都讀這個
     分享出生卡頁尾            v5.12   ← 匯出圖上的字
     生命證書頁尾              v5.2    ← 更舊
   結果是：更新說明對外顯示 v5.19.0、匯出的出生卡寫 v5.12、匯出的生命證書寫 v5.2，
   而玩家用的其實是 v5.97。分享圖是別人會看到的東西，寫錯版本特別明顯。
   現在這兩張圖都改讀 APP_VERSION；`python3 i18n_audit.py` 第 6 項檢查會擋住以後再漂。 */
const APP_VERSION = '6.12.0';
const APP_BUILD = '2026-10-23';

const STATE = {
  view: 'intro',
  era: 'now',          // 'now' | 'past' | 'future'
  birthMode: 'baby',   // 'baby' | 'all' (此刻出生 vs 80億人活口)
  selectedCountry: null,
  life: null,
  paused: false,
  speed: 1,
  tickMs: 1500,  // v5.13：1 年 ≈ 1.5 秒（慢到能讀事件；8× 時約 15 秒跑完一生）
              // v5.25：依生命長度選擇（30min/1hr/1.5hr）動態調整 → 改為 STATE.lifeDurationMs
  ticker: null,
  pendingDecision: null,
  autoDecide: false,  // v5.9 新增：自動抉擇模式
  fastForward: false, // v5.9 新增：快轉到下一個抉擇
  sharedShown: 8,    // v5.80：書架「共享人生」先顯示幾張
  shelfShown: 12,    // v5.81：書架「書本」先顯示幾本
  thoughtsEnabled: false, // v5.10：✎ 寫下想法 啟用（5/15/30/50/70 暫停時彈出 modal）
  pastLives: [],
  modal: null,
  eduMode: false,      // v5.19：教學版（?edu=1）— 過濾沉重事件、隱藏訃聞/書架
  softMode: false,     // v5.39：略過可怕的情節（1in8b.life 的 softBtn）— 可即時切換並記住
};

/* ==== v5.51：統一關閉 modal — 一定要解除暫停 ====
   過去每個 modal 各自在「選項點擊」時設 STATE.paused = false，但若使用者按 ×、
   點背景、或按空白鍵關閉，就沒有人把 paused 設回 false，tick() 便永久卡住，
   人生會停在該年不動。所有關閉路徑一律經過 closeModal()。 */
const PAUSING_MODALS = ['focusModal', 'financeModal', 'spendModal', 'pauseModal', 'decisionModal'];
function closeModal(id) {
  const el = id ? document.getElementById(id) : null;
  const wasOpen = el ? !el.hasAttribute('hidden') : false;
  // v5.73：決策 modal 若是被關掉（而非點選項），記成 skipped
  if (id === 'decisionModal' && wasOpen) {
    dismissDecision(STATE.pendingDecision?.id, STATE.pendingDecision?.age);
  }
  if (el) el.setAttribute('hidden', '');
  else PAUSING_MODALS.forEach(i => document.getElementById(i)?.setAttribute('hidden', ''));
  if (STATE.paused) {
    STATE.paused = false;
    const p = $('#btnPause');
    if (p) p.textContent = '❚❚';
    // v5.68：paused 在這裡被清掉，暫停鈕的圖示與 tooltip 也要跟著更新
    if (typeof syncPauseBtn === 'function') syncPauseBtn();
  }
  return el;
}

/* ==== v5.55：通用決策 modal（重大決定 / 小選擇 / 家人共決 三種版型共用） ====
   設計：showDecision() 一次塞入內容、綁定選項點擊，每個選項帶 apply(life, ctx)
        函式處理效果；關 modal 一律走 closeModal('decisionModal') 確保 tick 恢復。
   state 結構：
     STATE.pendingDecision = { kind: 'decision', id: 'de_xxx', age, choices: [...] }
     STATE.life.decisions  = [ { id, age, key } ]   // 已答過的決策避免重複 */
let _decisionBound = false;
/* v5.73：決策被「關掉但沒選」時要記成已處理。
   實測問題：25 歲那年同時是決策年與財務年，玩家對決策按 Escape ——
   決策有關掉、tick 也恢復了，但財務 modal 立刻補上來，玩家看到「按了沒反應」。
   修法：Escape / × / 點背景關掉決策時，把它記成 skipped，
   這樣 STATE.pendingDecision 清乾淨、tryTriggerDecision 的 done 集合也認得它已處理。 */
function dismissDecision(id, age) {
  if (!id) return;
  STATE.pendingDecision = null;
  const life = STATE.life;
  if (!life) return;
  life.decisions = life.decisions || [];
  if (life.decisions.some(d => d.id === id)) return;   // 已經答過了（例如 autoDecide）
  life.decisions.push({ id, age: age ?? life.age, key: 'skipped', note: '' });
  life.lastDecisionAge = age ?? life.age;               // 也吃冷卻期，避免下一年就補一個
}

// v5.90：健康值必須夾在 0～100。
// 決策選項的 apply() 有一批是 `health += 8` 這種沒夾的寫法，而 health 出生就是 100，
// 於是抽到「戒菸」就直接變 108，畫面上印出不可能的數字（實測最高 116.7）。
// 定義在這裡（DECISIONS 陣建構之前），讓下面所有 apply() 都能直接用。
function bumpHealth(life, delta) {
  if (!life || !life.stats) return;
  life.stats.health = Math.max(0, Math.min(100, life.stats.health + delta));
}

function showDecision({ id, kind, age, title, body, fact, hint, choices, hasNote }) {
  const modal = $('#decisionModal');
  if (!modal) return false;
  // 防止重複觸發（避免連續年度同 ID 觸發兩次）
  if (modal && !modal.hasAttribute('hidden')) return false;
  if (!choices || choices.length === 0) return false;
  // v5.92：反思視窗還開著的時候不要再往上疊決策視窗。
  // v5.84 已經處理過 pause+finance 疊在一起，但 decision+pause 漏了 ——
  // 實測會同時看到「如果 15 歲的你…」和「這個週末怎麼過？」兩個視窗。
  // 這裡選「讓位」而不是「擋住」：把反思視窗收掉再開決策，
  // 這樣決策的出現率不受影響（若改成擋住，23/24 的決策可達性會掉下來）。
  const pauseEl = document.getElementById('pauseModal');
  if (pauseEl && !pauseEl.hasAttribute('hidden')) closeModal('pauseModal');
  STATE.pendingDecision = { kind: 'decision', id, age, options: choices.length };
  STATE.paused = true;

  const kindLabel = { big: t('dec.kind.big'), small: t('dec.kind.small'), family: t('dec.kind.family'), pause: t('dec.kind.pause') }[kind] || t('dec.kind.big');
  $('#decisionKind').textContent = kindLabel + ' · ' + age + (LANG === 'fr' ? ' ' : '') + t('unit.years') + ' · ' + (STATE.life.year + STATE.life.yearOffset);
  $('#decisionTitle').textContent = title;
  $('#decisionBody').textContent = body || '';
  if (fact) { $('#decisionFact').textContent = fact; $('#decisionFact').hidden = false; }
  else { $('#decisionFact').hidden = true; }
  if (hint) { $('#decisionHint').textContent = hint; $('#decisionHint').hidden = false; }
  else { $('#decisionHint').hidden = true; }

  const noteWrap = $('#decisionNoteWrap');
  const note = $('#decisionNote');
  if (hasNote) {
    noteWrap.hidden = false;
    note.value = '';
    note.placeholder = t('dec.note.placeholder');
  } else {
    noteWrap.hidden = true;
  }

  const bodyEl = $('#decisionChoices');
  bodyEl.innerHTML = choices.map((c, i) => `
    <button type="button" class="dec-c" data-k="${escAttr(c.k)}" data-i="${i}">
      <span class="dec-c-k">${esc(c.label)}</span>
      ${c.sub ? `<span class="dec-c-sub">${esc(c.sub)}</span>` : ''}
    </button>`).join('');

  bodyEl.querySelectorAll('.dec-c').forEach(btn => {
    btn.addEventListener('click', () => {
      const k = btn.dataset.k;
      const i = +btn.dataset.i;
      const choice = choices[i];
      const noteText = hasNote ? (note.value || '').trim() : '';
      // 套用效果
      try { choice.apply && choice.apply(STATE.life, { note: noteText }); } catch (e) { console.warn('decision apply failed', id, k, e); }
      // 記錄（v5.78：連 label / icon 一起存，訃聞頁才組得出這一生做過的決定）
      STATE.life.decisions = STATE.life.decisions || [];
      STATE.life.decisions.push({ id, age, key: k, label: choice.label, icon: choice.icon || '', note: noteText, lang: LANG });
      // 寫進 log（讓使用者往後看得到）
      STATE.life.log.push({ age, kind: 'decision', icon: choice.icon || '✦', text: title + ' → ' + choice.label });
      logLife(t('dec.log', choice.label));
      // 若使用者停用了 autoDecide，pendingDecision 在 closeModal 後會被忽略；
      // 不影響 ticker 因為 pause 已解除
      closeModal('decisionModal');
    });
  });

  // v5.55：自動抉擇模式 — 立即套用第一個選項並關閉，不打斷 ticker
  if (STATE.autoDecide) {
    STATE.pendingDecision = null;
    STATE.paused = false;   // la fenêtre n'est jamais montrée : sans ceci la vie restait figée
    const first = choices[0];
    STATE.life.decisions = STATE.life.decisions || [];
    STATE.life.decisions.push({ id, age, key: first.k, label: first.label, icon: first.icon || '', note: '（自動抉擇）' });
    try { first.apply && first.apply(STATE.life, { note: '' }); } catch (e) { console.warn('auto-decide apply failed', id, e); }
    STATE.life.log.push({ age, kind: 'decision', icon: first.icon || '✦', text: title + ' → ' + first.label + (LANG === 'fr' ? ' (auto)' : '（自動）') });
    modal.setAttribute('hidden', '');
    return true;
  }

  modal.removeAttribute('hidden');
  // 焦點移到第一個選擇（鍵盤友好）
  setTimeout(() => bodyEl.querySelector('.dec-c')?.focus(), 50);
  return true;
}

/* 內容裡需要把 title、body 之類的字串塞進 innerHTML — 統一用這個轉義 */
function esc(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, m => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[m]);
}
function escAttr(s) { return esc(s); }

/* ==== v5.55：通用決策事件表 ====
   每個事件是一個物件：{ id, kind, chance(life), show(life) }，
     - chance(life) 是每年 tick 進入時的觸發機率（純粹年齡／狀態機率）
     - show(life) 才真正塞內容到 modal
   每個 choice = { k, label, sub, apply(life, ctx) }
   apply 不會 throw；失敗也要關 modal、不卡 tick。 */
/* v5.60：家屬存活狀態改為「按年份推算」，不再讀 p.alive。
   generateFamily() 只寫 birth / death 年份，從來沒有設過 alive，
   所以 `parents.some(p => p.alive)` 永遠是 undefined → falsy，
   de_parents_care 與 de_inheritance 兩個事件形同虛設（永久不會觸發）。
   現在改成用他們實際擁有的年份資料推算。 */
function isAliveAt(person, year) {
  if (!person) return false;
  const b = person.birth?.year;
  if (b == null || b > year) return false;
  const d = person.death?.year;
  return d == null || d > year;
}
function anyParentAlive(life) {
  if (!life?.family?.parents) return false;
  const year = (life.year || 0) + (life.yearOffset || 0);
  return life.family.parents.some(p => isAliveAt(p, year));
}

// Les sommes des évènements sont écrites pour un pays à 40 000 $ PPA par habitant, puis mises à l'échelle.
function moneyScale(life) { return Math.max(0.05, ((life.countryData && life.countryData.ppp) || 12000) / 40000); }
function addMoney(life, usd) { life.stats.netAssets += Math.round(usd * moneyScale(life)); }
const DECISIONS = [
  // 1. 失業：要不要接受一份外地工作？
  {
    id: 'de_relocate', kind: 'big',
    chance: (life) => life.age >= 25 && life.age <= 50 &&
                     life.stats.employment === 'employed' &&
                     Math.random() < 0.06,
    show: (life) => ({
      title: t('de.relocate.title'),
      body: t('de.relocate.body', life.countryData?.ko || ''),
      fact: t('de.relocate.fact'),
      choices: [
        { k: 'go', icon: '✈️',
          label: t('de.relocate.go'),
          sub: t('de.relocate.go.sub'),
          apply: (life) => { addMoney(life, 8000); life.stats.happiness -= 4; life.stats.social -= 3; logLife(t('de.relocate.go.log')); } },
        { k: 'stay', icon: '🏠',
          label: t('de.relocate.stay'),
          sub: t('de.relocate.stay.sub'),
          apply: () => { logLife(t('de.relocate.stay.log')); } },
      ],
    }),
  },

  // 2. 中年身心健康：戒菸 / 戒酒 vs. 維持
  {
    id: 'de_health_warning', kind: 'big',
    chance: (life) => life.age >= 30 && life.age <= 55 && !life.illness &&
                     (Math.random() < 0.05),
    show: (life) => ({
      title: t('de.health.title'),
      body: t('de.health.body'),
      fact: t('de.health.fact'),
      choices: [
        { k: 'quit', icon: '🧘',
          label: t('de.health.quit'),
          sub: t('de.health.quit.sub'),
          apply: (life) => { bumpHealth(life, +8); life.stats.happiness += 4; logLife(t('de.health.quit.log')); } },
        { k: 'keep', icon: '🚬',
          label: t('de.health.keep'),
          sub: t('de.health.keep.sub'),
          apply: (life) => { life.stats.happiness -= 3; logLife(t('de.health.keep.log')); } },
      ],
      hasNote: true,
    }),
  },

  // 3. 通膨惡化：把錢換成美元/黃金 vs. 留現金
  {
    id: 'de_inflation', kind: 'big',
    chance: (life) => life.age >= 40 && life.age <= 70 &&
                     Math.random() < 0.05,
    show: (life) => ({
      title: t('de.inflation.title'),
      body: t('de.inflation.body'),
      fact: t('de.inflation.fact'),
      choices: [
        { k: 'dollar', icon: '💵',
          label: t('de.inflation.dollar'),
          sub: t('de.inflation.dollar.sub'),
          apply: (life) => { life.stats.netAssets *= 1.15; life.stats.happiness += 1; logLife(t('de.inflation.dollar.log')); } },
        { k: 'hold', icon: '🏦',
          label: t('de.inflation.hold'),
          sub: t('de.inflation.hold.sub'),
          apply: (life) => { life.stats.netAssets *= 0.85; life.stats.happiness -= 3; logLife(t('de.inflation.hold.log')); } },
      ],
    }),
  },

  // 4. 重病：治療 6 個月 vs. 撐著
  {
    id: 'de_illness_treat', kind: 'big',
    chance: (life) => !STATE.eduMode && !STATE.softMode &&
                     life.age >= 38 && life.age <= 70 && !life.illness &&
                     Math.random() < 0.04,
    show: (life) => ({
      title: t('de.illness.title'),
      body: t('de.illness.body'),
      fact: t('de.illness.fact'),
      choices: [
        { k: 'treat', icon: '💊',
          label: t('de.illness.treat'),
          sub: t('de.illness.treat.sub'),
          apply: (life) => { bumpHealth(life, +5); life.stats.happiness += 3; addMoney(life, -4000); logLife(t('de.illness.treat.log')); } },
        { k: 'wait', icon: '⏳',
          label: t('de.illness.wait'),
          sub: t('de.illness.wait.sub'),
          apply: (life) => { bumpHealth(life, -3); life.stats.happiness -= 5; logLife(t('de.illness.wait.log')); } },
      ],
    }),
  },

  // 5. 父母行動不便：接過來同住 vs. 找看護 vs. 讓親戚照顧
  {
    id: 'de_parents_care', kind: 'big',
    chance: (life) =>
                     // v5.85：視窗原本是 45–75，但實測父母大約在你 40 歲前後就過世了
                     // （generateFamily 給父親 +70、母親 +75 年的壽命），
                     // 45 歲以後幾乎沒有任何人生還有活著的親屬 — 這個事件從未出現。
                     // 改成 40–58：這才是「父母開始需要照顧」的實際年齡區間。
                     life.age >= 40 && life.age <= 58 &&
                     anyParentAlive(life) &&
                     Math.random() < 0.08,
    show: (life) => ({
      title: t('de.parents.title'),
      body: t('de.parents.body'),
      fact: t('de.parents.fact'),
      choices: [
        { k: 'home', icon: '🏡',
          label: t('de.parents.home'),
          sub: t('de.parents.home.sub'),
          apply: (life) => { life.stats.happiness += 5; addMoney(life, -6000); logLife(t('de.parents.home.log')); } },
        { k: 'nurse', icon: '🏥',
          label: t('de.parents.nurse'),
          sub: t('de.parents.nurse.sub'),
          apply: (life) => { addMoney(life, -8000); life.stats.happiness -= 1; logLife(t('de.parents.nurse.log')); } },
        { k: 'kin', icon: '👪',
          label: t('de.parents.kin'),
          sub: t('de.parents.kin.sub'),
          apply: () => { logLife(t('de.parents.kin.log')); } },
      ],
    }),
  },

  // 6. 婚姻觸礁：為了孩子撐著 vs. 分居 vs. 離婚
  {
    id: 'de_divorce', kind: 'big',
    chance: (life) => life.stats && life.stats.married &&
                     life.age >= 32 && life.age <= 55 &&
                     Math.random() < 0.05,
    show: (life) => ({
      title: t('de.divorce.title'),
      body: t('de.divorce.body'),
      fact: t('de.divorce.fact'),
      choices: [
        { k: 'stay', icon: '🤝',
          label: t('de.divorce.stay'),
          sub: t('de.divorce.stay.sub'),
          apply: (life) => { life.stats.happiness -= 6; logLife(t('de.divorce.stay.log')); } },
        { k: 'separate', icon: '🛏️',
          label: t('de.divorce.separate'),
          sub: t('de.divorce.separate.sub'),
          apply: (life) => { life.stats.netAssets *= 0.6; life.stats.happiness += 2; logLife(t('de.divorce.separate.log')); } },
        { k: 'final', icon: '📜',
          label: t('de.divorce.final'),
          sub: t('de.divorce.final.sub'),
          apply: (life) => { life.stats.married = false; life.stats.partner = null; life.stats.relationship = 'divorced'; life.stats.netAssets *= 0.5; life.stats.happiness += 4; logLife(t('de.divorce.final.log')); } },
      ],
      hasNote: true,
    }),
  },

  // 7. 換工作：現職 vs. 朋友介紹的高風險高報酬
  {
    id: 'de_job_change', kind: 'big',
    chance: (life) => life.stats.employment === 'employed' &&
                     life.age >= 28 && life.age <= 50 &&
                     Math.random() < 0.05,
    show: (life) => ({
      title: t('de.job.title'),
      body: t('de.job.body'),
      fact: t('de.job.fact'),
      choices: [
        { k: 'stay', icon: '💼',
          label: t('de.job.stay'),
          sub: t('de.job.stay.sub'),
          apply: () => { logLife(t('de.job.stay.log')); } },
        { k: 'jump', icon: '🚀',
          label: t('de.job.jump'),
          sub: t('de.job.jump.sub'),
          apply: (life) => { life.stats.netAssets *= (Math.random() < 0.5 ? 1.4 : 0.7); life.stats.happiness += (Math.random() < 0.5 ? 4 : -4); logLife(t('de.job.jump.log')); } },
      ],
    }),
  },

  // 8. 兵役/徵召：自願 vs. 抽籤 vs. 良心拒服
  {
    id: 'de_conscription', kind: 'big',
    chance: (life) => life.age >= 18 && life.age <= 25 &&
                     life.sex === 'M' &&
                     ['KOR','TWN','ISR','SGP','CHN','RUS'].includes(life.country) &&
                     Math.random() < 0.10,
    show: (life) => ({
      title: t('de.conscript.title'),
      body: t('de.conscript.body'),
      fact: t('de.conscript.fact'),
      choices: [
        { k: 'volunteer', icon: '🪖',
          label: t('de.conscript.volunteer'),
          sub: t('de.conscript.volunteer.sub'),
          apply: (life) => { addMoney(life, 2000); life.stats.happiness += 1; bumpHealth(life, -2); logLife(t('de.conscript.volunteer.log')); } },
        { k: 'lottery', icon: '🎲',
          label: t('de.conscript.lottery'),
          sub: t('de.conscript.lottery.sub'),
          apply: (life) => {
            if (Math.random() < 0.5) { addMoney(life, 2000); bumpHealth(life, -2); logLife(t('de.conscript.lottery.go')); }
            else { logLife(t('de.conscript.lottery.skip')); }
          } },
        { k: 'object', icon: '✋',
          label: t('de.conscript.object'),
          sub: t('de.conscript.object.sub'),
          apply: (life) => { life.stats.happiness += 3; logLife(t('de.conscript.object.log')); } },
      ],
    }),
  },

  // 9. 小選擇：要不要把一筆意外之財分給家人
  {
    id: 'de_lottery', kind: 'small',
    chance: (life) => life.age >= 25 && life.age <= 65 &&
                     Math.random() < 0.03,
    show: (life) => ({
      title: t('de.lottery.title'),
      body: t('de.lottery.body'),
      fact: t('de.lottery.fact'),
      choices: [
        { k: 'keep', icon: '💰',
          label: t('de.lottery.keep'),
          sub: t('de.lottery.keep.sub'),
          apply: (life) => { addMoney(life, 5000); life.stats.happiness += 3; logLife(t('de.lottery.keep.log')); } },
        { k: 'share', icon: '🎁',
          label: t('de.lottery.share'),
          sub: t('de.lottery.share.sub'),
          apply: (life) => { addMoney(life, 2000); life.stats.social += 5; life.stats.happiness += 5; logLife(t('de.lottery.share.log')); } },
        { k: 'donate', icon: '❤️',
          label: t('de.lottery.donate'),
          sub: t('de.lottery.donate.sub'),
          apply: (life) => { addMoney(life, 1000); life.stats.happiness += 8; logLife(t('de.lottery.donate.log')); } },
      ],
      hasNote: true,
    }),
  },

  // 10. 心理健康：找諮商 vs. 撐著
  {
    id: 'de_mental_health', kind: 'big',
    chance: (life) => !STATE.eduMode &&
                     life.age >= 25 && life.age <= 70 &&
                     // v5.85：門檻是照著「實際量到的分布」訂的，不是拍腦袋。
                     // v5.59 設 < 55，但實測 25–70 歲的 happiness 每年取樣 4,537 筆：
                     //   p01=57.6  p05=60.9  p10=62.9  p50=65.2
                     // 55 低於 p01，等於這個事件永遠不會發生（實測 120 條人生 0 次）。
                     // v5.86：回歸速率放慢後分布整體上移，重新量一次：
                     //   p01=64.4  p05=67.2  p10=68.8  p50=74.2（25–70 歲，4,064 個年度樣本）
                     // 62 又低於 p01 了，所以跟著調到 67（約落在底端 5%）。
                     life.stats.happiness < 67 &&
                     Math.random() < 0.08,
    show: (life) => ({
      title: t('de.mental.title'),
      body: t('de.mental.body'),
      fact: t('de.mental.fact'),
      choices: [
        { k: 'therapy', icon: '🛋️',
          label: t('de.mental.therapy'),
          sub: t('de.mental.therapy.sub'),
          apply: (life) => { life.stats.happiness += 12; addMoney(life, -1500); logLife(t('de.mental.therapy.log')); } },
        { k: 'tough', icon: '💪',
          label: t('de.mental.tough'),
          sub: t('de.mental.tough.sub'),
          apply: () => { logLife(t('de.mental.tough.log')); } },
      ],
      hasNote: true,
    }),
  },

  // 11. 買房 vs 租房（30-55）
  {
    id: 'de_buy_home', kind: 'big',
    chance: (life) => life.age >= 30 && life.age <= 55 &&
                     life.stats.employment === 'employed' &&
                     Math.random() < 0.04,
    show: (life) => ({
      title: t('de.home.title'),
      body: t('de.home.body'),
      fact: t('de.home.fact'),
      choices: [
        { k: 'buy', icon: '🏠',
          label: t('de.home.buy'),
          sub: t('de.home.buy.sub'),
          apply: (life) => { addMoney(life, -20000); life.stats.social += 1; life.ownsHome = true; logLife(t('de.home.buy.log')); } },
        { k: 'rent', icon: '🔑',
          label: t('de.home.rent'),
          sub: t('de.home.rent.sub'),
          apply: (life) => { addMoney(life, 5000); life.stats.happiness += 1; logLife(t('de.home.rent.log')); } },
        { k: 'share', icon: '🏘️',
          label: t('de.home.share'),
          sub: t('de.home.share.sub'),
          apply: (life) => { addMoney(life, -6000); life.stats.social += 5; life.stats.happiness += 3; logLife(t('de.home.share.log')); } },
      ],
    }),
  },

  // 12. 借錢給親友（25-65）
  {
    id: 'de_loan_request', kind: 'family',
    chance: (life) => life.age >= 25 && life.age <= 65 &&
                     Math.random() < 0.07,
    show: (life) => ({
      title: t('de.loan.title'),
      body: t('de.loan.body'),
      fact: t('de.loan.fact'),
      choices: [
        { k: 'give', icon: '🤝',
          label: t('de.loan.give'),
          sub: t('de.loan.give.sub'),
          apply: (life) => { addMoney(life, -4000); life.stats.social += 6; life.stats.happiness += 3; logLife(t('de.loan.give.log')); } },
        { k: 'refuse', icon: '🚫',
          label: t('de.loan.refuse'),
          sub: t('de.loan.refuse.sub'),
          apply: (life) => { life.stats.happiness -= 2; logLife(t('de.loan.refuse.log')); } },
        { k: 'help_otherwise', icon: '💡',
          label: t('de.loan.help_otherwise'),
          sub: t('de.loan.help_otherwise.sub'),
          apply: (life) => { life.stats.social += 3; life.stats.happiness += 2; logLife(t('de.loan.help_otherwise.log')); } },
      ],
    }),
  },

  // 13. 給自己放個長假（28-50）
  {
    id: 'de_sabbatical', kind: 'big',
    chance: (life) => life.stats.employment === 'employed' &&
                     life.age >= 28 && life.age <= 50 &&
                     Math.random() < 0.05,
    show: (life) => ({
      title: t('de.sabbatical.title'),
      body: t('de.sabbatical.body'),
      fact: t('de.sabbatical.fact'),
      choices: [
        { k: 'take_it', icon: '🌴',
          label: t('de.sabbatical.take_it'),
          sub: t('de.sabbatical.take_it.sub'),
          apply: (life) => { life.stats.happiness += 8; bumpHealth(life, +4); addMoney(life, -8000); logLife(t('de.sabbatical.take_it.log')); } },
        { k: 'push', icon: '💼',
          label: t('de.sabbatical.push'),
          sub: t('de.sabbatical.push.sub'),
          apply: (life) => { addMoney(life, 6000); life.stats.knowledge += 2; logLife(t('de.sabbatical.push.log')); } },
      ],
    }),
  },

  // 14. 長輩留下事業 / 遺產（40-80）
  {
    id: 'de_inheritance', kind: 'big',
    chance: (life) => life.age >= 40 && life.age <= 80 &&
                     anyParentAlive(life) &&
                     Math.random() < 0.04,
    show: (life) => ({
      title: t('de.inherit.title'),
      body: t('de.inherit.body'),
      fact: t('de.inherit.fact'),
      choices: [
        { k: 'keep', icon: '🏛️',
          label: t('de.inherit.keep'),
          sub: t('de.inherit.keep.sub'),
          apply: (life) => { addMoney(life, 15000); life.stats.employment = 'family_biz'; logLife(t('de.inherit.keep.log')); } },
        { k: 'sell', icon: '💰',
          label: t('de.inherit.sell'),
          sub: t('de.inherit.sell.sub'),
          apply: (life) => { addMoney(life, 80000); life.stats.happiness -= 4; logLife(t('de.inherit.sell.log')); } },
        { k: 'split', icon: '👨‍👩‍👧',
          label: t('de.inherit.split'),
          sub: t('de.inherit.split.sub'),
          apply: (life) => { addMoney(life, 5000); life.stats.social += 8; life.stats.happiness += 3; logLife(t('de.inherit.split.log')); } },
      ],
    }),
  },

  // 15. 非父母親屬需要照顧（姑姑 / 阿姨）(35-65)
  {
    id: 'de_care_relative', kind: 'family',
    chance: (life) => life.age >= 35 && life.age <= 65 &&
                     Math.random() < 0.05,
    show: (life) => ({
      title: t('de.relative.title'),
      body: t('de.relative.body'),
      fact: t('de.relative.fact'),
      choices: [
        { k: 'take_in', icon: '🏡',
          label: t('de.relative.take_in'),
          sub: t('de.relative.take_in.sub'),
          apply: (life) => { addMoney(life, -5000); life.stats.social += 4; life.stats.happiness += 2; logLife(t('de.relative.take_in.log')); } },
        { k: 'facility', icon: '🏥',
          label: t('de.relative.facility'),
          sub: t('de.relative.facility.sub'),
          apply: (life) => { addMoney(life, -10000); life.stats.social += 2; life.stats.happiness -= 2; logLife(t('de.relative.facility.log')); } },
        { k: 'kin_share', icon: '👪',
          label: t('de.relative.kin_share'),
          sub: t('de.relative.kin_share.sub'),
          apply: (life) => { life.stats.social += 3; logLife(t('de.relative.kin_share.log')); } },
      ],
    }),
  },

  // 16. 公司晉升但要搬家（28-50, 在職）
  {
    id: 'de_promotion', kind: 'big',
    chance: (life) => life.stats.employment === 'employed' &&
                     life.age >= 28 && life.age <= 50 &&
                     Math.random() < 0.05,
    show: (life) => ({
      title: t('de.promotion.title'),
      body: t('de.promotion.body'),
      fact: t('de.promotion.fact'),
      choices: [
        { k: 'take', icon: '📈',
          label: t('de.promotion.take'),
          sub: t('de.promotion.take.sub'),
          apply: (life) => { addMoney(life, 4000); life.stats.knowledge += 3; life.stats.social -= 2; life.stats.happiness -= 1; logLife(t('de.promotion.take.log')); } },
        { k: 'decline', icon: '🚪',
          label: t('de.promotion.decline'),
          sub: t('de.promotion.decline.sub'),
          apply: (life) => { life.stats.happiness += 3; logLife(t('de.promotion.decline.log')); } },
        { k: 'negotiate', icon: '🤝',
          label: t('de.promotion.negotiate'),
          sub: t('de.promotion.negotiate.sub'),
          apply: (life) => { if (Math.random() < 0.5) { addMoney(life, 2000); life.stats.happiness += 1; logLife(t('de.promotion.negotiate.ok')); } else { logLife(t('de.promotion.negotiate.no')); } } },
      ],
      hasNote: true,
    }),
  },

  // ===== v5.57：小型日常選擇（對齊原作 sm_* 家族）=====
  // 這些不是轉折點，而是讓人生「有紋理」的小決定；低頻、影響小、選項樸素。

  // 17. 週末怎麼度過（18-75）
  {
    id: 'sm_weekend', kind: 'small',
    chance: (life) => life.age >= 18 && life.age <= 75 && Math.random() < 0.10,
    show: () => ({
      title: t('sm.weekend.title'),
      body: t('sm.weekend.body'),
      choices: [
        { k: 'friends', icon: '🍻',
          label: t('sm.weekend.friends'),
          sub: t('sm.weekend.friends.sub'),
          apply: (life) => { life.stats.social += 4; life.stats.happiness += 3; bumpHealth(life, -1); logLife(t('sm.weekend.friends.log')); } },
        { k: 'family', icon: '🏡',
          label: t('sm.weekend.family'),
          sub: t('sm.weekend.family.sub'),
          apply: (life) => { life.stats.social += 3; life.stats.happiness += 4; logLife(t('sm.weekend.family.log')); } },
        { k: 'rest', icon: '🛌',
          label: t('sm.weekend.rest'),
          sub: t('sm.weekend.rest.sub'),
          apply: (life) => { bumpHealth(life, +3); logLife(t('sm.weekend.rest.log')); } },
        { k: 'alone', icon: '🚶',
          label: t('sm.weekend.alone'),
          sub: t('sm.weekend.alone.sub'),
          apply: (life) => { life.stats.happiness -= 1; life.stats.knowledge += 1; logLife(t('sm.weekend.alone.log')); } },
      ],
    }),
  },

  // 18. 抽屜裡的零錢（8-15）
  {
    id: 'sm_pocket', kind: 'small',
    chance: (life) => life.age >= 8 && life.age <= 15 && Math.random() < 0.12,
    show: () => ({
      title: t('sm.pocket.title'),
      body: t('sm.pocket.body'),
      fact: t('sm.pocket.fact'),
      choices: [
        { k: 'save', icon: '🐷',
          label: t('sm.pocket.save'),
          sub: t('sm.pocket.save.sub'),
          apply: (life) => { addMoney(life, 60); logLife(t('sm.pocket.save.log')); } },
        { k: 'snack', icon: '🍡',
          label: t('sm.pocket.snack'),
          sub: t('sm.pocket.snack.sub'),
          apply: (life) => { life.stats.happiness += 3; bumpHealth(life, -1); logLife(t('sm.pocket.snack.log')); } },
        { k: 'gift', icon: '🎁',
          label: t('sm.pocket.gift'),
          sub: t('sm.pocket.gift.sub'),
          apply: (life) => { life.stats.social += 4; life.stats.happiness += 2; logLife(t('sm.pocket.gift.log')); } },
      ],
    }),
  },

  // 19. 打電話回家（25-80）
  {
    id: 'sm_call', kind: 'family',
    chance: (life) => life.age >= 25 && life.age <= 80 && Math.random() < 0.10,
    show: () => ({
      title: t('sm.call.title'),
      body: t('sm.call.body'),
      fact: t('sm.call.fact'),
      choices: [
        { k: 'call', icon: '📞',
          label: t('sm.call.call'),
          sub: t('sm.call.call.sub'),
          apply: (life) => { life.stats.social += 3; life.stats.happiness += 2; logLife(t('sm.call.call.log')); } },
        { k: 'visit', icon: '🚄',
          label: t('sm.call.visit'),
          sub: t('sm.call.visit.sub'),
          apply: (life) => { life.stats.social += 5; addMoney(life, -800); logLife(t('sm.call.visit.log')); } },
        { k: 'later', icon: '⏳',
          label: t('sm.call.later'),
          sub: t('sm.call.later.sub'),
          apply: (life) => { life.stats.social -= 2; life.stats.happiness -= 1; logLife(t('sm.call.later.log')); } },
      ],
    }),
  },

  // 20. 同學會（25-75）
  {
    id: 'sm_reunion', kind: 'small',
    chance: (life) => life.age >= 25 && life.age <= 75 && Math.random() < 0.08,
    show: () => ({
      title: t('sm.reunion.title'),
      body: t('sm.reunion.body'),
      fact: t('sm.reunion.fact'),
      choices: [
        { k: 'go', icon: '🥂',
          label: t('sm.reunion.go'),
          sub: t('sm.reunion.go.sub'),
          apply: (life) => { life.stats.social += 5; life.stats.happiness += 2; addMoney(life, -500); logLife(t('sm.reunion.go.log')); } },
        { k: 'skip', icon: '🚫',
          label: t('sm.reunion.skip'),
          sub: t('sm.reunion.skip.sub'),
          apply: (life) => { addMoney(life, 200); logLife(t('sm.reunion.skip.log')); } },
      ],
    }),
  },

  // 21. 學做一道菜（20-75）
  {
    id: 'sm_cook', kind: 'small',
    chance: (life) => life.age >= 20 && life.age <= 75 && Math.random() < 0.09,
    show: () => ({
      title: t('sm.cook.title'),
      body: t('sm.cook.body'),
      fact: t('sm.cook.fact'),
      choices: [
        { k: 'learn', icon: '🍳',
          label: t('sm.cook.learn'),
          sub: t('sm.cook.learn.sub'),
          apply: (life) => { life.stats.happiness += 3; life.stats.knowledge += 2; addMoney(life, -100); logLife(t('sm.cook.learn.log')); } },
        { k: 'buy', icon: '🍱',
          label: t('sm.cook.buy'),
          sub: t('sm.cook.buy.sub'),
          apply: (life) => { addMoney(life, -200); bumpHealth(life, -1); logLife(t('sm.cook.buy.log')); } },
      ],
    }),
  },

  // 22. 報名志工（20-75）
  {
    id: 'sm_volunteer', kind: 'small',
    chance: (life) => life.age >= 20 && life.age <= 75 && Math.random() < 0.08,
    show: () => ({
      title: t('sm.volunteer.title'),
      body: t('sm.volunteer.body'),
      fact: t('sm.volunteer.fact'),
      choices: [
        { k: 'join', icon: '🤲',
          label: t('sm.volunteer.join'),
          sub: t('sm.volunteer.join.sub'),
          apply: (life) => { life.stats.happiness += 5; life.stats.social += 4; life.stats.knowledge += 1; logLife(t('sm.volunteer.join.log')); } },
        { k: 'pass', icon: '🙅',
          label: t('sm.volunteer.pass'),
          sub: t('sm.volunteer.pass.sub'),
          apply: (life) => { life.stats.happiness -= 1; logLife(t('sm.volunteer.pass.log')); } },
      ],
    }),
  },

  // 23. 出去走走（40-85）
  {
    id: 'sm_walk', kind: 'small',
    chance: (life) => life.age >= 40 && life.age <= 85 && Math.random() < 0.09,
    show: () => ({
      title: t('sm.walk.title'),
      body: t('sm.walk.body'),
      fact: t('sm.walk.fact'),
      choices: [
        { k: 'walk', icon: '👟',
          label: t('sm.walk.walk'),
          sub: t('sm.walk.walk.sub'),
          apply: (life) => { bumpHealth(life, +4); life.stats.happiness += 2; logLife(t('sm.walk.walk.log')); } },
        { k: 'later', icon: '⏳',
          label: t('sm.walk.later'),
          sub: t('sm.walk.later.sub'),
          apply: (life) => { bumpHealth(life, -1); logLife(t('sm.walk.later.log')); } },
      ],
    }),
  },

  // 24. 換新手機（13-60）
  {
    id: 'sm_phone', kind: 'small',
    chance: (life) => life.age >= 13 && life.age <= 60 && Math.random() < 0.07,
    show: () => ({
      title: t('sm.phone.title'),
      body: t('sm.phone.body'),
      fact: t('sm.phone.fact'),
      choices: [
        { k: 'upgrade', icon: '📱',
          label: t('sm.phone.upgrade'),
          sub: t('sm.phone.upgrade.sub'),
          apply: (life) => { addMoney(life, -900); life.stats.happiness += 3; life.stats.knowledge += 1; logLife(t('sm.phone.upgrade.log')); } },
        { k: 'keep', icon: '📴',
          label: t('sm.phone.keep'),
          sub: t('sm.phone.keep.sub'),
          apply: (life) => { addMoney(life, 300); life.stats.happiness -= 1; logLife(t('sm.phone.keep.log')); } },
      ],
    }),
  },
];

/* v5.61：決策節奏控制
   實測一條人生（跑到 100 歲）會有 28 次 modal 中斷，而且決策嚴重擠在中年：
   26, 28, 30, 32, 34, 36, 38, 40 — 十五年裡八次，約兩年一個，
   而且 26/36/40 跟財務 modal 撞在同一年，玩家會被連續兩次打斷。
   這裡加兩道保護：
     1) 冷卻期：兩個決策之間至少隔 DECISION_COOLDOWN 年
     2) 避開其他 modal：別的中斷（財務 / 暫停）在 INTERRUPT_GAP 年內就不再出決策。
   注意：財務 modal 是 setTimeout 延遲開啟的，觸發那年跟真正打斷那年會差一歲，
   所以這裡用「區間」而不是「同年」，並且在 modal 真正開啟時才記錄中斷。 */
const DECISION_COOLDOWN = 3;
const INTERRUPT_GAP = 2;

/* ==== Évènements à choix supplémentaires ====
   Définis par des données : textes français et anglais sur place (les autres langues reçoivent l'anglais),
   effets décrits par un objet { money, happy, health, social, know } ou une fonction pour un résultat aléatoire.
   Les montants sont en dollars PPA pour un pays à 40 000 $ par habitant, puis mis à l'échelle du pays. */
const half = () => Math.random() < 0.5;
// roll([p1, issue1], [p2, issue2], …) : tire une issue selon les probabilités données.
const roll = (...opts) => { let r = Math.random(); for (const [pr, fx] of opts) { if ((r -= pr) < 0) return fx; } return opts[opts.length - 1][1]; };
const pppOf = (life) => life.countryData?.ppp || 0;
const quartOf = (life) => life.stats.incomeQuartile || 1;
// Vrai si le pays est assez riche, ou si la famille est dans la moitié aisée du pays.
const comfortable = (minPpp) => (life) => pppOf(life) >= minPpp || quartOf(life) >= 3;
const heavyOk = () => !STATE.softMode && !STATE.eduMode;
// Part de musulmans dans le pays, lue dans le champ `rel` (ex. « C55,N33,M9 »).
const muslimShare = (c) => { const m = /(?:^|,)\s*M(\d+)/.exec((c && c.rel) || ''); return m ? +m[1] : 0; };
const MIGRATION_DEST = { lac: ['USA', 'ESP'], ssa: ['FRA', 'GBR', 'ITA'], mena: ['FRA', 'DEU'], sa: ['GBR', 'USA'], eap: ['JPN', 'AUS', 'KOR'], eca: ['DEU', 'POL'] };
function newPartner(life, older) {
  const sex = life.sex === 'M' ? 'F' : 'M';
  return { name: randomName(life.countryData, sex), sex, birth: { year: life.year + life.yearOffset - life.age - older + Math.floor(Math.random() * 8) - 3 } };
}
// Pays où le mariage est le plus souvent arrangé par les familles : Asie du Sud et pays très majoritairement musulmans.
const arrangedNorm = (life) => life.countryData?.region === 'sa' || muslimShare(life.countryData) >= 70;
const relOf = (life) => life.stats.married ? 'married' : (life.stats.relationship || 'single');
function relLabel(life) {
  const fr = { single: 'Célibataire', dating: 'En couple', cohab: 'En concubinage', married: 'Marié(e)', divorced: 'Divorcé(e)' };
  const en = { single: 'Single', dating: 'Dating', cohab: 'Living together', married: 'Married', divorced: 'Divorced' };
  return (LANG === 'fr' ? fr : en)[relOf(life)];
}
function migrateLife(life) {
  const from = life.countryData;
  const dest = countryById(pick(MIGRATION_DEST[from.region] || ['USA']));
  if (!dest || dest.id === life.country) return;
  if (!life.birthOrigin) life.birthOrigin = { country: life.country, flag: from.flag };
  life.migratedAt = life.age;
  life.country = dest.id;
  life.countryData = dest;
  if (life === STATE.life) setTimeout(() => toast(from.flag + ' → ' + dest.flag + '  Migration'), 200);
}
const reg = (...r) => (life) => r.includes(life.countryData && life.countryData.region);
const inList = (...ids) => (life) => ids.includes(life.country);
const COLD = ['SWE', 'NOR', 'FIN', 'RUS', 'CAN', 'POL', 'UKR', 'BLR', 'EST', 'LVA', 'LTU', 'MNG', 'KAZ', 'ISL', 'DNK', 'CZE', 'SVK', 'KGZ', 'TJK', 'ARM', 'GEO', 'DEU', 'AUT', 'CHE'];
const QUAKE = ['JPN', 'CHL', 'MEX', 'NPL', 'IRN', 'TUR', 'IDN', 'PER', 'ITA', 'GRC', 'NZL', 'PHL', 'ECU', 'GTM'];
const CYCLONE = ['HTI', 'DOM', 'CUB', 'JAM', 'PHL', 'BGD', 'MDG', 'MOZ', 'VNM', 'IND'];
const MONSOON = ['IND', 'BGD', 'PAK', 'NPL', 'LKA', 'THA', 'VNM', 'KHM', 'LAO', 'MMR', 'PHL', 'IDN', 'CHN'];
const NO_VOTE = ['PRK', 'SAU', 'ARE', 'QAT', 'KWT', 'OMN', 'BHR', 'TKM', 'ERI', 'CHN', 'SYR', 'SDN', 'YEM'];
const OVERWORK = ['JPN', 'KOR', 'TWN', 'CHN', 'SGP', 'HKG'];
const bribery = (life) => pppOf(life) < 15000 && ['lac', 'ssa', 'mena', 'sa', 'eca'].includes(life.countryData?.region);
const sibs = (life) => ((life.family && life.family.siblings) || []).length > 0;
const GUNNY = ['USA', 'BRA', 'MEX', 'COL', 'VEN', 'HND', 'SLV', 'GTM', 'JAM', 'ZAF', 'ECU', 'PAN', 'DOM', 'HTI', 'TTO'];
const FIRE = ['AUS', 'CAN', 'PRT', 'GRC', 'USA', 'CHL', 'ESP'];
const TOURIST = ['ESP', 'ITA', 'GRC', 'THA', 'PRT', 'HRV', 'MLT', 'CYP', 'MEX', 'FRA'];
const gunny = (l) => GUNNY.includes(l.country);
const poorish = (l) => pppOf(l) < 8000;
const online = (min) => (life) => (life.countryData?.net || 0) >= min;
const EXTRA_DECISIONS = [
  { id: 'sm_stray', kind: 'small', min: 6, max: 12, p: 0.10,
    fr: ["Le chien errant", "Un chien sans collier vous suit jusqu'à la maison et s'assoit devant la porte."],
    en: ["The stray dog", "A dog with no collar follows you home and sits by the door."],
    choices: [
      { k: 'keep', icon: '🐕', fr: "Supplier vos parents de le garder", en: "Beg your parents to keep it", fx: { happy: 5, money: -150 } },
      { k: 'feed', icon: '🍖', fr: "Lui donner à manger, puis le laisser repartir", en: "Feed it, then let it go", fx: { happy: 1 } },
      { k: 'shoo', icon: '🚪', fr: "Fermer la porte", en: "Close the door", fx: { happy: -1 } },
    ] },
  { id: 'sm_cheat', kind: 'small', min: 10, max: 16, p: 0.10, when: (life) => inSchool(life),
    fr: ["Les réponses du contrôle", "Pendant le contrôle, votre voisin de table pousse discrètement sa copie vers vous."],
    en: ["The test answers", "During the test, the pupil next to you quietly slides their paper your way."],
    choices: [
      { k: 'copy', icon: '👀', fr: "Recopier", en: "Copy", fx: { happy: 1, know: -2 } },
      { k: 'refuse', icon: '✋', fr: "Faire le contrôle seul(e)", en: "Do the test on your own", fx: { know: 2 } },
      { k: 'tell', icon: '🧑‍🏫', fr: "Le dire au professeur", en: "Tell the teacher", fx: { know: 1, social: -3 } },
    ] },
  { id: 'sm_bully', kind: 'small', min: 9, max: 15, p: 0.10, when: (life) => inSchool(life),
    fr: ["Dans la cour", "Un élève plus petit se fait bousculer par un groupe, tous les jours au même endroit."],
    en: ["In the schoolyard", "A smaller pupil gets shoved around by a group, every day in the same spot."],
    choices: [
      { k: 'step', icon: '🛡️', fr: "Vous interposer", en: "Step in", fx: { social: 4, health: -1 } },
      { k: 'adult', icon: '🧑‍🏫', fr: "Prévenir un adulte", en: "Tell an adult", fx: { social: 2 } },
      { k: 'ignore', icon: '🙈', fr: "Regarder ailleurs", en: "Look away", fx: { happy: -3 } },
    ] },
  { id: 'sm_music', kind: 'small', min: 8, max: 14, p: 0.10, when: comfortable(8000),
    fr: ["Une place au cours de musique", "Une place se libère au cours de musique du quartier. Le même soir, vos amis jouent dehors."],
    en: ["A spot in music class", "A spot opens up in the local music class. On the same evening, your friends play outside."],
    choices: [
      { k: 'music', icon: '🎻', fr: "Prendre la place", en: "Take the spot", fx: { know: 3, happy: 2, money: -200 } },
      { k: 'sport', icon: '⚽', fr: "Préférer le sport", en: "Choose sport instead", fx: { health: 3, social: 2 } },
      { k: 'friends', icon: '🧒', fr: "Rester avec vos amis", en: "Stay with your friends", fx: { social: 3 } },
    ] },
  { id: 'sm_firstpay', kind: 'small', min: 15, max: 19, p: 0.12,
    fr: ["La première paie", "Vous tenez dans la main l'argent de votre premier petit boulot."],
    en: ["First pay", "You are holding the money from your very first job."],
    choices: [
      { k: 'save', icon: '🐷', fr: "Tout mettre de côté", en: "Save all of it", fx: { money: 600 } },
      { k: 'family', icon: '🤲', fr: "En donner une part à la famille", en: "Give a share to your family", fx: { money: 200, social: 4 } },
      { k: 'treat', icon: '🎉', fr: "Vous faire plaisir", en: "Treat yourself", fx: { happy: 4 } },
    ] },
  { id: 'sm_language', kind: 'small', min: 13, max: 20, p: 0.10, when: comfortable(5000),
    fr: ["Une autre langue", "On vous propose des cours du soir pour apprendre une langue étrangère."],
    en: ["Another language", "You are offered evening classes to learn a foreign language."],
    choices: [
      { k: 'learn', icon: '🗣️', fr: "S'y mettre sérieusement", en: "Take it seriously", fx: { know: 5, happy: -1 } },
      { k: 'skip', icon: '🛋️', fr: "Garder vos soirées", en: "Keep your evenings", fx: { happy: 1 } },
    ] },
  { id: 'de_study_abroad', kind: 'big', min: 18, max: 24, p: 0.10, when: (life) => (life.eduTarget ?? 0) >= 4 && quartOf(life) >= 3 && (pppOf(life) >= 8000 || quartOf(life) === 4),
    fr: ["Une année à l'étranger", "Une bourse permet d'étudier un an dans un autre pays. Il faut répondre cette semaine."],
    en: ["A year abroad", "A scholarship would let you study in another country for a year. You must answer this week."],
    choices: [
      { k: 'go', icon: '🌍', fr: "Partir", en: "Go", fx: { know: 6, happy: 3, social: -3 } },
      { k: 'stay', icon: '🏠', fr: "Rester près des vôtres", en: "Stay close to home", fx: { social: 3 } },
    ] },
  { id: 'de_startup', kind: 'big', min: 22, max: 40, p: 0.03, when: (life) => life.stats.employment === 'employed',
    fr: ["Monter une entreprise", "Un ami veut lancer une entreprise et vous propose de vous associer. Il faudrait quitter votre poste."],
    en: ["Starting a business", "A friend wants to start a business and asks you to join. You would have to leave your job."],
    choices: [
      { k: 'all', icon: '🚀', fr: "Vous lancer", en: "Go all in", fx: () => (Math.random() < 0.35 ? { money: 40000, happy: 5 } : { money: -15000, happy: -2, know: 3 }) },
      { k: 'part', icon: '💶', fr: "Mettre un peu d'argent sans quitter votre poste", en: "Put in some money but keep your job", fx: () => (Math.random() < 0.35 ? { money: 9000 } : { money: -3000 }) },
      { k: 'no', icon: '🙅', fr: "Refuser", en: "Decline", fx: { happy: -1 } },
    ] },
  { id: 'de_move_city', kind: 'big', min: 18, max: 35, p: 0.08, when: (life) => life.stats.birthPlaceType === 'rural',
    fr: ["La ville ou le village", "En ville, il y a du travail. Au village, il y a votre famille et tout ce que vous connaissez."],
    en: ["City or village", "The city has jobs. The village has your family and everything you know."],
    choices: [
      { k: 'city', icon: '🏙️', fr: "Partir en ville", en: "Move to the city", fx: { money: 6000, social: -4, happy: -1 } },
      { k: 'village', icon: '🌾', fr: "Rester au village", en: "Stay in the village", fx: { social: 3, happy: 1 } },
    ] },
  { id: 'fa_parent_time', kind: 'family', min: 24, max: 45, p: 0.10, when: (life) => (life.stats.kids || []).length > 0 && life.stats.employment === 'employed' && pppOf(life) >= 10000,
    fr: ["Du temps pour votre enfant", "Votre enfant est encore petit. Vous pourriez réduire votre temps de travail quelques années."],
    en: ["Time for your child", "Your child is still small. You could cut back your working hours for a few years."],
    choices: [
      { k: 'part', icon: '🧸', fr: "Passer à temps partiel", en: "Go part-time", fx: { money: -6000, happy: 5, social: 3 } },
      { k: 'full', icon: '💼', fr: "Garder le plein temps", en: "Stay full-time", fx: { money: 3000, happy: -3 } },
      { k: 'share', icon: '⚖️', fr: "Partager l'effort avec votre conjoint", en: "Share the load with your partner", fx: { money: -2000, happy: 2, social: 2 } },
    ] },
  { id: 'de_whistle', kind: 'big', min: 28, max: 55, p: 0.02, when: (life) => life.stats.employment === 'employed',
    fr: ["Ce que vous avez vu", "Vous découvrez que votre employeur triche sur les règles de sécurité. Personne d'autre ne semble au courant."],
    en: ["What you saw", "You find out your employer is cheating on safety rules. Nobody else seems to know."],
    choices: [
      { k: 'report', icon: '📣', fr: "Le signaler aux autorités", en: "Report it to the authorities", fx: () => (half() ? { social: 4, happy: 3 } : { money: -6000, social: 2, happy: -2 }) },
      { k: 'inside', icon: '🗂️', fr: "En parler à votre hiérarchie", en: "Raise it with your managers", fx: { know: 1, happy: 1 } },
      { k: 'silent', icon: '🤐', fr: "Vous taire", en: "Keep quiet", fx: { happy: -5 } },
    ] },
  { id: 'de_strike', kind: 'big', min: 22, max: 58, p: 0.06, when: (life) => life.stats.employment === 'employed' && pppOf(life) >= 4000,
    fr: ["La grève", "Vos collègues arrêtent le travail pour obtenir de meilleurs salaires. Chaque jour de grève n'est pas payé."],
    en: ["The strike", "Your colleagues stop work to win better pay. Strike days are unpaid."],
    choices: [
      { k: 'join', icon: '✊', fr: "Faire grève avec eux", en: "Strike with them", fx: () => (half() ? { money: 2500, social: 5 } : { money: -1500, social: 5 }) },
      { k: 'work', icon: '🏭', fr: "Continuer à travailler", en: "Keep working", fx: { money: 500, social: -4 } },
      { k: 'aside', icon: '🚶', fr: "Poser des congés et rester à l'écart", en: "Take leave and stay out of it", fx: { social: -1 } },
    ] },
  { id: 'de_flood', kind: 'big', min: 15, max: 75, p: 0.008,
    fr: ["L'eau monte", "Après des jours de pluie, la rivière déborde. L'eau entre dans les maisons du bas de la rue."],
    en: ["Rising water", "After days of rain the river bursts its banks. Water is entering the houses down the street."],
    choices: [
      { k: 'host', icon: '🏠', fr: "Accueillir des voisins chez vous", en: "Take neighbours in", fx: { social: 6, money: -1500 } },
      { k: 'leave', icon: '🚗', fr: "Partir vous mettre à l'abri", en: "Leave for safety", fx: { money: -1000, health: 1 } },
      { k: 'guard', icon: '🪣', fr: "Rester pour protéger la maison", en: "Stay to protect the house", fx: { health: -3, money: 500 } },
    ] },
  { id: 'de_war_flee', kind: 'big', min: 12, max: 65, p: (life) => 0.02 * (life.countryData?.war || 0), when: (life) => (life.countryData?.war || 0) >= 0.5 && !STATE.softMode && !STATE.eduMode,
    fr: ["Les combats approchent", "On entend les tirs depuis votre rue. Des voisins chargent déjà leurs affaires."],
    en: ["The fighting gets closer", "Gunfire can be heard from your street. Neighbours are already loading their belongings."],
    choices: [
      { k: 'abroad', icon: '🧳', fr: "Fuir vers un autre pays", en: "Flee to another country", fx: { money: -5000, social: -8, health: 2 } },
      { k: 'country', icon: '🌾', fr: "Vous réfugier chez des proches à la campagne", en: "Shelter with relatives in the countryside", fx: { money: -1500, social: 2 } },
      { k: 'stay', icon: '🏚️', fr: "Rester", en: "Stay", fx: { health: -8, happy: -6 } },
    ] },
  { id: 'de_harvest', kind: 'big', min: 18, max: 60, p: 0.07, when: (life) => life.stats.birthPlaceType === 'rural' && (life.countryData?.agr || 0) > 30,
    fr: ["Une mauvaise récolte", "La pluie n'est pas venue. La récolte de cette année ne suffira pas."],
    en: ["A bad harvest", "The rains did not come. This year's harvest will not be enough."],
    choices: [
      { k: 'borrow', icon: '🌱', fr: "Emprunter pour acheter des semences", en: "Borrow to buy seed", fx: () => (half() ? { money: 3000 } : { money: -3000, happy: -2 }) },
      { k: 'season', icon: '🏗️', fr: "Chercher un travail en ville pour la saison", en: "Find seasonal work in town", fx: { money: 1500, social: -2 } },
      { k: 'tighten', icon: '🍚', fr: "Réduire les repas et attendre", en: "Cut back on meals and wait", fx: { health: -3, happy: -2 } },
    ] },
  { id: 'de_retrain', kind: 'big', min: 38, max: 55, p: 0.06, when: (life) => life.stats.employment === 'employed' && comfortable(5000)(life),
    fr: ["Votre métier change", "Les outils de votre métier ne sont plus ceux que vous avez appris. Une formation longue est possible."],
    en: ["Your trade is changing", "The tools of your trade are no longer the ones you learned. A long training course is available."],
    choices: [
      { k: 'train', icon: '📚', fr: "Suivre la formation", en: "Take the course", fx: { know: 6, money: -4000, happy: 1 } },
      { k: 'switch', icon: '🔀', fr: "Changer complètement de voie", en: "Switch careers entirely", fx: () => (half() ? { money: 8000, happy: 3 } : { money: -8000, happy: 3 }) },
      { k: 'coast', icon: '🪑', fr: "Compter sur votre expérience", en: "Rely on your experience", fx: { happy: -1 } },
    ] },
  { id: 'de_retire_early', kind: 'big', min: 50, max: 66, p: 0.10, when: (life) => life.stats.employment === 'employed' && pppOf(life) >= 10000 && hasPension(life) && life.age >= retireAge(life) - 5 && life.age < retireAge(life),
    fr: ["Partir plus tôt", "Votre employeur propose un départ anticipé, avec une somme moins élevée que si vous restiez."],
    en: ["Leaving early", "Your employer offers early retirement, for less money than if you stayed on."],
    choices: [
      { k: 'leave', icon: '🌅', fr: "Accepter et arrêter de travailler", en: "Accept and stop working", fx: { happy: 6, health: 3, money: -10000, retire: true } },
      { k: 'stay', icon: '💼', fr: "Continuer jusqu'au bout", en: "Work until the end", fx: { money: 15000, health: -3 } },
      { k: 'part', icon: '⏳', fr: "Négocier un temps partiel", en: "Negotiate part-time", fx: { happy: 3, money: 4000 } },
    ] },
  { id: 'fa_grandkids', kind: 'family', min: 58, max: 82, p: 0.10, when: (life) => (life.stats.kids || []).length > 0,
    fr: ["Garder les petits", "Vos enfants vous demandent de garder les petits-enfants un jour par semaine."],
    en: ["Minding the little ones", "Your children ask you to mind the grandchildren one day a week."],
    choices: [
      { k: 'weekly', icon: '👵', fr: "Accepter chaque semaine", en: "Agree to every week", fx: { social: 5, happy: 3, health: -1 } },
      { k: 'sometimes', icon: '📅', fr: "De temps en temps", en: "Now and then", fx: { social: 2, happy: 1 } },
      { k: 'no', icon: '🛋️', fr: "Garder votre temps pour vous", en: "Keep your time for yourself", fx: { health: 1, social: -2 } },
    ] },
  { id: 'sm_neighbour', kind: 'small', min: 30, max: 75, p: 0.08,
    fr: ["Le voisin d'en face", "Votre voisin âgé n'arrive plus à porter ses courses jusque chez lui."],
    en: ["The neighbour across the way", "Your elderly neighbour can no longer carry his shopping home."],
    choices: [
      { k: 'weekly', icon: '🛒', fr: "Faire ses courses chaque semaine", en: "Do his shopping every week", fx: { social: 5, happy: 2 } },
      { k: 'once', icon: '🤝', fr: "L'aider cette fois-ci", en: "Help him this once", fx: { social: 2 } },
      { k: 'busy', icon: '⌚', fr: "Vous n'avez pas le temps", en: "You have no time", fx: {} },
    ] },
  // ---- Évènements à fort impact : dépendances, violence, pauvreté, migration ----
  { id: 'sm_cigarette', kind: 'small', min: 12, max: 19, when: (life) => !life.smoker,
    p: (life) => 0.04 + ((life.sex === 'M' ? life.countryData?.sm : life.countryData?.sf) || 10) / 100 * 0.2,
    fr: ["La première cigarette", "Derrière l'école, un ami vous tend une cigarette allumée. Les autres vous regardent."],
    en: ["The first cigarette", "Behind the school, a friend holds out a lit cigarette. The others are watching."],
    choices: [
      { k: 'take', icon: '🚬', fr: "La prendre", en: "Take it",
        fx: () => roll([0.5, { smoker: true, social: 2, health: -2, msg: { fr: "Vous prenez l'habitude de fumer.", en: "Smoking becomes a habit." } }],
                       [0.5, { social: 1, msg: { fr: "Vous toussez. Vous n'y retouchez pas.", en: "You cough. You never touch one again." } }]) },
      { k: 'no', icon: '✋', fr: "Refuser", en: "Refuse", fx: {} },
      { k: 'lie', icon: '🤥', fr: "Dire que vous avez déjà essayé", en: "Say you have already tried", fx: { social: 1 } },
    ] },
  { id: 'de_alcohol', kind: 'big', min: 16, max: 26, p: 0.07, when: (life) => muslimShare(life.countryData) < 50,
    fr: ["Les soirées", "Chaque fin de semaine, le groupe se retrouve pour boire. On remarque vite ceux qui ne suivent pas."],
    en: ["The parties", "Every weekend the group meets to drink. Those who do not join in get noticed."],
    choices: [
      { k: 'drink', icon: '🍺', fr: "Boire comme les autres", en: "Drink like the others",
        fx: () => roll([0.3, { flag: ['drinker', true], social: 3, health: -7, msg: { fr: "L'alcool devient une habitude quotidienne.", en: "Drinking becomes a daily habit." } }],
                       [0.7, { social: 3, health: -1 }]) },
      { k: 'sober', icon: '🥤', fr: "Venir sans boire", en: "Come but stay sober", fx: { social: 1 } },
      { k: 'leave', icon: '🚶', fr: "Ne plus y aller", en: "Stop going", fx: { social: -3, health: 1 } },
    ] },
  { id: 'de_drugs', kind: 'big', min: 15, max: 28, p: 0.05, when: heavyOk,
    fr: ["Ce qu'on vous tend", "En soirée, quelqu'un fait circuler une drogue. « Juste une fois », dit-il."],
    en: ["What you are offered", "At a party, someone passes a drug around. \"Just once,\" he says."],
    choices: [
      { k: 'try', icon: '💊', fr: "Essayer", en: "Try it",
        fx: () => roll([0.2, { flag: ['addicted', true], health: -8, happy: -4, money: -1500, msg: { fr: "Vous n'arrivez plus à vous en passer.", en: "You can no longer do without it." } }],
                       [0.8, { happy: 1, health: -1, msg: { fr: "Vous n'y retouchez pas.", en: "You never touch it again." } }]) },
      { k: 'no', icon: '✋', fr: "Refuser", en: "Refuse", fx: {} },
      { k: 'leave', icon: '🚪', fr: "Quitter la soirée", en: "Leave the party", fx: { social: -1 } },
    ] },
  { id: 'de_addiction', kind: 'big', min: 16, max: 60, p: 0.5, when: (life) => !!life.addicted,
    fr: ["Sortir de la dépendance", "La drogue prend votre argent, votre sommeil et vos amis. Un proche vous parle d'un centre de soins."],
    en: ["Getting clean", "The drug is taking your money, your sleep and your friends. Someone close tells you about a treatment centre."],
    choices: [
      { k: 'care', icon: '🏥', fr: "Entrer en soins", en: "Enter treatment",
        fx: () => roll([0.6, { flag: ['addicted', false], health: 6, happy: 5, money: -2500, msg: { fr: "Après des mois difficiles, vous vous en sortez.", en: "After hard months, you pull through." } }],
                       [0.4, { money: -2500, health: -2, msg: { fr: "Vous rechutez à la sortie.", en: "You relapse when you get out." } }]) },
      { k: 'alone', icon: '🧍', fr: "Arrêter seul(e)", en: "Quit on your own",
        fx: () => roll([0.25, { flag: ['addicted', false], health: 4, happy: 3, msg: { fr: "Contre toute attente, vous tenez.", en: "Against the odds, you hold on." } }],
                       [0.75, { health: -5, happy: -3, msg: { fr: "Vous rechutez au bout de quelques semaines.", en: "You relapse after a few weeks." } }]) },
      { k: 'go', icon: '🌀', fr: "Continuer", en: "Carry on",
        fx: () => roll([0.08, { die: '事故', msg: { fr: "Une dose de trop.", en: "One dose too many." } }],
                       [0.92, { health: -10, money: -4000, happy: -6, social: -5 }]) },
    ] },
  { id: 'de_package', kind: 'big', min: 15, max: 30, p: 0.05,
    when: (life) => heavyOk() && quartOf(life) <= 2 && ((life.countryData?.hom || 0) > 5 || pppOf(life) < 12000),
    fr: ["Le paquet", "Un homme du quartier propose une grosse somme pour porter un paquet à l'autre bout de la ville, sans poser de questions."],
    en: ["The package", "A man from the neighbourhood offers a large sum to carry a package across town, no questions asked."],
    choices: [
      { k: 'yes', icon: '📦', fr: "Accepter", en: "Accept",
        fx: () => roll([0.55, { money: 4000, msg: { fr: "Tout se passe bien. On vous le reproposera.", en: "It goes smoothly. They will ask again." } }],
                       [0.33, { happy: -10, social: -6, know: -2, money: -1000, msg: { fr: "Vous êtes arrêté(e) et passez plusieurs mois en prison.", en: "You are arrested and spend several months in prison." } }],
                       [0.12, { health: -18, msg: { fr: "Le rendez-vous tourne mal : vous êtes gravement blessé(e).", en: "The handover goes wrong: you are badly hurt." } }]) },
      { k: 'no', icon: '✋', fr: "Refuser", en: "Refuse", fx: {} },
      { k: 'tell', icon: '👪', fr: "En parler à votre famille", en: "Tell your family", fx: { social: 2 } },
    ] },
  { id: 'de_robbery', kind: 'big', min: 15, max: 75, when: (life) => heavyOk() && (life.countryData?.hom || 0) > 3,
    p: (life) => Math.min(life.countryData?.hom || 0, 40) / 40 * 0.05,
    fr: ["Dans la rue", "Deux hommes vous barrent le passage et réclament votre téléphone et votre argent."],
    en: ["In the street", "Two men block your way and demand your phone and your money."],
    choices: [
      { k: 'give', icon: '🤲', fr: "Tout donner", en: "Hand everything over", fx: { money: -300, happy: -2 } },
      { k: 'fight', icon: '✊', fr: "Résister", en: "Fight back",
        fx: () => roll([0.5, { happy: 1, msg: { fr: "Ils prennent la fuite.", en: "They run off." } }],
                       [0.42, { health: -14, money: -300, msg: { fr: "Vous êtes blessé(e) et ils repartent avec tout.", en: "You are hurt and they leave with everything." } }],
                       [0.08, { die: '他殺', msg: { fr: "L'un d'eux était armé.", en: "One of them was armed." } }]) },
      { k: 'run', icon: '🏃', fr: "Courir", en: "Run",
        fx: () => roll([0.8, { msg: { fr: "Vous leur échappez.", en: "You get away." } }],
                       [0.2, { health: -6, money: -300, msg: { fr: "Ils vous rattrapent.", en: "They catch up with you." } }]) },
    ] },
  { id: 'de_gang', kind: 'big', min: 12, max: 18, p: 0.10,
    when: (life) => heavyOk() && (life.countryData?.hom || 0) > 10 && quartOf(life) <= 2,
    fr: ["Le groupe du quartier", "Les jeunes qui tiennent votre rue vous proposent de les rejoindre. Ils promettent de l'argent et de la protection."],
    en: ["The neighbourhood crew", "The young men who run your street ask you to join. They promise money and protection."],
    choices: [
      { k: 'join', icon: '🔗', fr: "Les rejoindre", en: "Join them",
        fx: () => roll([0.1, { die: '他殺', msg: { fr: "Un règlement de comptes vous coûte la vie.", en: "A settling of scores costs you your life." } }],
                       [0.9, { money: 2500, health: -5, know: -3, edu: 'stop', flag: ['gang', true], msg: { fr: "Vous quittez l'école pour le groupe.", en: "You leave school for the crew." } }]) },
      { k: 'no', icon: '✋', fr: "Refuser", en: "Refuse",
        fx: () => roll([0.7, {}], [0.3, { health: -6, msg: { fr: "Ils vous le font payer.", en: "They make you pay for it." } }]) },
      { k: 'move', icon: '🧳', fr: "Partir vivre chez un parent, ailleurs", en: "Go and live with a relative elsewhere", fx: { social: -4, money: -800 } },
    ] },
  { id: 'fa_child_marriage', kind: 'family', min: 13, max: 17,
    when: (life) => heavyOk() && life.sex === 'F' && !life.stats.married && (life.countryData?.cm || 0) >= 10,
    p: (life) => (life.countryData?.cm || 0) / 100 / 5 * 1.2,
    fr: ["Un mariage arrangé", "Vos parents ont trouvé un mari. Il est bien plus âgé que vous. Le mariage est prévu pour bientôt."],
    en: ["An arranged marriage", "Your parents have found a husband. He is much older than you. The wedding is to be soon."],
    choices: [
      { k: 'accept', icon: '💍', fr: "Accepter", en: "Accept", fx: { happy: -6, social: 2, edu: 'stop', marry: true } },
      { k: 'plead', icon: '📚', fr: "Supplier de rester à l'école", en: "Plead to stay in school",
        fx: () => roll([0.5, { know: 2, social: -3, msg: { fr: "Vos parents cèdent, pour l'instant.", en: "Your parents give in, for now." } }],
                       [0.5, { happy: -6, edu: 'stop', marry: true, msg: { fr: "Le mariage a lieu malgré tout.", en: "The wedding goes ahead anyway." } }]) },
      { k: 'flee', icon: '🏃‍♀️', fr: "Fuir chez une tante en ville", en: "Run away to an aunt in town", fx: { social: -6, happy: -2, know: 1 } },
    ] },
  { id: 'fa_child_labor', kind: 'family', min: 8, max: 13, p: 0.10, when: (life) => pppOf(life) < 8000 && quartOf(life) <= 2,
    fr: ["Aider la famille", "L'argent manque à la maison. Vos parents vous demandent de travailler au lieu d'aller à l'école."],
    en: ["Helping the family", "Money is short at home. Your parents ask you to work instead of going to school."],
    choices: [
      { k: 'quit', icon: '🧺', fr: "Quitter l'école pour travailler", en: "Leave school to work", fx: { pppx: 0.15, know: -3, edu: 'stop' } },
      { k: 'both', icon: '🌙', fr: "Travailler après la classe", en: "Work after class", fx: { pppx: 0.07, health: -3, know: -1 } },
      { k: 'school', icon: '🎒', fr: "Rester à l'école", en: "Stay in school", fx: { know: 2, happy: -1 } },
    ] },
  { id: 'de_migration', kind: 'big', min: 18, max: 40, p: 0.04, when: (life) => pppOf(life) < 15000,
    fr: ["Partir vers un pays riche", "Un passeur promet de vous faire entrer dans un pays riche. Il demande l'équivalent de plusieurs années d'économies. D'autres sont partis avant vous ; tous ne sont pas arrivés."],
    en: ["Leaving for a rich country", "A smuggler promises to get you into a rich country. He asks for the equivalent of several years of savings. Others left before you; not all of them arrived."],
    choices: [
      { k: 'smuggler', icon: '🚤', fr: "Payer le passeur", en: "Pay the smuggler",
        fx: () => roll([0.5, { migrate: true, pppx: -2.5, social: -6, msg: { fr: "Après des semaines de voyage, vous arrivez à destination.", en: "After weeks on the road, you reach your destination." } }],
                       [0.25, { pppx: -2.5, happy: -5, msg: { fr: "Vous êtes arrêté(e) à la frontière et expulsé(e) vers votre pays. L'argent est perdu.", en: "You are stopped at the border and deported home. The money is gone." } }],
                       [0.15, { pppx: -2.5, health: -8, happy: -6, msg: { fr: "Vous restez bloqué(e) des mois dans un pays de transit, puis vous rentrez.", en: "You are stuck for months in a transit country, then go back." } }],
                       [0.10, { die: '溺水', msg: { fr: "L'embarcation chavire pendant la traversée.", en: "The boat capsizes during the crossing." } }]) },
      { k: 'visa', icon: '🛂', fr: "Demander un visa de travail", en: "Apply for a work visa",
        fx: (life) => roll([life.stats.education >= 4 ? 0.3 : 0.06, { migrate: true, pppx: -0.3, social: -5, msg: { fr: "Votre visa est accepté. Vous partez légalement.", en: "Your visa is granted. You leave legally." } }],
                           [1, { pppx: -0.1, happy: -2, msg: { fr: "Votre demande de visa est refusée.", en: "Your visa application is refused." } }]) },
      { k: 'stay', icon: '🏡', fr: "Rester", en: "Stay", fx: { social: 2 } },
    ] },
  { id: 'de_malaria', kind: 'big', min: 8, max: 60, p: 0.06, when: (life) => (life.countryData?.mal || 0) > 0,
    fr: ["La fièvre", "Une forte fièvre vous cloue au lit depuis deux jours. Le dispensaire est à plusieurs heures de route."],
    en: ["The fever", "A high fever has kept you in bed for two days. The clinic is several hours away."],
    choices: [
      { k: 'clinic', icon: '🏥', fr: "Aller au dispensaire", en: "Go to the clinic", fx: { pppx: -0.03, health: -2 } },
      { k: 'meds', icon: '💊', fr: "Envoyer quelqu'un acheter des médicaments", en: "Send someone to buy medicine", fx: { pppx: -0.02, health: -5 } },
      { k: 'wait', icon: '🛏️', fr: "Attendre que ça passe", en: "Wait for it to pass",
        fx: () => roll([0.65, { health: -4 }],
                       [0.31, { health: -14, msg: { fr: "La fièvre empire. Vous mettez des semaines à vous remettre.", en: "The fever worsens. It takes you weeks to recover." } }],
                       [0.04, { die: '瘧疾', msg: { fr: "Le paludisme n'a pas été soigné à temps.", en: "The malaria was not treated in time." } }]) },
    ] },
  { id: 'sm_helmet', kind: 'small', min: 15, max: 45, p: 0.07, when: (life) => (life.countryData?.road || 0) > 15,
    fr: ["La moto", "Vous vous déplacez à moto tous les jours. Un casque coûte plusieurs jours de salaire."],
    en: ["The motorbike", "You ride a motorbike every day. A helmet costs several days' pay."],
    choices: [
      { k: 'buy', icon: '🪖', fr: "Acheter un casque", en: "Buy a helmet", fx: { pppx: -0.02 } },
      { k: 'none', icon: '🏍️', fr: "Rouler sans", en: "Ride without one",
        fx: () => roll([0.88, {}],
                       [0.10, { health: -15, msg: { fr: "Vous chutez. Sans casque, la blessure est sérieuse.", en: "You crash. Without a helmet, the injury is serious." } }],
                       [0.02, { die: '事故', msg: { fr: "Un accident de la route.", en: "A road accident." } }]) },
    ] },
  { id: 'de_burnout', kind: 'big', min: 28, max: 55, p: 0.05, when: (life) => life.stats.employment === 'employed' && pppOf(life) >= 20000,
    fr: ["À bout", "Vous dormez mal, vous oubliez des choses, et le dimanche soir vous serre la gorge. Votre médecin parle d'épuisement."],
    en: ["Burnt out", "You sleep badly, you forget things, and Sunday evenings tighten your throat. Your doctor calls it exhaustion."],
    choices: [
      { k: 'stop', icon: '🛌', fr: "Vous arrêter plusieurs mois", en: "Take several months off", fx: { money: -3000, health: 6, happy: 4 } },
      { k: 'hold', icon: '💼', fr: "Tenir", en: "Push through", fx: { money: 4000, health: -8, happy: -6 } },
      { k: 'quit', icon: '🚪', fr: "Démissionner", en: "Resign", fx: { money: -8000, happy: 6, health: 3 } },
    ] },
  { id: 'de_student_loan', kind: 'big', min: 17, max: 20, p: 0.15,
    when: (life) => (life.eduTarget ?? 0) >= 4 && quartOf(life) <= 2 && pppOf(life) >= 15000,
    fr: ["Payer ses études", "Vous êtes admis(e) à l'université, mais votre famille ne peut pas payer."],
    en: ["Paying for university", "You have a place at university, but your family cannot pay."],
    choices: [
      { k: 'loan', icon: '🏦', fr: "Emprunter", en: "Take out a loan", fx: { money: -15000, know: 3 } },
      { k: 'job', icon: '🍽️', fr: "Travailler le soir et le week-end", en: "Work evenings and weekends", fx: { money: -2000, health: -3, know: 1 } },
      { k: 'drop', icon: '✖️', fr: "Renoncer à l'université", en: "Give up on university", fx: { edu: 3, happy: -4, money: 2000 } },
    ] },
  { id: 'de_gambling', kind: 'big', min: 20, max: 60, p: 0.015, when: (life) => life.stats.employment === 'employed' && muslimShare(life.countryData) < 50,
    fr: ["Les paris", "Un collègue dit gagner régulièrement aux paris sportifs. Il vous montre comment faire depuis votre téléphone."],
    en: ["Betting", "A colleague says he wins regularly on sports bets. He shows you how to do it from your phone."],
    choices: [
      { k: 'bet', icon: '🎰', fr: "Parier", en: "Place bets",
        fx: () => roll([0.55, { money: -600, msg: { fr: "Vous perdez un peu et vous arrêtez.", en: "You lose a little and stop." } }],
                       [0.30, { money: 900, happy: 2, msg: { fr: "Vous gagnez un peu.", en: "You win a little." } }],
                       [0.15, { money: -12000, happy: -6, social: -3, msg: { fr: "Vous ne savez plus vous arrêter et perdez beaucoup.", en: "You cannot stop any more and lose a lot." } }]) },
      { k: 'no', icon: '✋', fr: "Ne pas commencer", en: "Do not start", fx: {} },
    ] },
  { id: 'fa_violence', kind: 'family', min: 20, max: 60, p: 0.01, when: (life) => heavyOk() && life.stats.married,
    fr: ["À la maison", "Votre conjoint vous a frappé(e). Ce n'est pas la première fois. Il promet que cela ne se reproduira pas."],
    en: ["At home", "Your partner hit you. It is not the first time. They promise it will not happen again."],
    choices: [
      { k: 'leave', icon: '🚪', fr: "Partir", en: "Leave", fx: { money: -3000, happy: 3, social: 2, leave: true } },
      { k: 'help', icon: '🤝', fr: "Demander de l'aide à un proche ou à une association", en: "Ask a relative or a support group for help", fx: { social: 4, happy: 1 } },
      { k: 'stay', icon: '🏠', fr: "Rester", en: "Stay", fx: { health: -8, happy: -10 } },
    ] },
  { id: 'sm_scam', kind: 'small', min: 55, max: 85, p: 0.06, when: (life) => pppOf(life) >= 15000,
    fr: ["Le placement miracle", "Au téléphone, un conseiller très aimable vous propose un placement « sans risque » à 12 % par an."],
    en: ["The miracle investment", "On the phone, a very friendly adviser offers you a \"risk-free\" investment at 12% a year."],
    choices: [
      { k: 'invest', icon: '💸', fr: "Investir", en: "Invest",
        fx: () => roll([0.85, { money: -9000, happy: -4, msg: { fr: "C'était une arnaque. L'argent a disparu.", en: "It was a scam. The money is gone." } }],
                       [0.15, { money: 500, msg: { fr: "Vous récupérez votre mise de justesse.", en: "You barely get your money back." } }]) },
      { k: 'ask', icon: '📞', fr: "En parler d'abord à un proche", en: "Talk to someone close first", fx: { social: 2 } },
      { k: 'hang', icon: '📵', fr: "Raccrocher", en: "Hang up", fx: {} },
    ] },
  { id: 'de_literacy', kind: 'big', min: 18, max: 40, p: 0.08, when: (life) => life.stats.education <= 1 && pppOf(life) < 15000,
    fr: ["Les cours du soir", "Une association ouvre des cours du soir pour les adultes qui n'ont pas pu finir l'école."],
    en: ["Evening classes", "A charity opens evening classes for adults who could not finish school."],
    choices: [
      { k: 'go', icon: '📖', fr: "Vous inscrire", en: "Sign up", fx: { know: 8, happy: 3, health: -1 } },
      { k: 'no', icon: '⌚', fr: "Vous n'avez pas le temps", en: "You have no time", fx: {} },
    ] },
  { id: 'de_water', kind: 'big', min: 12, max: 45, p: 0.06, when: (life) => life.stats.birthPlaceType === 'rural' && pppOf(life) < 5000,
    fr: ["Le puits à sec", "Le puits du village est à sec. Le point d'eau le plus proche est à deux heures de marche."],
    en: ["The dry well", "The village well has run dry. The nearest water is a two-hour walk away."],
    choices: [
      { k: 'walk', icon: '🚶', fr: "Aller chercher l'eau chaque matin", en: "Fetch water every morning", fx: { health: -3, know: -1 } },
      { k: 'dig', icon: '⛏️', fr: "Creuser un nouveau puits avec les voisins", en: "Dig a new well with the neighbours", fx: { social: 5, health: -2 } },
      { k: 'buy', icon: '🚚', fr: "Acheter l'eau au camion-citerne", en: "Buy water from the tanker", fx: { pppx: -0.05 } },
    ] },
  // ---- Vie amoureuse ----
  { id: 'sm_first_love', kind: 'small', min: 13, max: 18, p: 0.12, priority: true,
    fr: ["Premier amour", "Quelqu'un de votre âge vous plaît depuis des semaines. Vous y pensez tout le temps."],
    en: ["First love", "You have liked someone your age for weeks. You think about it all the time."],
    choices: [
      { k: 'tell', icon: '💌', fr: "Vous déclarer", en: "Say how you feel",
        fx: () => roll([0.5, { happy: 6, msg: { fr: "C'est réciproque : votre premier amour.", en: "The feeling is mutual: your first love." } }],
                       [0.5, { happy: -3, msg: { fr: "Ce n'est pas réciproque.", en: "The feeling is not mutual." } }]) },
      { k: 'note', icon: '✉️', fr: "Glisser un mot anonyme", en: "Slip an anonymous note", fx: { happy: 1 } },
      { k: 'quiet', icon: '🤐', fr: "Ne rien dire", en: "Say nothing", fx: {} },
    ] },
  { id: 'de_meet', kind: 'family', min: 17, max: 45, p: 0.35, priority: true, repeat: true, when: (life) => relOf(life) !== 'married' && !life.stats.partner && !arrangedNorm(life),
    fr: ["Une rencontre", "Vous revoyez souvent la même personne. Elle semble chercher votre compagnie, et vous la sienne."],
    en: ["Meeting someone", "You keep running into the same person. They seem to seek your company, and you theirs."],
    choices: [
      { k: 'date', icon: '❤️', fr: "Commencer une relation", en: "Start a relationship", fx: { rel: 'dating', happy: 6, social: 2 } },
      { k: 'friend', icon: '🤝', fr: "Rester ami(e)s", en: "Stay friends", fx: { social: 2 } },
      { k: 'away', icon: '🚶', fr: "Garder vos distances", en: "Keep your distance", fx: {} },
    ] },
  { id: 'fa_arranged', kind: 'family', min: 18, max: 30, p: 0.5, priority: true, repeat: true, when: (life) => relOf(life) === 'single' && !life.stats.partner && arrangedNorm(life),
    fr: ["Une proposition de mariage", "Vos parents ont rencontré une autre famille. Ils vous présentent quelqu'un qu'ils jugent convenable."],
    en: ["A marriage proposal", "Your parents have met another family. They introduce someone they consider suitable."],
    choices: [
      { k: 'accept', icon: '💍', fr: "Accepter le mariage", en: "Accept the marriage", fx: { marry: true, pppx: -0.4, happy: 2, social: 4 } },
      { k: 'know', icon: '🗣️', fr: "Demander à mieux connaître la personne", en: "Ask to get to know them first",
        fx: () => roll([0.6, { marry: true, pppx: -0.4, happy: 4, social: 2, msg: { fr: "Après plusieurs rencontres, vous acceptez.", en: "After several meetings, you accept." } }],
                       [0.4, { social: -2, msg: { fr: "L'autre famille retire sa proposition.", en: "The other family withdraws the proposal." } }]) },
      { k: 'refuse', icon: '✋', fr: "Refuser", en: "Refuse", fx: { social: -5, happy: 1 } },
    ] },
  { id: 'de_move_in', kind: 'family', min: 18, max: 46, p: 0.3, priority: true, repeat: true, when: (life) => relOf(life) === 'dating',
    fr: ["Vivre ensemble", "Votre relation dure. La question de vivre sous le même toit se pose."],
    en: ["Living together", "Your relationship is lasting. The question of sharing a home comes up."],
    choices: [
      { k: 'cohab', icon: '🏠', fr: "Emménager ensemble", en: "Move in together", fx: { rel: 'cohab', happy: 4, money: -1500 } },
      { k: 'marry', icon: '💍', fr: "Vous marier", en: "Get married", fx: { marry: true, pppx: -0.25, happy: 5, social: 3 } },
      { k: 'wait', icon: '⏳', fr: "Garder chacun son logement", en: "Keep separate homes", fx: {} },
      { k: 'break', icon: '💔', fr: "Rompre", en: "Break up", fx: { rel: 'single', happy: -6 } },
    ] },
  { id: 'de_proposal', kind: 'family', min: 20, max: 50, p: 0.2, priority: true, repeat: true, when: (life) => relOf(life) === 'cohab',
    fr: ["Se marier ?", "Vous vivez ensemble depuis un moment. Votre entourage demande à quand le mariage."],
    en: ["Getting married?", "You have been living together for a while. People around you ask when the wedding will be."],
    choices: [
      { k: 'marry', icon: '💍', fr: "Vous marier", en: "Get married", fx: { marry: true, pppx: -0.25, happy: 5, social: 3 } },
      { k: 'free', icon: '🕊️', fr: "Rester en union libre", en: "Stay unmarried partners", fx: { happy: 1 } },
      { k: 'split', icon: '💔', fr: "Vous séparer", en: "Split up", fx: { rel: 'single', happy: -8, money: -2000 } },
    ] },
  // ---- Études, premier emploi, animal, loisir ----
  { id: 'de_after_school', kind: 'big', min: 17, max: 19, p: 0.6, priority: true, when: (life) => life.stats.education >= 3 && life.stats.employment !== 'university' && life.stats.employment !== 'employed',
    fr: ["Après le lycée", "Vous avez terminé le lycée. Il faut maintenant choisir la suite."],
    en: ["After secondary school", "You have finished secondary school. Now you must choose what comes next."],
    choices: [
      { k: 'univ', icon: '🎓', fr: "Tenter l'université", en: "Try for university",
        sub: (life) => (LANG === 'fr' ? "Admission incertaine : places et moyens de la famille" : "Admission uncertain: places and family means"),
        fx: (life) => roll([Math.max(0.1, Math.min(0.9, (life.countryData?.ter || 30) / 100 + (quartOf(life) - 2) * 0.1)),
                            { eduUp: 4, know: 3, msg: { fr: "Vous êtes admis{e} à l'université.", en: "You are admitted to university." } }],
                           [1, { edu: 3, happy: -3, msg: { fr: "Vous n'êtes pas admis{e}. Il faut chercher du travail.", en: "You are not admitted. You have to look for work." } }]) },
      { k: 'trade', icon: '🔧', fr: "Apprendre un métier", en: "Learn a trade", fx: { edu: 3, know: 4, flag: ['trained', true] } },
      { k: 'work', icon: '💼', fr: "Travailler tout de suite", en: "Start working right away", fx: { edu: 3, money: 1500 } },
    ] },
  { id: 'de_first_job', kind: 'big', min: 14, max: 45, p: 1, priority: true, when: (life) => life.stats.employment === 'employed' && !life.job,
    fr: ["Votre premier emploi", (l) => (l.univ && l.univ.status === 'graduated' ? "Votre diplôme universitaire en poche, vous cherchez un premier poste. " : l.univ && l.univ.status === 'failed' ? "Sans le diplôme que vous visiez, vous cherchez un premier poste. " : "Vos études terminées, vous cherchez un premier poste. ") + "Voici ce que l'on vous propose là où vous vivez."],
    en: ["Your first job", "These are the jobs you can find, with your schooling and where you live."],
    choices: (life) => jobOffers(life).map((j, n) => ({ k: 'job' + n, icon: j.i, fr: j.fr, en: j.en,
      sub: (l) => money(wageFor(l, j.mult)) + (LANG === 'fr' ? ' par an avant impôts' : ' a year before tax'),
      fx: { job: j, health: j.health || 0, happy: j.happy || 0 } })) },
  { id: 'sm_pet', kind: 'small', min: 8, max: 60, p: 0.05, when: comfortable(3000),
    fr: ["Un animal à la maison ?", "La chienne des voisins a eu des petits. Ils cherchent des familles pour les accueillir."],
    en: ["A pet at home?", "The neighbours' dog has had puppies. They are looking for families to take them in."],
    choices: [
      { k: 'dog', icon: '🐕', fr: "Adopter un chiot", en: "Adopt a puppy", fx: { happy: 5, health: 1, money: -300, flag: ['pet', 'dog'] } },
      { k: 'cat', icon: '🐈', fr: "Préférer un chat", en: "Get a cat instead", fx: { happy: 4, money: -200, flag: ['pet', 'cat'] } },
      { k: 'no', icon: '✋', fr: "Pas maintenant", en: "Not now", fx: {} },
    ] },
  { id: 'sm_hobby', kind: 'small', min: 10, max: 55, p: 0.06,
    fr: ["Un nouveau loisir ?", "Vous avez un peu de temps libre et l'envie d'en faire quelque chose."],
    en: ["A new hobby?", "You have some free time and want to make something of it."],
    choices: [
      { k: 'sport', icon: '🏃', fr: "Un sport", en: "A sport", fx: { health: 4, social: 2, hobby: 'Sport' } },
      { k: 'music', icon: '🎸', fr: "La musique", en: "Music", fx: { happy: 4, know: 1, hobby: 'Musique' } },
      { k: 'read', icon: '📚', fr: "La lecture", en: "Reading", fx: { know: 4, happy: 1, hobby: 'Lecture' } },
      { k: 'none', icon: '🛋️', fr: "Le repos suffit", en: "Rest is enough", fx: { happy: 1 } },
    ] },
  // ---- Santé, argent, famille, vie sociale : décisions adaptées au pays ----
  { id: 'de_quit_smoking', kind: 'big', min: 28, max: 70, p: 0.12, repeat: true, when: (life) => !!life.smoker,
    fr: ["Arrêter de fumer ?", "Vous toussez de plus en plus souvent. Est-il temps d'arrêter de fumer ?"],
    choices: [
      { k: 'quit', icon: '🚭', fr: "Essayer d'arrêter", sub: () => "Si ça marche, votre santé se rétablit",
        fx: () => roll([0.35, { flag: ['smoker', false], exSmoker: true, health: 4, happy: 2, msg: { fr: "Vous tenez bon : vous ne fumez plus.", en: "You hold on: you no longer smoke." } }],
                       [0.65, { health: -1, msg: { fr: "Vous recommencez au bout de quelques semaines.", en: "You start again after a few weeks." } }]) },
      { k: 'keep', icon: '🚬', fr: "Continuer à fumer", fx: { health: -2 } },
    ] },
  { id: 'de_diabetes_diet', kind: 'big', min: 35, max: 75, p: 0.25, when: (life) => !!(life.conditions && life.conditions.diabetes),
    fr: ["Un régime à suivre", "Votre médecin est clair : sans changer votre alimentation, le diabète va s'aggraver."],
    choices: [
      { k: 'diet', icon: '🥗', fr: "Suivre le régime", fx: { health: 4, money: -400, happy: -1 } },
      { k: 'half', icon: '🍽️', fr: "Faire de votre mieux", fx: { health: 1 } },
      { k: 'ignore', icon: '🍰', fr: "Ne rien changer", fx: { health: -6 } },
    ] },
  { id: 'de_screening', kind: 'big', min: 40, max: 65, p: 0.1, when: (l) => comfortable(5000)(l) && !(l.illness && l.illness.type === 'cancer'),   // pas de dépistage pour un cancer déjà diagnostiqué
    fr: ["Un dépistage", "On vous propose un dépistage du cancer. Rien ne vous fait mal, mais mieux vaut ne pas attendre les symptômes."],
    choices: [
      { k: 'go', icon: '🩺', fr: "Y aller", fx: { money: -150, health: 1, flag: ['screened', true] } },
      { k: 'skip', icon: '⏭️', fr: "Remettre à plus tard", fx: {} },
    ] },
  { id: 'de_vaccination', kind: 'small', min: 18, max: 70, p: 0.06, when: (life) => pppOf(life) < 15000 && !life.vaccinated,
    fr: ["Une campagne de vaccination", "Une équipe sanitaire s'installe sur la place du quartier. La file est longue."],
    choices: [
      { k: 'yes', icon: '💉', fr: "Faire la queue", fx: { flag: ['vaccinated', true], health: 1 } },
      { k: 'no', icon: '🙅', fr: "Vous n'avez pas le temps", fx: {} },
    ] },
  { id: 'de_bednet', kind: 'small', min: 18, max: 50, p: 0.12, when: (life) => (life.countryData?.mal || 0) > 0 && !life.bednet && pppOf(life) < 8000,
    fr: ["La moustiquaire", "Les moustiques sont venus en nombre avec la saison des pluies. Une moustiquaire traitée coûte l'équivalent de quelques jours de travail."],
    choices: [
      { k: 'buy', icon: '🛏️', fr: "En acheter une", fx: { pppx: -0.02, flag: ['bednet', true] } },
      { k: 'skip', icon: '🙅', fr: "Vous passer de moustiquaire", fx: {} },
    ] },
  { id: 'de_pilgrimage', kind: 'big', min: 40, max: 72, p: 0.08, when: (life) => isMuslim(life) && comfortable(6000)(life),
    fr: ["Le pèlerinage", "Depuis des années, vous rêvez de faire le pèlerinage à La Mecque. Il faut réunir une somme importante et partir plusieurs semaines."],
    choices: [
      { k: 'go', icon: '🕋', fr: "Partir cette année", fx: { pppx: -0.9, happy: 6, social: 3 } },
      { k: 'wait', icon: '⏳', fr: "Attendre encore", fx: {} },
    ] },
  { id: 'de_wedding', kind: 'family', min: 18, max: 60, p: 1, priority: true, when: (life) => life.stats.married && life.marriedAt != null && life.age - life.marriedAt <= 2 && !life.weddingDone,
    fr: ["La cérémonie", "Votre mariage approche. La famille a ses idées sur la fête, et sur son prix."],
    choices: [
      { k: 'big', icon: '🎊', fr: "Une grande fête", fx: { pppx: -0.5, social: 4, happy: 3, flag: ['weddingDone', true] } },
      { k: 'simple', icon: '🥂', fr: "Une cérémonie simple", fx: { pppx: -0.1, happy: 2, flag: ['weddingDone', true] } },
      { k: 'civil', icon: '📜', fr: "Seulement la mairie", fx: { pppx: -0.02, social: -1, flag: ['weddingDone', true] } },
    ] },
  { id: 'de_school_choice', kind: 'family', min: 28, max: 45, p: 0.15, when: (life) => hasKids(life) && comfortable(5000)(life),
    fr: ["Où scolariser votre enfant ?", "Votre enfant entre à l'école. L'établissement le plus proche n'a pas très bonne réputation."],
    choices: [
      { k: 'public', icon: '🏫', fr: "L'école publique du quartier", fx: { social: 2 } },
      { k: 'private', icon: '🎒', fr: "Une école privée, plus chère", fx: { pppx: -0.3, know: 1, happy: 1 } },
    ] },
  { id: 'de_second_job', kind: 'big', min: 22, max: 50, p: 0.08, when: (life) => isEmployed(life) && pppOf(life) < 15000,
    fr: ["Un second travail", "Votre salaire ne suffit plus. Un voisin propose de vous employer le week-end."],
    choices: [
      { k: 'yes', icon: '🛠️', fr: "Accepter", fx: { pppx: 0.2, health: -3, social: -2 } },
      { k: 'no', icon: '🏠', fr: "Refuser et serrer les dépenses", fx: { happy: -1 } },
    ] },
  { id: 'de_loan_shark', kind: 'big', min: 22, max: 55, p: 0.07, when: (life) => pppOf(life) < 8000 && quartOf(life) <= 2,
    fr: ["Un prêteur du quartier", "Il vous manque de l'argent pour un mois. Un prêteur du coin propose de vous avancer la somme, à un taux qui fait peur."],
    choices: [
      { k: 'take', icon: '🤝', fr: "Accepter le prêt", fx: () => roll([0.5, { pppx: 0.15, happy: -2 }], [0.5, { pppx: -0.1, happy: -5, social: -2, msg: { fr: "Les intérêts vous étranglent.", en: "The interest strangles you." } }]) },
      { k: 'family', icon: '👪', fr: "Demander à la famille", fx: { pppx: 0.05, social: -1 } },
      { k: 'refuse', icon: '✋', fr: "Vous débrouiller autrement", fx: { health: -1 } },
    ] },
  { id: 'de_microcredit', kind: 'big', min: 20, max: 50, p: 0.07, when: (life) => pppOf(life) < 8000 && reg('ssa', 'sa', 'lac')(life),
    fr: ["Un microcrédit", "Une association propose un petit prêt pour lancer un commerce, à rembourser par petites sommes."],
    choices: [
      { k: 'yes', icon: '🏪', fr: "Se lancer", fx: () => roll([0.6, { pppx: 0.25, happy: 3, msg: { fr: "Votre petit commerce marche.", en: "Your little business works." } }], [0.4, { pppx: -0.15, happy: -2, msg: { fr: "Le commerce peine à décoller.", en: "The business struggles." } }]) },
      { k: 'no', icon: '🙅', fr: "Ne pas s'endetter", fx: {} },
    ] },
  { id: 'de_nepotism', kind: 'big', min: 20, max: 38, p: 0.08, when: (life) => reg('lac', 'mena', 'sa', 'ssa')(life) && !isEmployed(life),
    fr: ["Un coup de pouce", "Un oncle bien placé peut vous faire entrer dans l'administration. Il faudra lui renvoyer l'ascenseur un jour."],
    choices: [
      { k: 'yes', icon: '🏛️', fr: "Accepter", fx: { pppx: 0.2, social: 2, happy: -1 } },
      { k: 'no', icon: '🧭', fr: "Chercher par vos propres moyens", fx: { happy: 1 } },
    ] },
  { id: 'de_bribe', kind: 'small', min: 20, max: 60, p: 0.07, when: bribery,
    fr: ["Un pot-de-vin", "Un fonctionnaire laisse entendre que votre dossier avancerait plus vite avec une petite enveloppe."],
    choices: [
      { k: 'pay', icon: '✉️', fr: "Payer", fx: { pppx: -0.02, happy: -1 } },
      { k: 'refuse', icon: '✋', fr: "Refuser et attendre", fx: { happy: -1, social: 1 } },
    ] },
  { id: 'de_land_dispute', kind: 'big', min: 20, max: 60, p: 0.06, when: (life) => isRural(life) && (life.countryData?.agr || 0) > 30,
    fr: ["Un différend de terrain", "Un voisin prétend que la limite de votre champ passe plus loin. La tension monte."],
    choices: [
      { k: 'elders', icon: '🧓', fr: "Faire appel aux anciens du village", fx: () => roll([0.7, { social: 2 }], [0.3, { social: -2, pppx: -0.05 }]) },
      { k: 'court', icon: '⚖️', fr: "Aller en justice", fx: () => roll([0.5, { pppx: -0.15, happy: 2 }], [0.5, { pppx: -0.25, happy: -3 }]) },
      { k: 'yield', icon: '🤷', fr: "Céder", fx: { pppx: -0.1, happy: -2 } },
    ] },
  { id: 'de_earthquake_repair', kind: 'big', min: 15, max: 75, p: 0.012, when: inList(...QUAKE),
    fr: ["Après la secousse", "Un séisme a fissuré un mur porteur de votre maison. Les réparations coûtent cher."],
    choices: [
      { k: 'repair', icon: '🧱', fr: "Réparer tout de suite", fx: { pppx: -0.3, happy: 1 } },
      { k: 'wait', icon: '⏳', fr: "Attendre de pouvoir payer", fx: () => roll([0.9, { happy: -2 }], [0.1, { health: -12, msg: { fr: "Le mur cède pendant une réplique.", en: "The wall gives way in an aftershock." } }]) },
    ] },
  { id: 'de_football_scout', kind: 'big', min: 14, max: 18, p: 0.05, when: (life) => life.sex === 'M' && reg('lac', 'ssa', 'eca')(life),
    fr: ["Un recruteur", "Un homme assis au bord du terrain vous a observé{e} toute l'après-midi. Il vous propose un essai dans un club."],
    choices: [
      { k: 'try', icon: '⚽', fr: "Tenter l'essai", fx: () => roll([0.08, { pppx: 1.0, happy: 6, edu: 'stop', msg: { fr: "Le club vous garde : vous deviendrez footballeur.", en: "The club keeps you: you will become a footballer." } }], [0.92, { happy: -2, know: -1, msg: { fr: "Ce n'était pas pour cette fois.", en: "It was not meant to be." } }]) },
      { k: 'school', icon: '📚', fr: "Rester concentré{e} sur l'école", fx: { know: 2 } },
    ] },
  { id: 'de_overtime', kind: 'big', min: 25, max: 50, p: 0.1, when: (life) => isEmployed(life) && inList(...OVERWORK)(life),
    fr: ["Les heures du soir", "Votre chef reste tard et chacun attend de voir qui partira le premier."],
    choices: [
      { k: 'stay', icon: '🕙', fr: "Rester comme les autres", fx: { pppx: 0.05, health: -3, happy: -2 } },
      { k: 'leave', icon: '🚪', fr: "Partir à l'heure", fx: { social: -3, happy: 2 } },
    ] },
  { id: 'de_exam', kind: 'big', min: 15, max: 18, p: 0.3, priority: true, when: (life) => reg('eap', 'sa')(life) && life.stats.education >= 2,
    fr: ["Le concours d'entrée", "Toute votre classe prépare le grand concours qui décidera des études supérieures."],
    choices: [
      { k: 'cram', icon: '📖', fr: "Réviser nuit et jour", fx: { know: 5, health: -3, happy: -3 } },
      { k: 'balance', icon: '⚖️', fr: "Garder du temps pour vous", fx: { know: 2, happy: 1 } },
    ] },
  { id: 'de_workplace_mockery', kind: 'big', min: 25, max: 60, p: 0.06, when: (life) => isEmployed(life) && pppOf(life) >= 8000,
    fr: ["Moqueries au travail", "Une personne de votre équipe est la cible de moqueries devant tout le monde, à cause de ses origines et de sa façon de parler."],
    choices: [
      { k: 'stop', icon: '✋', fr: "Leur dire d'arrêter", sub: () => "L'ambiance risque de devenir pesante", fx: { social: -1, happy: 2 } },
      { k: 'ignore', icon: '🙈', fr: "Faire semblant de ne rien voir", fx: { happy: -2 } },
    ] },
  { id: 'de_absent_father', kind: 'family', min: 30, max: 58, p: 0.15, when: (life) => { const par = (life.family && life.family.parents) || []; return par.length === 1 && par[0].sex === 'F'; },
    fr: ["Le père qui était parti", "Votre père, qui avait quitté la maison dans votre enfance, a repris contact. Il aimerait vous rencontrer, une fois."],
    choices: [
      { k: 'meet', icon: '🤝', fr: "Le rencontrer", fx: () => roll([0.5, { happy: 4, social: 2 }], [0.5, { happy: -3 }]) },
      { k: 'no', icon: '🚪', fr: "Ne pas le rencontrer", fx: { happy: -1 } },
    ] },
  { id: 'de_refugee_neighbour', kind: 'family', min: 20, max: 65, p: 0.05, when: (life) => pppOf(life) >= 8000 && heavyOk(),
    fr: ["Une famille s'installe à côté", "Une famille qui a fui un conflit vient d'emménager à côté de chez vous. Vous avez du mal à vous comprendre."],
    choices: [
      { k: 'meet', icon: '🍲', fr: "Apporter un plat et aller dire bonjour", fx: { social: 4, happy: 2 } },
      { k: 'distance', icon: '🙂', fr: "Garder une distance polie", fx: {} },
    ] },
  { id: 'de_naturalize', kind: 'big', min: 20, max: 80, p: 0.2, when: (life) => !!life.birthOrigin && life.migratedAt != null && life.age - life.migratedAt >= 5 && !life.naturalized,
    fr: ["Prendre la nationalité ?", (l) => "Vous vivez " + inCountry(l.countryData) + " depuis " + (l.age - l.migratedAt) + " ans. Après un examen et un serment, vous pourriez voter et obtenir un nouveau passeport."],
    choices: [
      { k: 'yes', icon: '🛂', fr: "Demander la naturalisation", fx: { pppx: -0.05, social: 3, happy: 3, flag: ['naturalized', true] } },
      { k: 'no', icon: '🙅', fr: "Ne pas la demander", fx: { flag: ['naturalized', true] } },
    ] },
  { id: 'de_remittance', kind: 'family', min: 22, max: 65, p: 0.1, when: (life) => !!life.birthOrigin,
    fr: ["La famille au pays", "Votre famille restée au pays vous écrit : la toiture de la maison cède et ils n'ont pas de quoi la refaire."],
    choices: [
      { k: 'send', icon: '💸', fr: "Envoyer une grosse somme", fx: { pppx: -0.1, social: 3, happy: 2 } },
      { k: 'some', icon: '✉️', fr: "Envoyer un peu", fx: { pppx: -0.03, social: 1 } },
      { k: 'no', icon: '🙅', fr: "Vous ne pouvez pas", fx: { happy: -3, social: -2 } },
    ] },
  { id: 'de_rent_rise', kind: 'small', min: 25, max: 65, p: 0.07, when: (life) => !isRural(life) && pppOf(life) >= 10000 && isEmployed(life),
    fr: ["Le loyer augmente", "Votre propriétaire annonce une hausse de loyer importante."],
    choices: [
      { k: 'accept', icon: '💶', fr: "Accepter", fx: { money: -1200 } },
      { k: 'negotiate', icon: '🗣️', fr: "Négocier", fx: () => roll([0.5, { money: -400 }], [0.5, { money: -1200, happy: -1 }]) },
      { k: 'move', icon: '📦', fr: "Déménager", fx: { money: -800, social: -2 } },
    ] },
  { id: 'de_elder_home', kind: 'family', min: 70, max: 90, p: 0.12, when: (life) => hasKids(life),
    fr: ["Vivre seul{e} ou avec vos enfants ?", "Vos forces déclinent. Vos enfants vous proposent de vivre chez eux."],
    choices: [
      { k: 'family', icon: '🏡', fr: "Emménager chez vos enfants", fx: { social: 5, happy: 3, health: 1 } },
      { k: 'alone', icon: '🔑', fr: "Rester chez vous, tant que vous le pouvez", fx: { happy: 1, social: -2 } },
    ] },
  { id: 'de_protest', kind: 'big', min: 18, max: 60, p: 0.05, when: (life) => heavyOk() && reg('lac', 'mena', 'eca', 'ssa', 'sa')(life),
    fr: ["La manifestation", "Une grande manifestation traverse votre ville. Des collègues vous proposent de vous y joindre."],
    choices: [
      { k: 'join', icon: '✊', fr: "Défiler avec eux", fx: () => roll([0.9, { social: 3, happy: 2 }], [0.1, { health: -6, social: 2, msg: { fr: "La manifestation dégénère, vous êtes blessé{e}.", en: "The march turns violent and you are hurt." } }]) },
      { k: 'home', icon: '🏠', fr: "Rester chez vous", fx: {} },
    ] },
  // ---- Santé et maladies du pays, violence, argent, famille, climat ----
  { id: 'de_hiv_test', kind: 'big', min: 18, max: 45, p: 0.12, when: (life) => (life.countryData?.hiv || 0) > 1 && !life.hivTested,
    fr: ["Faire le test du VIH ?", "Dans votre pays, le virus du sida est loin d'être rare. Un centre de santé propose un test gratuit et confidentiel."],
    choices: [
      { k: 'test', icon: '🩸', fr: "Faire le test", sub: () => "Savoir pour pouvoir se soigner",
        fx: (life) => roll([Math.min(0.5, (life.countryData.hiv || 0) / 100 * 2), { flag: ['hivPos', true], happy: -8, social: -2, msg: { fr: "Le test est positif. Un traitement existe, mais il faut s'y tenir toute la vie.", en: "The test is positive. A treatment exists, but it must be taken for life." } }],
                           [1, { flag: ['hivTested', true], happy: 2, msg: { fr: "Le test est négatif.", en: "The test is negative." } }]) },
      { k: 'no', icon: '🙈', fr: "Ne pas savoir", fx: { flag: ['hivTested', true] } },
    ] },
  { id: 'de_hiv_treatment', kind: 'big', min: 18, max: 70, p: 0.7, priority: true, when: (life) => !!life.hivPos && !life.hivTreated,
    fr: ["Un traitement à vie", "On vous propose un traitement antirétroviral. Il demande une prise chaque jour et un suivi régulier."],
    choices: [
      { k: 'treat', icon: '💊', fr: "Commencer le traitement", fx: { flag: ['hivTreated', true], pppx: -0.04, health: 3, msg: { fr: "Sous traitement, le virus devient indétectable.", en: "Under treatment, the virus becomes undetectable." } } },
      { k: 'later', icon: '⏳', fr: "Attendre", fx: { health: -4 } },
      { k: 'healer', icon: '🌿', fr: "Vous en remettre à un guérisseur", fx: { health: -6, pppx: -0.03 } },
    ] },
  { id: 'de_hypertension', kind: 'big', min: 40, max: 70, p: 0.1, when: (life) => !life.htnIgnored && !life.htnTreated,
    fr: ["Une tension trop haute", "Le médecin vous prescrit des médicaments et vous demande de manger moins salé."],
    choices: [
      { k: 'follow', icon: '💊', fr: "Suivre le traitement", fx: { health: 3, pppx: -0.02, flag: ['htnTreated', true] } },
      { k: 'ignore', icon: '🧂', fr: "Ne rien changer", fx: { flag: ['htnIgnored', true] } },
    ] },
  { id: 'de_weight', kind: 'big', min: 30, max: 60, p: 0.08, when: (life) => pppOf(life) > 20000,
    fr: ["Reprendre en main votre santé", "Vous avez pris dix kilos en quelques années. L'escalier vous essouffle."],
    choices: [
      { k: 'sport', icon: '🏃', fr: "Vous mettre au sport", fx: { health: 3, happy: 1, flag: ['sporty', true] } },
      { k: 'diet', icon: '🥗', fr: "Surveiller l'assiette", fx: { health: 2, money: -200 } },
      { k: 'no', icon: '🛋️', fr: "Vous n'y pensez pas", fx: { health: -3 } },
    ] },
  { id: 'de_gym', kind: 'small', min: 18, max: 55, p: 0.06, when: (life) => comfortable(8000)(life) && !life.sporty,
    fr: ["Un club de sport", "Un collègue vous propose de l'accompagner à son club de sport deux fois par semaine."],
    choices: [
      { k: 'yes', icon: '🏋️', fr: "S'inscrire", fx: { health: 2, social: 2, money: -300, flag: ['sporty', true] } },
      { k: 'no', icon: '🛋️', fr: "Garder vos soirées", fx: {} },
    ] },
  { id: 'de_car', kind: 'big', min: 22, max: 50, p: 0.08, when: (life) => isEmployed(life) && pppOf(life) >= 12000 && !life.hasCar,
    fr: ["Acheter une voiture ?", "Les transports en commun vous coûtent une bonne heure par trajet. Une voiture changerait votre quotidien, et votre budget."],
    choices: [
      { k: 'buy', icon: '🚗', fr: "L'acheter", fx: { money: -4000, happy: 2, flag: ['hasCar', true] } },
      { k: 'transit', icon: '🚌', fr: "Continuer en transports", fx: { happy: -1 } },
    ] },
  { id: 'de_motorbike', kind: 'big', min: 18, max: 45, p: 0.07, when: (life) => isEmployed(life) && (life.countryData?.road || 0) > 12 && pppOf(life) < 12000 && !life.hasMoto,
    fr: ["Une moto pour aller travailler", "Une moto d'occasion vous ferait gagner deux heures par jour. Elle expose aussi aux accidents."],
    choices: [
      { k: 'buy', icon: '🏍️', fr: "L'acheter", fx: { pppx: -0.35, happy: 2, flag: ['hasMoto', true] } },
      { k: 'no', icon: '🚶', fr: "Continuer à pied et en minibus", fx: {} },
    ] },
  { id: 'de_drunk_driving', kind: 'big', min: 18, max: 60, p: 0.05, when: (life) => !!life.drinker && pppOf(life) >= 5000,
    fr: ["Les clés en main", "La soirée a duré, vous avez bu et vous tenez vos clés."],
    choices: [
      { k: 'drive', icon: '🚗', fr: "Conduire quand même", fx: () => roll([0.02, { die: '事故', msg: { fr: "Vous sortez de la route.", en: "You leave the road." } }], [0.1, { health: -12, money: -800, msg: { fr: "Un accident vous envoie à l'hôpital.", en: "A crash sends you to hospital." } }], [0.88, { happy: -1 }]) },
      { k: 'taxi', icon: '🚕', fr: "Prendre un taxi", fx: { money: -40 } },
      { k: 'sleep', icon: '🛏️', fr: "Dormir sur place", fx: {} },
    ] },
  { id: 'de_gun_home', kind: 'big', min: 21, max: 60, p: 0.05, when: (life) => gunny(life) && heavyOk() && !life.gun,
    fr: ["Une arme à la maison ?", "Après des cambriolages dans le quartier, vos voisins parlent de s'armer. Une arme en vente libre est à votre portée."],
    choices: [
      { k: 'buy', icon: '🔫', fr: "En acheter une", fx: () => roll([0.9, { money: -400, happy: 1, flag: ['gun', true] }], [0.1, { money: -400, health: -10, flag: ['gun', true], msg: { fr: "Un coup part par accident : vous êtes blessé{e}.", en: "A shot goes off by accident and you are hurt." } }]) },
      { k: 'no', icon: '🚪', fr: "Renforcer la porte et les serrures", fx: { money: -150, happy: 1 } },
    ] },
  { id: 'de_extortion', kind: 'big', min: 22, max: 55, p: 0.08, when: (life) => heavyOk() && (life.countryData?.hom || 0) > 20 && pppOf(life) < 20000 && isEmployed(life),
    fr: ["La « taxe » du quartier", "Des hommes armés réclament chaque mois une somme pour vous laisser travailler."],
    choices: [
      { k: 'pay', icon: '💵', fr: "Payer", fx: { pppx: -0.06, happy: -2 } },
      { k: 'refuse', icon: '✋', fr: "Refuser", fx: () => roll([0.06, { die: '槍擊', msg: { fr: "Ils tiennent leurs menaces.", en: "They carry out their threats." } }], [0.3, { health: -8, pppx: -0.1, msg: { fr: "Ils vous passent à tabac et saccagent votre local.", en: "They beat you up and wreck your premises." } }], [0.64, { social: 1 }]) },
      { k: 'leave', icon: '🧳', fr: "Quitter le quartier", fx: { pppx: -0.2, social: -3 } },
    ] },
  { id: 'de_witness', kind: 'small', min: 18, max: 65, p: 0.06, when: (life) => heavyOk() && (life.countryData?.hom || 0) > 15,
    fr: ["Une agression sous vos yeux", "Dans la rue, un homme en frappe un autre. Personne ne bouge."],
    choices: [
      { k: 'step', icon: '✋', fr: "Intervenir", fx: () => roll([0.7, { social: 3, happy: 2 }], [0.25, { health: -8, social: 2 }], [0.05, { die: '他殺', msg: { fr: "L'agresseur était armé.", en: "The attacker was armed." } }]) },
      { k: 'call', icon: '📞', fr: "Appeler la police", fx: { social: 1 } },
      { k: 'away', icon: '🚶', fr: "Passer votre chemin", fx: { happy: -2 } },
    ] },
  { id: 'de_neighbourhood_watch', kind: 'small', min: 25, max: 65, p: 0.05, when: (life) => (life.countryData?.hom || 0) > 15,
    fr: ["La ronde du quartier", "Les voisins s'organisent pour surveiller la rue à tour de rôle, la nuit."],
    choices: [
      { k: 'join', icon: '🔦', fr: "Participer aux tours de garde", fx: { social: 3, health: -1 } },
      { k: 'no', icon: '🏠', fr: "Laisser les autres faire", fx: { social: -1 } },
    ] },
  { id: 'de_stall', kind: 'big', min: 20, max: 45, p: 0.1, when: (life) => !isEmployed(life) && poorish(life),
    fr: ["Un petit étal", "Faute d'emploi, un cousin vous propose de partager son étal au marché."],
    choices: [
      { k: 'yes', icon: '🧺', fr: "Vous lancer", fx: () => roll([0.7, { pppx: 0.15, happy: 2 }], [0.3, { pppx: -0.05, happy: -1 }]) },
      { k: 'wait', icon: '⏳', fr: "Attendre un vrai emploi", fx: { happy: -1 } },
    ] },
  { id: 'de_tontine', kind: 'small', min: 22, max: 60, p: 0.06, when: (life) => pppOf(life) < 12000 && reg('ssa', 'sa', 'mena', 'lac')(life),
    fr: ["Entrer dans une tontine", "Des voisins forment un groupe d'épargne : chaque mois, chacun verse la même somme et l'un d'eux la reçoit."],
    choices: [
      { k: 'join', icon: '🪙', fr: "Rejoindre le groupe", fx: () => roll([0.85, { pppx: 0.1, social: 2 }], [0.15, { pppx: -0.08, social: -2, msg: { fr: "Un membre disparaît avec la cagnotte.", en: "A member disappears with the pot." } }]) },
      { k: 'no', icon: '🙅', fr: "Garder votre argent", fx: {} },
    ] },
  { id: 'de_inflation_hedge', kind: 'big', min: 25, max: 60, p: 0.07, when: (life) => pppOf(life) < 15000 && life.stats.netAssets > 0,
    fr: ["Les prix flambent", "La monnaie perd de la valeur de mois en mois. Vos économies fondent."],
    choices: [
      { k: 'goods', icon: '🐄', fr: "Acheter du bétail, de l'or ou des matériaux", fx: () => roll([0.7, { pppx: 0.05 }], [0.3, { pppx: -0.08 }]) },
      { k: 'dollar', icon: '💵', fr: "Changer en devises fortes", fx: { pppx: 0.03 } },
      { k: 'keep', icon: '🏦', fr: "Laisser l'argent à la banque", fx: { pppx: -0.1, happy: -1 } },
    ] },
  { id: 'de_build_house', kind: 'big', min: 28, max: 55, p: 0.07, when: (life) => !life.ownsHome && !life.housing && reg('ssa', 'lac', 'sa', 'mena')(life) && pppOf(life) < 12000 && isEmployed(life),
    fr: ["Construire sa maison", "Comme beaucoup autour de vous, vous pourriez construire votre maison brique après brique, au fil des salaires."],
    choices: [
      { k: 'build', icon: '🧱', fr: "Commencer les travaux", fx: { pppx: -0.5, happy: 3, flag: ['ownsHome', true] } },
      { k: 'rent', icon: '🔑', fr: "Rester locataire", fx: {} },
    ] },
  { id: 'de_funeral_cost', kind: 'family', min: 30, max: 70, p: 0.07, when: (life) => reg('ssa', 'lac', 'sa', 'mena')(life),
    fr: ["Les frais des obsèques", "Un parent âgé est mort. La famille attend que chacun participe aux frais, et aux trois jours de cérémonie."],
    choices: [
      { k: 'big', icon: '⚰️', fr: "Participer largement", fx: { pppx: -0.12, social: 4 } },
      { k: 'small', icon: '✉️', fr: "Donner ce que vous pouvez", fx: { pppx: -0.04, social: 1 } },
      { k: 'none', icon: '🙅', fr: "Ne pas participer", fx: { social: -5 } },
    ] },
  { id: 'de_gulf_job', kind: 'big', min: 20, max: 40, p: 0.07, when: (life) => pppOf(life) < 6000 && reg('sa', 'ssa', 'eap')(life) && !life.birthOrigin,
    fr: ["Un contrat dans le Golfe", "Un recruteur propose un travail dans un pays du Golfe, avec un salaire trois fois supérieur à celui d'ici. Il réclame des frais d'agence."],
    choices: [
      { k: 'go', icon: '✈️', fr: "Payer les frais et partir", fx: () => roll([0.6, { pppx: 0.6, social: -3, msg: { fr: "Vous rentrez deux ans plus tard avec des économies.", en: "You come home two years later with savings." } }], [0.3, { pppx: -0.2, happy: -4, msg: { fr: "Le contrat n'est pas respecté : vous rentrez sans rien.", en: "The contract is not honoured: you come home with nothing." } }], [0.1, { pppx: -0.2, health: -8, happy: -5, msg: { fr: "Votre passeport est confisqué et les conditions sont très dures.", en: "Your passport is confiscated and conditions are harsh." } }]) },
      { k: 'stay', icon: '🏡', fr: "Refuser", fx: {} },
    ] },
  { id: 'de_child_fees', kind: 'family', min: 28, max: 45, p: 0.1, when: (life) => hasKids(life) && pppOf(life) < 5000,
    fr: ["Les frais de scolarité", "Votre enfant est en âge d'aller à l'école. Les frais, l'uniforme et les fournitures dépassent ce que vous gagnez en un mois."],
    choices: [
      { k: 'school', icon: '🎒', fr: "Payer, en vous serrant la ceinture", fx: { pppx: -0.15, happy: 1 } },
      { k: 'work', icon: '🧺', fr: "Le faire travailler avec vous", fx: { pppx: 0.05, happy: -3 } },
    ] },
  { id: 'de_child_vaccines', kind: 'family', min: 22, max: 40, p: 0.1, when: (life) => hasKids(life) && pppOf(life) < 15000,
    fr: ["Les vaccins de votre enfant", "Le centre de santé est à une demi-journée de marche. Le calendrier de vaccination n'attend pas."],
    choices: [
      { k: 'go', icon: '💉', fr: "Faire le trajet", fx: { pppx: -0.01, health: 1 } },
      { k: 'skip', icon: '⏭️', fr: "Remettre à plus tard", fx: () => roll([0.9, {}], [0.1, { happy: -6, health: -3, msg: { fr: "Votre enfant tombe gravement malade.", en: "Your child falls seriously ill." } }]) },
    ] },
  { id: 'de_retirement_savings', kind: 'big', min: 30, max: 50, p: 0.08, when: (life) => pppOf(life) >= 15000 && !life.retireSaver && isEmployed(life),
    fr: ["Préparer la retraite", "Un conseiller vous explique qu'une épargne régulière dès maintenant changerait beaucoup de choses plus tard."],
    choices: [
      { k: 'save', icon: '🏦', fr: "Mettre de l'argent de côté chaque mois", fx: { pppx: -0.08, flag: ['retireSaver', true] } },
      { k: 'later', icon: '⏳', fr: "Y penser plus tard", fx: {} },
    ] },
  { id: 'de_wildfire', kind: 'big', min: 18, max: 70, p: 0.02, when: inList(...FIRE),
    fr: ["Un incendie approche", "Les flammes progressent vers votre quartier. Les autorités appellent à évacuer."],
    choices: [
      { k: 'leave', icon: '🚗', fr: "Évacuer tout de suite", fx: { money: -300, happy: -1 } },
      { k: 'stay', icon: '🏠', fr: "Rester défendre la maison", fx: () => roll([0.85, { money: -500, health: -3 }], [0.15, { health: -15, money: -2000 }]) },
    ] },
  { id: 'de_drought', kind: 'big', min: 18, max: 65, p: 0.06, when: (life) => isRural(life) && reg('ssa', 'sa')(life) && (life.countryData?.agr || 0) > 20,
    fr: ["La sécheresse", "La pluie n'est pas venue pour la deuxième année. Il faut décider quoi faire des bêtes et des champs."],
    choices: [
      { k: 'sell', icon: '🐄', fr: "Vendre une partie du troupeau", fx: { pppx: -0.1, happy: -2 } },
      { k: 'migrate', icon: '🧳', fr: "Partir travailler en ville quelques mois", fx: { pppx: 0.05, social: -3 } },
      { k: 'wait', icon: '🙏', fr: "Attendre la prochaine saison", fx: { health: -3, happy: -3 } },
    ] },
  { id: 'de_screens', kind: 'small', min: 14, max: 60, p: 0.05, when: online(60),
    fr: ["Moins d'écrans ?", "Vous passez de plus en plus d'heures sur votre téléphone, et vous dormez de moins en moins."],
    choices: [
      { k: 'cut', icon: '📵', fr: "Limiter votre temps d'écran", fx: { happy: 2, health: 1, social: 1 } },
      { k: 'keep', icon: '📱', fr: "Continuer comme avant", fx: { happy: -1, health: -1 } },
    ] },
  { id: 'de_retire_abroad', kind: 'big', min: 60, max: 70, p: 0.06, when: (life) => pppOf(life) >= 25000 && life.stats.employment === 'retired' && life.stats.netAssets > 0,
    fr: ["Une retraite au soleil", "Avec votre pension, la vie coûterait moitié moins cher dans un pays plus chaud, loin de vos proches."],
    choices: [
      { k: 'go', icon: '🏝️', fr: "Partir", fx: { money: 3000, happy: 2, social: -5, health: 1 } },
      { k: 'stay', icon: '🏡', fr: "Rester près des vôtres", fx: { social: 2 } },
    ] },
  { id: 'de_gap_year', kind: 'big', min: 18, max: 26, p: 0.06, when: (life) => comfortable(15000)(life) && !isEmployed(life),
    fr: ["Une année pour voyager", "Entre deux étapes, vous pourriez prendre une année pour voyager, avec un petit budget."],
    choices: [
      { k: 'go', icon: '🌍', fr: "Partir", fx: { money: -2500, happy: 5, know: 2, social: -1 } },
      { k: 'no', icon: '📘', fr: "Enchaîner directement", fx: {} },
    ] },
  // ---- Suites : maladie diagnostiquée, échec à l'université ----
  { id: 'de_illness_followup', kind: 'big', min: 18, max: 90, p: 1, priority: true, when: (l) => illActive(l),
    fr: [(l) => ({ cancer: "Face au cancer", heart: "Un cœur fragile", stroke: "Après l'AVC", diabetes: "Vivre avec le diabète" })[l.illness.type],
         (l) => { const c = l.countryData || {}, o = Math.round(c.oop ?? 30); const acc = illnessAccess(c);
           return "Dans votre pays, " + o + " % des dépenses de santé restent à la charge des ménages, et les soins spécialisés sont " + (acc >= 0.8 ? "faciles à obtenir." : acc >= 0.6 ? "assez difficiles à obtenir." : "très difficiles à obtenir, loin de chez vous.") + " Comment voulez-vous vous soigner ?"; }],
    choices: (life) => [
      { k: 'full', icon: '🏥', fr: "Suivre le traitement complet", sub: (l) => "Environ " + money(illnessCost(l, 'full')) + " par an", fx: { illTreat: 'full', health: 1 } },
      { k: 'partial', icon: '💊', fr: "Se limiter aux soins essentiels", sub: (l) => "Environ " + money(illnessCost(l, 'partial')) + " par an · moins de chances", fx: { illTreat: 'partial' } },
      { k: 'none', icon: '🕯️', fr: "Renoncer au traitement", sub: () => "La maladie suivra son cours", fx: { illTreat: 'none' } },
    ] },
  { id: 'de_univ_failed', kind: 'big', min: 20, max: 28, p: 1, priority: true, when: (l) => !!(l.univ && l.univ.status === 'failed' && !l.univAsked),
    fr: ["Un échec difficile", "Vous n'avez pas obtenu votre diplôme. Vos parents et vos amis attendent de savoir ce que vous allez faire."],
    choices: [
      { k: 'retry', icon: '📚', fr: "Retenter votre chance l'année suivante", sub: () => "Une année de plus, sans revenu", fx: { univRetry: true, money: -1000, happy: -2 } },
      { k: 'work', icon: '💼', fr: "Chercher du travail", sub: () => "Un emploi sans le diplôme visé", fx: { univWork: true } },
    ] },
];
/* ==== Logement, transport, bétail : coûts exprimés en multiples du revenu moyen du pays (PPA) ==== */
const priceTxt = (life, mult) => money(mult * pppOf(life) / moneyScale(life)) + ' (aux prix français)';
const HERD = {
  goat:  { fr: 'chèvres', icon: '🐐', cost: 0.06, inc: 0.05, why: "Les chèvres se reproduisent vite, donnent du lait et se vendent en cas de coup dur : c'est une épargne vivante." },
  sheep: { fr: 'moutons', icon: '🐑', cost: 0.1, inc: 0.07, why: "Les moutons fournissent la laine, la viande et un capital qui grandit chaque année." },
  cow:   { fr: 'une vache', icon: '🐄', cost: 0.35, inc: 0.16, why: "Une vache donne du lait chaque jour, des veaux chaque année, et sert d'assurance quand la récolte échoue." },
  buffalo: { fr: 'une bufflonne', icon: '🐃', cost: 0.4, inc: 0.18, why: "Le lait de bufflonne est très recherché et ses veaux se vendent bien ; elle travaille aussi les champs." },
  camel: { fr: 'un dromadaire', icon: '🐪', cost: 0.9, inc: 0.25, why: "Un dromadaire supporte la sécheresse, porte les charges et donne du lait là où presque rien d'autre ne survit." },
  yak:   { fr: 'des yaks', icon: '🐂', cost: 0.3, inc: 0.14, why: "Les yaks donnent lait, laine et viande en altitude, là où les autres bêtes ne tiennent pas." },
};
const herdKinds = (life) => {
  const r = (life.countryData || {}).region;
  if (['MNG', 'NPL', 'BTN', 'KGZ', 'TJK'].includes(life.country)) return ['sheep', 'yak', 'goat'];
  if (['NER', 'MLI', 'TCD', 'SOM', 'MRT', 'DJI', 'SDN', 'ERI', 'KEN', 'ETH', 'SAU', 'EGY', 'MAR', 'DZA', 'LBY', 'YEM', 'OMN'].includes(life.country)) return ['camel', 'sheep', 'goat'];
  if (r === 'sa') return ['buffalo', 'goat', 'cow'];
  if (r === 'ssa') return ['goat', 'cow', 'sheep'];
  if (r === 'mena') return ['sheep', 'goat', 'camel'];
  if (r === 'lac') return ['cow', 'sheep', 'goat'];
  return ['goat', 'cow', 'sheep'];
};
const CYCLING = ['NLD', 'DNK', 'DEU', 'BEL', 'SWE', 'FIN', 'NOR', 'CHE', 'AUT', 'JPN', 'CHN'];
EXTRA_DECISIONS.push(
  { id: 'de_housing', kind: 'big', min: 24, max: 44, p: 0.14, priority: true, when: (life) => !life.housing && !life.ownsHome && isEmployed(life),
    fr: ["Où habiter ?", (life) => `Vous avez un revenu stable, et la question du logement se pose. Dans ce pays, un logement coûte en moyenne environ ${priceTxt(life, comfortable(15000)(life) ? 6 : 3)}.`],
    choices: (life) => {
      const rich = comfortable(15000)(life);
      const ch = [];
      if (rich) ch.push({ k: 'mortgage', icon: '🏡', fr: "Acheter avec un prêt sur 20 ans",
        sub: (l) => `Mensualités d'environ ${money(0.35 * pppOf(l) / moneyScale(l) / 12)} par mois · frais et travaux · stabilité`,
        fx: (l) => ({ pppx: -0.3, happy: 3, social: 1, flag: ['housing', { type: 'mortgage', annual: 0.35 * pppOf(l), end: l.age + 20 }] }) });
      else ch.push({ k: 'build', icon: '🧱', fr: "Construire petit à petit sur un terrain de la famille",
        sub: (l) => `Environ ${priceTxt(l, 1.5)}, étalé sur plusieurs années · on y est chez soi`,
        fx: { pppx: -0.6, happy: 3, social: 1, flag: ['housing', { type: 'own' }] } });
      ch.push({ k: 'rent', icon: '🔑', fr: "Rester locataire",
        sub: (l) => `Loyer d'environ ${money(0.25 * pppOf(l) / moneyScale(l) / 12)} par mois · aucune mise de départ · mais on ne possède rien`,
        fx: { happy: 0, flag: ['housing', { type: 'rent' }] } });
      ch.push({ k: 'family', icon: '👨‍👩‍👧', fr: "Rester chez vos parents ou en colocation",
        sub: () => "Très économique, mais moins d'intimité",
        fx: { social: 2, happy: -2, pppx: 0.05, flag: ['housing', { type: 'family' }] } });
      return ch;
    } },
  { id: 'de_bike', kind: 'small', min: 12, max: 45, p: 0.1, when: (life) => !life.hasBike && (poorish(life) || CYCLING.includes(life.country)),
    fr: [(life) => poorish(life) ? "Un vélo pour aller plus loin" : "Le vélo au quotidien", (life) => poorish(life) ? "Le travail, l'école et le marché sont à plusieurs kilomètres. Un vélo coûte cher, mais il changerait vos journées." : "Ici, beaucoup de gens se rendent au travail à vélo : c'est rapide en ville, bon pour la santé et peu coûteux."],
    choices: [
      { k: 'buy', icon: '🚲', fr: "L'acheter", sub: (l) => `${priceTxt(l, poorish(l) ? 0.05 : 0.02)} · santé et gain de temps`, fx: (l) => ({ pppx: poorish(l) ? -0.05 : -0.02, health: 2, happy: 1, flag: ['hasBike', true] }) },
      { k: 'no', icon: '🚶', fr: "Continuer à pied", sub: () => "Rien à payer, mais plus de temps perdu", fx: {} },
    ] },
  { id: 'de_livestock', kind: 'big', min: 18, max: 55, p: 0.14, priority: true, when: (life) => !life.herd && pppOf(life) < 22000 && ['ssa', 'sa', 'mena', 'lac', 'eap', 'eca'].includes(life.countryData?.region) && (life.stats.birthPlaceType === 'rural' || (life.countryData?.agr || 0) > 35),
    fr: ["Acheter du bétail ?", "Dans votre région, beaucoup de familles placent leurs économies dans des bêtes plutôt qu'à la banque : un troupeau grandit tout seul, se vend en cas de besoin et fournit du lait ou de la laine."],
    choices: (life) => herdKinds(life).map(k => ({ k, icon: HERD[k].icon, fr: 'Acheter ' + (/^(une?|des) /.test(HERD[k].fr) ? HERD[k].fr : 'quelques ' + HERD[k].fr),
      sub: (l) => `${priceTxt(l, HERD[k].cost)} · ${HERD[k].why}`,
      fx: { pppx: -HERD[k].cost * 0.1, happy: 1, flag: ['herd', { type: k, since: null }] } })).concat([{ k: 'no', icon: '💰', fr: "Garder l'argent", sub: () => "Pas de risque de maladie ou de sécheresse, mais l'argent perd de la valeur avec l'inflation", fx: {} }]) },
);
EXTRA_DECISIONS.push(
  { id: 'de_path_18', kind: 'big', min: 17, max: 19, p: 0.9, priority: true, when: (l) => !l.pathChosen && l.stats.education <= 3,
    fr: ["Quelle voie choisir ?", "Vous avez fini le lycée ou vous en êtes sorti. Chacun autour de vous a un avis sur ce qu'il faut faire."],
    choices: (l) => [
      { k: 'work', icon: '💼', fr: "Chercher du travail tout de suite", sub: () => "Un revenu rapidement, mais moins de diplôme", fx: { pppx: 0.05, happy: 1, flag: ['pathChosen', true] } },
      { k: 'trade', icon: '🛠️', fr: "Apprendre un métier", sub: (l2) => `Formation courte pour un revenu stable · coût ${priceTxt(l2, 0.1)}`, fx: { pppx: -0.1, know: 3, flag: ['trained', true] } },
      ...(comfortable(8000)(l) ? [{ k: 'uni', icon: '🎓', fr: "Viser l'université", sub: () => "Trois ou quatre ans de plus, et de meilleurs revenus ensuite", fx: { eduUp: 4, know: 4, flag: ['pathChosen', true] } }] : []),
    ] },
  { id: 'de_parent_decline', kind: 'family', min: 45, max: 65, p: 0.15, repeat: false, when: (l) => motherAlive(l) || fatherAlive(l),
    fr: ["Un parent qui décline", "Votre parent a de plus en plus de mal à vivre seul. Il faut décider qui s'en occupe, et à quel prix."],
    choices: (l) => [
      { k: 'home', icon: '🏠', fr: "L'accueillir chez vous", sub: () => "Plus de présence, moins d'argent et d'intimité", fx: { social: 3, happy: 1, pppx: -0.05, flag: ['housedParent', true] } },
      { k: 'visit', icon: '🚶', fr: "Passer le voir tous les jours", sub: () => "Du temps et de la fatigue", fx: { social: 2, health: -2 } },
      ...(comfortable(12000)(l) ? [{ k: 'care', icon: '🏥', fr: "Payer une aide ou une maison de retraite", sub: (l2) => `Environ ${priceTxt(l2, 0.4)} par an`, fx: { pppx: -0.4, happy: -1 } }] : []),
    ] },
  { id: 'de_midlife', kind: 'big', min: 38, max: 50, p: 0.12, when: (l) => isEmployed(l),
    fr: ["Un tournant à la quarantaine", "Vous regardez où vous en êtes. Le travail, les proches, les rêves d'avant : quelque chose doit peut-être changer."],
    choices: [
      { k: 'stay', icon: '⚓', fr: "Rester sur la même voie", sub: () => "Stabilité, mais peut-être des regrets", fx: { happy: 0 } },
      { k: 'change', icon: '🧭', fr: "Changer de métier", sub: () => "Un risque de revenu, une chance de s'épanouir", fx: () => roll([0.6, { happy: 6, pppx: -0.1, know: 3 }], [0.4, { happy: -3, pppx: -0.3 }]) },
      { k: 'family', icon: '👪', fr: "Passer plus de temps avec vos proches", sub: () => "Moins de revenu mais plus de liens", fx: { social: 4, happy: 3, pppx: -0.05 } },
    ] },
  { id: 'de_retire_plan', kind: 'big', min: 50, max: 66, p: 0.16, when: (l) => isEmployed(l) && !l.retirePlanned && hasPension(l) && l.age >= retireAge(l) - 4 && l.age < retireAge(l),
    fr: ["Préparer la retraite", (l) => `Dans ce pays, l'âge légal de la retraite est de ${retireAge(l)} ans : il vous en reste ${retireAge(l) - l.age}. Le moment de regarder ce qu'on a mis de côté.`],
    choices: [
      { k: 'save', icon: '💰', fr: "Mettre le maximum de côté", sub: () => "Une retraite plus confortable", fx: { pppx: 0.05, happy: -1, flag: ['retireSaver', true] } },
      { k: 'enjoy', icon: '🌴', fr: "Profiter de ces années", sub: () => "Des souvenirs maintenant, une pension plus modeste", fx: { pppx: -0.1, happy: 3 } },
      { k: 'work', icon: '⏳', fr: "Travailler le plus longtemps possible", sub: () => "Un meilleur revenu mais moins de repos", fx: { pppx: 0.1, health: -2 } },
    ] },
);
EXTRA_DECISIONS.push(
  { id: 'de_fin_savings', kind: 'big', min: 20, max: 45, p: 0.12, when: (l) => isEmployed(l) && !l.savingsPlan,
    fr: ["Où mettre vos économies ?", (l) => reg('ssa', 'sa', 'eap', 'lac')(l) && poorish(l) ? "Quelques économies commencent à s'accumuler. Autour de vous, beaucoup se méfient des banques : on se confie à une tontine, à un cercle d'épargne ou au téléphone." : "Quelques économies commencent à s'accumuler. Autant décider tout de suite où elles dormiront."],
    choices: (l) => {
      const poorReg = reg('ssa', 'sa', 'eap', 'lac')(l) && poorish(l);
      const ch = [];
      if (poorReg) ch.push({ k: 'tontine', icon: '🤝', fr: "Rejoindre une tontine avec des voisins", sub: () => "Chacun verse chaque mois, chacun reçoit la cagnotte à son tour · solide si le groupe est sérieux", fx: () => roll([0.85, { social: 3, pppx: 0.06, flag: ['savingsPlan', true] }], [0.15, { social: -2, pppx: -0.08, msg: { fr: "Le trésorier a disparu avec la cagnotte.", en: "The treasurer vanished with the pot." }, flag: ['savingsPlan', true] }]) });
      else ch.push({ k: 'account', icon: '🏦', fr: "Ouvrir un compte d'épargne", sub: () => "Peu de rendement mais aucun risque", fx: { pppx: 0.05, flag: ['savingsPlan', true] } });
      if (reg('ssa')(l) || l.country === 'IND') ch.push({ k: 'mobile', icon: '📱', fr: "Garder l'argent sur votre téléphone", sub: () => "Pratique pour envoyer à la famille · quelques frais", fx: { pppx: 0.03, flag: ['savingsPlan', true] } });
      ch.push({ k: 'cash', icon: '🧦', fr: "Garder l'argent à la maison", sub: () => "Toujours disponible, mais l'inflation le ronge et le vol est possible", fx: () => roll([0.8, { flag: ['savingsPlan', true] }], [0.2, { pppx: -0.1, happy: -3, msg: { fr: "Une partie de vos économies disparaît lors d'un cambriolage.", en: "Part of your savings is stolen." }, flag: ['savingsPlan', true] }]) });
      return ch;
    } },
  { id: 'de_fin_insurance', kind: 'big', min: 25, max: 55, p: 0.1, when: (l) => isEmployed(l) && !l.insured && pppOf(l) >= 6000,
    fr: ["Une assurance santé ?", (l) => `Un agent vous propose une assurance qui rembourserait une partie des soins. Elle coûte environ ${priceTxt(l, 0.025)} par an.`],
    choices: [
      { k: 'yes', icon: '🛡️', fr: "La souscrire", sub: () => "Moins de frais en cas de maladie, mais une dépense chaque année", fx: { flag: ['insured', true], happy: 1 } },
      { k: 'no', icon: '🎲', fr: "Prendre le risque", sub: () => "Rien à payer maintenant, une facture lourde si vous tombez malade", fx: {} },
    ] },
  { id: 'de_fin_business', kind: 'big', min: 24, max: 52, p: 0.08, when: (l) => isEmployed(l) && !l.bizTried && l.stats.netAssets > 0,
    fr: ["Se mettre à son compte ?", "Une occasion se présente de monter votre propre petite affaire : un commerce, un atelier, un service. Vous y mettriez vos économies."],
    choices: [
      { k: 'go', icon: '🏪', fr: "Se lancer", sub: (l) => `Mise de départ d'environ ${priceTxt(l, 0.5)} · risque réel d'échec`, fx: () => roll([0.35, { pppx: 0.8, happy: 5, flag: ['bizTried', true], msg: { fr: "L'affaire marche : vos revenus dépassent ceux d'un salaire.", en: "The business works and beats a salary." } }], [0.65, { pppx: -0.5, happy: -4, flag: ['bizTried', true], msg: { fr: "L'affaire ne décolle pas et vous fermez au bout d'un an, en perdant votre mise.", en: "The business fails and you lose your stake." } }]) },
      { k: 'stay', icon: '💼', fr: "Garder votre emploi", sub: () => "Un revenu régulier, sans risque", fx: { flag: ['bizTried', true] } },
    ] },
  { id: 'de_fin_debt', kind: 'big', min: 22, max: 70, p: 0.35, repeat: true, when: (l) => l.stats.netAssets < -0.3 * pppOf(l) && l.age - (l.lastDebtAsk || -9) > 6,
    fr: ["Les dettes s'accumulent", "Les remboursements s'empilent et les fins de mois deviennent difficiles. Il faut trouver une issue."],
    choices: [
      { k: 'family', icon: '🫂', fr: "Demander de l'aide à la famille", sub: () => "Cela allège la dette, mais pèse sur les relations", fx: (l) => ({ pppx: 0.25, social: -3, flag: ['lastDebtAsk', l.age] }) },
      { k: 'work', icon: '🕰️', fr: "Prendre un travail en plus", sub: () => "Du revenu en plus, de la fatigue aussi", fx: (l) => ({ pppx: 0.2, health: -4, flag: ['lastDebtAsk', l.age] }) },
      { k: 'cut', icon: '✂️', fr: "Réduire fortement vos dépenses", sub: () => "Rien de superflu pendant quelques années", fx: (l) => ({ pppx: 0.12, happy: -3, flag: ['lastDebtAsk', l.age] }) },
    ] },
  { id: 'de_fin_remit', kind: 'family', min: 22, max: 60, p: 0.18, when: (l) => !!l.birthOrigin && !l.remitAsked,
    fr: ["Envoyer de l'argent au pays", "Votre famille, restée là-bas, compte sur vous : une toiture, des frais d'école, des soins. Les transferts des migrants font vivre des villages entiers."],
    choices: [
      { k: 'much', icon: '💸', fr: "Envoyer une part importante de votre salaire", sub: (l) => `Environ ${priceTxt(l, 0.2)} · vos proches vivent mieux`, fx: { pppx: -0.2, social: 4, happy: 2, flag: ['remitAsked', true] } },
      { k: 'some', icon: '✉️', fr: "Envoyer un peu, quand vous le pouvez", sub: () => "Un équilibre entre eux et vous", fx: { pppx: -0.06, social: 2, flag: ['remitAsked', true] } },
      { k: 'no', icon: '🔒', fr: "Garder l'argent pour vous", sub: () => "Plus d'économies, des reproches à distance", fx: { social: -4, flag: ['remitAsked', true] } },
    ] },
  { id: 'de_fin_school_fund', kind: 'family', min: 26, max: 45, p: 0.12, when: (l) => hasKids(l) && !l.schoolFund,
    fr: ["Mettre de côté pour les études", "Vos enfants grandissent. Les études coûtent, ici comme ailleurs, et mieux vaut y penser tôt."],
    choices: [
      { k: 'yes', icon: '🎒', fr: "Épargner chaque mois pour eux", sub: (l) => `Environ ${priceTxt(l, 0.08)} par an mis de côté`, fx: { pppx: -0.08, happy: 1, social: 1, flag: ['schoolFund', true] } },
      { k: 'no', icon: '🕰️', fr: "Voir plus tard", sub: () => "Moins de contraintes aujourd'hui", fx: { flag: ['schoolFund', true] } },
    ] },
  { id: 'de_fin_will', kind: 'family', min: 58, max: 78, p: 0.12, when: (l) => hasKids(l) && l.stats.netAssets > 0.5 * pppOf(l) && !l.willDone,
    fr: ["Organiser la transmission", "Vous avez de quoi laisser quelque chose à vos proches. Mieux vaut décider aujourd'hui que laisser les autres se disputer demain."],
    choices: [
      { k: 'equal', icon: '⚖️', fr: "Partager équitablement entre vos enfants", sub: () => "Moins de rancœur après vous", fx: { social: 3, happy: 2, flag: ['willDone', true] } },
      { k: 'give', icon: '🎁', fr: "Donner dès maintenant", sub: () => "Voir ses proches en profiter, mais moins de sécurité pour vous", fx: { pppx: -0.2, social: 4, happy: 3, flag: ['willDone', true] } },
      { k: 'keep', icon: '🏦', fr: "Tout garder", sub: () => "De la sécurité, des tensions possibles ensuite", fx: { flag: ['willDone', true] } },
    ] },
  { id: 'de_fin_pension', kind: 'big', min: 30, max: 52, p: 0.1, when: (l) => isEmployed(l) && !l.retireSaver && comfortable(8000)(l),
    fr: ["Un plan d'épargne retraite", "Votre conseiller vous parle d'un plan d'épargne pour la retraite. Vous y verseriez un peu chaque mois, bloqué jusqu'à vos vieux jours."],
    choices: [
      { k: 'yes', icon: '🌅', fr: "Y verser chaque mois", sub: (l) => `Environ ${priceTxt(l, 0.05)} par an · pension plus confortable`, fx: { pppx: -0.05, flag: ['retireSaver', true] } },
      { k: 'no', icon: '🎉', fr: "Profiter de l'argent maintenant", sub: () => "Plus de liberté aujourd'hui, une pension plus modeste demain", fx: { happy: 2 } },
    ] },
);
// ==== Enfants mineurs : un enfant à la fois, repéré par son âge et par les décisions déjà prises pour lui ====
const kidAge = (l, k) => l.age - k.bornAt;
const kidIdx = (l, a, b, key) => (l.stats.kids || []).findIndex(k => kidAge(l, k) >= a && kidAge(l, k) <= b && !(k.done || {})[key]);
const kidName = (l, i) => { const n = l.family && l.family.kids && l.family.kids[i]; return n && n.name ? n.name.split(' ')[0] : (LANG === 'fr' ? 'votre enfant' : 'your child'); };
const kidMark = (l, i, key, val) => { const k = l.stats.kids[i]; if (k) { (k.done || (k.done = {}))[key] = val || true; } };
const hasKidIn = (a, b, key) => (l) => kidIdx(l, a, b, key) >= 0;
// Une décision pour un enfant : le texte cite son prénom ; le choix est enregistré sur lui.
const kidDec = (id, a, b, key, p, title, body, choices, extra = {}) => ({
  id, kind: 'family', min: 18, max: 75, p, repeat: true, when: (l) => hasKidIn(a, b, key)(l) && (!extra.when || extra.when(l)),
  fr: [(l) => title(kidName(l, kidIdx(l, a, b, key)), l), (l) => body(kidName(l, kidIdx(l, a, b, key)), l)],
  choices: (l) => choices(l).map(c => ({ ...c, fx: (l2) => { const i = kidIdx(l2, a, b, key); kidMark(l2, i, key, c.k); const r = typeof c.fx === 'function' ? c.fx(l2) : c.fx; return r; } })),
});
function addChildNow(life) {
  const sex = Math.random() < 0.5 ? 'M' : 'F';
  life.stats.kids.push({ sex, bornAt: life.age });
  if (life.family) {
    (life.family.kids = life.family.kids || []).push({ id: 'k_' + Math.random().toString(36).slice(2, 8), name: randomName(life.countryData, sex, life.name.last).full || '?', sex, country: life.country, countryData: life.countryData, birth: { year: life.year + life.yearOffset }, death: null });
  }
  life.log.push({ age: life.age, kind: 'milestone', icon: '👶', text: t('event.baby', life.stats.kids.length) });
}
EXTRA_DECISIONS.push(
  { id: 'de_have_child', kind: 'family', min: 22, max: 40, p: 0.22, priority: true, when: (l) => (l.stats.married || l.stats.relationship === 'cohab') && !(l.stats.kids || []).length && !l.noKids,
    fr: ["Fonder une famille ?", (l) => `Vous et ${l.stats.partner && l.stats.partner.name && (l.stats.partner.name.first || '') || 'votre conjoint'} parlez de plus en plus d'avoir un enfant. Dans ce pays, une femme a en moyenne ${(l.countryData.tfr || 2).toFixed(1).replace('.', ',')} enfant(s).`],
    choices: [
      { k: 'yes', icon: '👶', fr: "Avoir un enfant", sub: () => "Une nouvelle vie, des dépenses et moins de sommeil", fx: { baby: true, happy: 4, pppx: -0.05 } },
      { k: 'wait', icon: '⏳', fr: "Attendre encore", sub: () => "Un peu de temps pour vous deux", fx: {} },
      { k: 'no', icon: '🧳', fr: "Ne pas en avoir", sub: () => "Plus de liberté, la question reviendra parfois", fx: { flag: ['noKids', true], happy: 1 } },
    ] },
  kidDec('de_kid_care', 0, 2, 'care', 0.5, (n) => `Qui garde ${n} ?`, (n, l) => `${n} est tout petit, et vous reprenez le travail. Il faut décider de la garde.`, (l) => [
    comfortable(15000)(l) ? { k: 'creche', icon: '🏫', fr: "Une crèche", sub: (l2) => `Environ ${priceTxt(l2, 0.12)} par an`, fx: { pppx: -0.12, social: 1, happy: 1 } } : { k: 'family', icon: '👵', fr: "La grand-mère ou une voisine", sub: () => "Gratuit, mais cela repose sur d'autres", fx: { social: 3 } },
    { k: 'home', icon: '🏠', fr: "L'un de vous reste à la maison", sub: () => "Du temps avec lui, un revenu en moins", fx: { pppx: -0.2, happy: 3, social: 1 } },
    { k: 'carry', icon: '🧺', fr: "L'emmener sur le lieu de travail", sub: () => "On se débrouille, la fatigue s'accumule", fx: { health: -2, happy: -1 } },
  ]),
  kidDec('de_kid_school', 5, 7, 'school', 0.6, (n) => `L'école de ${n}`, (n, l) => poorish(l) ? `${n} a l'âge d'entrer à l'école. Les frais, l'uniforme et les fournitures pèsent sur le budget, et il faut parfois marcher longtemps.` : `${n} entre en primaire. Vous hésitez entre l'école du quartier et une école plus exigeante.`, (l) => poorish(l) ? [
    { k: 'school', icon: '🎒', fr: "L'inscrire, quitte à se priver", sub: (l2) => `Environ ${priceTxt(l2, 0.06)} par an · de meilleures chances plus tard`, fx: { pppx: -0.06, happy: 2, social: 1 } },
    { k: 'late', icon: '⏳', fr: "Attendre un ou deux ans", sub: () => "Vous économisez maintenant, il rattrapera plus tard", fx: { pppx: 0.01, happy: -2 } },
  ] : [
    { k: 'public', icon: '🏫', fr: "L'école publique du quartier", sub: () => "Gratuite, proche, avec ses camarades du coin", fx: { social: 2 } },
    { k: 'private', icon: '🎓', fr: "Une école privée", sub: (l2) => `Environ ${priceTxt(l2, 0.1)} par an · plus d'exigence`, fx: { pppx: -0.1, happy: 1, know: 1 } },
  ]),
  kidDec('de_kid_hobby', 7, 12, 'hobby', 0.5, (n) => `Une activité pour ${n}`, (n) => `${n} cherche ce qui le passionne. Une activité le soir ou le week-end lui ferait du bien.`, (l) => [
    { k: 'sport', icon: '⚽', fr: "Un sport collectif", sub: (l2) => `Environ ${priceTxt(l2, 0.02)} par an · amis et énergie`, fx: { pppx: -0.02, happy: 2, social: 2 } },
    { k: 'music', icon: '🎵', fr: "La musique", sub: (l2) => `Environ ${priceTxt(l2, 0.04)} par an · du temps et de la patience`, fx: { pppx: -0.04, happy: 2, know: 1 } },
    { k: 'free', icon: '🌳', fr: "Jouer dehors, sans programme", sub: () => "Gratuit et libre", fx: { social: 1 } },
  ]),
  kidDec('de_kid_sick', 1, 12, 'sick', 0.35, (n) => `${n} est malade`, (n, l) => `${n} a une forte fièvre depuis deux jours. ${(l.countryData.oop || 30) > 30 ? "Ici, les soins se paient en grande partie de sa poche." : "Les soins sont en grande partie pris en charge."}`, (l) => [
    { k: 'doctor', icon: '🏥', fr: "L'emmener à l'hôpital", sub: (l2) => `Environ ${priceTxt(l2, 0.01 + (l2.countryData.oop || 30) / 1000)}`, fx: (l2) => ({ pppx: -(0.01 + (l2.countryData.oop || 30) / 1000), happy: 1 }) },
    { k: 'home', icon: '🍵', fr: "Le soigner à la maison", sub: () => "Moins cher, un peu risqué", fx: () => roll([0.85, { happy: 0 }], [0.15, { happy: -6, pppx: -0.05, msg: { fr: "L'état empire : vous finissez par l'emmener à l'hôpital, plus tard.", en: "He gets worse." } }]) },
  ]),
  kidDec('de_kid_work', 9, 14, 'work', 0.55, (n) => `Faut-il que ${n} travaille ?`, (n) => `L'argent manque à la maison. Des voisins proposent à ${n} de travailler dans les champs ou au marché.`, () => [
    { k: 'school', icon: '📚', fr: "Le garder à l'école", sub: () => "Moins d'argent aujourd'hui, un meilleur avenir", fx: { pppx: -0.03, happy: 2 } },
    { k: 'both', icon: '🌙', fr: "Travailler après la classe", sub: () => "Un petit revenu et de la fatigue", fx: { pppx: 0.04, happy: -2 } },
    { k: 'work', icon: '🧺', fr: "Le laisser travailler", sub: () => "Un vrai revenu, mais l'école s'arrête", fx: { pppx: 0.1, happy: -5, social: -2 } },
  ], { when: (l) => poorish(l) && quartOf(l) <= 2 }),
  kidDec('de_kid_screen', 10, 14, 'screen', 0.45, (n) => `Un téléphone pour ${n} ?`, (n) => `Tous les camarades de ${n} en ont un. L'insistance est forte, et vous hésitez.`, () => [
    { k: 'yes', icon: '📱', fr: "Lui en offrir un", sub: (l2) => `Environ ${priceTxt(l2, 0.03)} · lien avec ses amis, moins de contrôle`, fx: { pppx: -0.03, happy: 1 } },
    { k: 'later', icon: '⏳', fr: "Attendre encore", sub: () => "Des disputes, mais plus de temps pour lui", fx: { happy: -1, social: -1 } },
  ], { when: online(30) }),
  kidDec('de_kid_talk', 13, 17, 'talk', 0.5, (n) => `${n} rentre tard`, (n) => `${n} a passé la soirée dehors sans prévenir. Vous l'attendiez, inquiet(ète).`, () => [
    { k: 'talk', icon: '💬', fr: "Discuter calmement", sub: () => "Du temps et de l'écoute", fx: { social: 2, happy: 1 } },
    { k: 'strict', icon: '🚪', fr: "Fixer des règles strictes", sub: () => "Plus de sécurité, des tensions", fx: { happy: -2, social: -1 } },
    { k: 'let', icon: '🕊️', fr: "Faire confiance", sub: () => "Un peu d'inquiétude, plus de liberté", fx: () => roll([0.85, { social: 2 }], [0.15, { happy: -5, msg: { fr: "Une mauvaise rencontre vous donne des sueurs froides.", en: "A bad encounter gives you a scare." } }]) },
  ]),
  kidDec('de_kid_orient', 15, 17, 'orient', 0.6, (n) => `Quel avenir pour ${n} ?`, (n) => `${n} approche de la fin du secondaire. Il faut parler d'études, de métier, et de ce que vous pouvez payer.`, (l) => [
    { k: 'uni', icon: '🎓', fr: "L'encourager à poursuivre ses études", sub: (l2) => `Environ ${priceTxt(l2, 0.2)} par an · de meilleures perspectives`, fx: { pppx: -0.2, happy: 2, social: 1 } },
    { k: 'trade', icon: '🛠️', fr: "L'orienter vers un métier", sub: (l2) => `Environ ${priceTxt(l2, 0.08)} · un revenu plus tôt`, fx: { pppx: -0.08, happy: 1 } },
    { k: 'free', icon: '🧭', fr: "Le laisser choisir seul", sub: () => "Il décidera à sa manière", fx: { social: 2 } },
  ]),
);
// ==== Retraite : âge légal et couverture propres à chaque pays ====
const RETIRE_AGE = { FRA: [64, 64], DEU: [67, 67], ITA: [67, 67], ESP: [66, 66], GBR: [66, 66], USA: [67, 67], JPN: [65, 65], KOR: [63, 63], CHN: [60, 55], RUS: [63, 58], BRA: [65, 62], IND: [60, 60], NLD: [67, 67], SWE: [65, 65], NOR: [67, 67], DNK: [67, 67], CHE: [65, 64], BEL: [66, 66], POL: [65, 60], TUR: [60, 58], MEX: [65, 65], ARG: [65, 60], COL: [62, 57], CHL: [65, 60], EGY: [60, 60], SAU: [60, 60], IRN: [60, 55], ZAF: [60, 60], NGA: [60, 60], IDN: [58, 58], VNM: [60, 55], THA: [60, 60], PHL: [60, 60], PAK: [60, 60], BGD: [60, 60], AUS: [67, 67], CAN: [65, 65], PRT: [66, 66], GRC: [62, 62], ISR: [67, 62] };
const retireAge = (l) => { const a = RETIRE_AGE[l.country]; if (a) return a[l.sex === 'F' ? 1 : 0]; const r = l.countryData?.region; return r === 'hi' ? 65 : r === 'eca' ? 62 : r === 'lac' ? 62 : 60; };
// Part de la population qui touche une pension : emplois déclarés, caisse de retraite ; très faible là où le travail est informel.
const pensionCoverage = (c) => Math.max(0.03, Math.min(1, ((c.ppp || 12000) - 3000) / 30000)) * (1 - Math.min(0.4, (c.agr || 0) / 100));
function hasPension(l) {
  if (l.pensionRight === undefined) {
    const q = [0.5, 0.8, 1.1, 1.3][(l.stats.incomeQuartile || 2) - 1];
    const cov = pensionCoverage(l.countryData || {});
    l.pensionRight = Math.random() < (cov >= 0.8 ? 0.97 : Math.min(1, cov * q * (l.stats.birthPlaceType === 'rural' ? 0.6 : 1) * (l.stats.education >= 4 ? 1.3 : 1)));
  }
  return l.pensionRight;
}
EXTRA_DECISIONS.push(
  { id: 'de_no_pension', kind: 'big', min: 52, max: 70, p: 0.2, when: (l) => isEmployed(l) && !hasPension(l) && l.age >= retireAge(l) - 6 && !l.noPensionAsked,
    fr: ["Pas de retraite en vue", (l) => `Dans votre situation, personne ne vous versera de pension : ${pppOf(l) < 8000 ? "la retraite n'existe presque pas pour les travailleurs non déclarés" : "vos années travaillées ne vous ouvrent pas de droits"}. Il faut préparer ce qui viendra.`],
    choices: (l) => [
      { k: 'work', icon: '⚒️', fr: "Travailler aussi longtemps que possible", sub: () => "Un revenu qui baisse avec l'âge et la fatigue", fx: { pppx: 0.05, health: -3, flag: ['noPensionAsked', true] } },
      { k: 'kids', icon: '👨‍👩‍👧', fr: "Compter sur vos enfants", sub: (l2) => (l2.stats.kids || []).length ? "Ils vous aideront, au prix de tensions possibles" : "Vous n'avez pas d'enfant : ce sera difficile", fx: (l2) => (l2.stats.kids || []).length ? { social: 3, happy: 1, flag: ['noPensionAsked', true] } : { happy: -4, flag: ['noPensionAsked', true] } },
      { k: 'save', icon: '🐐', fr: "Mettre de côté ce que vous pouvez (bétail, terre, or)", sub: () => "Un petit capital pour les vieux jours", fx: { pppx: -0.05, happy: 1, flag: ['noPensionAsked', true] } },
    ] },
);
// ==== Décisions du cœur : des proches en jeu, 3 ou 4 voies, des suites durables ====
EXTRA_DECISIONS.push(
  { id: 'de_friend_crisis', kind: 'family', min: 22, max: 65, p: 0.1, when: (l) => hasFriends(l) && !l.friendCrisis,
    fr: ["{ami1} ne va pas bien", "{ami1} ne donne plus de nouvelles depuis quelques semaines. Quand vous vous voyez enfin, vous lui trouvez les yeux creux, et son « tout va bien » sonne faux."],
    choices: [
      { k: 'stay', icon: '🫂', fr: "Tout laisser pour être là", sub: () => "Du temps, de la fatigue, un lien qui peut devenir indestructible", fx: { social: 5, happy: 2, health: -2, flag: ['friendCrisis', true] } },
      { k: 'help', icon: '💶', fr: "L'aider financièrement", sub: (l) => `Environ ${priceTxt(l, 0.06)} · cela soulage, mais ne règle pas tout`, fx: { pppx: -0.06, social: 3, flag: ['friendCrisis', true] } },
      { k: 'listen', icon: '☎️', fr: "Rester disponible, sans le brusquer", sub: () => "Un appel de temps en temps", fx: { social: 2, flag: ['friendCrisis', true] } },
      { k: 'away', icon: '🚪', fr: "Prendre vos distances", sub: () => "Vous protégez votre tranquillité, au prix d'un regret possible", fx: { social: -4, happy: -2, flag: ['friendCrisis', true] } },
    ] },
  { id: 'de_partner_move', kind: 'big', min: 26, max: 55, p: 0.09, priority: false, when: (l) => hasPartner(l) && (l.stats.married || l.stats.relationship === 'cohab') && !l.partnerMove,
    fr: ["Un nouveau départ pour {conj}", "{conj} a reçu une belle proposition dans une autre ville. Elle change tout pour lui ou pour elle, mais elle vous arrache à vos habitudes, vos proches et votre quartier."],
    choices: [
      { k: 'follow', icon: '🚚', fr: "Le ou la suivre", sub: () => "Une nouvelle vie à deux, loin des vôtres", fx: { social: -3, happy: 2, pppx: 0.1, flag: ['partnerMove', true] } },
      { k: 'refuse', icon: '🏠', fr: "Refuser de partir", sub: () => "Vous gardez vos racines, au risque de la rancœur", fx: { social: 2, happy: -3, flag: ['partnerMove', true] } },
      { k: 'distance', icon: '🚆', fr: "Essayer de vivre à distance", sub: () => "De longs trajets, des retrouvailles intenses", fx: { happy: -1, social: -1, pppx: -0.05, flag: ['partnerMove', true] } },
      { k: 'talk', icon: '💬', fr: "Chercher un compromis, quelques années pour chacun", sub: () => "Du dialogue et de la patience", fx: { happy: 3, social: 1, flag: ['partnerMove', true] } },
    ] },
  { id: 'de_work_credit', kind: 'big', min: 24, max: 58, p: 0.09, when: (l) => isEmployed(l) && !l.creditStolen,
    fr: ["Votre travail, son nom", "Vous découvrez que {coll1} a présenté votre travail comme le sien devant la direction. Tout le monde s'est empressé de féliciter {coll1}, et personne ne vous regarde."],
    choices: [
      { k: 'confront', icon: '🗣️', fr: "L'affronter en face", sub: () => "Une explication franche, avec un risque de tension", fx: () => roll([0.55, { happy: 3, social: -1, flag: ['creditStolen', true] }], [0.45, { happy: -3, social: -3, flag: ['creditStolen', true] }]) },
      { k: 'report', icon: '📨', fr: "En parler à votre responsable", sub: () => "Une reconnaissance possible, des représailles aussi", fx: () => roll([0.6, { happy: 2, pppx: 0.05, flag: ['creditStolen', true] }], [0.4, { happy: -4, social: -2, flag: ['creditStolen', true] }]) },
      { k: 'swallow', icon: '😶', fr: "Ne rien dire", sub: () => "Rien ne change, mais cela vous ronge", fx: { happy: -3, flag: ['creditStolen', true] } },
      { k: 'leave', icon: '🧭', fr: "Chercher ailleurs un endroit qui vous reconnaisse", sub: () => "Un nouveau départ, un peu d'incertitude", fx: () => roll([0.6, { happy: 4, pppx: 0.1, flag: ['creditStolen', true] }], [0.4, { happy: -2, pppx: -0.1, flag: ['creditStolen', true] }]) },
    ] },
  { id: 'de_dream_back', kind: 'big', min: 28, max: 55, p: 0.08, when: (l) => !!(l.traits && l.traits.dream) && !l.dreamAsked,
    fr: ["Le rêve de l'enfance", (l) => `Un souvenir vous traverse : enfant, vous rêviez d'être ${String(l.traits.dream).toLowerCase()}. Tout cela semble loin, et pourtant quelque chose en vous bat encore.`],
    choices: [
      { k: 'try', icon: '✨', fr: "Y consacrer vos soirées", sub: () => "Du temps volé au repos, une joie qui revient", fx: { happy: 5, health: -2, social: 1, flag: ['dreamAsked', true] } },
      { k: 'kids', icon: '🧒', fr: "Le transmettre à vos proches", sub: () => "Ce que vous n'avez pas pu faire, quelqu'un d'autre le vivra", fx: { social: 3, happy: 3, flag: ['dreamAsked', true] } },
      { k: 'join', icon: '🤝', fr: "Rejoindre un groupe ou une association", sub: () => "Un peu de cotisation, de nouveaux visages", fx: { pppx: -0.02, social: 4, happy: 3, flag: ['dreamAsked', true] } },
      { k: 'forget', icon: '🕰️', fr: "Le ranger dans un tiroir", sub: () => "La vie réelle d'abord", fx: { happy: -2, flag: ['dreamAsked', true] } },
    ] },
  { id: 'de_neighbor_loss', kind: 'family', min: 35, max: 85, p: 0.09, when: (l) => !l.neighborLoss,
    fr: ["Le deuil d'à côté", "Une personne que vous côtoyez depuis toujours dans le quartier est décédée cette nuit. Sa famille est loin, sa maison est vide, et tout le quartier vous regarde pour savoir ce qu'on fait."],
    choices: [
      { k: 'organise', icon: '🕯️', fr: "Organiser les adieux avec le quartier", sub: () => "Une soirée à la fois triste et unie", fx: { social: 5, happy: 1, health: -1, flag: ['neighborLoss', true] } },
      { k: 'attend', icon: '🌹', fr: "Venir à la cérémonie et rester auprès de la famille", sub: () => "Une présence discrète", fx: { social: 3, flag: ['neighborLoss', true] } },
      { k: 'note', icon: '✉️', fr: "Envoyer quelques mots", sub: () => "Un geste simple, de loin", fx: { social: 1, flag: ['neighborLoss', true] } },
      { k: 'none', icon: '🚪', fr: "Ne pas vous mêler de cela", sub: () => "Chacun son chagrin", fx: { social: -2, flag: ['neighborLoss', true] } },
    ] },
  { id: 'de_loneliness', kind: 'family', min: 60, max: 92, p: 0.14, when: (l) => aloneNow(l) && !l.lonelyAsked,
    fr: ["Les journées sont longues", "Vos proches sont occupés, les amis disparaissent un à un. Les journées s'étirent, et le téléphone sonne de moins en moins."],
    choices: [
      { k: 'club', icon: '🎲', fr: "Rejoindre un club ou un groupe de paroisse, de mosquée, de quartier", sub: () => "Se déplacer, retrouver des visages", fx: { social: 5, happy: 3, flag: ['lonelyAsked', true] } },
      { k: 'pet', icon: '🐕', fr: "Adopter un animal", sub: () => "Une présence quotidienne, un peu de soin à donner", fx: { social: 1, happy: 4, flag: ['pet', 'dog'], } },
      { k: 'call', icon: '📞', fr: "Appeler les vieux amis que vous avez perdus de vue", sub: () => "Un peu de courage pour recoller les morceaux", fx: () => roll([0.7, { social: 4, happy: 3, flag: ['lonelyAsked', true] }], [0.3, { social: -1, happy: -2, flag: ['lonelyAsked', true] }]) },
      { k: 'stay', icon: '🪑', fr: "Rester dans le silence", sub: () => "Rien ne change, rien ne se brise", fx: { happy: -4, health: -2, flag: ['lonelyAsked', true] } },
    ] },
  { id: 'de_teen_crush', kind: 'small', min: 13, max: 17, p: 0.14, when: (l) => inSchool(l) && !l.crushAsked,
    fr: ["Quelqu'un dans la classe", "Depuis des semaines, vous ne pensez qu'à une personne de la classe. Elle ne s'en doute pas, ou fait comme si."],
    choices: [
      { k: 'say', icon: '💬', fr: "Tout lui dire", sub: () => "Le cœur dans la gorge", fx: () => roll([0.4, { happy: 5, social: 2, flag: ['crushAsked', true] }], [0.6, { happy: -4, social: -1, flag: ['crushAsked', true] }]) },
      { k: 'friend', icon: '🤝', fr: "Devenir d'abord son ami", sub: () => "Plus lent, plus doux", fx: { social: 3, happy: 1, flag: ['crushAsked', true] } },
      { k: 'letter', icon: '💌', fr: "Écrire une lettre anonyme", sub: () => "Un mot dans un cahier, et l'attente", fx: { happy: 1, flag: ['crushAsked', true] } },
      { k: 'keep', icon: '🤐', fr: "Garder le secret", sub: () => "Un tourment discret", fx: { happy: -2, flag: ['crushAsked', true] } },
    ] },
  { id: 'de_exam_pressure', kind: 'family', min: 13, max: 19, p: 0.15, when: (l) => inSchool(l) && !l.pressureAsked && (motherAlive(l) || fatherAlive(l)),
    fr: ["Les attentes de la famille", "Vos parents comptent sur vos résultats, ils l'ont dit plusieurs fois. Ils se sacrifient pour que vous puissiez étudier, et la peur de les décevoir vous serre la gorge."],
    choices: [
      { k: 'work', icon: '📚', fr: "Travailler jour et nuit", sub: () => "Des résultats, de la fatigue", fx: { know: 4, health: -3, happy: -2, flag: ['pressureAsked', true] } },
      { k: 'talk', icon: '🗣️', fr: "Leur dire ce que vous ressentez", sub: () => "Une conversation difficile, un poids qui s'allège", fx: { happy: 3, social: 2, flag: ['pressureAsked', true] } },
      { k: 'help', icon: '🧑‍🏫', fr: "Demander de l'aide à un professeur ou à un ami", sub: () => "Apprendre à ne pas rester seul", fx: { know: 3, social: 2, flag: ['pressureAsked', true] } },
      { k: 'ease', icon: '🌿', fr: "Prendre du recul", sub: () => "Moins de pression, un risque sur les résultats", fx: { know: -2, happy: 3, flag: ['pressureAsked', true] } },
    ] },
  { id: 'de_sibling_quarrel', kind: 'family', min: 28, max: 70, p: 0.09, when: (l) => sibs(l) && !l.sibQuarrel,
    fr: ["{frere1} et vous", "Une vieille dispute avec {frere1} n'a jamais été réglée. Vous ne vous parlez plus que lors des fêtes, et chacun attend que l'autre appelle."],
    choices: [
      { k: 'call', icon: '📞', fr: "Appeler le premier", sub: () => "Avaler un peu de fierté", fx: () => roll([0.75, { social: 5, happy: 4, flag: ['sibQuarrel', true] }], [0.25, { social: -1, happy: -2, flag: ['sibQuarrel', true] }]) },
      { k: 'letter', icon: '✉️', fr: "Lui écrire une longue lettre", sub: () => "Dire enfin ce qui n'a jamais été dit", fx: { social: 3, happy: 2, flag: ['sibQuarrel', true] } },
      { k: 'wait', icon: '⏳', fr: "Attendre un événement familial", sub: () => "Un enterrement ou un mariage rapproche souvent", fx: { happy: -1, flag: ['sibQuarrel', true] } },
      { k: 'pride', icon: '🧱', fr: "Tenir bon sur votre position", sub: () => "Vous aurez raison, mais seul", fx: { social: -3, happy: -2, flag: ['sibQuarrel', true] } },
    ] },
  { id: 'de_anniversary', kind: 'family', min: 26, max: 70, p: 0.08, when: (l) => hasPartner(l) && l.stats.married && !l.anniversaryForgot,
    fr: ["Un anniversaire oublié", "Vous réalisez, en voyant le visage de {conj}, que vous avez oublié votre anniversaire de mariage. Rien n'est dit, mais le regard dit tout."],
    choices: [
      { k: 'sorry', icon: '💐', fr: "Reconnaître votre oubli sans détour", sub: () => "Un moment gênant, puis un moment tendre", fx: { happy: 2, social: 2, flag: ['anniversaryForgot', true] } },
      { k: 'surprise', icon: '🎁', fr: "Improviser une soirée pour vous deux", sub: (l) => `Environ ${priceTxt(l, 0.02)}`, fx: { pppx: -0.02, happy: 4, social: 2, flag: ['anniversaryForgot', true] } },
      { k: 'letter', icon: '💌', fr: "Écrire à votre conjoint tout ce que vous ne dites plus", sub: () => "Des mots qui font du bien", fx: { happy: 5, social: 3, flag: ['anniversaryForgot', true] } },
      { k: 'pretend', icon: '🎭', fr: "Faire comme si de rien n'était", sub: () => "Vous espérez qu'il ou elle oubliera aussi", fx: { happy: -3, social: -2, flag: ['anniversaryForgot', true] } },
    ] },
  { id: 'de_mother_letters', kind: 'family', min: 35, max: 75, p: 0.1, when: (l) => !l.lettersFound && ((l.family && l.family.parents) || []).some(p => p.sex === 'F') && !motherAlive(l),
    fr: ["Les lettres de {mere}", "En vidant la maison de {mere}, vous retrouvez une boîte de lettres jamais envoyées. Certaines vous sont adressées."],
    choices: [
      { k: 'read', icon: '📖', fr: "Les lire seul{e}, ce soir", sub: () => "Une nuit de larmes et de mots enfin dits", fx: { happy: 4, social: 1, flag: ['lettersFound', true] } },
      { k: 'share', icon: '👨‍👩‍👧', fr: "Les lire avec vos frères et sœurs", sub: () => "Un deuil partagé", fx: { social: 5, happy: 3, flag: ['lettersFound', true] } },
      { k: 'keep', icon: '📦', fr: "Les garder fermées", sub: () => "Vous n'êtes pas encore prêt(e)", fx: { happy: -2, flag: ['lettersFound', true] } },
    ] },
);
// Choix supplémentaires pour des décisions qui n'en avaient que deux : une voie plus humaine, plus nuancée.
const ENRICH = {
  de_screening: [{ k: 'talk', icon: '💬', fr: "En parler à un proche avant de décider", sub: () => "Une présence pour vous accompagner", fx: { social: 2, happy: 1 } }],
  de_quit_smoking: [{ k: 'support', icon: '🫂', fr: "Demander à un proche de vous soutenir", sub: () => "Plus de chances, et un lien plus fort", fx: () => roll([0.55, { flag: ['smoker', false], exSmoker: true, health: 4, happy: 3, social: 2, msg: { fr: "Avec le soutien des vôtres, vous tenez bon : vous ne fumez plus.", en: "With support you quit." } }], [0.45, { social: 1, happy: -1 }]) }],
  de_car: [{ k: 'used', icon: '🚙', fr: "Acheter une voiture d'occasion", sub: () => "Moins chère, plus d'entretien", fx: { money: -1800, happy: 1, flag: ['hasCar', true] } }],
  de_motorbike: [{ k: 'share', icon: '🤝', fr: "Partager la moto d'un cousin", sub: () => "Moins cher, des liens renforcés", fx: { happy: 1, social: 2 } }],
  de_elder_home: [{ k: 'rota', icon: '🔄', fr: "Alterner chez chacun de vos proches", sub: () => "Un peu de fatigue pour tous, un peu de présence partout", fx: { social: 3, happy: 1 } }],
  de_gym: [{ k: 'walk', icon: '🚶', fr: "Marcher chaque matin avec un voisin", sub: () => "Gratuit, et une amitié en plus", fx: { health: 1, social: 2 } }],
  de_hypertension: [{ k: 'family', icon: '👨‍👩‍👧', fr: "Faire du suivi un projet de famille", sub: () => "Manger mieux ensemble, marcher le soir", fx: { health: 2, social: 2 } }],
  de_workplace_mockery: [{ k: 'ally', icon: '🤝', fr: "En parler à un collègue de confiance", sub: () => "Ne plus porter cela seul", fx: { social: 3, happy: 1 } }],
  de_gambling: [{ k: 'confide', icon: '🫂', fr: "En parler à un proche avant qu'il ne soit trop tard", sub: () => "Un aveu difficile, une vraie aide", fx: { happy: 2, social: 2 } }],
  de_bednet: [{ k: 'share', icon: '🛏️', fr: "En acheter aussi pour les voisins", sub: () => "Plus cher, mais tout le quartier est protégé", fx: { pppx: -0.02, social: 3, health: 1 } }],
  de_vaccination: [{ k: 'family', icon: '💉', fr: "Y aller avec vos proches", sub: () => "Moins de peur ensemble", fx: { health: 2, social: 2 } }],
  de_overtime: [{ k: 'negotiate', icon: '🗣️', fr: "Négocier un autre rythme", sub: () => "Un risque de tension, une chance de souffler", fx: () => roll([0.55, { happy: 3, social: 1 }], [0.45, { happy: -1 }]) }],
  de_exam: [{ k: 'friend', icon: '📚', fr: "Réviser avec un ami", sub: () => "Se motiver à deux", fx: { know: 3, social: 2 } }],
  de_second_job: [{ k: 'partner', icon: '👥', fr: "En discuter avec votre famille d'abord", sub: () => "Décider ensemble", fx: { social: 2, happy: 1 } }],
  de_study_abroad: [{ k: 'scholar', icon: '🎓', fr: "Chercher une bourse avant de décider", sub: () => "Du temps, des démarches, moins de risque", fx: { know: 2, happy: 1 } }],
  de_move_city: [{ k: 'visit', icon: '🧭', fr: "Aller visiter d'abord", sub: () => "Se faire une idée avant de s'engager", fx: { happy: 1, pppx: -0.01 } }],
};
EXTRA_DECISIONS.forEach(d => { const extra = ENRICH[d.id]; if (extra && Array.isArray(d.choices)) extra.forEach(c => { if (!d.choices.some(x => x.k === c.k)) d.choices.push(c); }); });
// Emplois proposés au premier poste, selon les études et le lieu de vie. mult module le revenu du pays.
const JOBS = {
  lowRural: [{ i: '🌾', fr: "Ouvri{er|ère} agricole", en: 'Farm labourer', mult: 0.8, health: -1 }, { i: '🐄', fr: "Éleveu{r|se}", en: 'Herder', mult: 0.85 }, { i: '🧺', fr: "Vendeu{r|se} sur les marchés", en: 'Market seller', mult: 0.9, happy: 1 }],
  lowUrban: [{ i: '🛒', fr: "Vendeu{r|se} de rue", en: 'Street vendor', mult: 0.85 }, { i: '🧱', fr: "Manœuvre sur les chantiers", en: 'Building labourer', mult: 1.0, health: -2 }, { i: '🧽', fr: "Employé{e} de maison", en: 'Domestic worker', mult: 0.8 }],
  mid: [{ i: '🏭', fr: "Ouvri{er|ère} d'usine", en: 'Factory worker', mult: 1.0, health: -1 }, { i: '🏪', fr: "Vendeu{r|se} en magasin", en: 'Shop assistant', mult: 0.95 }, { i: '🚚', fr: "Chauffeu{r|se}", en: 'Driver', mult: 1.05 }, { i: '🍽️', fr: "Serveu{r|se}", en: 'Waiter', mult: 0.85, happy: 1 }, { i: '🔧', fr: "Artisan{e}", en: 'Tradesperson', mult: 1.1 }],
  high: [{ i: '🧑‍🏫', fr: "Enseignant{e}", en: 'Teacher', mult: 1.0, happy: 2 }, { i: '🩺', fr: "Infirmi{er|ère}", en: 'Nurse', mult: 1.05 }, { i: '📊', fr: "Comptable", en: 'Accountant', mult: 1.15 }, { i: '⚙️', fr: "Ingénieur{e}", en: 'Engineer', mult: 1.4 }],
};
function jobOffers(life) {
  const edu = life.stats.education;
  const pool = edu >= 4 ? JOBS.high : edu >= 2 ? JOBS.mid : (life.stats.birthPlaceType === 'rural' ? JOBS.lowRural : JOBS.lowUrban);
  const list = pool.map(j => ({ ...j, mult: j.mult * (life.trained && edu < 4 ? 1.1 : 1) }));
  return list.sort(() => Math.random() - 0.5).slice(0, 3);
}
// Salaire annuel qu'offrirait un emploi à cette personne, d'après le modèle de budget.
function wageFor(life, mult) {
  const probe = { ...life, job: { mult }, stats: { ...life.stats, employment: 'employed' } };
  return yearBudget(probe).income;
}
const FX_LABELS = {
  fr: { money: 'Patrimoine', happy: 'Bonheur', health: 'Santé', social: 'Relations', know: 'Savoir' },
  en: { money: 'Wealth', happy: 'Happiness', health: 'Health', social: 'Social', know: 'Knowledge' },
};
function fxSub(fx) {
  if (typeof fx === 'function') return LANG === 'fr' ? 'Résultat incertain' : 'Uncertain outcome';
  const lab = FX_LABELS[LANG === 'fr' ? 'fr' : 'en'];
  const v = { ...fx, money: (fx.money || 0) + (fx.pppx || 0) };
  return Object.keys(v).filter(k => lab[k] && v[k]).map(k => lab[k] + (v[k] > 0 ? '↑' : '↓')).join(' ');
}
function applyFx(life, fx, label) {
  let e = typeof fx === 'function' ? fx(life) : fx;
  if (e.die && !heavyOk()) e = { happy: -5 };   // mode protégé : aucun évènement ne tue
  const s = life.stats;
  const c = life.countryData || {};
  const scale = moneyScale(life);
  const clamp = v => Math.max(0, Math.min(100, v));
  if (e.money) s.netAssets += Math.round(e.money * scale);
  if (e.pppx) s.netAssets += Math.round(e.pppx * (c.ppp || 12000));
  if (e.money || e.pppx) { const amt = Math.round((e.money || 0) * scale + (e.pppx || 0) * (c.ppp || 12000)); if (amt) { const fl = life.flows || (life.flows = []); fl.push({ age: life.age, label: label || '', amt }); if (fl.length > 60) fl.shift(); } }   // montant exprimé en années de revenu moyen du pays
  if (e.happy) s.happiness = clamp(s.happiness + e.happy);
  if (e.health) bumpHealth(life, e.health);
  if (e.social) s.social = clamp(s.social + e.social);
  if (e.know) s.knowledge = clamp(s.knowledge + e.know);
  if (e.retire) s.employment = 'retired';
  if (e.smoker) life.smoker = true;
  if (e.flag) {
    life[e.flag[0]] = e.flag[1];
    if (e.flag[0] === 'herd' && e.flag[1]) { e.flag[1].since = life.age; e.flag[1].n = 1; }
    if (e.flag[0] === 'housing' && e.flag[1] && ['own', 'mortgage'].includes(e.flag[1].type)) life.ownsHome = true;
    if (e.flag[0] === 'pet') {
      const pets = life.pets || (life.pets = []);
      if (e.flag[1]) { life.petSince = life.age; pets.push({ name: pick(['Luna', 'Bella', 'Max', 'Rex', 'Nala', 'Milo', 'Tigre', 'Pépita', 'Choupette', 'Rocky']), type: e.flag[1], from: life.age, to: null }); }
      else { const last = pets.filter(x => x.to == null).pop(); if (last) last.to = life.age; }
    }
  }
  if (e.hobby) { const hb = life.hobbies || (life.hobbies = {}); hb[e.hobby] = (hb[e.hobby] || 0) + 1; }
  if (e.friend) { const fl = life.friends || (life.friends = []); fl.push({ name: randomName(life.countryData, Math.random() < 0.5 ? 'M' : 'F').first, closeness: 'proche' }); }
  if (e.edu != null) life.eduTarget = e.edu === 'stop' ? s.education : Math.min(life.eduTarget ?? 4, e.edu);
  if (e.eduUp) life.eduTarget = Math.max(life.eduTarget ?? 0, e.eduUp);
  if (e.job) { life.job = { fr: e.job.fr, en: e.job.en, mult: e.job.mult }; life.jobStart = life.age; }
  if (e.rel === 'dating' || e.rel === 'cohab') { if (!s.partner) s.partner = newPartner(life, 0); s.relationship = e.rel; }
  if (e.rel === 'single') { s.partner = null; s.married = false; s.relationship = 'single'; }
  if (e.marry && !s.married) { if (!s.partner) s.partner = newPartner(life, life.age < 18 ? 9 : 0); life.pendingMarriage = true; }
  if (e.leave) { s.married = false; s.partner = null; s.relationship = 'divorced'; }
  if (e.baby) addChildNow(life);
  if (e.migrate) migrateLife(life);
  if (e.illTreat) startTreatment(life, e.illTreat);
  if (e.univRetry) { life.univ = { start: life.age - 2, status: 'enrolled' }; s.employment = 'university'; life.univAsked = true; }
  if (e.univWork) { life.univAsked = true; s.employment = 'employed'; }
  if (e.msg) {
    const m = genderize(LANG === 'fr' ? e.msg.fr : e.msg.en, life);
    life.log.push({ age: life.age, kind: 'decision', icon: '❗', text: m });
    if (life === STATE.life) { logLife(m); toast(m); }
  }
  if (e.die) setTimeout(() => { if (STATE.life === life && !life.died) dieNow(e.die); }, 80);
}
// Petits évènements annuels : condition de plausibilité, indexée par leur texte anglais.
const never = () => false;
const hasKids = (life) => (life.stats.kids || []).length > 0;
// Encore scolarisé : entre 6 ans et l'âge de fin du niveau visé (primaire 12, collège 15, lycée 18, université 22).
const inSchool = (life) => life.age >= 6 && life.age < [6, 12, 15, 18, 22][Math.min(life.eduTarget ?? 2, 4)];
const isEmployed = (life) => life.stats.employment === 'employed';
const FLAVOR_GUARDS = {
  'Fell in love': never, 'Got married': never, 'Had a child': never, 'Got divorced': never, 'Bought a home': never,   // gérés par l'état réel de la vie
  'Child graduated': hasKids, 'Helped the kids with homework': hasKids,
  'Grandchild born': (life) => hasKids(life) && life.age >= 50, 'Grandchildren visit': (life) => hasKids(life) && life.age >= 50, 'Saw grandchild grow': (life) => hasKids(life) && life.age >= 50,
  'Joined a school club': inSchool, 'Went on a class trip': inSchool, 'Got good grades': inSchool, 'Joined a school team': inSchool, 'Won academic award': inSchool,
  'Got tutoring after school': (life) => inSchool(life) && comfortable(5000)(life),
  'Graduated': (life) => life.stats.education >= 3, 'Got first job': isEmployed, 'Got promoted': isEmployed, 'Got big promotion': isEmployed,
  'Started a project outside work': isEmployed, 'Took a work trip abroad': (life) => isEmployed(life) && pppOf(life) >= 10000,
  'Bought a car': comfortable(10000), 'Got driver license': comfortable(6000), 'Ran a marathon': comfortable(8000),
  'Took vacation': comfortable(8000), 'Family trip': comfortable(8000), 'Travelled alone for the first time': comfortable(8000),
  'Went back to school': comfortable(5000), 'Took a night class': comfortable(5000),
  'Started a regular checkup habit': comfortable(5000), 'Health checkup': comfortable(5000), 'Had health check': comfortable(5000),
  'Started thinking about retirement': (life) => pppOf(life) >= 8000, 'Joined a community class for seniors': (life) => pppOf(life) >= 10000,
  'Posted your first photo online': online(40), 'Got into gaming': online(40), 'Learned to use a smartphone': online(20),
};
// Conditions ajoutées aux évènements d'origine : ils supposaient tous un pays riche.
const ORIGINAL_GUARDS = {
  de_health_warning: comfortable(5000),                                   // un médecin qui fait un bilan
  de_illness_treat: comfortable(6000),                                    // un dépistage précoce
  de_inflation: (life) => life.stats.netAssets > 1000 * moneyScale(life), // il faut une épargne à protéger
  de_job_change: comfortable(8000),                                       // une startup
  de_buy_home: () => false,   // remplacé par de_housing (prix et mensualités propres à chaque pays)
  de_sabbatical: (life) => pppOf(life) >= 20000,
  de_inheritance: (life) => quartOf(life) >= 3,                           // une entreprise familiale et des biens
  sm_weekend: (life) => life.stats.employment === 'employed',
  sm_cook: (life) => pppOf(life) >= 10000,                                // la livraison de repas
  sm_volunteer: (life) => pppOf(life) >= 8000,                                        // un centre communautaire
  sm_reunion: (life) => life.stats.education >= 2,                        // d'anciens camarades de classe
  sm_phone: comfortable(3000),
};
DECISIONS.forEach(d => {
  const guard = ORIGINAL_GUARDS[d.id];
  if (!guard) return;
  const base = d.chance;
  d.chance = (life) => guard(life) && base(life);
});
EXTRA_DECISIONS.forEach(d => DECISIONS.push({
  id: d.id, kind: d.kind, priority: !!d.priority, repeat: !!d.repeat,
  chance: (life) => life.age >= d.min && life.age <= d.max && (!d.when || d.when(life)) && Math.random() < (typeof d.p === 'function' ? d.p(life) : d.p),
  show: (life) => {
    const fr = LANG === 'fr';
    const G = (txt) => genderize(txt, life);
    const choices = typeof d.choices === 'function' ? d.choices(life) : d.choices;
    return {
      title: G(((fr || !d.en) ? (typeof d.fr[0] === 'function' ? d.fr[0](life) : d.fr[0]) : d.en[0])),
      body: G(((fr || !d.en) ? (typeof d.fr[1] === 'function' ? d.fr[1](life) : d.fr[1]) : d.en[1])),
      choices: choices.map(c => ({ k: c.k, icon: c.icon, label: G((fr || !c.en) ? c.fr : c.en), sub: c.sub ? c.sub(life) : fxSub(c.fx), apply: (l) => applyFx(l, c.fx, typeof d.fr[0] === 'function' ? '' : G(fr ? d.fr[0] : (d.en ? d.en[0] : d.fr[0]))) })),
    };
  },
}));

function tryTriggerDecision(life, newAge) {
  if (!life) return false;
  // 已經有 modal 在開就不要觸發
  const decM = document.getElementById('decisionModal');
  if (decM && !decM.hasAttribute('hidden')) return false;
  // 冷卻期：距上一個決策還不夠就先不要，這一年仍然有機會（隔年再試）
  const lastAge = life.lastDecisionAge;
  if (lastAge != null && newAge - lastAge < DECISION_COOLDOWN) return false;
  // 剛被別的 modal 打斷過就讓玩家喘口氣
  const lastInt = life.lastInterruptAge;
  if (lastInt != null && newAge - lastInt < INTERRUPT_GAP) return false;

  const done = new Set((life.decisions || []).map(d => d.id));
  // v5.85：先收集所有「擲骰通過」的事件，再從中隨機挑一個。
  // 舊寫法照 DECISIONS 陣列順序逐一嘗試、遇到第一個就 return ——
  // 這讓排在後面的事件被前面的系統性壓制。
  // 實測 de_mental_health 排在第 10 位，200 條人生一次都沒出現過。
  const eligible = [];
  for (const dec of DECISIONS) {
    if (done.has(dec.id) && !dec.repeat) continue;   // une rencontre peut se représenter après un refus ou une rupture
    let ok = false;
    try { ok = dec.chance(life); } catch (e) { continue; }
    if (ok) eligible.push(dec);
  }
  if (!eligible.length) return false;
  // 每年最多一個
  const prio = eligible.filter(d => d.priority);   // la vie amoureuse passe avant les autres évènements
  const from = prio.length ? prio : eligible;
  const dec = from[Math.floor(Math.random() * from.length)];
  try {
    const payload = dec.show(life);
    if (payload) {
      const ok = showDecision({ id: dec.id, kind: dec.kind, age: newAge, ...payload });
      if (ok) { life.lastDecisionAge = newAge; return true; }
    }
  } catch (e) { console.warn('decision show failed', dec.id, e); }
  return false;
}



// ==== i18n ====
function t(key, ...vals) {
  const dict = I18N[LANG] || I18N['zh-Hant'] || {};
  let s = dict[key] || key;
  // 支援 placeholder：
  //  1) {}     — 依序替換（vals 是基本型別陣列）
  //  2) {name} — 具名替換（從 vals[0] 物件讀 name 屬性）
  //  3) {0} {1} — 索引替換（按 vals 陣列索引）
  // 先把 {name} 與 {n} 換成對應 vals 值；再把剩餘 {} / {0} / {1} 依序套用
  // 自動偵測：如果 vals[0] 是物件，視為 named dict；否則按位置
  const first = vals[0];
  const isNamedDict = first && typeof first === 'object' && !Array.isArray(first);
  if (isNamedDict) {
    s = s.replace(/\{(\w+)\}/g, (m, name) => (first[name] !== undefined ? String(first[name]) : m));
  } else {
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i];
      // 嘗試替換 {i} 與 {} 兩種
      s = s.replace(`{${i}}`, v).replace('{}', v);
    }
  }
  return s;
}
/* v5.46：死因 i18n — 死因在資料層以中文儲存，顯示時翻譯 */
function causeLabel(cause) {
  if (!cause) return '';
  return t('cause.' + cause);
}
// Exemples concrets d'une cause de décès ; vide si la langue n'en fournit pas.
function causeExamples(cause) {
  return (I18N[LANG] || {})['causeEx.' + cause] || '';
}

async function loadData() {
  if (!CACHE.countries) {
    const r1 = await fetch('data/countries.json');
    CACHE.countries = await r1.json();
    COUNTRIES = CACHE.countries;
  }
  if (!CACHE.i18n) {
    const r2 = await fetch('data/i18n.json');
    CACHE.i18n = await r2.json();
    I18N = CACHE.i18n;
  }
  // 語言偏好
  LANG = localStorage.getItem(STORAGE_KEY + ':lang') || detectLang();
}
function detectLang() {
  const nav = (navigator.language || 'en').toLowerCase();
  if (nav.startsWith('zh')) return nav.includes('hans') ? 'zh-Hans' : 'zh-Hant';
  if (nav.startsWith('en')) return 'en';
  if (nav.startsWith('ko')) return 'ko';
  if (nav.startsWith('ja')) return 'ja';
  if (nav.startsWith('vi')) return 'vi';
  if (nav.startsWith('fr')) return 'fr';
  if (nav.startsWith('th')) return 'th';
  if (nav.startsWith('es')) return 'es';
  return 'zh-Hant';
}
function setLang(lang) {
  LANG = lang;
  localStorage.setItem(STORAGE_KEY + ':lang', lang);
  document.documentElement.lang = lang;
  renderAll();
  syncDetailToggleLabel();
  syncPauseBtn();
  syncAutoBtn();
}
/* v5.61：切換語言後更新「詳細資料」按鈕文字 */
function syncDetailToggleLabel() {
  const btn = $('#btnDetailToggle');
  if (!btn) return;
  const on = $('#view-life')?.classList.contains('show-detail');
  const lbl = btn.querySelector('.ldt-label');
  if (lbl) lbl.textContent = t(on ? 'life.detail.hide' : 'life.detail.show');
}

// ==== 國家 ====
function countryById(id) { return COUNTRIES.find(c => c.id === id) || null; }
// Français des tableaux de données {en, zh} : dictionnaire indexé par le texte anglais.
const FR_BY_EN = {
  "Learned to walk": "A appris à marcher",
  "First word spoken": "A dit son premier mot",
  "Had a fever": "A eu de la fièvre",
  "Started recognizing family": "Commence à reconnaître sa famille",
  "Started eating solid food": "Commence à manger des aliments solides",
  "Clung to a stuffed toy": "Ne lâche plus sa peluche",
  "Scribbled on the floor": "A gribouillé par terre",
  "Slept through the night": "A fait sa première nuit complète",
  "Made a new friend": "S'est fait un nouvel ami",
  "Won a small competition": "A été classé(e) à un petit concours",
  "Got injured playing": "S'est blessé(e) en jouant",
  "Discovered a favorite book": "A découvert un livre préféré",
  "Caught a cold": "A attrapé un rhume",
  "Joined a school club": "A rejoint un club de l'école",
  "Got tutoring after school": "Suit des cours de soutien après l'école",
  "Went on a class trip": "Est parti(e) en voyage scolaire",
  "Finished a big project": "A terminé un grand projet",
  "Got good grades": "A eu de bonnes notes",
  "Discovered favorite music": "A découvert sa musique préférée",
  "First heartbreak": "Premier chagrin d'amour",
  "Got into gaming": "S'est pris(e) de passion pour les jeux vidéo",
  "Biked somewhere new": "Est allé(e) à vélo dans un endroit inconnu",
  "Got sick for a week": "Malade pendant une semaine",
  "Joined a school team": "A intégré une équipe de l'école",
  "Started a diary": "A commencé un journal intime",
  "Got a first part-time job": "Premier petit boulot",
  "Performed on a stage": "Est monté(e) sur scène",
  "Won academic award": "A reçu un prix scolaire",
  "Graduated": "Diplôme obtenu",
  "Got first job": "A trouvé son premier emploi",
  "Fell in love": "Est tombé(e) amoureux(se)",
  "Ran a marathon": "A couru un marathon",
  "Got driver license": "A passé le permis de conduire",
  "Had health scare": "Une alerte de santé",
  "Travelled alone for the first time": "Premier voyage en solitaire",
  "Set a long-term goal": "S'est fixé un objectif à long terme",
  "Posted your first photo online": "A publié sa première photo en ligne",
  "Got promoted": "A obtenu une promotion",
  "Got married": "S'est marié(e)",
  "Had a child": "A eu un enfant",
  "Bought a home": "A acheté un logement",
  "Got big promotion": "A obtenu une grosse promotion",
  "Bought a car": "A acheté une voiture",
  "Had health issue": "Un souci de santé",
  "Got divorced": "A divorcé",
  "Started a project outside work": "A lancé un projet en dehors du travail",
  "Took up a new hobby": "S'est trouvé un nouveau loisir",
  "Took a work trip abroad": "Déplacement professionnel à l'étranger",
  "Started a regular checkup habit": "Fait désormais des bilans de santé réguliers",
  "Took a night class": "A suivi des cours du soir",
  "Family trip": "Voyage en famille",
  "Child graduated": "Un enfant a obtenu son diplôme",
  "Took vacation": "Est parti(e) en vacances",
  "Grandchild born": "Naissance d'un petit-enfant",
  "Health checkup": "Bilan de santé",
  "Went back to school": "A repris des études",
  "Lost a loved one": "A perdu un être cher",
  "The roles reversed with a parent": "Les rôles s'inversent avec un parent",
  "Adopted a pet": "A adopté un animal",
  "Started cooking at home": "S'est mis(e) à cuisiner à la maison",
  "Learned to use a smartphone": "A appris à se servir d'un smartphone",
  "Helped the kids with homework": "A aidé les enfants à faire leurs devoirs",
  "Started thinking about retirement": "Commence à penser à la retraite",
  "Grandchildren visit": "Visite des petits-enfants",
  "Walked in the park": "Promenade au parc",
  "Read a great book": "A lu un très bon livre",
  "Saw grandchild grow": "Regarde ses petits-enfants grandir",
  "Had health check": "A passé un bilan de santé",
  "Sat on a bench watching the street": "Assis(e) sur un banc à regarder la rue",
  "Had tea with an old friend": "A pris le thé avec un vieil ami",
  "Took up gardening": "S'est mis(e) au jardinage",
  "Joined a community class for seniors": "A rejoint un atelier pour seniors",
  "Danced at a community night": "A dansé à la fête du quartier",
  "Called up an old friend": "A appelé un vieil ami",
  "Learned to knit": "A appris à tricoter",
  "Started writing a memoir": "S'est mis(e) à écrire ses mémoires",
  "Went to a funeral": "A assisté à des funérailles",
  "Kept an old photo on the shelf": "A posé une vieille photo sur l'étagère",
  "Affected by local unrest": "Touché(e) par des troubles locaux",
  "Stay healthy": "Prendre soin de sa santé",
  "Family time": "Du temps en famille",
  "Rest & enjoy": "Se reposer et profiter",
  "Career growth": "Progresser au travail",
  "Start a family": "Fonder une famille",
  "Health & fitness": "Santé et forme",
  "Self-study": "Se former seul(e)",
  "Study hard": "Bien travailler à l'école",
  "Play & explore": "Jouer et explorer",
  "Help family": "Aider la famille",
  "Stay active": "Rester actif(ve)",
  "Savings": "Livret d'épargne",
  "Bonds": "Obligations",
  "60/40 fund": "Fonds mixte actions-obligations",
  "Stock index": "Actions (indice)",
  "Global index": "Indice mondial (actions du monde entier)",
  "Stock picking": "Choisir ses actions soi-même",
  "after inflation 1-1.5%/yr": "1 à 1,5 % par an après inflation",
  "~2% avg, low volatility": "environ 2 % en moyenne, peu de variations",
  "~3.5% avg, medium volatility": "environ 3,5 % en moyenne, variations modérées",
  "~5% avg, high volatility": "environ 5 % en moyenne, fortes variations",
  "~5% avg + currency risk, +1% fee": "environ 5 % en moyenne, risque de change, frais +1 % par an",
  "most earn less than index": "la plupart gagnent moins que l'indice",
  "Health": "Santé",
  "Education": "Éducation",
  "Income": "Revenu",
  "Relationship": "Relations",
  "Life expectancy": "Espérance de vie",
  "Under-5 mortality": "Mortalité avant 5 ans",
  "GDP per capita (PPP)": "PIB par habitant (PPA)",
  "Expected school years": "Années d'études attendues",
  "Farmer": "Agriculteur",
  "Laborer": "Ouvrier",
  "Taxi driver": "Chauffeur de taxi",
  "Construction worker": "Ouvrier du bâtiment",
  "Fisherman": "Pêcheur",
  "Herder": "Éleveur",
  "Auto mechanic": "Mécanicien auto",
  "Technician": "Technicien",
  "Vendor": "Marchand ambulant",
  "Porter": "Porteur",
  "Security guard": "Agent de sécurité",
  "Engineer": "Ingénieur",
  "Teacher": "Enseignant(e)",
  "Bank clerk": "Employé de banque",
  "Sales clerk": "Vendeur(se)",
  "Civil servant": "Fonctionnaire",
  "Nurse": "Infirmière",
  "Service worker": "Employée de service",
  "Buddhist": "Bouddhisme",
  "Folk religion": "Religion populaire",
  "Protestant": "Protestantisme",
  "Catholic": "Catholicisme",
  "Non-religious": "Sans religion",
  "Hindu": "Hindouisme",
  "Muslim": "Islam",
  "Sikh": "Sikhisme",
  "Christian": "Christianisme",
  "Orthodox": "Orthodoxie",
  "Druze": "Druzes",
  "African traditional": "Religion traditionnelle africaine",
  "Other": "Autre",
  "Jewish": "Judaïsme",
  "Bottom 25%": "Les 25 % les plus modestes",
  "Lower-middle": "Moitié basse",
  "Upper-middle": "Moitié haute",
  "Top 25%": "Les 25 % les plus aisés",
  "small house": "petite maison",
  "apartment": "appartement"
};
const enfr = (en, zh) => LANG === 'en' ? en : LANG === 'fr' ? (FR_BY_EN[en] || en) : zh;

/* ==== Récit ====
   Les textes s'adressent au joueur (« vous ») et s'accordent au sexe du personnage :
   {e} ajoute un « e » au féminin, {masculin|féminin} choisit l'une des deux formes. */
function genderize(txt, life) {
  const f = !!life && life.sex === 'F';
  let out = String(txt).replace(/\{([^|{}]*)\|([^{}]*)\}/g, (m, a, b) => (f ? b : a)).replace(/\{e\}/g, f ? 'e' : '');
  if (life && /\{(ami1?|frere1?|conj|collegue|coll1|age_mere|animal|mere|pere|enfant|reve)\}/.test(out)) {
    const yr = life.year + life.yearOffset;
    const rnd = (a) => a[Math.floor(Math.random() * a.length)];
    const sibs = ((life.family && life.family.siblings) || []).map(x => String(x.name).split(' ')[0]);
    const mother = ((life.family && life.family.parents) || []).find(x => x.sex === 'F');
    const pet = (life.pets || []).filter(x => x.to == null).pop();
    // {ami1}, {frere1}, {coll1} : le même prénom dans tout le texte d'une même année (titre et corps d'une décision).
    const tk = (life._tk && life._tk.age === life.age) ? life._tk : (life._tk = { age: life.age });
    out = out.replace(/\{ami1\}/g, () => tk.ami || (tk.ami = (life.friends && life.friends.length ? rnd(life.friends).name : "un ami d'enfance")))
      .replace(/\{frere1\}/g, () => tk.frere || (tk.frere = (sibs.length ? rnd(sibs) : 'votre frère')))
      .replace(/\{coll1\}/g, () => tk.coll || (tk.coll = randomName(life.countryData, Math.random() < 0.5 ? 'M' : 'F').first));
    out = out.replace(/\{ami\}/g, () => (life.friends && life.friends.length ? rnd(life.friends).name : "un ami d'enfance"))
      .replace(/\{frere\}/g, () => (sibs.length ? rnd(sibs) : 'votre frère'))
      .replace(/\{conj\}/g, () => (life.stats && life.stats.partner && life.stats.partner.name ? String(life.stats.partner.name.first || life.stats.partner.name.full || '').split(' ')[0] || 'votre conjoint' : 'votre conjoint'))
      .replace(/\{collegue\}/g, () => randomName(life.countryData, Math.random() < 0.5 ? 'M' : 'F').first)
      .replace(/\{age_mere\}/g, () => (mother && mother.birth ? yr - mother.birth.year : '60'))
      .replace(/\{animal\}/g, () => (pet ? pet.name : 'votre animal'))
      .replace(/\{mere\}/g, () => (mother && mother.name ? String(mother.name).split(' ')[0] : 'votre mère'))
      .replace(/\{pere\}/g, () => { const f = ((life.family && life.family.parents) || []).find(x => x.sex === 'M'); return f && f.name ? String(f.name).split(' ')[0] : 'votre père'; })
      .replace(/\{enfant\}/g, () => { const ks = (life.stats && life.stats.kids) || [], fk = (life.family && life.family.kids) || []; let bi = -1; ks.forEach((k, i) => { if (bi < 0 || k.bornAt > ks[bi].bornAt) bi = i; }); return fk[bi] && fk[bi].name ? String(fk[bi].name).split(' ')[0] : 'votre enfant'; })
      .replace(/\{reve\}/g, () => String((life.traits && life.traits.dream) || 'votre rêve').toLowerCase());
  }
  return out;
}
Object.assign(FR_BY_EN, {
  'Learned to walk': "Vous faites vos premiers pas, les bras tendus vers vos parents.",
  'First word spoken': "Vous prononcez votre premier mot. Toute la maison le répète.",
  'Had a fever': "Une forte fièvre vous garde au lit plusieurs jours.",
  'Started recognizing family': "Vous reconnaissez les visages de la famille et leur tendez les bras.",
  'Started eating solid food': "Vous découvrez les premiers aliments solides, et en mettez partout.",
  'Clung to a stuffed toy': "Vous ne vous séparez plus de votre doudou.",
  'Scribbled on the floor': "Vous dessinez par terre avec tout ce qui vous tombe sous la main.",
  'Slept through the night': "Vous faites enfin vos nuits. Vos parents aussi.",
  'Made a new friend': "Vous vous faites un{|e} nouvel{|le} ami{e}.",
  'Won a small competition': "Vous montez sur le podium d'un petit concours.",
  'Got injured playing': "Vous vous blessez en jouant et rentrez à la maison en boitant.",
  'Discovered a favorite book': "Vous découvrez un livre que vous relisez dix fois.",
  'Caught a cold': "Vous attrapez un gros rhume.",
  'Joined a school club': "Vous rejoignez un club de l'école.",
  'Got tutoring after school': "Vous suivez des cours de soutien après la classe.",
  'Went on a class trip': "Vous partez en sortie avec toute la classe.",
  'Finished a big project': "Vous terminez un travail dont vous êtes fi{er|ère}.",
  'Got good grades': "Vos notes progressent nettement.",
  'Discovered favorite music': "Vous découvrez une musique qui ne vous quittera plus.",
  'First heartbreak': "Vous vivez votre premier chagrin d'amour.",
  'Got into gaming': "Vous vous passionnez pour les jeux vidéo.",
  'Biked somewhere new': "Vous partez à vélo explorer un endroit que vous ne connaissiez pas.",
  'Got sick for a week': "Vous restez malade toute une semaine.",
  'Joined a school team': "Vous intégrez une équipe de l'école.",
  'Started a diary': "Vous commencez à tenir un journal intime.",
  'Got a first part-time job': "Vous décrochez votre premier petit boulot.",
  'Performed on a stage': "Vous montez sur scène pour la première fois, le cœur battant.",
  'Won academic award': "Vous recevez un prix pour vos résultats scolaires.",
  'Graduated': "Vous obtenez votre diplôme.",
  'Got first job': "Vous commencez votre premier vrai travail.",
  'Ran a marathon': "Vous terminez votre premier marathon.",
  'Got driver license': "Vous obtenez le permis de conduire.",
  'Had health scare': "Une alerte de santé vous inquiète quelques semaines.",
  'Travelled alone for the first time': "Vous partez en voyage seul{e} pour la première fois.",
  'Set a long-term goal': "Vous vous fixez un objectif pour les années à venir.",
  'Posted your first photo online': "Vous publiez votre première photo en ligne.",
  'Got promoted': "Vous obtenez une promotion.",
  'Got big promotion': "Vous obtenez une promotion importante.",
  'Bought a car': "Vous achetez votre première voiture.",
  'Had health issue': "Un souci de santé vous oblige à lever le pied.",
  'Started a project outside work': "Vous lancez un projet personnel en dehors du travail.",
  'Took up a new hobby': "Vous vous trouvez un nouveau loisir.",
  'Took a work trip abroad': "Votre travail vous envoie à l'étranger pour la première fois.",
  'Started a regular checkup habit': "Vous prenez l'habitude de faire un bilan de santé chaque année.",
  'Took a night class': "Vous suivez des cours du soir.",
  'Family trip': "Vous partez en voyage avec toute la famille.",
  'Child graduated': "Votre enfant obtient son diplôme. Vous êtes au premier rang.",
  'Took vacation': "Vous partez en vacances.",
  'Grandchild born': "Vous devenez grand-{père|mère}.",
  'Health checkup': "Vous passez un bilan de santé.",
  'Went back to school': "Vous reprenez des études.",
  'Lost a loved one': "Vous perdez un être cher.",
  'The roles reversed with a parent': "Les rôles s'inversent : c'est vous qui veillez maintenant sur vos parents.",
  'Adopted a pet': "Vous adoptez un animal.",
  'Started cooking at home': "Vous vous mettez à cuisiner à la maison.",
  'Learned to use a smartphone': "Vous apprenez à vous servir d'un smartphone.",
  'Helped the kids with homework': "Vous passez la soirée à aider votre enfant à faire ses devoirs.",
  'Started thinking about retirement': "Vous commencez à penser à la retraite.",
  'Grandchildren visit': "Vos petits-enfants viennent passer la journée chez vous.",
  'Walked in the park': "Vous prenez l'habitude d'une longue promenade.",
  'Read a great book': "Vous lisez un livre qui vous marque.",
  'Saw grandchild grow': "Vous regardez vos petits-enfants grandir.",
  'Had health check': "Vous passez un bilan de santé.",
  'Sat on a bench watching the street': "Vous passez de longs moments sur un banc à regarder la rue.",
  'Had tea with an old friend': "Vous prenez le thé avec un{|e} ami{e} de toujours.",
  'Took up gardening': "Vous vous mettez au jardinage.",
  'Joined a community class for seniors': "Vous rejoignez un atelier pour les aînés du quartier.",
  'Danced at a community night': "Vous dansez à la fête du quartier.",
  'Called up an old friend': "Vous appelez un{|e} ami{e} perdu{e} de vue.",
  'Learned to knit': "Vous apprenez à tricoter.",
  'Started writing a memoir': "Vous commencez à écrire vos souvenirs.",
  'Went to a funeral': "Vous assistez aux obsèques d'une connaissance.",
  'Kept an old photo on the shelf': "Vous posez une vieille photo sur l'étagère.",
  'Affected by local unrest': "Des troubles éclatent près de chez vous.",
});
const relIs = (life, re) => re.test(String(life.stats.religion || ''));
const isChristian = (life) => relIs(life, /christ|cathol|protest|orthod/i);
const isMuslim = (life) => relIs(life, /islam|muslim/i);
const isHindu = (life) => relIs(life, /hindou|hindu/i);
const isBuddhist = (life) => relIs(life, /boudd|buddh/i);
const isRural = (life) => life.stats.birthPlaceType === 'rural';
// a : âges ; w : poids ; rep : false = une seule fois dans la vie ; fx : effets (voir applyFx)
const RECIT = [
  { a: [0, 1], i: '💉', rep: false, en: 'You get your first vaccines.', fr: "Vous recevez vos premiers vaccins." },
  { a: [1, 3], i: '🍲', rep: false, en: 'You taste the family dish for the first time.', fr: "Vous goûtez pour la première fois au plat que toute la famille adore." },
  { a: [2, 5], i: '🌧️', en: 'You jump in every puddle on the way.', fr: "Vous sautez à pieds joints dans toutes les flaques du chemin." },
  { a: [1, 12], i: '🕯️', when: (l) => pppOf(l) < 6000, en: 'The power is out again; the evening goes by lamplight.', fr: "Le courant saute encore : la soirée se passe à la lueur d'une lampe." },
  { a: [4, 9], i: '🪁', en: 'You play outside with the neighbourhood children until dark.', fr: "Vous jouez dehors avec les enfants du voisinage jusqu'à la tombée de la nuit." },
  { a: [5, 11], i: '🚶', when: (l) => isRural(l) && pppOf(l) < 8000 && inSchool(l), en: 'School is far: you walk an hour each way.', fr: "L'école est loin : vous faites chaque jour une heure de marche pour vous y rendre." },
  { a: [5, 11], i: '🚌', when: (l) => pppOf(l) >= 15000 && inSchool(l), en: 'You take the school bus every morning, always in the same seat.', fr: "Vous prenez le car scolaire chaque matin, toujours à la même place." },
  { a: [5, 13], i: '🥣', when: (l) => pppOf(l) < 5000 && quartOf(l) <= 2, fx: { health: -1 }, en: 'Some evenings there is not enough food for everyone.', fr: "Certains soirs, il n'y a pas assez à manger pour tout le monde." },
  { a: [6, 12], i: '🧑‍🏫', when: inSchool, fx: { know: 1 }, en: 'A teacher believes in you and gives you a taste for learning.', fr: "Une institutrice croit en vous et vous donne le goût d'apprendre." },
  { a: [5, 10], i: '🚲', rep: false, when: comfortable(4000), en: 'You learn to ride a bike, knees scraped and grinning.', fr: "Vous apprenez à faire du vélo, les genoux écorchés et le sourire aux lèvres." },
  { a: [7, 13], i: '🐐', when: (l) => isRural(l) && (l.countryData?.agr || 0) > 30, en: 'After class, you mind the family animals.', fr: "Après la classe, vous gardez les bêtes de la famille." },
  { a: [7, 14], i: '💧', when: (l) => isRural(l) && pppOf(l) < 5000, en: 'Each morning, you are the one who fetches the water before school.', fr: "Chaque matin, c'est vous qui allez chercher l'eau avant l'école." },
  { a: [6, 12], i: '🎂', when: comfortable(8000), en: 'For your birthday, the whole class is invited home.', fr: "Pour votre anniversaire, toute la classe est invitée à la maison." },
  { a: [8, 14], i: '📺', when: online(30), en: 'You spend hours on videos until the screen is taken away.', fr: "Vous passez des heures devant des vidéos, jusqu'à ce qu'on vous confisque l'écran." },
  { a: [4, 85], i: '🎄', when: isChristian, en: 'The whole family gathers for the Christmas meal.', fr: "Toute la famille se retrouve autour du repas de Noël." },
  { a: [4, 85], i: '🌙', when: isMuslim, en: 'At the end of Ramadan, you celebrate Eid with the whole family.', fr: "À la fin du ramadan, vous fêtez l'Aïd avec toute la famille." },
  { a: [4, 85], i: '🪔', when: isHindu, en: 'For Diwali, the house is lit up and sweets are shared.', fr: "Pour Diwali, la maison s'illumine et l'on partage des sucreries." },
  { a: [4, 85], i: '🛕', when: isBuddhist, en: 'You go to the temple with the family for the New Year.', fr: "Vous accompagnez la famille au temple pour le Nouvel An." },
  { a: [11, 16], i: '📱', rep: false, when: online(50), en: 'You get your first phone and never put it down.', fr: "Vous recevez votre premier téléphone. Vous ne le lâchez plus." },
  { a: [11, 17], i: '🏃', en: 'You join the neighbourhood sports team and never miss a practice.', fr: "Vous rejoignez l'équipe de sport du quartier et ne manquez aucun entraînement." },
  { a: [11, 17], i: '🧹', when: (l) => quartOf(l) <= 2, en: 'At weekends you help your parents at work to make ends meet.', fr: "Le week-end, vous aidez vos parents au travail pour boucler les fins de mois." },
  { a: [12, 17], i: '😤', en: 'You argue with your parents and slam the door. By morning it is forgotten.', fr: "Vous vous disputez avec vos parents et claquez la porte. Le lendemain, tout est oublié." },
  { a: [10, 18], i: '👫', rep: false, fx: { social: 3 }, en: 'You form a friendship that will last for years.', fr: "Vous nouez une amitié qui durera des années." },
  { a: [18, 62], i: '🚌', when: (l) => isEmployed(l) && !isRural(l), en: 'You spend nearly two hours a day commuting.', fr: "Vous passez près de deux heures par jour dans les transports pour aller travailler." },
  { a: [20, 32], i: '🏠', rep: false, when: (l) => isEmployed(l) && pppOf(l) >= 10000, fx: { money: -1500, happy: 3 }, en: 'You leave the family home for your first place.', fr: "Vous quittez le domicile familial pour votre premier logement." },
  { a: [20, 35], i: '🏚️', rep: false, when: (l) => pppOf(l) < 10000, en: 'For lack of means, you go on living under the family roof, like most people your age here.', fr: "Faute de moyens, vous continuez de vivre sous le toit familial, comme la plupart des gens de votre âge ici." },
  { a: [20, 60], i: '💸', when: (l) => isEmployed(l) && pppOf(l) < 15000, fx: { money: -300, social: 2 }, en: 'You send part of your pay to the family back home.', fr: "Vous envoyez une partie de votre paie à la famille restée au village." },
  { a: [20, 45], i: '🎉', fx: { money: -150, social: 1 }, en: "You are invited to a friend's wedding and chip in.", fr: "Vous êtes invité{e} au mariage d'un ami et participez à la cagnotte." },
  { a: [18, 75], i: '🤧', fx: { health: -1 }, en: 'A bad flu keeps you in bed for a week.', fr: "Une mauvaise grippe vous cloue au lit toute une semaine." },
  { a: [20, 70], i: '🦷', when: comfortable(3000), fx: { money: -200 }, en: 'A toothache sends you to the dentist. The bill is yours.', fr: "Une rage de dents vous envoie chez le dentiste. La facture est pour vous." },
  { a: [20, 70], i: '🦷', when: (l) => pppOf(l) < 3000 && quartOf(l) <= 2, fx: { health: -2 }, en: 'A toothache hurts for weeks: the dentist is too expensive.', fr: "Une rage de dents vous fait souffrir des semaines : le dentiste est trop cher." },
  { a: [20, 62], i: '📉', w: 6, when: isEmployed, fx: { money: -2500, happy: -3 }, en: 'Your employer closes down. You go months without pay before finding work again.', fr: "Votre employeur ferme. Vous restez plusieurs mois sans salaire avant de retrouver du travail." },
  { a: [18, 65], i: '🌍', w: 5, when: isEmployed, fx: { money: -800 }, en: 'An economic crisis hits the country: prices rise, your wage does not.', fr: "Une crise économique frappe le pays : les prix montent, votre salaire non." },
  { a: [15, 70], i: '🚨', when: (l) => heavyOk() && (l.countryData?.hom || 0) > 8, fx: { money: -200, happy: -2 }, en: 'Your bag is snatched in the street.', fr: "On vous arrache votre sac dans la rue." },
  { a: [20, 70], i: '📦', fx: { social: 2 }, en: 'A neighbour is moving: you spend the day carrying boxes.', fr: "Un voisin déménage : vous passez la journée à porter ses cartons." },
  { a: [25, 60], i: '🧑‍🤝‍🧑', en: 'You bump into a childhood friend and talk until the middle of the night.', fr: "Vous retrouvez par hasard un{|e} ami{e} d'enfance. Vous parlez jusqu'au milieu de la nuit." },
  { a: [25, 58], i: '🏋️', when: (l) => isEmployed(l) && l.stats.education <= 2, fx: { health: -2 }, en: 'From carrying heavy loads, your back starts to hurt.', fr: "À force de porter des charges lourdes, votre dos commence à vous faire souffrir." },
  { a: [18, 80], i: '🍛', when: (l) => !!l.birthOrigin, fx: { social: 2 }, en: 'You cook a dish from your home country for your new neighbours.', fr: "Vous cuisinez un plat de votre pays natal pour vos nouveaux voisins." },
  { a: [18, 80], i: '📞', when: (l) => !!l.birthOrigin, en: 'On the phone with family back home, you sometimes search for words in your mother tongue.', fr: "Au téléphone avec la famille restée au pays, vous cherchez parfois vos mots dans votre langue maternelle." },
  { a: [22, 50], i: '👣', when: hasKids, en: 'Your child takes a few steps towards you.', fr: "Votre enfant fait quelques pas vers vous, les bras tendus." },
  { a: [28, 60], i: '🎭', when: hasKids, en: "You watch your child's end-of-year show, moved.", fr: "Vous assistez, ému{e}, au spectacle de fin d'année de votre enfant." },
  { a: [38, 50], i: '🪞', rep: false, en: 'You spot your first grey hairs in the mirror.', fr: "Vous remarquez vos premiers cheveux blancs dans le miroir." },
  { a: [40, 55], i: '👓', rep: false, when: comfortable(3000), en: 'The doctor prescribes reading glasses.', fr: "Le médecin vous prescrit des lunettes pour lire." },
  { a: [40, 65], i: '🧓', when: (l) => anyParentAlive(l), en: 'You spend more and more time looking after your ageing parents.', fr: "Vous passez de plus en plus de temps à vous occuper de vos parents vieillissants." },
  { a: [65, 95], i: '📖', en: 'You tell the young ones about your childhood; they barely listen.', fr: "Vous racontez votre enfance aux plus jeunes, qui écoutent à peine." },
  { a: [65, 95], i: '🦵', fx: { health: -1 }, en: 'Your knees complain on the stairs.', fr: "Vos genoux protestent dans les escaliers." },
  { a: [65, 95], i: '😴', en: 'You nap every afternoon, without the slightest guilt.', fr: "Vous faites la sieste chaque après-midi, sans la moindre culpabilité." },
  { a: [62, 85], i: '🧺', when: (l) => pppOf(l) < 8000, en: 'With no pension, you keep working as long as your strength allows.', fr: "Faute de retraite, vous continuez à travailler tant que vos forces le permettent." },
];

// ---- Évènements du récit supplémentaires : région, pays, religion, habitudes ----
RECIT.push(
  { a: [10, 16], i: '🌙', rep: false, when: isMuslim, fr: "Vous jeûnez pour la première fois pendant le ramadan, fi{er|ère} d'aller jusqu'au bout." },
  { a: [4, 22], i: '🧧', when: reg('eap'), fx: { happy: 1 }, fr: "Pour le Nouvel An lunaire, les aînés vous glissent une enveloppe rouge." },
  { a: [25, 60], i: '🧧', when: (l) => reg('eap')(l) && hasKids(l), fx: { money: -100 }, fr: "Vous préparez des enveloppes rouges pour les enfants de la famille." },
  { a: [18, 50], i: '💒', when: reg('sa'), fx: { money: -100, social: 1 }, fr: "Vous assistez à un mariage de trois jours, avec des centaines d'invités." },
  { a: [15, 55], i: '💃', when: reg('lac'), fx: { social: 1 }, fr: "Le quartier fête un anniversaire en musique jusqu'à l'aube." },
  { a: [8, 70], i: '⚽', w: 8, when: reg('lac', 'ssa', 'eca', 'hi'), fx: { social: 1 }, fr: "Vous regardez un match de Coupe du monde avec tout le quartier, devant un seul écran." },
  { a: [5, 80], i: '🌾', when: (l) => isRural(l) && (l.countryData?.agr || 0) > 20, fx: { happy: 1 }, fr: "Le village fête la fin des récoltes : on chante, on mange, on danse." },
  { a: [15, 60], i: '🚐', when: (l) => ['ssa', 'sa', 'lac'].includes(l.countryData?.region) && pppOf(l) < 8000, fr: "Vous attendez le minibus pendant une heure, puis voyagez serré{|e} contre vos voisins." },
  { a: [3, 80], i: '🌧️', w: 5, when: inList(...MONSOON), fr: "La mousson inonde la rue pendant plusieurs jours : on circule avec de l'eau jusqu'aux genoux." },
  { a: [3, 80], i: '🥶', w: 6, when: inList(...COLD), fx: { money: -150 }, fr: "Un hiver glacial s'installe : le chauffage coûte cher et l'on rentre tôt." },
  { a: [3, 80], i: '🥵', w: 6, when: reg('mena', 'ssa', 'sa'), fx: { health: -1 }, fr: "Une vague de chaleur rend les nuits irrespirables." },
  { a: [3, 80], i: '🌋', w: 3, when: inList(...QUAKE), fx: { happy: -2 }, fr: "Un séisme secoue la région. La maison tient, mais personne ne dort chez soi cette nuit-là." },
  { a: [3, 80], i: '🌀', w: 3, when: inList(...CYCLONE), fx: { money: -300 }, fr: "Un cyclone arrache des toits dans le quartier. Il faut des semaines pour réparer." },
  { a: [20, 65], i: '📄', when: bribery, fx: { money: -80 }, fr: "On vous réclame un « petit cadeau » pour qu'un document soit enfin tamponné." },
  { a: [25, 75], i: '🏥', when: inList('USA'), fx: { money: -1800 }, fr: "Une facture d'hôpital imprévue arrive, bien plus élevée que prévu." },
  { a: [22, 55], i: '🕙', when: (l) => isEmployed(l) && inList(...OVERWORK)(l), fx: { health: -1 }, fr: "Vous restez au bureau bien après l'heure : personne ne part avant le chef." },
  { a: [22, 62], i: '🚶', when: (l) => isEmployed(l) && pppOf(l) > 20000 && reg('hi', 'eca')(l), fr: "Une grève des transports vous oblige à marcher une heure pour aller travailler." },
  { a: [18, 60], i: '📲', when: reg('ssa'), fr: "Vous envoyez de l'argent à votre famille par téléphone, en quelques secondes." },
  { a: [13, 35], i: '🎬', when: online(50), fx: { social: 1 }, fr: "Une vidéo de vous fait rire tout le quartier, puis des inconnus." },
  { a: [20, 45], i: '💐', when: sibs, fr: "L'un de vos frères et sœurs se marie. Toute la famille est réunie." },
  { a: [25, 55], i: '🍼', rep: false, when: sibs, fr: "Vous devenez {oncle|tante} : votre neveu vient au monde." },
  { a: [60, 60], i: '🎂', rep: false, fr: "Vous fêtez vos soixante ans entouré{e} des vôtres." },
  { a: [18, 20], i: '🗳️', rep: false, when: (l) => !NO_VOTE.includes(l.country), fr: "Vous votez pour la première fois, avec le sentiment que ça compte." },
  { a: [5, 70], i: '🌧️', w: 4, when: (l) => isRural(l) && pppOf(l) < 5000, fr: "La saison des pluies coupe la route : le village reste isolé pendant des semaines." },
  { a: [18, 65], i: '✊', w: 4, when: (l) => heavyOk() && reg('lac', 'mena', 'sa', 'ssa', 'eca')(l), fr: "Des manifestations bloquent le centre-ville pendant plusieurs jours." },
  { a: [25, 85], i: '😮‍💨', w: 10, when: (l) => !!l.smoker, fx: { health: -1 }, fr: "Votre toux du matin ne passe plus." },
  { a: [45, 85], i: '🫁', rep: false, w: 12, when: (l) => !!l.smoker, fx: { health: -6 }, fr: "On vous diagnostique une bronchite chronique : respirer devient un effort." },
  { a: [25, 80], i: '🤲', w: 10, when: (l) => !!l.drinker, fx: { health: -2, happy: -2 }, fr: "Vos mains tremblent le matin tant que vous n'avez pas bu." },
  { a: [16, 60], i: '💸', w: 10, when: (l) => !!l.addicted, fx: { money: -300, social: -3 }, fr: "Vous empruntez de l'argent à vos proches pour payer votre prochaine dose." },
  { a: [25, 70], i: '🪜', w: 8, when: (l) => !!l.sporty, fx: { health: 1 }, fr: "Vous montez trois étages sans être essouflé{e}." },
  { a: [30, 80], i: '🌬️', rep: false, w: 10, when: (l) => !!l.exSmoker, fx: { health: 2 }, fr: "Votre souffle revient : vous sentez la différence depuis que vous ne fumez plus." },
  { a: [8, 80], i: '🐕', w: 6, when: (l) => l.pet === 'dog', fx: { health: 1 }, fr: "Votre chien vous traîne dehors par tous les temps : vous marchez plus qu'avant." },
  { a: [8, 80], i: '🐈', w: 6, when: (l) => l.pet === 'cat', fx: { happy: 1 }, fr: "Votre chat s'endort sur vos genoux chaque soir." },
  { a: [10, 85], i: '🕊️', rep: false, w: 4, when: (l) => !!l.pet && l.petSince != null && l.age - l.petSince >= 10, fx: { happy: -4, flag: ['pet', null] }, fr: "Votre animal meurt de vieillesse. La maison paraît soudain vide." },
);

// ---- Évènements du récit : santé et maladies du pays, violence, argent, travail, famille, climat, croyances ----
RECIT.push(
  // santé et maladies endémiques
  { a: [15, 60], i: '🫁', rep: false, w: 3, when: (l) => pppOf(l) < 12000 && reg('ssa', 'sa', 'eap')(l), fx: { health: -5, money: -150 }, fr: "Une toux qui n'en finit pas vous inquiète : le dispensaire diagnostique une tuberculose, six mois de traitement." },
  { a: [3, 70], i: '🦟', w: 4, when: reg('lac', 'ssa', 'sa', 'eap'), fx: { health: -2 }, fr: "La dengue vous cloue au lit pendant une semaine." },
  { a: [3, 70], i: '🚰', w: 4, when: (l) => pppOf(l) < 4000, fx: { health: -2 }, fr: "L'eau du puits est contaminée : tout le quartier a la diarrhée pendant des jours." },
  { a: [10, 75], i: '😷', w: 4, when: (l) => reg('sa', 'eap')(l) && (l.countryData?.urb || 0) > 40, fx: { health: -1 }, fr: "Un smog épais couvre la ville pendant des semaines." },
  { a: [20, 50], i: '🤫', w: 3, when: (l) => (l.countryData?.hiv || 0) > 1, fx: { social: -1 }, fr: "Un voisin tombe malade du sida. On chuchote à son sujet et plus personne ne lui rend visite." },
  { a: [10, 80], i: '🕐', w: 5, when: poorish, fr: "Vous passez une journée entière dans la file d'un dispensaire public." },
  { a: [40, 70], i: '🩺', rep: false, fx: { health: -1 }, fr: "Le médecin découvre que votre tension est trop élevée." },
  { a: [30, 60], i: '⚖️', w: 4, when: (l) => pppOf(l) > 20000, fx: { health: -1 }, fr: "Vous prenez du poids depuis quelques années. Votre médecin vous met en garde." },
  { a: [5, 80], i: '🌿', w: 4, when: (l) => isRural(l) && pppOf(l) < 6000, fr: "Faute de médecin, vous consultez le guérisseur du village." },
  { a: [3, 17], i: '🏥', w: 3, when: (l) => (l.countryData?.oop || 0) > 30, fx: { money: -80 }, fr: "Une ordonnance pour vous pèse lourd sur le salaire de vos parents : ici, les soins se paient de sa poche." },
  { a: [18, 75], i: '🏥', w: 3, when: (l) => (l.countryData?.oop || 0) > 30, fx: { money: -200 }, fr: "Une ordonnance vous coûte une grosse part de la paie : ici, les soins se paient de sa poche." },
  // route, violence, armes
  { a: [15, 70], i: '🚗', w: 5, when: (l) => (l.countryData?.road || 0) > 15, fx: { happy: -1 }, fr: "Vous êtes témoin d'un grave accident sur la route que vous prenez chaque jour." },
  { a: [18, 70], i: '🚙', w: 4, when: comfortable(8000), fx: { money: -300 }, fr: "Un accrochage sans gravité abîme votre véhicule." },
  { a: [8, 70], i: '🔫', w: 6, when: (l) => heavyOk() && gunny(l), fx: { happy: -2 }, fr: "Des coups de feu retentissent dans le quartier. Les voisins s'enferment chez eux." },
  { a: [6, 17], i: '🏫', w: 5, when: inList('USA'), fr: "À l'école, vous participez à un exercice de confinement en cas de tireur." },
  { a: [18, 70], i: '🌃', w: 4, when: (l) => heavyOk() && ((l.countryData?.hom || 0) > 30 || (l.countryData?.war || 0) >= 1), fx: { social: -1 }, fr: "Un couvre-feu s'installe : plus personne ne sort le soir." },
  { a: [18, 65], i: '🚓', w: 4, when: reg('lac', 'ssa', 'mena'), fr: "Un contrôle de police vous retient une heure au bord de la route." },
  { a: [20, 60], i: '🧾', w: 4, when: (l) => heavyOk() && (l.countryData?.hom || 0) > 20 && pppOf(l) < 20000, fx: { money: -200 }, fr: "Des hommes du quartier exigent une « taxe » pour vous laisser travailler tranquille." },
  { a: [3, 70], i: '💥', w: 3, when: (l) => heavyOk() && (l.countryData?.war || 0) >= 1, fx: { happy: -4 }, fr: "Un bombardement touche un quartier voisin. La nuit, personne ne dort." },
  { a: [3, 70], i: '🏕️', w: 3, when: (l) => heavyOk() && (l.countryData?.war || 0) >= 1, fx: { social: 1 }, fr: "Votre famille héberge des déplacés venus d'une région en guerre." },
  // argent
  { a: [20, 60], i: '🪙', w: 5, when: (l) => pppOf(l) < 12000 && reg('ssa', 'sa', 'mena', 'lac')(l), fx: { social: 1 }, fr: "Vous participez à une tontine entre voisins : chacun reçoit la cagnotte à son tour." },
  { a: [8, 80], i: '🛒', w: 5, when: (l) => pppOf(l) < 10000, fx: { money: -100 }, fr: "Les prix du marché augmentent encore ; le panier de la semaine coûte plus cher." },
  { a: [20, 60], i: '⏳', w: 4, when: (l) => isEmployed(l) && pppOf(l) < 12000, fx: { happy: -1 }, fr: "Votre salaire arrive avec trois semaines de retard." },
  { a: [18, 30], i: '🏦', rep: false, when: (l) => pppOf(l) >= 15000, fr: "Vous ouvrez votre premier compte en banque." },
  { a: [18, 35], i: '📱', rep: false, when: (l) => reg('ssa', 'sa')(l) && pppOf(l) < 8000, fr: "Vous ouvrez un compte d'argent mobile : plus besoin de tout porter en liquide." },
  { a: [20, 30], i: '🧮', rep: false, when: (l) => reg('hi', 'eca')(l) && pppOf(l) > 20000, fr: "Vous remplissez votre première déclaration d'impôts, en vous trompant deux fois." },
  { a: [18, 70], i: '⛽', w: 4, when: (l) => reg('lac', 'ssa', 'mena', 'sa')(l), fx: { money: -100 }, fr: "Le prix de l'essence grimpe, et avec lui celui des transports." },
  { a: [15, 70], i: '🧺', w: 5, when: (l) => isRural(l) && (l.countryData?.agr || 0) > 30, fr: "Le jour du marché, vous vendez votre récolte au bord de la route." },
  // école et travail
  { a: [15, 19], i: '📝', w: 5, when: reg('eap', 'sa', 'mena'), fx: { happy: -1 }, fr: "Vous attendez les résultats du grand examen, la gorge serrée." },
  { a: [8, 17], i: '🌙', w: 4, when: (l) => reg('eap')(l) && comfortable(8000)(l), fx: { know: 1, happy: -1 }, fr: "Chaque soir, vous suivez des cours privés après l'école." },
  { a: [6, 14], i: '👔', w: 3, when: (l) => reg('ssa', 'sa', 'lac')(l) && inSchool(l), fr: "Vous portez l'uniforme de l'école, un peu trop grand pour que ça dure." },
  { a: [6, 14], i: '🪑', w: 4, when: (l) => poorish(l) && inSchool(l), fx: { know: -1 }, fr: "Votre instituteur est absent pendant des semaines et la classe se vide." },
  { a: [18, 22], i: '🏛️', w: 4, when: (l) => l.stats.employment === 'university', fx: { social: 2 }, fr: "Vous découvrez la vie de campus : cours, cafétéria, nuits blanches avant les examens." },
  { a: [19, 25], i: '📎', w: 3, when: (l) => l.stats.education >= 3 && comfortable(8000)(l), fx: { know: 1 }, fr: "Vous faites un stage non rémunéré en espérant qu'il débouche sur un emploi." },
  { a: [18, 60], i: '🧱', w: 5, when: (l) => isEmployed(l) && poorish(l), fr: "Vous travaillez sans contrat, payé à la journée, sans savoir de quoi demain sera fait." },
  { a: [20, 55], i: '🥵', w: 4, when: (l) => isEmployed(l) && poorish(l), fx: { health: -1 }, fr: "Dans l'atelier, la chaleur est étouffante : vous buvez toute la journée." },
  { a: [20, 50], i: '🌙', w: 4, when: isEmployed, fx: { health: -1 }, fr: "Vous enchaînez les semaines de travail de nuit : vous ne vous couchez qu'au lever du jour." },
  { a: [25, 60], i: '🏠', w: 4, when: (l) => isEmployed(l) && online(60)(l) && comfortable(12000)(l), fr: "Vous travaillez de chez vous deux jours par semaine." },
  { a: [60, 66], i: '🥂', rep: false, when: (l) => l.stats.employment === 'retired', fr: "Vos collègues vous offrent un pot de départ à la retraite." },
  { a: [25, 60], i: '🤝', rep: false, when: (l) => isEmployed(l) && reg('hi', 'eca', 'lac')(l), fx: { social: 1 }, fr: "Vous adhérez à un syndicat après une réunion animée." },
  // famille et vie sociale
  { a: [25, 70], i: '⚰️', w: 4, when: reg('ssa', 'lac', 'sa'), fx: { money: -100, social: 1 }, fr: "Vous passez trois jours aux obsèques d'un oncle : toute la famille élargie est là." },
  { a: [45, 60], i: '🚪', rep: false, when: hasKids, fr: "Votre aîné quitte la maison. Le silence vous surprend." },
  { a: [50, 65], i: '↩️', rep: false, when: hasKids, fx: { money: -200 }, fr: "Votre enfant revient vivre chez vous après un échec." },
  { a: [25, 40], i: '👵', w: 5, when: (l) => hasKids(l) && pppOf(l) < 15000, fr: "Votre mère garde les enfants pendant que vous travaillez." },
  { a: [20, 80], i: '🍽️', w: 6, fx: { social: 1 }, fr: "Le dimanche, toute la famille se retrouve pour un long repas chez vos parents." },
  { a: [20, 60], i: '💬', w: 4, when: online(50), fr: "Le groupe de messagerie du quartier ne se tait plus, même la nuit." },
  { a: [25, 60], i: '💍', w: 4, when: (l) => l.stats.married, fx: { happy: 1 }, fr: "Vous fêtez votre anniversaire de mariage." },
  { a: [10, 70], i: '🏟️', w: 5, fx: { social: 1 }, fr: "Vous suivez le championnat local avec toute la bande de copains." },
  { a: [16, 40], i: '🎶', w: 4, when: (l) => comfortable(8000)(l) && reg('hi', 'lac', 'eca')(l), fx: { happy: 1, money: -80 }, fr: "Vous partez à un festival de musique avec vos amis." },
  { a: [10, 80], i: '🛕', w: 4, when: (l) => isHindu(l), fx: { happy: 1 }, fr: "Vous vous baignez dans le fleuve sacré lors d'une grande fête." },
  { a: [6, 80], i: '⛪', w: 5, when: (l) => isChristian(l) && reg('lac', 'eca', 'ssa')(l), fr: "Vous allez à la messe, puis déjeunez en famille." },
  { a: [10, 80], i: '🕌', w: 5, when: isMuslim, fr: "Après la prière du vendredi, la famille se retrouve autour d'un grand plat." },
  { a: [20, 80], i: '🗳️', w: 4, when: (l) => !NO_VOTE.includes(l.country), fr: "Jour d'élection : la file devant le bureau de vote est longue." },
  // climat et environnement
  { a: [5, 70], i: '🏜️', w: 4, when: (l) => isRural(l) && reg('ssa', 'sa')(l) && (l.countryData?.agr || 0) > 20, fx: { money: -100 }, fr: "La sécheresse dure : les puits baissent et les bêtes maigrissent." },
  { a: [5, 70], i: '🦗', w: 2, when: (l) => isRural(l) && reg('ssa')(l), fx: { money: -100 }, fr: "Un nuage de criquets s'abat sur les champs voisins." },
  { a: [5, 80], i: '🔥', w: 3, when: inList(...FIRE), fr: "Les incendies de forêt enfument la région pendant plusieurs jours." },
  { a: [10, 70], i: '🏖️', w: 3, when: inList(...TOURIST), fr: "Des touristes envahissent votre quartier chaque été : tout y devient plus cher." },
  { a: [3, 80], i: '❄️', w: 4, when: inList(...COLD), fr: "Il neige : l'école ferme et la ville s'arrête une journée." },
  { a: [18, 80], i: '☎️', w: 3, when: (l) => !!l.birthOrigin, fr: "Un appel de la famille restée au pays vous rappelle d'où vous venez." },
  { a: [18, 50], i: '🛬', w: 3, when: (l) => !!l.birthOrigin, fr: "Un cousin arrive du pays pour quelques semaines : vous lui montrez la ville." },
  { a: [20, 45], i: '🪪', w: 3, when: (l) => !!l.birthOrigin && !l.naturalized, fx: { money: -80 }, fr: "Il faut renouveler vos papiers de séjour : files d'attente et justificatifs à n'en plus finir." },
  { a: [6, 60], i: '🎈', w: 3, when: comfortable(8000), fr: "Vous fêtez un anniversaire dans un parc, avec des ballons et trop de gâteau." },
);

const motherAlive = (l) => { const m = ((l.family && l.family.parents) || []).find(x => x.sex === 'F'); return !!m && isAliveAt(m, l.year + l.yearOffset); };
const fatherAlive = (l) => { const m = ((l.family && l.family.parents) || []).find(x => x.sex === 'M'); return !!m && isAliveAt(m, l.year + l.yearOffset); };
const gpAlive = (l) => ((l.family && l.family.grandparents) || []).some(g => isAliveAt(g, l.year + l.yearOffset));
const hasFriends = (l) => !!(l.friends && l.friends.length);
const hasPartner = (l) => !!(l.stats && l.stats.partner);
const herdOf = (l) => !!l.herd;
const renting = (l) => l.housing && l.housing.type === 'rent';
const owning = (l) => l.housing && ['own', 'mortgage'].includes(l.housing.type);
// ==== Scènes de vie plus intimes : des proches nommés, des souvenirs, des gestes qui comptent ====
const youngKid = (a, b) => (l) => { const ks = (l.stats && l.stats.kids) || []; if (!ks.length) return false; const y = ks.reduce((m, k) => k.bornAt > m.bornAt ? k : m, ks[0]); const ag = l.age - y.bornAt; return ag >= a && ag <= b; };
const aloneNow = (l) => !l.stats.married && ['single', 'divorced'].includes(l.stats.relationship || 'single');
RECIT.push(
  // enfance
  { a: [4, 9], i: '🌙', w: 5, rep: true, when: motherAlive, fx: { happy: 2, social: 1 }, fr: "Un soir d'orage, vous vous glissez dans le lit de {mere}. Elle ne dit rien, elle vous serre contre elle, et l'orage n'a plus d'importance." },
  { a: [5, 11], i: '🥣', w: 4, when: (l) => motherAlive(l) || fatherAlive(l), fx: { happy: 2 }, fr: "Vous êtes malade, et quelqu'un de la maison veille près de vous toute la nuit. Vous vous rappellerez longtemps la fraîcheur de sa main sur votre front." },
  { a: [6, 12], i: '🎒', w: 4, rep: false, when: (l) => inSchool(l), fx: { happy: 1 }, fr: "Vous oubliez votre cahier le jour du contrôle. Votre voisin de classe vous prête le sien sans rien demander : vous en faites votre meilleur ami." },
  { a: [7, 13], i: '🧸', w: 3, rep: false, when: (l) => sibs(l), fx: { social: 2, happy: 1 }, fr: "{frere} et vous inventez un jeu avec trois bouts de ficelle et des cartons. Vous ne saviez pas que vous parleriez encore de cet après-midi trente ans plus tard." },
  { a: [8, 14], i: '🏆', w: 3, rep: false, when: (l) => inSchool(l) && (motherAlive(l) || fatherAlive(l)), fx: { happy: 3, know: 1 }, fr: "À la remise des prix, vous cherchez dans la salle le visage de vos parents. Quand vous le trouvez, il est déjà mouillé de larmes." },
  { a: [9, 15], i: '🐕', w: 3, rep: false, when: (l) => !(l.pets || []).length && !reg('hi')(l), fx: { happy: 2 }, fr: "Un chien errant vous suit jusqu'à la maison trois jours de suite. Vous lui laissez un bol d'eau, puis un peu de pain, puis une place." },
  { a: [11, 16], i: '💌', w: 4, rep: false, when: (l) => inSchool(l), fx: { happy: -1, social: 1 }, fr: "Vous écrivez un mot à quelqu'un que vous n'osez pas aborder, puis vous le déchirez en mille morceaux. Le cœur bat encore longtemps après." },
  { a: [12, 17], i: '🪞', w: 3, rep: false, fx: { happy: -2 }, fr: "Vous vous comparez à tout le monde et vous trouvez que vous ne valez pas grand-chose. Personne ne le saura, et pourtant c'est l'été le plus long de votre vie." },
  // jeunesse
  { a: [16, 22], i: '🚪', w: 4, rep: false, when: (l) => motherAlive(l) || fatherAlive(l), fx: { social: 1, happy: 1 }, fr: "La veille de votre départ de la maison, {mere} range votre valise une deuxième fois, en silence. Vous comprenez à ce geste tout ce qu'elle ne sait pas dire." },
  { a: [18, 26], i: '📞', w: 4, rep: true, when: (l) => hasFriends(l), fx: { social: 2 }, fr: "{ami} vous appelle à minuit, juste pour prendre de vos nouvelles. Vous restez au téléphone une heure, sans rien de particulier à raconter." },
  { a: [18, 28], i: '🌅', w: 3, rep: false, fx: { happy: 2 }, fr: "Vous passez une nuit blanche à discuter de la vie avec des amis, et le soleil vous surprend sur un toit. Vous aurez rarement été aussi léger." },
  { a: [19, 30], i: '💔', w: 4, rep: false, when: (l) => l.stats.relationship === 'dating' || l.stats.relationship === 'cohab', fx: { happy: -3, social: -1 }, fr: "{conj} et vous vous disputez violemment pour une broutille. En claquant la porte, vous savez déjà que le vrai sujet est ailleurs." },
  { a: [20, 35], i: '🤝', w: 3, rep: false, when: (l) => hasPartner(l) && l.stats.relationship !== 'single', fx: { happy: 3, social: 1 }, fr: "Après une longue dispute, c'est {conj} qui fait le premier pas. Vous vous réconciliez en riant de votre entêtement." },
  { a: [22, 35], i: '🎂', w: 3, rep: true, when: (l) => hasPartner(l) && l.stats.relationship !== 'single', fx: { happy: 2 }, fr: "{conj} a préparé votre repas préféré, avec la nappe des grands jours. Vous ne savez pas quoi dire, alors vous la regardez longtemps." },
  // vie adulte
  { a: [25, 55], i: '🍂', w: 4, rep: true, when: (l) => motherAlive(l), fx: { social: 1 }, fr: "Vous remarquez que {mere} répète les mêmes histoires, et qu'elle a un peu rapetissé. Ce jour-là, vous écoutez chaque mot comme si c'était la première fois." },
  { a: [30, 65], i: '📷', w: 3, rep: true, fx: { happy: 2, social: 1 }, fr: "En triant de vieilles photos, vous retrouvez un visage que vous aviez presque oublié. Vous restez longtemps à regarder ceux que vous étiez." },
  { a: [28, 60], i: '🤗', w: 3, rep: true, when: (l) => hasKids(l), fx: { happy: 3 }, fr: "Un soir, {enfant} vous serre dans ses bras sans raison, juste parce que l'envie lui en a pris. Vous n'avez rien fait pour le mériter, et c'est exactement ce qui vous bouleverse." },
  { a: [30, 70], i: '🧶', w: 3, rep: false, when: (l) => hasKids(l) && youngKid(0, 5)(l), fx: { happy: 2 }, fr: "{enfant} vous offre un dessin : trois bonshommes et un soleil trop jaune. Vous l'accrochez au mur, bien en vue, et vous le garderez toujours." },
  { a: [30, 70], i: '🛌', w: 4, rep: true, when: (l) => hasKids(l) && youngKid(0, 3)(l), fx: { health: -1, happy: 1 }, fr: "{enfant} a pleuré toute la nuit. Vous marchez dans le couloir en le berçant, épuisé{e} et pourtant incapable de lui en vouloir." },
  { a: [35, 70], i: '🏫', w: 3, rep: false, when: (l) => hasKids(l) && youngKid(6, 14)(l), fx: { happy: 2, social: 1 }, fr: "À la fête de l'école, {enfant} vous cherche des yeux dans le public, vous fait un signe de la main, et vous comprenez que vous comptez beaucoup pour {enfant}." },
  { a: [38, 70], i: '🎓', w: 3, rep: false, when: (l) => hasKids(l) && youngKid(18, 26)(l), fx: { happy: 4 }, fr: "{enfant} a fini ses études. Vous qui n'avez jamais su dire votre fierté, vous trouvez enfin les mots, et vous pleurez un peu." },
  { a: [40, 70], i: '🪟', w: 3, rep: false, when: (l) => hasKids(l) && youngKid(18, 30)(l), fx: { social: -1, happy: -1 }, fr: "La chambre de {enfant} est vide depuis hier. Vous passez devant la porte plusieurs fois par jour, sans oser y entrer." },
  { a: [35, 65], i: '🕊️', w: 3, rep: false, when: (l) => hasPartner(l) && l.stats.married, fx: { happy: 3, social: 1 }, fr: "Vous réalisez que {conj} connaît toutes vos manies, et que c'est précisément pour cela que vous l'aimez." },
  { a: [30, 60], i: '🧳', w: 3, rep: false, when: (l) => hasPartner(l) && l.stats.married, fx: { happy: 2, pppx: -0.02 }, fr: "{conj} et vous partez deux jours au bord de l'eau, sans enfants, sans téléphone. Vous vous redécouvrez comme au premier jour." },
  { a: [30, 65], i: '🌧️', w: 3, rep: false, when: (l) => isEmployed(l), fx: { happy: -2 }, fr: "Vous sortez du bureau sous la pluie en vous demandant si c'est vraiment cela que vous vouliez de la vie. Personne ne vous répond." },
  { a: [25, 60], i: '🍵', w: 3, rep: true, when: (l) => isEmployed(l) && !reg('hi')(l), fx: { social: 1 }, fr: "À la pause, {collegue} vous raconte ses soucis, et vous lui racontez les vôtres. Vous repartez travailler avec un poids en moins." },
  { a: [30, 70], i: '🔔', w: 3, rep: false, when: hasFriends, fx: { social: 2 }, fr: "{ami} frappe à votre porte avec un gâteau, sans prévenir : « Je passais par là. » Vous savez très bien que ce n'est pas un hasard." },
  // parents et grands-parents
  { a: [40, 70], i: '📻', w: 3, rep: false, when: (l) => fatherAlive(l), fx: { happy: 1 }, fr: "Vous retrouvez {pere} penché sur son vieux poste de radio, comme quand vous étiez petit{e}. Vous vous asseyez à côté de lui sans parler." },
  { a: [40, 75], i: '🍲', w: 3, rep: true, when: (l) => motherAlive(l), fx: { happy: 2, social: 1 }, fr: "{mere} vous prépare le plat de votre enfance. Vous n'en avez plus faim, mais vous mangez jusqu'à la dernière bouchée pour la voir sourire." },
  { a: [45, 75], i: '🕯️', w: 3, rep: false, when: (l) => !motherAlive(l) && ((l.family && l.family.parents) || []).some(p => p.sex === 'F'), fx: { happy: -2 }, fr: "En ouvrant le tiroir de {mere}, vous retrouvez une odeur que vous croyiez perdue. Vous restez agenouillé{e}, un vêtement entre les mains." },
  { a: [45, 80], i: '✉️', w: 3, rep: false, when: (l) => !fatherAlive(l) && ((l.family && l.family.parents) || []).some(p => p.sex === 'M'), fx: { happy: -1, social: 1 }, fr: "Vous relisez les rares lettres de {pere}. Elles sont maladroites, mal écrites, et vous y entendez enfin sa voix." },
  // vieillesse
  { a: [60, 90], i: '🪑', w: 4, rep: true, when: (l) => aloneNow(l), fx: { happy: -2 }, fr: "Le silence de la maison devient lourd. Vous laissez la radio allumée pour qu'il y ait une voix." },
  { a: [60, 90], i: '📖', w: 3, rep: true, when: (l) => hasKids(l), fx: { happy: 2, social: 1 }, fr: "{enfant} vous demande de raconter votre jeunesse, et vous parlez des heures. Vous réalisez que vous ne vous étiez jamais livré{e} ainsi." },
  { a: [60, 90], i: '🌻', w: 3, rep: true, fx: { happy: 2 }, fr: "Un matin de printemps, vous restez longtemps à regarder le soleil entrer par la fenêtre. Vous vous sentez, sans raison, reconnaissant{e}." },
  { a: [65, 90], i: '🎞️', w: 3, rep: false, when: (l) => hasPartner(l), fx: { happy: 2, social: 1 }, fr: "{conj} et vous regardez ensemble d'anciennes photos. Vous riez des coiffures, puis vous vous taisez longuement, la main dans la main." },
  { a: [65, 90], i: '👵', w: 3, rep: false, when: (l) => hasKids(l) && l.age >= 60, fx: { happy: 3 }, fr: "Vos petits-enfants s'invitent chez vous et mettent la maison sens dessus dessous. Quand ils repartent, vous avez les larmes aux yeux, de bonheur et de silence." },
);
RECIT.push(
  // bétail
  { a: [18, 75], i: '🐑', w: 5, when: herdOf, fx: () => ({ pppx: 0.04, happy: 1 }), fr: "Votre troupeau a grandi : de nouveaux petits sont nés ce printemps, et vous en vendez quelques-uns au marché." },
  { a: [18, 75], i: '🌵', w: 4, when: herdOf, fx: { pppx: -0.1, happy: -3 }, fr: "La sécheresse s'installe. Les pâturages jaunissent et vous devez acheter du fourrage pour sauver vos bêtes." },
  { a: [18, 75], i: '🩺', w: 3, when: herdOf, fx: { pppx: -0.06, happy: -2 }, fr: "Une maladie touche le troupeau. Le vétérinaire est loin, et vous perdez quelques bêtes." },
  { a: [18, 75], i: '🥛', w: 4, when: herdOf, fx: { happy: 2 }, fr: "Vous vendez le lait et le fromage au marché du village : les voisins reconnaissent maintenant votre étal." },
  // logement
  { a: [25, 80], i: '🏠', w: 4, when: renting, fx: { pppx: -0.04, happy: -2 }, fr: "Votre propriétaire augmente le loyer. Vous hésitez entre payer plus et déménager." },
  { a: [25, 80], i: '🔧', w: 4, when: owning, fx: { pppx: -0.05, happy: -1 }, fr: "La toiture fuit : les travaux coûtent cher, mais c'est votre maison et personne d'autre ne les paiera." },
  { a: [25, 80], i: '🌳', w: 3, when: owning, fx: { happy: 2 }, fr: "Vous plantez un arbre dans votre jardin. Vous savez maintenant que vous le verrez grandir." },
  { a: [25, 80], i: '📦', w: 3, when: renting, fx: { happy: -1 }, fr: "Un nouveau déménagement : encore des cartons, encore un quartier à apprivoiser." },
  // zones
  { a: [8, 60], i: '🍚', w: 3, when: reg('eap', 'sa'), fx: { happy: 1 }, fr: "Toute la famille se retrouve autour du repas du dimanche, trois générations autour de la table." },
  { a: [10, 70], i: '🪔', w: 4, when: (l) => l.country === 'IND' || l.country === 'NPL', fx: { social: 1, happy: 1 }, fr: "À Diwali, vous allumez des lampes à huile devant la maison et partagez des sucreries avec tous les voisins." },
  { a: [10, 70], i: '🌙', w: 5, when: isMuslim, fx: { social: 1, happy: 1 }, fr: "La fin du ramadan : on s'embrasse, on se rend visite, et les enfants reçoivent un peu d'argent." },
  { a: [10, 70], i: '🥁', w: 4, when: reg('ssa'), fx: { social: 1, happy: 1 }, fr: "Les tambours résonnent dans le village : un mariage, et tout le monde danse jusqu'à tard dans la nuit." },
  { a: [20, 60], i: '🚌', w: 4, when: (l) => reg('ssa', 'sa', 'lac')(l) && !l.hasCar, fx: { happy: -1 }, fr: "Le minibus est tombé en panne en pleine route. Vous marchez des heures sous le soleil." },
  { a: [5, 60], i: '🌧️', w: 4, when: (l) => MONSOON.includes(l.country), fx: { happy: -1 }, fr: "La mousson est arrivée : les rues sont inondées, et il faut porter les enfants à l'école." },
  { a: [5, 70], i: '❄️', w: 4, when: (l) => COLD.includes(l.country), fx: { health: -1 }, fr: "Un hiver très froid : vous passez les soirées autour du poêle, à parler de tout et de rien." },
  { a: [10, 70], i: '🎣', w: 3, when: reg('eap', 'ssa', 'lac'), fx: { happy: 1 }, fr: "Une journée de pêche avec vos proches : peu de prises, beaucoup de rires." },
  { a: [18, 60], i: '📱', w: 4, when: (l) => (l.countryData?.net || 0) > 40, fx: { social: 1 }, fr: "Vous appelez vos proches en visio le soir : la distance se réduit un peu." },
  { a: [30, 70], i: '☕', w: 4, when: reg('hi', 'eca'), fx: { social: 1 }, fr: "Le café du coin vous connaît par votre prénom : vous y retrouvez les mêmes visages chaque matin." },
  { a: [18, 60], i: '🧺', w: 3, when: (l) => poorish(l) && l.stats.employment === 'employed', fx: { pppx: -0.02, happy: -1 }, fr: "Les prix du marché ont encore monté : vous remplissez moins le panier que le mois dernier." },
  { a: [30, 75], i: '🧓', w: 3, when: (l) => hasKids(l) && l.age > 55, fx: { happy: 2 }, fr: "Vos enfants vous appellent le dimanche, comme chaque semaine. Cet appel est devenu le plus beau moment de la semaine." },
);

// ---- Cinquante scènes de vie : proches nommés, gestes, souvenirs, culture du pays ----
RECIT.push(
  // amis et voisins
  { a: [9, 60], i: '🔔', w: 6, when: hasFriends, fx: { social: 1 }, fr: "Un matin, {ami} sonne à votre porte sans prévenir. Vous passez la journée à ne rien faire, et c'est parfait." },
  { a: [18, 60], i: '🚚', w: 4, when: hasFriends, fr: "{ami} vous annonce son départ dans une autre ville. Vous promettez de vous écrire, tout en sachant que ce sera plus rare." },
  { a: [25, 60], i: '🥂', w: 4, when: hasFriends, fx: { social: 1 }, fr: "Vous êtes témoin au mariage de {ami}. Au moment du discours, vous avez du mal à parler." },
  { a: [22, 65], i: '🫂', w: 5, when: hasFriends, fx: { social: 1 }, fr: "{ami} traverse une mauvaise passe. Vous passez des soirées à l'écouter, sans rien dire de très malin, et cela suffit." },
  { a: [20, 70], i: '👋', w: 4, fx: { social: 1 }, fr: "Un voisin vous dépanne sous la pluie. Depuis ce jour, vous vous saluez chaque matin." },
  { a: [30, 75], i: '🍯', w: 3, when: (l) => !isRural(l) || l.age > 45, fr: "Votre voisine âgée vous remet un pot de confiture maison pour vous remercier de lui monter ses courses." },
  { a: [30, 70], i: '🙂', w: 4, fx: { social: 1 }, fr: "Le visage plus léger, une personne que vous avez aidée vous a dit merci. Vous y avez repensé toute la journée." },
  { a: [35, 75], i: '🤝', w: 4, fx: { social: 2 }, fr: "Vous avez donné de votre temps à une association du quartier. On vous a demandé de revenir." },
  // famille
  { a: [20, 60], i: '☎️', w: 6, when: motherAlive, fr: "Vous appelez votre mère un dimanche soir. Elle a {age_mere} ans et vous demande, comme toujours, si vous mangez bien." },
  { a: [25, 70], i: '📷', w: 3, when: fatherAlive, fr: "Votre père vous montre une vieille photo de lui à votre âge. Vous vous ressemblez plus que vous ne l'auriez cru." },
  { a: [40, 75], i: '🩺', w: 3, when: motherAlive, fx: { social: 1 }, fr: "Vous accompagnez votre mère à un rendez-vous chez le médecin. Les rôles s'inversent, doucement." },
  { a: [28, 60], i: '😤', w: 3, when: sibs, fx: { social: -2 }, fr: "Une dispute avec {frere}, pour une broutille, tourne mal. Vous restez trois mois sans vous parler." },
  { a: [25, 60], i: '📦', w: 3, when: sibs, fx: { social: 1 }, fr: "{frere} vous appelle à l'aide pour un déménagement. La camionnette est trop petite et vous riez de tout." },
  { a: [3, 12], i: '🎶', w: 4, when: gpAlive, fr: "Votre grand-mère vous apprend une chanson que vous chanterez encore des années plus tard." },
  { a: [6, 16], i: '🏡', w: 5, when: gpAlive, fx: { happy: 1 }, fr: "Vous passez les vacances chez vos grands-parents. La maison sent le pain et la cire." },
  { a: [25, 50], i: '🌌', w: 4, when: hasKids, fr: "Votre enfant vous demande pourquoi le ciel est bleu. Vous inventez une réponse, il vous croit." },
  { a: [25, 50], i: '🌙', w: 3, when: hasKids, fr: "Un cauchemar réveille votre enfant. Vous restez près de lui jusqu'au matin." },
  { a: [30, 60], i: '🖼️', w: 4, when: hasKids, fx: { happy: 1 }, fr: "Votre enfant rentre de l'école avec un dessin de vous deux. Vous le fixez au mur." },
  { a: [25, 70], i: '🕯️', w: 5, when: hasPartner, fx: { happy: 1 }, fr: "Vous dînez en tête-à-tête avec {conj}, sans téléphone. Vous aviez oublié à quel point vous aimiez ça." },
  { a: [25, 70], i: '💢', w: 3, when: hasPartner, fr: "Une dispute avec {conj} éclate pour un détail. Vous vous réconciliez tard dans la nuit." },
  { a: [25, 75], i: '🎁', w: 3, when: hasPartner, fx: { happy: 1 }, fr: "{conj} vous surprend avec un petit cadeau, pour rien." },
  // travail
  { a: [22, 60], i: '🧑‍💼', w: 5, when: isEmployed, fx: { social: 1 }, fr: "Une nouvelle recrue arrive dans votre équipe. {collegue} semble perdu{e} ; vous lui montrez les ficelles." },
  { a: [22, 60], i: '👏', w: 4, when: isEmployed, fx: { happy: 2 }, fr: "Votre chef vous complimente devant toute l'équipe. Vous rentrez chez vous en souriant." },
  { a: [22, 60], i: '😰', w: 3, when: isEmployed, fx: { happy: -2 }, fr: "Une erreur de votre part coûte cher à l'entreprise. Vous y repensez toute la semaine." },
  { a: [22, 60], i: '🕰️', w: 4, when: (l) => isEmployed(l) && poorish(l), fr: "Vous faites des heures supplémentaires non payées : refuser serait mal vu." },
  { a: [22, 60], i: '🍜', w: 4, when: isEmployed, fr: "Vous déjeunez avec {collegue} et découvrez que vous avez grandi dans le même quartier." },
  { a: [40, 62], i: '🧓', w: 4, when: isEmployed, fr: "Un jeune collègue vous demande conseil. Vous réalisez que vous êtes devenu{e} celui qu'on écoute." },
  { a: [22, 65], i: '🚪', w: 4, when: (l) => heavyOk() && (l.countryData?.hom || 0) > 3, fx: { money: -300, happy: -3 }, fr: "Votre logement a été cambriolé pendant que vous travailliez. Vous mettrez longtemps à vous sentir de nouveau chez vous." },
  // moments de vie
  { a: [25, 60], i: '🌇', w: 4, fr: "Vous passez une soirée sur un toit à regarder la ville s'allumer." },
  { a: [12, 18], i: '📖', w: 4, fx: { know: 1 }, fr: "Vous vous perdez dans un livre tard dans la nuit, une lampe de poche sous les draps." },
  { a: [10, 16], i: '💬', w: 4, fx: { happy: 1 }, fr: "Un adulte vous dit un mot gentil au bon moment. Vous ne l'oublierez pas." },
  { a: [40, 75], i: '🪞', w: 3, when: (l) => motherAlive(l) || fatherAlive(l), fr: "Le jour où vous avez compris que vos parents avaient vieilli, vous êtes resté longtemps silencieux." },
  { a: [30, 80], i: '🎵', w: 4, fr: "Un parfum, une chanson : la maison de votre enfance revient d'un coup, intacte." },
  { a: [45, 80], i: '📸', w: 4, fr: "Vous triez de vieilles photos et riez en reconnaissant des visages que vous aviez oubliés." },
  { a: [50, 85], i: '✉️', w: 3, fr: "Vous écrivez une longue lettre à quelqu'un que vous aimez. Vous ne l'enverrez pas." },
  { a: [60, 90], i: '🌳', w: 4, fx: { happy: 1 }, fr: "Vous passez l'après-midi à regarder les enfants jouer dans le parc, et cela suffit." },
  { a: [65, 90], i: '🏥', w: 3, when: hasFriends, fx: { social: 1 }, fr: "Vous rendez visite à {ami}, malade. Vous repartez plus léger qu'à l'arrivée." },
  { a: [6, 12], i: '🏫', rep: false, when: inSchool, fr: "Le jour de la rentrée, vous ne retrouvez plus votre classe. Un camarade vous prend par la main et vous y conduit." },
  // habitudes
  { a: [28, 70], i: '🚬', w: 6, when: (l) => !!l.smoker, fr: "Vous avez tenté de réduire les cigarettes. Au troisième jour, la fatigue a gagné." },
  { a: [28, 70], i: '🍷', w: 6, when: (l) => !!l.drinker, fx: { happy: -1 }, fr: "L'alcool a failli reprendre de la place, mais une fois de plus, vous avez posé le verre." },
  { a: [25, 60], i: '🏃', rep: false, w: 8, when: (l) => !!l.sporty, fx: { happy: 3, health: 1 }, fr: "Vous avez couru votre premier dix kilomètres. Vous avez fini en larmes, et fi{er|ère}." },
  // pays et cultures
  { a: [10, 70], i: '🔦', w: 5, when: (l) => reg('lac', 'ssa', 'sa')(l) && poorish(l), fx: { social: 1 }, fr: "Pendant une coupure de courant, tout le quartier est sorti sur le trottoir. On a partagé des histoires, à boire et des rires." },
  { a: [20, 80], i: '🌿', w: 3, when: reg('eap'), fr: "Vous passez la journée à nettoyer la tombe de vos ancêtres, comme chaque année." },
  { a: [15, 80], i: '🌅', w: 3, when: isMuslim, fr: "Au coucher du soleil, toute la famille partage le repas du soir dans la même pièce." },
  { a: [25, 70], i: '⛰️', w: 3, when: (l) => reg('hi', 'eca')(l) && comfortable(15000)(l), fx: { health: 1, happy: 1 }, fr: "Vous passez un long week-end dans un village de montagne. Le silence vous fait du bien." },
  { a: [12, 70], i: '🏈', w: 3, when: inList('USA'), fr: "Vous regardez un match de football américain chez des voisins, un bol de chips à la main." },
  { a: [20, 70], i: '🌸', w: 4, when: inList('JPN'), fx: { happy: 1 }, fr: "Vous contemplez les cerisiers en fleurs avec vos collègues, pour la saison du hanami." },
  { a: [10, 60], i: '🎭', w: 4, when: inList('BRA'), fx: { happy: 1 }, fr: "Vous défilez au carnaval avec votre rue : plumes, tambours et rires jusqu'au matin." },
  { a: [8, 70], i: '🏏', w: 4, when: inList('IND'), fr: "Toute la famille se serre devant la même télévision pour un match de cricket." },
  { a: [14, 60], i: '🚶', w: 3, when: (l) => reg('ssa')(l) && isRural(l), fr: "Vous marchez des kilomètres jusqu'à une fête de village où toute la région se retrouve." },
  { a: [10, 80], i: '🍷', w: 3, when: inList('FRA'), fr: "Un dimanche entier à table en famille : la conversation dérive vers la politique et personne ne se fâche vraiment." },
);
// Décès dans la famille : annoncés l'année où ils surviennent.
function familyDeathEvents(life, age) {
  if (age < 3 || !life.family) return [];
  const year = life.year + life.yearOffset;
  const fr = LANG === 'fr';
  const out = [];
  const died = (p) => p && p.death && p.death.year === year && p.birth;
  (life.family.parents || []).filter(died).forEach(p => {
    const who = fr ? (p.sex === 'M' ? 'Votre père' : 'Votre mère') : (p.sex === 'M' ? 'Your father' : 'Your mother');
    life.stats.happiness = Math.max(0, life.stats.happiness - 8);
    out.push({ age, kind: 'heavy', icon: '🕯️', text: fr ? who + ' meurt à ' + (year - p.birth.year) + ' ans.' : who + ' dies at ' + (year - p.birth.year) + '.' });
  });
  const father = (life.family.parents || []).find(p => p.sex === 'M');
  (life.family.grandparents || []).filter(died).forEach(g => {
    const side = fr ? (father && g.childOf === father.id ? 'paternel' : 'maternel') : (father && g.childOf === father.id ? 'paternal' : 'maternal');
    const who = fr ? (g.sex === 'M' ? 'Votre grand-père ' + side : 'Votre grand-mère ' + side + 'le') : 'Your ' + side + (g.sex === 'M' ? ' grandfather' : ' grandmother');
    life.stats.happiness = Math.max(0, life.stats.happiness - 3);
    out.push({ age, kind: 'heavy', icon: '🕯️', text: fr ? who + ' meurt à ' + (year - g.birth.year) + ' ans.' : who + ' dies at ' + (year - g.birth.year) + '.' });
  });
  return out;
}
// Première ligne du récit : la naissance, racontée au joueur.
function birthIntro(life) {
  const c = localize(life.countryData);
  if (LANG !== 'fr') return t('event.birth', '');
  const q = ['très modeste', 'modeste', 'plutôt aisée', 'aisée'][quartOf(life) - 1];
  const mother = (life.family?.parents || []).find(p => p.sex === 'F');
  return genderize("Vous naissez " + (isRural(life) ? 'à la campagne' : 'en ville') + ', ' + c.flag + ' ' + c.name + ", dans une famille " + q + '.'
    + (mother && life.motherDetail ? ' Votre mère a ' + life.motherDetail.age + ' ans.' : ''), life);
}
// Tirage du pays : les noms défilent, ralentissent, puis s'arrêtent sur le pays de naissance.
function rollCountry(target, done) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { done(); return; }
  const fr = LANG === 'fr';
  const total = COUNTRIES.reduce((a, c) => a + (c.births || 0), 0) || 1;
  const ov = document.createElement('div');
  ov.className = 'country-roll';
  ov.innerHTML = '<p class="cr-label"></p><p class="cr-name" aria-live="polite"></p><p class="cr-prob"></p>';
  ov.querySelector('.cr-label').textContent = fr ? 'Le hasard choisit où vous naissez…' : 'Chance picks where you are born…';
  document.body.appendChild(ov);
  const name = ov.querySelector('.cr-name');
  const delays = [70, 70, 80, 90, 100, 120, 150, 190, 240, 300, 380, 480, 600];
  let i = 0, finished = false, timer = null;
  const finish = () => { if (finished) return; finished = true; clearTimeout(timer); ov.remove(); done(); };
  const step = () => {
    if (i < delays.length) {
      const c = localize(COUNTRIES[Math.floor(Math.random() * COUNTRIES.length)]);
      name.textContent = c.flag + ' ' + c.name;
      timer = setTimeout(step, delays[i++]);
    } else {
      const c = localize(target);
      const share = (target.births || 0) / total * 100;
      name.textContent = c.flag + ' ' + c.name;
      ov.classList.add('cr-done');
      ov.querySelector('.cr-prob').textContent = fr
        ? share.toFixed(2).replace('.', ',') + ' % des naissances dans le monde'
        : share.toFixed(2) + '% of births worldwide';
      timer = setTimeout(finish, 1500);
    }
  };
  ov.addEventListener('click', finish);
  step();
}
const REGIONS_FR = { eap: 'Asie de l\'Est et Pacifique', eca: 'Europe et Asie centrale', hi: 'Pays à revenu élevé', lac: 'Amérique latine et Caraïbes', mena: 'Moyen-Orient et Afrique du Nord', sa: 'Asie du Sud', ssa: 'Afrique subsaharienne' };
const FR_REGION_NAMES = new Intl.DisplayNames(['fr'], { type: 'region' });
// Le drapeau emoji encode le code ISO à 2 lettres : on s'en sert pour demander le nom français au navigateur.
// « en France », « au Japon », « aux États-Unis », « à Singapour » : la préposition dépend du pays.
const PREP_AU = new Set('JPN CAN BRA MEX MAR PER CHL NER SEN MLI TCD TGO BEN CMR GHA KEN NGA ZWE SDN LBN PAK BGD NPL VNM KHM LAO PRT DNK GBR QAT KWT BFA GAB COG RWA BDI MWI MOZ LSO BWA PRY VEN SLV HND NIC GTM PAN CRI SUR BTN LKA KAZ KGZ TJK TKM URY'.split(' '));
const PREP_AUX = new Set('NLD USA PHL ARE COM MDV'.split(' '));
const PREP_A = new Set('SGP HKG MAC MLT CYP CUB TWN BHR MUS MDG DJI'.split(' '));
function inCountry(c) {
  const n = localize(c).name;
  if (LANG !== 'fr') return n;
  return (PREP_AUX.has(c.id) ? 'aux ' : PREP_A.has(c.id) ? 'à ' : PREP_AU.has(c.id) ? 'au ' : 'en ') + n;
}
function nameFr(c) {
  try { return FR_REGION_NAMES.of([...c.flag].map(ch => String.fromCharCode(ch.codePointAt(0) - 0x1F1A5)).join('')) || c.name_en; }
  catch (e) { return c.name_en; }
}
function localize(c) {
  if (!c) return null;
  if (LANG === 'fr') return { ...c, name: nameFr(c), region_name: REGIONS_FR[c.region] || c.region_en };
  return {
    ...c,
    name: LANG === 'en' ? c.name_en : (LANG === 'zh-Hans' ? (c.name_zh_cn || c.name_zh) : c.name_zh),
    region_name: LANG === 'en' ? c.region_en : c.region_zh,
  };
}

// ==== 出生選擇 ====
function chooseCountry(mode) {
  // mode:
  //   'baby' 依嬰兒出生人數權重（c.births — 每國每年新生兒數）
  //   'all'  依現存人口權重（c.pop — 80 億人口的當下分布）
  if (!COUNTRIES.length) return null;
  const m = (mode === 'all') ? 'all' : 'baby';
  const weights = COUNTRIES.map(c => {
    if (m === 'all') return Math.max(1, c.pop || 1);
    return Math.max(1, c.births || c.pop || 1);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < COUNTRIES.length; i++) {
    r -= weights[i];
    if (r <= 0) return COUNTRIES[i];
  }
  return COUNTRIES[0];
}

/* ==== v5.19：依出生人數加權的機率分布（top N） ==== */
function countryProbabilities(mode, n) {
  // 回傳 [{c, weight, pct, cumPct}]，c=country, pct=該國佔比(%), 已排序降冪
  const m = (mode === 'all') ? 'all' : 'baby';
  const rows = COUNTRIES.map(c => {
    const w = (m === 'all')
      ? Math.max(1, c.pop || 1)
      : Math.max(1, c.births || c.pop || 1);
    return { c, weight: w };
  });
  const total = rows.reduce((s, r) => s + r.weight, 0);
  rows.forEach(r => r.pct = r.weight / total * 100);
  rows.sort((a, b) => b.weight - a.weight);
  let cum = 0;
  rows.forEach(r => { cum += r.pct; r.cumPct = cum; });
  return n ? rows.slice(0, n) : rows;
}

/* ==== v5.19：今日主題 ==== */
const THEMES_ZH = ['家人','未來','記憶','離別','重逢','家鄉','城市','海','山','雨','雪','風','黎明','黃昏','路','名字','時光','童年','母親','父親','兄弟','姊妹','朋友','敵人','鄰居','陌生人','夢','醒','工作','休息','旅行','停留','選擇','機會','失敗','成功','病','老','死','生','信仰','希望','失望','愛','恨','孤獨','陪伴'];
const THEMES_EN = ['family','future','memory','farewell','homecoming','hometown','city','sea','mountain','rain','snow','wind','dawn','dusk','road','name','time','childhood','mother','father','brother','sister','friend','stranger','neighbor','dream','work','rest','travel','stay','choice','chance','failure','success','sickness','age','death','birth','faith','hope','love','loneliness','company'];
function getDailyTheme() {
  // 跨 session 同日保留；不同日期重新抽
  const today = new Date();
  const dayKey = today.toISOString().slice(0, 10); // YYYY-MM-DD
  const cacheKey = STORAGE_KEY + ':theme:' + dayKey;
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    try {
      const obj = JSON.parse(cached);
      return { word: obj.word, dayKey, en: obj.en || THEMES_EN[obj.idx] || '' };
    } catch (e) { /* fallthrough */ }
  }
  // 用日期當 hash seed（保證同日所有人都抽到同一個，但讓每天不同）
  const seed = hashStringToInt(dayKey);
  const idx = seed % THEMES_ZH.length;
  const word = LANG === 'en' ? (THEMES_EN[idx] || THEMES_ZH[idx]) : (THEMES_ZH[idx]);
  const en = THEMES_EN[idx] || THEMES_ZH[idx];
  localStorage.setItem(cacheKey, JSON.stringify({ word, idx, en }));
  // 清掉過期主題（保留最近 7 天）
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(STORAGE_KEY + ':theme:')) {
      const day = k.split(':').pop();
      if (day !== dayKey && Date.now() - new Date(day).getTime() > 7 * 86400 * 1000) {
        localStorage.removeItem(k);
      }
    }
  }
  return { word, dayKey, en };
}
function hashStringToInt(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/* ==== v5.19：依瀏覽器語言/時區推測「你實際所在的國家」 ==== */
function guessUserCountry() {
  // 1) localStorage 顯式設定（若使用者已選過國家）
  const sel = localStorage.getItem(STORAGE_KEY + ':country');
  if (sel) {
    const c = countryById(sel);
    if (c) return c;
  }
  // 2) Intl locale → 國家
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale || '';
    const region = (locale.split('-').pop() || '').toUpperCase();
    if (region && region.length === 2) {
      const c = countryById(region);
      if (c) return c;
    }
  } catch (e) { /* ignore */ }
  // 3) navigator.language → 語言對應主要國家（單一國家）
  const lang = (navigator.language || 'en').toLowerCase();
  const langToCountry = {
    'zh-tw': 'TWN', 'zh-hk': 'HKG', 'zh-cn': 'CHN', 'zh': 'TWN',
    'en-us': 'USA', 'en-gb': 'GBR', 'en-ca': 'CAN', 'en-au': 'AUS',
    'ja': 'JPN', 'ja-jp': 'JPN',
    'ko': 'KOR', 'ko-kr': 'KOR',
    'vi': 'VNM', 'vi-vn': 'VNM',
    'fr': 'FRA', 'fr-fr': 'FRA',
    'th': 'THA', 'th-th': 'THA',
    'es': 'ESP', 'es-es': 'ESP', 'es-mx': 'MEX',
    'pt': 'BRA', 'pt-br': 'BRA',
    'de': 'DEU', 'de-de': 'DEU',
    'ru': 'RUS', 'ru-ru': 'RUS',
    'ar': 'SAU', 'ar-sa': 'SAU',
  };
  let key = lang.toLowerCase();
  if (langToCountry[key]) {
    const c = countryById(langToCountry[key]);
    if (c) return c;
  }
  // 部分匹配（zh-* → TWN、en-* → USA、es-* → ESP）
  const base = lang.split('-')[0];
  const fallback = {
    'zh': 'TWN', 'en': 'USA', 'ja': 'JPN', 'ko': 'KOR',
    'vi': 'VNM', 'fr': 'FRA', 'th': 'THA', 'es': 'ESP',
    'pt': 'BRA', 'de': 'DEU', 'ru': 'RUS', 'ar': 'SAU',
  };
  if (fallback[base]) {
    const c = countryById(fallback[base]);
    if (c) return c;
  }
  return countryById('USA') || COUNTRIES[0];
}

/* ==== v5.19：即時計數器 — 從頁面載入算起的全球出生/死亡數 ==== */
// 全球每秒約出生 4.3 人、死亡 1.8 人（依 UN WPP 2024 估算）
const REAL_BIRTHS_PER_SEC = 4.3;
const REAL_DEATHS_PER_SEC = 1.8;
let REALTIME_PAGE_LOAD = Date.now();
let REALTIME_INTERVAL = null;
function startRealtimeCounters() {
  if (REALTIME_INTERVAL) return;
  REALTIME_PAGE_LOAD = Date.now();
  REALTIME_INTERVAL = setInterval(updateRealtimeCounters, 1000);
  updateRealtimeCounters();
}
function stopRealtimeCounters() {
  if (REALTIME_INTERVAL) clearInterval(REALTIME_INTERVAL);
  REALTIME_INTERVAL = null;
}
function updateRealtimeCounters() {
  const elapsedSec = Math.max(0, (Date.now() - REALTIME_PAGE_LOAD) / 1000);
  // 加 ±5% 隨機讓數字不會太死板（用 seeded RNG 從載入秒數當種子）
  const jitter = 0.95 + Math.random() * 0.10;
  const born = Math.floor(elapsedSec * REAL_BIRTHS_PER_SEC * jitter);
  const died = Math.floor(elapsedSec * REAL_DEATHS_PER_SEC * jitter);
  const bornEl = $('#counterBorn');
  const diedEl = $('#counterDied');
  if (bornEl) bornEl.textContent = born.toLocaleString();
  if (diedEl) diedEl.textContent = died.toLocaleString();
}

// ==== 生命表 (Gompertz) ====
const LT_CACHE = {};
function lifeTable(c, sex) {
  const key = c.id + sex + (c.yr || '');
  if (LT_CACHE[key]) return LT_CACHE[key];
  const e0 = sex === 'F' ? c.le + (c.gap || 4) * 0.49 : c.le - (c.gap || 4) * 0.51;
  const k = sex === 'F' ? 0.92 : 1.08;
  const q0 = Math.min(0.25, (c.im || 15) / 1000 * k);
  const u5 = Math.min(0.35, Math.max(q0 + 0.0005, (c.u5 || 10) / 1000 * k));
  const H = -Math.log((1 - u5) / Math.max(0.0001, 1 - q0));
  const qc = [0.4, 0.27, 0.19, 0.14].map(w => 1 - Math.exp(-H * w));
  const A = 0.00025 + 0.000028 * (c.u5 || 10);
  const g = Math.max(0.085, Math.min(0.112, 0.112 - 0.00016 * (c.u5 || 10)));
  // q[0..4] 為嬰兒/幼兒段；q[5..110] 為 Gompertz
  const q = new Float64Array(111);
  q[0] = q0;
  for (let i = 1; i <= 4; i++) q[i] = qc[i - 1];
  for (let x = 5; x <= 110; x++) {
    if (x === 110) { q[x] = 1; continue; }
    q[x] = Math.min(1, 1 - Math.exp(-(A + Math.exp(g * (x + 0.5)) * 0.001)));
  }
  // 找 B 讓生命期望 = e0
  let lo = Math.log(1e-9), hi = Math.log(5e-2), r = 0.5;
  for (let i = 0; i < 50; i++) {
    const m = (lo + hi) / 2;
    const B = Math.exp(m);
    // 計算生命期望
    let l = 1, e = 0;
    for (let x = 0; x <= 110; x++) {
      const qx = (x < 5) ? q[x] : Math.min(1, 1 - Math.exp(-(A + B * Math.exp(g * (x + 0.5)))));
      const d = l * qx;
      e += x === 0 ? l - 0.85 * d : l - 0.5 * d;
      l -= d;
    }
    if (e > e0) lo = m; else hi = m;
    r = B;
  }
  // 用最終的 r 重新算
  const qf = new Float64Array(111);
  qf[0] = q0;
  for (let i = 1; i <= 4; i++) qf[i] = qc[i - 1];
  for (let x = 5; x <= 110; x++) {
    if (x === 110) { qf[x] = 1; continue; }
    qf[x] = Math.min(1, 1 - Math.exp(-(A + r * Math.exp(g * (x + 0.5)))));
  }
  // 累計存活率
  const l = new Float64Array(112);
  l[0] = 1;
  for (let x = 0; x <= 110; x++) l[x + 1] = l[x] * (1 - qf[x]);
  LT_CACHE[key] = { q: qf, l, e0 };
  return LT_CACHE[key];
}

function pDie(age, c, sex) {
  if (age < 0) return 0;
  const lt = lifeTable(c, sex);
  if (age >= 110) return 1;
  if (age === 0) return lt.q[0];
  if (lt.l[age] === 0) return 1;
  return Math.max(0, Math.min(0.95, 1 - lt.l[age + 1] / lt.l[age]));
}

// ==== 死因分布 ====
const CAUSE_BASE = {
  // 嬰兒
  infant:  { '周產期問題':50, '先天異常':20, '感染性疾病':15, '嬰兒猝死':5, '事故':5, '其他':5 },
  // 兒童 1-4
  child:    { '感染性疾病':35, '事故':25, '先天異常':15, '營養不良':10, '溺水':8, '其他':7 },
  // 兒童 5-14
  young:    { '事故':30, '感染性疾病':25, '癌症':12, '溺水':10, '自殺':6, '他殺':5, '其他':12 },
  // 青年 15-29
  young_a:  { '事故':28, '自殺':20, '他殺':15, '癌症':10, '感染性疾病':10, '其他':17 },
  // 中年 30-49
  middle:   { '癌症':22, '心血管':18, '自殺':14, '事故':10, '感染性疾病':10, '他殺':6, '其他':20 },
  // 中老年 50-69
  older:    { '癌症':30, '心血管':25, '呼吸系統':8, '糖尿病':8, '自殺':5, '事故':5, '其他':19 },
  // 老年 70+
  elderly:  { '心血管':35, '癌症':25, '呼吸系統':12, '中風':8, '糖尿病':5, '其他':15 },
};

// Niveau relatif de suicide selon le pays (estimation d'après les grands écarts régionaux de l'OMS ; 1 = moyenne mondiale).
function suicideFactor(c) {
  const byId = { RUS: 1.8, KOR: 2.2, JPN: 1.4, LTU: 2.0, KAZ: 1.6, UKR: 1.4, BLR: 1.6, USA: 1.3, FIN: 1.3, HUN: 1.3, BEL: 1.2, FRA: 1.1, IND: 1.0 };
  if (byId[c.id] !== undefined) return byId[c.id];
  if (muslimShare(c) >= 70) return 0.3;
  return ({ lac: 0.9, ssa: 0.8, mena: 0.5, eap: 1.0, sa: 1.0, eca: 1.2, hi: 1.0 })[c.region] ?? 1;
}
// Part des armes à feu parmi les homicides (estimation par région, quelques pays à part).
function gunShare(c) {
  const byId = { USA: 0.8, ZAF: 0.55, CAN: 0.3, JPN: 0.02, KOR: 0.02, SGP: 0.02, TWN: 0.02, GBR: 0.1 };
  if (byId[c.id] !== undefined) return byId[c.id];
  return ({ lac: 0.7, ssa: 0.35, mena: 0.4, eca: 0.35, sa: 0.3, eap: 0.15, hi: 0.2 })[c.region] ?? 0.3;
}
// Remplace, pour les causes liées au pays, les parts génériques par des parts déduites des taux observés :
// homicides et routes (pour 100 000), prévalence du VIH, indice de paludisme, rapportés au risque total de décès à cet âge.
function applyExternalShares(w, c, age, sex) {
  const tot = Math.max(50, pDie(Math.max(1, age), c, sex) * 1e5);   // décès pour 100 000 à cet âge
  const M = sex === 'M';
  const hom = (c.hom || 0) * (age < 5 ? 0.3 : age < 15 ? 0.2 : age < 30 ? 2.0 : age < 50 ? 1.3 : age < 70 ? 0.6 : 0.3) * (M ? 1.6 : 0.4);
  const road = (c.road || 0) * (age < 15 ? 0.5 : age < 30 ? 1.6 : age < 50 ? 1.1 : age < 70 ? 0.8 : 1.0) * (M ? 1.5 : 0.5);
  const hiv = 1.5 * Math.pow(c.hiv || 0, 1.5) * (age < 15 ? 0.15 : age < 25 ? 0.5 : age < 50 ? 2.0 : age < 60 ? 1.0 : 0.2);
  const mal = (c.mal || 0) * 30 * (age < 5 ? 6 : age < 15 ? 2 : 0.5);
  const sh = (r, cap) => Math.min(cap, r / tot);
  const sHom = STATE.softMode ? 0 : sh(hom, 0.55), sRoad = sh(road, 0.45), sHiv = sh(hiv, 0.6), sMal = sh(mal, 0.6);
  const fixed = ['他殺', '槍擊', '事故', '愛滋病', '瘧疾'];
  const T = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  const nonRoadAcc = 0.5 * (w['事故'] || 0) / T;
  const g = gunShare(c);
  const out = { '事故': sRoad + nonRoadAcc, '他殺': sHom * (1 - g), '槍擊': sHom * g, '愛滋病': sHiv, '瘧疾': sMal };
  const ext = Object.values(out).reduce((a, b) => a + b, 0);
  const rest = Math.max(0.15, 1 - ext);
  let others = 0;
  for (const k of Object.keys(w)) if (!fixed.includes(k)) others += w[k];
  for (const k of Object.keys(w)) { if (fixed.includes(k)) delete w[k]; else w[k] = others ? w[k] / others * rest : 0; }
  for (const k of fixed) if (out[k] > 0) w[k] = out[k];
}
function causeWeights(c, age, sex) {
  let bucket;
  if (age < 1) bucket = 'infant';
  else if (age < 5) bucket = 'child';
  else if (age < 15) bucket = 'young';
  else if (age < 30) bucket = 'young_a';
  else if (age < 50) bucket = 'middle';
  else if (age < 70) bucket = 'older';
  else bucket = 'elderly';
  const w = { ...CAUSE_BASE[bucket] };
  // Transition épidémiologique : dans les pays pauvres, infections et malnutrition dominent bien plus longtemps, les cancers et maladies cardiaques moins.
  { const poor = Math.max(0, Math.min(1, 1 - ((c.ppp || 12000) - 2000) / 30000));
    const mul = (k, f) => { if (w[k] !== undefined) w[k] *= f; };
    mul('感染性疾病', 1 + (age < 60 ? 5 : 2) * poor); mul('營養不良', 1 + 3 * poor);
    if (age >= 50 && w['感染性疾病'] === undefined) w['感染性疾病'] = 25 * poor;   // pneumonies, diarrhées, tuberculose aux grands âges
    mul('癌症', 1 - 0.55 * poor); mul('心血管', 1 - 0.4 * poor); mul('糖尿病', 1 - 0.5 * poor); mul('呼吸系統', 1 + 0.5 * poor); }
  // v5.39：略過可怕的情節 — 把自殺/他殺機率併入其他死因（不改變總死亡率）
  if (STATE.softMode) {
    let heavy = 0;
    for (const k of ['自殺', '他殺', '槍擊']) {
      if (w[k]) { heavy += w[k]; delete w[k]; }
    }
    if (heavy > 0) {
      w['其他'] = (w['其他'] || 0) + heavy;
    }
  }
  // 國家加成
  if (c.hom > 5 && w['他殺']) w['他殺'] *= c.hom / 5;
  else if (w['他殺'] && c.hom < 1) w['他殺'] *= 0.5;
  // v6.06：自殺率也終於接上國家差了。
  // c.sf 是「每 10 萬人的自殺率」，172 國：中位數 5、平均 9.4、p90 = 23、最大 39、最小 0。
  // 舊碼完全沒有這一段 —— 匈牙利(29) 和中國(2) 的自殺權重都是一樣的 20，
  // 實測 causeWeights 在 25 歲時六個國家的 '自殺' 權重全部等於 20。
  // intro 的文案卻明說這款模擬用了「自殺率」。
  // pickCause() 會把權重正規化，所以這裡只是重新分配「死因之間的比例」，
  // 不會改變總死亡率（和上面的 hom / road / hiv / sm 同一個性質）。
  // 下限 0.15：資料裡有 5 國 sf=0，但完全不給權重等於宣稱那裡不可能自殺，
  // 這是比資料更強的主張，所以留一個很小的地板。
  // 注意用 ?? 不是 || —— sf=0 是「真的 0」，|| 會把它當成沒有值而回退到 10，
  // 那 5 國反而會拿到中位數權重，正好和實測抓到的那個 bug 相反。
  if (w['自殺']) w['自殺'] *= suicideFactor(c);
  if (c.road > 15 && w['事故']) w['事故'] *= c.road / 15;
  if (c.hiv > 1 && w['感染性疾病']) w['感染性疾病'] *= Math.min(2, c.hiv / 0.5);   // le VIH a sa propre part (applyExternalShares)
  if (c.sm > 30 && w['癌症']) w['癌症'] *= c.sm / 25;
  if (c.sm > 30 && w['心血管']) w['心血管'] *= 1.2;
  if (c.war > 0.1 && (age < 50)) {
    w['戰爭/衝突'] = c.war * 5;
  }
  if (c.mal > 0.5) {
    w['瘧疾'] = (w['感染性疾病'] || 0) * c.mal * 2;
  }
  // 性別調整
  if (sex === 'F') {
    if (w['他殺'] && age >= 15 && age < 30) w['他殺'] *= 0.3;
    if (w['他殺'] && age >= 30 && age < 50) w['他殺'] *= 0.5;
    if (w['事故'] && age >= 15 && age < 50) w['事故'] *= 0.5;
  }
  // 個人條件
  if (STATE.life && STATE.life.smoker) {
    w['癌症'] *= 1.4; w['心血管'] *= 1.3; w['呼吸系統'] *= 1.5;
  }
  if (STATE.life) {
    const Lf = STATE.life;
    const mul = (k, f) => { if (w[k] !== undefined) w[k] *= f; };
    if (Lf.exSmoker) { mul('癌症', 1.15); mul('心血管', 1.1); mul('呼吸系統', 1.2); }
    if (Lf.drinker) { mul('其他', 1.6); mul('事故', 1.3); mul('癌症', 1.15); mul('心血管', 1.15); mul('自殺', 1.3); }
    if (Lf.addicted) { mul('事故', 2.5); mul('自殺', 1.8); mul('他殺', 1.5); mul('感染性疾病', 1.5); mul('其他', 1.4); }
    if (Lf.gang) { mul('他殺', 6); }
    if (Lf.sporty) { mul('心血管', 0.8); mul('糖尿病', 0.7); }
    if (Lf.screened) { mul('癌症', 0.7); }
    if (Lf.vaccinated) { mul('感染性疾病', 0.85); }
    if (Lf.hivPos) { w['愛滋病'] = (w['愛滋病'] || 0) + (Lf.hivTreated ? 0.1 : 0.6); }
    if (Lf.htnIgnored) { mul('心血管', 1.3); mul('中風', 1.5); }
    { const il = Lf.illness; if (il && il.status === 'active') { if (il.type === 'cancer') mul('癌症', 6); else if (il.type === 'heart') { mul('心血管', 4); mul('中風', 3); } else if (il.type === 'stroke') { mul('中風', 6); mul('心血管', 2); } } }
    if (Lf.bednet) { mul('瘧疾', 0.2); }
  }
  if (STATE.life && STATE.life.conditions) {
    if (STATE.life.conditions.diabetes) w['糖尿病'] = (w['糖尿病'] || 1) * 3;
    if (STATE.life.conditions.heart) w['心血管'] *= 1.5;
  }
  applyExternalShares(w, c, age, sex);
  return w;
}

// Multiplicateur du risque de décès de l'année selon les habitudes (ordres de grandeur : un fumeur perd environ dix ans).
function habitMort(life) {
  let m = 1;
  // La table de mortalité du pays contient déjà ses fumeurs : on la normalise pour que la moyenne reste celle du pays.
  if (life.age >= 35) m *= 1 / (1 + ((life.countryData && life.countryData.sm) || 20) / 100 * 0.5 * 1.5);
  if (life.smoker && life.age >= 35) m *= 2.5;      // simulé : environ 8 ans de vie en moins
  if (life.hivPos && life.age >= 18) m *= life.hivTreated ? 1.4 : 4;
  { const il = life.illness; if (il && il.status !== 'resolved' && il.treated != null) {
    if (il.type === 'cancer') m *= il.status === 'remission' ? 1.3 : il.treated === 'full' ? 2 : il.treated === 'partial' ? 3 : 5;
    else if (il.type === 'heart' || il.type === 'stroke') m *= il.treated === 'full' ? 1.4 : il.treated === 'partial' ? 1.8 : 2.8; } }
  if (life.exSmoker) m *= 1.2;
  if (life.drinker && life.age >= 30) m *= 1.5;     // environ 4 ans
  if (life.addicted) m *= 2.2;                      // environ 8 ans
  if (life.sporty) m *= 0.8;                        // environ 2 ans de plus
  return m;
}
// Risque annuel supplémentaire de mourir de la maladie en cours : un cancer non traité tue souvent en quelques années, même à 23 ans.
function illnessHazard(life) {
  const il = life.illness; if (!il || il.status === 'resolved' || il.treated == null) return null;
  const acc = Math.max(0.3, illnessAccess(life.countryData || {}));
  if (il.type === 'cancer') {
    if (il.status === 'remission') return { p: 0.01, cause: '癌症' };
    return { p: il.treated === 'full' ? 0.06 / acc : il.treated === 'partial' ? 0.14 : 0.3, cause: '癌症' };
  }
  if (il.type === 'heart') return { p: il.treated === 'full' ? 0.015 : il.treated === 'partial' ? 0.03 : 0.06, cause: '心血管' };
  if (il.type === 'stroke') return { p: il.treated === 'full' ? 0.02 : il.treated === 'partial' ? 0.04 : 0.1, cause: '中風' };
  if (il.type === 'diabetes' && il.treated === 'none') return { p: 0.02, cause: '糖尿病' };
  return null;
}
// Décès de l'année : risque de base, puis risque propre à la maladie en cours.
function yearDeath(life, c, sex) {
  const ih = illnessHazard(life);
  if (ih && Math.random() < Math.min(0.6, ih.p)) return ih.cause;
  return Math.random() < Math.min(1, pDie(life.age, c, sex) * habitMort(life)) ? true : false;
}
function pickCause(c, age, sex) {
  const w = causeWeights(c, age, sex);
  const keys = Object.keys(w);
  const weights = keys.map(k => Math.max(0.001, w[k]));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < keys.length; i++) {
    r -= weights[i];
    if (r <= 0) return keys[i];
  }
  return keys[0];
}

// ==== 隨機抽樣 ====
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const wpick = (obj) => {
  const keys = Object.keys(obj);
  const total = keys.reduce((s, k) => s + obj[k], 0);
  let r = Math.random() * total;
  for (const k of keys) {
    r -= obj[k];
    if (r <= 0) return k;
  }
  return keys[0];
};
const rand = (a, b) => a + Math.random() * (b - a);
const irand = (a, b) => Math.floor(rand(a, b + 1));
const chance = p => Math.random() < p;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ==== 名字 ====
const FIRST_NAMES_ZH = {
  M: ['志明','俊宏','家豪','建宏','俊傑','浩宇','承恩','柏翰','冠廷','彥廷','俊佑','俊廷','柏宇','宥廷','禹辰','建宇','俊宇','子軒','睿恩','嘉佑','家明','俊宏','志強','志偉','志豪','志遠','家豪','家銘','家祥','家瑞','國華','建國','建華','建民','建志','志強','志明','志偉','志豪','志遠','俊傑','俊宏','俊豪','俊宇','家豪','家銘','家祥','家瑞','家豪','家豪','家豪'],
  F: ['雅婷','怡君','佳穎','怡萱','雅雯','心怡','筱涵','筱萍','雅琪','雅文','郁婷','思妤','雅筑','宜君','詩涵','雅晴','宜臻','雅芳','婉婷','佳蓉','家瑜','家琪','雅琪','雅雯','怡君','佳穎','怡萱','雅雯','心怡','筱涵','筱萍','雅琪','雅文','郁婷','思妤','雅筑','宜君','詩涵','雅晴','宜臻','雅芳','婉婷','佳蓉','婉婷','佳蓉','家瑜','家琪','雅琪','雅雯','美華','美玲','美君','美玉','美麗','淑芬','淑君','淑玲','玉嬌','秀蘭','秀英','秀梅','秀珍','秀珠','秀鳳','麗華','麗君','麗玲','麗娟','麗美','麗珍','麗珠','麗鳳','麗雲','麗霞','麗秋','麗月','麗雪','麗冰','麗卿','麗珊','麗貞','麗蓉','麗蓮','麗萍','麗燕','麗虹','麗鳳','麗鸞','麗雁','麗燕','麗鸞']
};
const FIRST_NAMES_EN = {
  M: ['Wei','Hao','Junjie','Jianhong','Chen','Yu','Haochen','Bohan','Yanting','Yanting','Junjie','Yuchen','Jiayu','Bowen','Yuchen','Junhao','Zixuan','Rui','Jiayou','Minghao','David','James','Michael','John','Robert','William','Daniel','Matthew','Anthony','Mark','Steven','Paul','Andrew','Kenneth','George','Joshua','Kevin','Brian','Edward','Ronald','Timothy','Jason','Jeffrey','Ryan','Jacob','Gary','Nicholas','Eric','Jonathan','Stephen','Larry','Justin','Scott','Brandon','Benjamin','Samuel','Gregory','Alexander','Frank','Patrick','Raymond','Jack','Dennis','Jerry','Tyler','Aaron','Jose','Adam','Nathan','Henry','Douglas','Zachary','Peter','Kyle','Walter','Ethan','Jeremy','Harold','Keith','Christian','Roger','Noah','Gerald','Carl','Terry','Sean','Austin','Arthur','Lawrence','Jesse','Dylan','Bryan','Joe','Jordan','Billy','Bruce','Albert','Willie','Jordan','Dylan','Bryan','Joe','Alan','Ralph','Gabriel','Carl','Howard','Logan','Sean','Juan','Jack','Dean','Felix','Bruce','Peter','Patrick','Harold','Douglas','Jerry','Keith','Roger','Gerald','Carl','Terry','Arthur','Lawrence','Jesse','Christian','Sean','Austin','Noah','Bryan','Billy','Bruce','Albert','Willie','Gabriel','Alan','Ralph','Logan'],
  F: ['Mei','Hua','Lin','Fang','Yan','Ling','Min','Jing','Xia','Xiu','Lan','Ying','Mei','Fang','Yan','Jing','Lili','Min','Jing','Fang','Mei','Lan','Ying','Hua','Lily','Emma','Olivia','Ava','Sophia','Isabella','Mia','Charlotte','Amelia','Harper','Evelyn','Abigail','Emily','Ella','Elizabeth','Camila','Luna','Sofia','Avery','Mila','Aria','Scarlett','Penelope','Layla','Chloe','Victoria','Madison','Eleanor','Grace','Zoe','Nora','Riley','Zoey','Hannah','Hazel','Lily','Ellie','Violet','Aurora','Savannah','Audrey','Brooklyn','Bella','Claire','Skylar','Lucy','Paisley','Everly','Anna','Caroline','Nova','Genesis','Emilia','Kennedy','Samantha','Maya','Willow','Kinsley','Naomi','Aaliyah','Elena','Sarah','Ariana','Allison','Gabriella','Alice','Madelyn','Cora','Ruby','Eva','Serenity','Autumn','Adeline','Hailey','Gianna','Valentina','Isla','Eliana','Quinn','Nevaeh','Ivy','Sadie','Lydia','Piper','Lyla','Maya','Hailey']
};
const LAST_NAMES_ZH = ['張','王','李','陳','林','黃','吳','劉','蔡','楊','許','鄭','謝','洪','郭','邱','曾','廖','賴','徐','周','葉','蘇','莊','呂','江','何','羅','高','蕭','朱','羅','董','余','沈','許','韓','曹','許','鄧','曹','彭','曾','田','丁','杜','傅','范','方','鄒'];
const LAST_NAMES_EN = ['Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Rodriguez','Martinez','Hernandez','Lopez','Gonzalez','Wilson','Anderson','Thomas','Taylor','Moore','Jackson','Martin','Lee','Perez','Thompson','White','Harris','Sanchez','Clark','Ramirez','Lewis','Robinson','Walker','Young','Allen','King','Wright','Scott','Torres','Nguyen','Hill','Flores','Green','Adams','Nelson','Baker','Hall','Rivera','Campbell','Mitchell','Carter','Roberts','Gomez','Phillips','Evans','Turner','Diaz','Parker','Cruz','Edwards','Collins','Reyes','Stewart','Morris','Morales','Murphy','Cook','Rogers','Gutierrez','Ortiz','Morgan','Cooper','Peterson','Bailey','Reed','Kelly','Howard','Ramos','Kim','Cox','Ward','Richardson','Watson','Brooks','Chavez','Wood','James','Bennett','Gray','Mendoza','Ruiz','Hughes','Price','Alvarez','Castillo','Sanders','Patel','Myers','Long','Ross','Foster','Jimenez'];
const FIRST_NAMES_INDIA = {
  M: ['Aarav','Vihaan','Aditya','Arjun','Rohit','Karan','Rahul','Amit','Vikram','Raj','Arun','Suresh','Mohan','Krishna','Ravi','Sanjay','Anil','Manish','Deepak','Pradeep','Rakesh','Sunil','Vinod','Ashok','Rajesh','Ajay','Naveen','Manoj','Dinesh','Pankaj','Sandeep','Mukesh','Anand','Sandeep','Rakesh','Prakash','Mukesh','Vivek','Vikas'],
  F: ['Aadhya','Saanvi','Ananya','Aaradhya','Diya','Pari','Anika','Navya','Myra','Ira','Aarohi','Anvi','Misha','Anaya','Pihu','Riya','Aaradhya','Ananya','Saanvi','Diya','Aadhya','Pari','Navya','Myra','Aarohi','Anvi','Misha','Pihu','Riya','Anaya','Saanvi','Diya','Aadhya','Pari','Navya','Myra','Aarohi','Anvi','Misha','Pihu','Riya','Anaya']
};
const LAST_NAMES_INDIA = {
  SC: ['Kumar','Ram','Lal','Das','Paswan','Choudhary','Valmiki','Korwa','Mochi','Dusadh','Pasi','Khatik','Dhobi','Nai','Kahar','Turi','Bhai','Gandhi','Mallah','Mochi','Dushadh','Mushahar','Rajbhar','Bind','Chamar','Dhanuk','Dobi','Dom','Ghasiya','Goswami','Harijan','Kori','Musahar','Ravidas','Sarang','Singh','Bauri','Daiya','Ghasia','Mahar','Mehtar','Meth','Rawat','Sapera','Saran','Saunta','Bhanwar','Bhanwaria','Bhangi','Bhil','Bhotia','Bhuiya','Boria','Charan','Gadia','Gadaria','Gandhila','Garia','Garoda','Gauda','Gawala','Ghasia','Ghogha','Ghisar','Gola','Gond','Goriya','Gosa','Gulam','Gurjar','Hajam','Halwai','Heliya','Jadugar','Jagal','Jaiswal','Jogi','Kalal','Kalwar','Kamathi','Kandara','Kandra','Kanjar','Kansar','Kansera','Kanth','Kanyal','Karadi','Kareem','Karigar','Karnam','Kashmiri','Kasumbi','Katiyar','Kavadi','Kavutia','Kayasth','Keelara','Keral','Kerkar','Kewat','Khadera','Khagi','Khaimar','Khaiyar','Khajanchi','Khalasi','Khalpa','Khamar','Khan'],
  ST: ['Meena','Munda','Ho','Oraon','Santhal','Bedia','Bhil','Korku','Gond','Kharia','Baiga','Marias','Gadabas','Chenchu','Thoti','Sabaria','Parahiya','Lodha','Birhor','Paharia','Asur','Birjia','Bhotda','Chakma','Gadaba','Gond','Gorait','Halba','Ho','Jatapu','Kamar','Karku','Katkari','Kawar','Khairwar','Kharia','Kharwar','Kol','Kolam','Korku','Koya','Kudubi','Maria','Munda','Nagesia','Nayak','Oraon','Paik','Pardhan','Parengi','Santhal','Saora','Sauka','Savara','Shabar','Toda','Tripuri','Warli'],
  obc: ['Yadav','Kurmi','Patel','Jat','Reddy','Nayak','Gujjar','Kamboj','Rathore','Saini','Khatri','Kayastha','Brahmin','Thakur','Rathod','Mali','Teli','Kumhar','Lohar','Mocha','Nai','Sonar','Bania','Vaishya','Agrawal','Maheshwari','Khandelwal','Mittal','Garg','Jindal','Jain','Porwal','Kasat','Kalani','Bagrecha','Chhajed','Bothra','Singhal','Rathi','Bagaria','Lakhotia','Mundhra','Mangal','Kabra','Bansal','Goyal','Tibrewala','Dang','Hissaria','Bhut','Bhutra','Kothari','Karwa','Kala','Bagla','Asawa','Bagri','Choudhary','Halwai','Modi','Bhoot','Oswal','Kankariya','Porwal','Kansal','Mandhana','Bhandari','Kabra','Jalan','Bajoria','Bhuwalka','Mimani','Bumb','Bhand'],
  jana: ['Thapa','Tamang','Lama','Sherpa','Magar','Gurung','Rai','Limbu','Newar','Yadav','Mahato','Kami','Damai','Sarki','Chhetri','Bhatta','Bohara','Chauhan','Maharjan','Manandhar','Maharjan','Shrestha','Bajracharya','Pradhan','Karmacharya','Tamrakar','Manandhar','Joshi','Regmi','Bohara','Bist','Khatri','Khadka','Rana','Thapa','Bohara','Bist','Khatri','Khadka','Rana','Thapa','Mahato','Tharu','Rajbhar','Mahara','Kurmi','Yadav','Patel','Jat','Reddy','Nayak','Gujjar','Kamboj','Rathore','Saini','Khatri','Kayastha','Brahmin','Thakur','Rathod'],
  madh: ['Yadav','Kurmi','Patel','Jat','Reddy','Nayak','Gujjar','Kamboj','Rathore','Saini','Khatri','Kayastha','Brahmin','Thakur','Rathod','Mali','Teli','Kumhar','Lohar','Mocha','Nai','Sonar','Bania','Vaishya','Agrawal','Maheshwari','Khandelwal','Mittal','Garg','Jindal','Jain','Porwal','Kasat','Kalani','Bagrecha','Chhajed','Bothra','Singhal','Rathi','Bagaria','Lakhotia','Mundhra','Mangal','Kabra','Bansal','Goyal','Tibrewala','Dang','Hissaria','Bhut','Bhutra','Kothari','Karwa','Kala','Bagla','Asawa','Bagri','Choudhary','Halwai','Modi','Bhoot','Oswal','Kankariya','Porwal','Kansal','Mandhana','Bhandari','Kabra','Jalan','Bajoria','Bhuwalka','Mimani','Bumb','Bhand'],
  '': ['Patel','Kumar','Singh','Shah','Sharma','Gupta','Verma','Yadav','Jain','Bansal','Garg','Mittal','Khatri','Kapoor','Mehta','Choudhary','Soni','Patwa','Sharma','Joshi','Bhatt','Pandey','Tiwari','Dubey','Mishra','Saxena','Srivastava','Trivedi','Chaturvedi','Dwivedi','Upadhyay','Pathak','Pandey','Mishra','Saxena','Srivastava','Trivedi','Chaturvedi','Dwivedi','Upadhyay','Pathak']
};

const LAST_NAMES_FR = ['Martin','Bernard','Dubois','Thomas','Robert','Richard','Petit','Durand','Leroy','Moreau','Simon','Laurent','Lefebvre','Michel','Garcia','David','Bertrand','Roux','Vincent','Fournier','Morel','Girard','André','Mercier','Dupont','Lambert','Bonnet','François','Benali','Diallo'];
const FIRST_NAMES_FR = {
  M: ['Gabriel','Léo','Raphaël','Louis','Arthur','Jules','Adam','Hugo','Lucas','Nathan','Théo','Paul','Antoine','Maxime','Julien','Nicolas','Pierre','Thomas','Karim','Mathieu'],
  F: ['Emma','Jade','Louise','Alice','Chloé','Léa','Manon','Camille','Inès','Sarah','Julie','Marie','Clara','Zoé','Anna','Juliette','Lucie','Margaux','Élise','Nadia'],
};
// Prénoms et noms courants par aire culturelle, en écriture latine. Approximation : une aire regroupe plusieurs pays.
const NAME_SETS = {
  en:   { l: ['Smith','Johnson','Williams','Brown','Jones','Miller','Davis','Wilson','Taylor','Clark'], M: ['James','John','Michael','William','David','Daniel','Thomas','Ryan'], F: ['Emily','Sarah','Jessica','Olivia','Emma','Hannah','Laura','Grace'] },
  es:   { l: ['García','Rodríguez','Martínez','López','González','Pérez','Sánchez','Ramírez','Torres','Flores','Morales','Castillo'], M: ['Santiago','Mateo','Diego','Carlos','Luis','Javier','Andrés','Miguel'], F: ['Sofía','Valentina','Camila','Lucía','María','Daniela','Gabriela','Paula'] },
  pt:   { l: ['Silva','Santos','Oliveira','Souza','Pereira','Costa','Ferreira','Almeida','Ribeiro','Carvalho'], M: ['João','Pedro','Lucas','Gabriel','Rafael','Thiago','Bruno','Felipe'], F: ['Ana','Beatriz','Juliana','Larissa','Mariana','Camila','Fernanda','Letícia'] },
  ar:   { l: ['Al-Sayed','Haddad','Mansour','Khalil','Nasser','Hamdan','Saleh','Farouk','Aziz','Bakr'], M: ['Ahmed','Mohamed','Omar','Youssef','Ali','Hassan','Khaled','Karim'], F: ['Fatima','Aïcha','Layla','Mariam','Nour','Salma','Yasmine','Hana'] },
  ssa:  { l: ['Diallo','Traoré','Okafor','Mensah','Ndlovu','Kamara','Mwangi','Abdi','Bello','Tembo','Ouédraogo','Mutombo'], M: ['Kwame','Amadou','Chidi','Tendai','Moussa','Juma','Sipho','Ibrahim'], F: ['Amina','Fatou','Ngozi','Thandiwe','Aïssatou','Wanjiru','Zainab','Abena'] },
  sam:  { l: ['Khan','Ahmed','Hossain','Rahman','Malik','Chowdhury','Durrani','Karimi','Siddiqui','Akhtar'], M: ['Imran','Farhan','Tariq','Rashid','Hamid','Bilal','Arif','Nasir'], F: ['Ayesha','Nasrin','Farzana','Shabnam','Rukhsana','Sadia','Parveen','Zahra'] },
  slav: { l: ['Ivanov','Kowalski','Novák','Petrov','Horvat','Popov','Kovač','Shevchenko','Nowak','Sokolov'], M: ['Ivan','Jan','Pavel','Dmitri','Marek','Nikolai','Tomasz','Andrei'], F: ['Anna','Olga','Katarina','Natalia','Elena','Marta','Irina','Zofia'] },
  turk: { l: ['Yılmaz','Kaya','Demir','Aliyev','Karimov','Nazarov','Şahin','Çelik','Rakhimov','Öztürk'], M: ['Mehmet','Mustafa','Emre','Timur','Rustam','Elchin','Murat','Aziz'], F: ['Ayşe','Elif','Zeynep','Leyla','Dilnoza','Gulnara','Aylin','Madina'] },
  ger:  { l: ['Müller','Schmidt','Jansen','Andersson','Nielsen','Bauer','De Vries','Virtanen','Hansen','Meier'], M: ['Lukas','Jonas','Lars','Erik','Felix','Daan','Mikael','Henrik'], F: ['Anna','Emma','Ingrid','Lena','Sofie','Freja','Hanna','Elin'] },
  it:   { l: ['Rossi','Russo','Ferrari','Esposito','Bianchi','Romano','Colombo','Ricci','Marino','Greco'], M: ['Marco','Luca','Giuseppe','Matteo','Andrea','Francesco','Paolo','Davide'], F: ['Giulia','Chiara','Francesca','Sara','Martina','Elena','Alessia','Valentina'] },
  gr:   { l: ['Papadopoulos','Georgiou','Nikolaou','Dimitriou','Ioannou','Vasiliou','Christou','Makris'], M: ['Giorgos','Dimitris','Nikos','Kostas','Yannis','Christos'], F: ['Maria','Eleni','Katerina','Sofia','Dimitra','Ioanna'] },
  he:   { l: ['Cohen','Levi','Mizrahi','Peretz','Biton','Friedman','Katz','Azoulay'], M: ['David','Noam','Yosef','Daniel','Ariel','Eitan'], F: ['Noa','Tamar','Yael','Maya','Shira','Talia'] },
  zh:   { l: ['Wang','Li','Zhang','Liu','Chen','Yang','Huang','Zhao','Wu','Zhou'], M: ['Wei','Jun','Hao','Lei','Ming','Tao','Jie','Bo'], F: ['Xiu','Mei','Ling','Yan','Jing','Hui','Lan','Ying'] },
  ja:   { l: ['Sato','Suzuki','Takahashi','Tanaka','Watanabe','Ito','Yamamoto','Nakamura','Kobayashi','Kato'], M: ['Haruto','Ren','Sota','Yuto','Kenji','Hiroshi','Takumi','Daiki'], F: ['Yui','Sakura','Hina','Aoi','Yuki','Emi','Haruka','Miyu'] },
  ko:   { l: ['Kim','Lee','Park','Choi','Jung','Kang','Cho','Yoon'], M: ['Min-jun','Seo-jun','Ji-ho','Hyun-woo','Dong-hyun','Sung-min'], F: ['Seo-yeon','Ji-woo','Min-seo','Ha-eun','Soo-jin','Eun-ji'] },
  sea:  { l: ['Nguyen','Tran','Pham','Wijaya','Santoso','Reyes','Dela Cruz','Sok','Wong','Rahman'], M: ['Minh','Anh','Budi','Agus','Jose','Somchai','Arif','Dara'], F: ['Linh','Mai','Siti','Dewi','Maria','Sokha','Putri','Thuy'] },
};
const NAME_SET_BY_ID = {};
[['en', 'USA CAN GBR IRL AUS NZL JAM GUY TTO'], ['es', 'ESP GNQ'], ['pt', 'BRA PRT AGO MOZ GNB CPV TLS'],
 ['ar', 'SDN SOM MRT DJI COM'], ['sam', 'PAK BGD AFG MDV IRN'], ['turk', 'TUR AZE KAZ UZB KGZ TKM TJK'],
 ['ger', 'DEU AUT CHE NLD DNK FIN NOR SWE LUX BEL'], ['it', 'ITA MLT'], ['gr', 'GRC CYP'], ['he', 'ISR'],
 ['zh', 'CHN TWN HKG MAC SGP'], ['ja', 'JPN'], ['ko', 'KOR PRK']]
  .forEach(([set, ids]) => ids.split(' ').forEach(id => { NAME_SET_BY_ID[id] = set; }));
function nameSetFor(c) {
  return NAME_SET_BY_ID[c.id] || ({ lac: 'es', mena: 'ar', ssa: 'ssa', eca: 'slav', eap: 'sea', hi: 'slav' })[c.region] || null;
}
// forcedLast : nom de famille hérité, pour qu'une fratrie porte le même nom
function randomName(country, sex, forcedLast) {
  const lang = country.lang || '';
  if (/^fr:/.test(lang)) {
    const last = forcedLast || pick(LAST_NAMES_FR);
    const first = pick(FIRST_NAMES_FR[sex] || FIRST_NAMES_FR.M);
    return { last, first, full: first + ' ' + last, full_en: first + ' ' + last };
  }
  // Hors interfaces chinoise, japonaise et coréenne : noms de l'aire culturelle du pays, en écriture latine.
  const nameSet = NAME_SETS[nameSetFor(country)];
  if (nameSet && country.id !== 'IND' && !['zh-Hant', 'zh-Hans', 'ja', 'ko'].includes(LANG)) {
    const last = forcedLast || pick(nameSet.l);
    const first = pick(nameSet[sex] || nameSet.M);
    return { last, first, full: first + ' ' + last, full_en: first + ' ' + last };
  }
  if (country.id === 'TWN' || country.id === 'HKG' || country.region === 'eap' && lang === 'zh') {
    const last = forcedLast || pick(LAST_NAMES_ZH);
    const first = pick(FIRST_NAMES_ZH[sex] || FIRST_NAMES_ZH.M);
    return { last, first, full: last + first, full_en: pick(LAST_NAMES_EN) + ' ' + pick(FIRST_NAMES_EN[sex] || FIRST_NAMES_EN.M) };
  }
  if (country.id === 'IND') {
    const caste = pickIndianCaste();
    const last = forcedLast || pick(LAST_NAMES_INDIA[caste] || LAST_NAMES_INDIA['']);
    const first = pick(FIRST_NAMES_INDIA[sex] || FIRST_NAMES_INDIA.M);
    return { last, first, full: first + ' ' + last, full_en: first + ' ' + last, caste };
  }
  if (country.id === 'JPN' || country.id === 'KOR') {
    const last = forcedLast || (sex === 'F' ? (chance(0.3) ? '김' : '이') : (chance(0.3) ? '박' : '최'));
    const first = sex === 'F' ? '영' + pick(['희','은','아','수']) : '준' + pick(['호','혁','영','수']);
    return { last, first, full: last + first, full_en: pick(LAST_NAMES_EN) + ' ' + pick(FIRST_NAMES_EN[sex] || FIRST_NAMES_EN.M) };
  }
  // 預設英文
  const last = forcedLast || pick(LAST_NAMES_EN);
  const first = pick(FIRST_NAMES_EN[sex] || FIRST_NAMES_EN.M);
  return { last, first, full: last + ' ' + first, full_en: last + ' ' + first };
}
function pickIndianCaste() {
  // SC 18%, ST 9%, OBC 44%, General 29% (近似 2024 估算)
  const r = Math.random();
  if (r < 0.18) return 'SC';
  if (r < 0.27) return 'ST';
  if (r < 0.71) return 'obc';
  return '';
}

// ==== 角色生成 ====
function newLife(countryCode) {
  const c = countryById(countryCode);
  if (!c) return null;
  const sex = Math.random() < 0.5 ? 'M' : 'F';
  const fam = generateFamily(countryCode, sex);
  const name = randomName(c, sex, fam.familyLast);
  const birthYear = STATE.era === 'past' ? 1990 : STATE.era === 'future' ? 2080 : 2024;
  const father = fam.parents.find(p => p.sex === 'M');
  const mother = fam.parents.find(p => p.sex === 'F');
  const q0 = 1 + Math.floor(Math.random() * 4);                 // milieu familial : décide aussi du métier des parents
  const rural0 = chance(1 - (c.urb ?? 45) / 100);
  return {
    country: countryCode,
    countryData: c,
    name,
    sex,
    age: 0,
    year: STATE.era === 'past' ? 1990 : STATE.era === 'future' ? 2080 : 2024,
    yearOffset: 0,
    // 個人條件
    smoker: false,                            // on ne fume pas à la naissance : voir smokeProne
    smokeProne: chance(c.sm / 100 * 0.5),     // prédisposition : le tabac commence à l'adolescence
    conditions: {
      diabetes: chance(0.05 * (c.sm / 30)),
      heart: chance(0.03),
    },
    // 事件記錄
    log: [],
    quotes: {},
    // 統計
    stats: {
      education: 0,
      married: false,
      partner: null,
      kids: [],
      employment: 'none',
      health: 100,
      happiness: 70,
      knowledge: 50,    // v5.8 新增：知識 0-100
      social: 60,       // v5.8 新增：人際關係 0-100
      netAssets: 0,     // v5.8 新增：淨資產（PPP 美元）
      annualIncome: 0,  // v5.8 新增：年收入
      // 1in8b.life 風格：家境、宗教、出生地類型
      incomeQuartile: q0,
      religion: pickReligion(c),
      birthPlaceType: rural0 ? 'rural' : 'urban',   // selon le taux d'urbanisation du pays  // 55% 鄉村、45% 城市
    },
    // v5.59：教育上限（依出生國家的 eys / ter 統計抽出），教育歷程會往這個目標推進
    eduTarget: rollEducation(c),
    // 父母詳細（v5.8 新增）
    fatherDetail: father ? { age: birthYear - father.birth.year, job: parentJobFor(c, 'M', q0, rural0) } : null,
    motherDetail: mother ? { age: birthYear - mother.birth.year, job: parentJobFor(c, 'F', q0, rural0) } : null,
    // 同伴（v5.8 新增）：4 個同時出生的隨機人物
    companions: generateCompanions(countryCode, 4),
    // 1in8b.life 風格：出生登記編號
    regNumber: `${countryCode}-${(STATE.era==='past'?'1990':STATE.era==='future'?'2080':'2024')}-${Math.floor(Math.random()*9000000)+1000000}`,
    // 死亡
    died: false,
    cause: null,
    deathAge: null,
    // 族譜
    family: fam,
    // personnalité tirée à la naissance (fiche d'identité)
    traits: {
      temperament: pick(['Persévérant{e}', 'Curieu{x|se}', 'Rêveu{r|se}', 'Sociable', 'Timide', 'Têtu{e}', 'Généreu{x|se}', 'Prudent{e}', 'Impulsi{f|ve}', 'Joyeu{x|se}']),
      talents: pick(['Relations avec les autres', 'Activités physiques', 'Sens de la musique', 'Bricolage', 'Calcul et logique', 'Cuisine', 'Dessin', 'Langues', 'Sens des affaires', 'Soin des autres']),
      dream: pick(['Sportif{|ve} de haut niveau', 'Médecin', 'Enseignant{e}', 'Pilote', 'Chanteu{r|se}', 'Agricult{eur|rice}', 'Ingénieu{r|re}', 'Footballeu{r|se}', 'Artiste', 'Voyageu{r|se}', 'Commerçant{e}']),
    },
  };
}

/* ==== v5.8 新增：宗教 + 父母工作池 ==== */
function pickReligion(c) { const r0 = pickReligionRaw(c); return LANG === 'fr' ? (FR_BY_EN[r0] || r0) : r0; }
function pickReligionRaw(c) {
  const r = c.region || 'eap';
  const isEn = LANG === 'en' || LANG === 'fr';
  const mapZh = {
    'eap': ['佛教', '民間信仰', '基督新教', '天主教', '無信仰'],
    'sa': ['印度教', '伊斯蘭', '錫克教', '基督教', '佛教'],
    'eca': ['基督新教', '天主教', '東正教', '伊斯蘭', '無信仰'],
    'mena': ['伊斯蘭', '基督宗教', '德魯茲派'],
    'ssa': ['基督新教', '天主教', '伊斯蘭', '非洲傳統宗教'],
    'lac': ['天主教', '基督新教', '無信仰'],
    'na': ['基督新教', '天主教', '無信仰'],
  };
  const mapEn = {
    'eap': ['Buddhist', 'Folk religion', 'Protestant', 'Catholic', 'Non-religious'],
    'sa': ['Hindu', 'Muslim', 'Sikh', 'Christian', 'Buddhist'],
    'eca': ['Protestant', 'Catholic', 'Orthodox', 'Muslim', 'Non-religious'],
    'mena': ['Muslim', 'Christian', 'Druze'],
    'ssa': ['Protestant', 'Catholic', 'Muslim', 'African traditional'],
    'lac': ['Catholic', 'Protestant', 'Non-religious'],
    'na': ['Protestant', 'Catholic', 'Non-religious'],
  };
  const m = isEn ? mapEn : mapZh;
  const regionFallback = m[r] || (isEn ? ['Non-religious'] : ['無信仰']);

  // v6.07：改用該國真正的宗教分布 c.rel（172 國都有，每列加總 100）。
  //
  // 這裡原本只用地區清單「平均」抽，而且地區表根本沒有 'hi' 這個 key ——
  // countries.json 的 region 欄位是混用的：開發中國家放地理區
  // (sa/mena/ssa/lac/eap/eca)，已開發國家放收入級距 ('hi' = 高收入，38 國)。
  // 結果美國、日本、德國、英國、法國、以色列、台灣、韓國… 全部落到
  // fallback ['無信仰']，也就是說這 38 國出生的人生，宗教 100% 都是「無信仰」。
  // 實測 TWN / ISR 抽 300 次都是 100% 無信仰，儘管資料裡 TWN 有 44% 佛教。
  //
  // 字母對照（以各國實況核對過）：
  //   F 佛教  B 民間信仰  C 基督宗教  N 無信仰  O 其他
  //   H 印度教  M 伊斯蘭  S 錫克教  J 猶太教
  const REL_ZH = { F:'佛教', B:'民間信仰', C:'基督宗教', N:'無信仰', O:'其他',
                   H:'印度教', M:'伊斯蘭', S:'錫克教', J:'猶太教' };
  const REL_EN = { F:'Buddhist', B:'Folk religion', C:'Christian', N:'Non-religious', O:'Other',
                   H:'Hindu', M:'Muslim', S:'Sikh', J:'Jewish' };
  const relMap = isEn ? REL_EN : REL_ZH;
  const rel = c.rel;
  if (!rel) return pick(regionFallback);
  const parts = String(rel).split(',')
    .map(s => s.trim())
    .map(s => ({ name: relMap[s[0]], pct: Number(s.slice(1)) }))
    .filter(x => x.name && x.pct > 0);
  if (!parts.length) return pick(regionFallback);
  const total = parts.reduce((s, x) => s + x.pct, 0);
  let r2 = Math.random() * total;
  for (const p of parts) { r2 -= p.pct; if (r2 <= 0) return p.name; }
  return parts[parts.length - 1].name;
}

// Métier des parents selon le milieu familial (1 = très modeste … 4 = aisé) et le lieu de vie.
const PARENT_JOBS = {
  1: { rural: [['Farmer', 'Agriculteur'], ['Laborer', 'Ouvrier agricole'], ['Herder', 'Éleveur'], ['Vendor', 'Petit commerçant'], ['Porter', 'Porteur']], urban: [['Vendor', 'Vendeur de rue'], ['Laborer', 'Manœuvre'], ['Security guard', 'Gardien'], ['Service worker', 'Employé de service'], ['Porter', 'Docker']] },
  2: { rural: [['Farmer', 'Agriculteur'], ['Fisherman', 'Pêcheur'], ['Auto mechanic', 'Mécanicien'], ['Vendor', 'Commerçant'], ['Construction worker', 'Ouvrier du bâtiment']], urban: [['Taxi driver', 'Chauffeur de taxi'], ['Construction worker', 'Ouvrier du bâtiment'], ['Sales clerk', 'Vendeur'], ['Service worker', 'Employé de service'], ['Technician', 'Technicien']] },
  3: { rural: [['Teacher', 'Enseignant'], ['Technician', 'Technicien'], ['Farmer', 'Agriculteur propriétaire'], ['Civil servant', 'Fonctionnaire']], urban: [['Teacher', 'Enseignant'], ['Nurse', 'Infirmier'], ['Civil servant', 'Fonctionnaire'], ['Bank clerk', 'Employé de banque'], ['Technician', 'Technicien']] },
  4: { rural: [['Doctor', 'Médecin'], ['Teacher', 'Directeur d\'école'], ['Farmer', 'Grand exploitant agricole']], urban: [['Engineer', 'Ingénieur'], ['Doctor', 'Médecin'], ['Lawyer', 'Avocat'], ['Manager', 'Cadre dirigeant'], ['Business owner', 'Chef d\'entreprise']] },
};
function parentJobFor(c, sex, q, rural) {
  const pool = PARENT_JOBS[q][rural ? 'rural' : 'urban'];
  const [en, fr] = pick(pool);
  if (LANG !== 'fr') return en;
  if (sex === 'F') return fr.replace(/^Agriculteur/, 'Agricultrice').replace(/^Éleveur/, 'Éleveuse').replace(/^Ouvrier/, 'Ouvrière').replace(/^Petit commerçant/, 'Petite commerçante').replace(/^Commerçant/, 'Commerçante').replace(/^Vendeur/, 'Vendeuse').replace(/^Mécanicien/, 'Mécanicienne').replace(/^Pêcheur/, 'Pêcheuse').replace(/^Chauffeur/, 'Chauffeuse').replace(/^Enseignant/, 'Enseignante').replace(/^Infirmier/, 'Infirmière').replace(/^Technicien/, 'Technicienne').replace(/^Gardien/, 'Gardienne').replace(/^Employé/, 'Employée').replace(/^Médecin/, 'Médecin').replace(/^Directeur/, 'Directrice').replace(/^Ingénieur/, 'Ingénieure').replace(/^Avocat/, 'Avocate').replace(/^Cadre/, 'Cadre').replace(/^Chef/, 'Cheffe').replace(/^Fonctionnaire/, 'Fonctionnaire').replace(/^Grand exploitant/, 'Grande exploitante').replace(/^Manœuvre/, 'Manœuvre').replace(/^Porteur/, 'Porteuse').replace(/^Docker/, 'Docker');
  return fr;
}
function pickParentJob(c, sex) { const j0 = pickParentJobRaw(c, sex); return LANG === 'fr' ? (FR_BY_EN[j0] || j0) : j0; }
function pickParentJobRaw(c, sex) {
  const isEn = LANG === 'en' || LANG === 'fr';
  const ruralMZh = ['農夫', '工人', '計程車司機', '建築工', '漁民', '牧民', '汽車維修技師', '技工', '小販', '搬運工', '保全'];
  const urbanMZh = ['工程師', '教師', '銀行員', '銷售員', '公務員'];
  const urbanFZh = ['教師', '護理師', '銷售員', '公務員', '服務業'];
  const ruralMEn = ['Farmer', 'Laborer', 'Taxi driver', 'Construction worker', 'Fisherman', 'Herder', 'Auto mechanic', 'Technician', 'Vendor', 'Porter', 'Security guard'];
  const urbanMEn = ['Engineer', 'Teacher', 'Bank clerk', 'Sales clerk', 'Civil servant'];
  const urbanFEn = ['Teacher', 'Nurse', 'Sales clerk', 'Civil servant', 'Service worker'];
  // v6.07：鄉村／城市改用該國真正的都市化率 c.urb（每 10 萬人的都市人口百分比，
  // 全體中位數 63.5）。舊碼是一顆固定的 55% 骰子，
  // 於是日本（92% 都市）和衣索比亞（23% 都市）的家長職業池長得一樣。
  // 另外舊碼在這裡算了 `const r = c.region` 但從來沒用過，是死碼。
  const isRural = Math.random() * 100 >= (c.urb ?? 55);
  if (isEn) {
    return isRural ? pick(ruralMEn) : pick(sex === 'M' ? urbanMEn : urbanFEn);
  }
  return isRural ? pick(ruralMZh) : pick(sex === 'M' ? urbanMZh : urbanFZh);
}

/* ==== v5.8 新增：4 位同伴（同時出生的隨機人物） ==== */
/* v5.19：每位同伴補上「家庭背景」+「出生地區」 */
function generateCompanions(selfCountry, n) {
  const allCountries = ['USA','CHN','IND','JPN','KOR','BRA','RUS','DEU','GBR','FRA','MEX','IDN','TUR','SAU','ITA','EGY','PAK','BGD','NGA','VNM','PHL','ETH','IRN','COD','MMR','THA','ZAF','TZA','KEN','UKR','POL','CAN','AUS','ARG','KAZ','NPL','CUB'];
  const companions = [];
  for (let i = 0; i < n; i++) {
    let cCode;
    do { cCode = pick(allCountries); } while (cCode === selfCountry);
    const c = countryById(cCode);
    const sex = Math.random() < 0.5 ? 'M' : 'F';
    const nm = randomName(c, sex);
    // v5.19：父母職業依同伴國家脈絡
    const fatherJob = pickParentJob(c, 'M');
    const motherJob = pickParentJob(c, 'F');
    companions.push({
      id: 'comp_' + i,
      name: nm.full || nm.full_en,
      nameEn: nm.full_en || '',
      sex, country: cCode,
      countryData: c,
      flag: c.flag,
      // 每人也是 80 歲預期壽命起點
      lifeExpectancy: c.le,
      // 家境也分位
      incomeQuartile: 1 + Math.floor(Math.random()*4),
      // v5.19 新增：家庭背景 + 出生地類型
      parentJobFather: fatherJob,
      parentJobMother: motherJob,
      birthPlaceType: chance(1 - (c.urb ?? 45) / 100) ? 'rural' : 'urban',   // selon le taux d'urbanisation du pays
    });
  }
  return companions;
}

/* v5.19：根據瀏覽器語言推測「你現在若出生」的真實國家 */
function guessBirthCountry() {
  const nav = (navigator.language || 'en').toLowerCase();
  // 依語系 → 推測人口最多的國家
  if (nav.startsWith('zh-tw') || nav === 'zh-hant' || nav === 'zh-hk' || nav === 'zh-mo') return countryById('TWN');
  if (nav.startsWith('zh')) return countryById('CHN');
  if (nav.startsWith('ja')) return countryById('JPN');
  if (nav.startsWith('ko')) return countryById('KOR');
  if (nav.startsWith('vi')) return countryById('VNM');
  if (nav.startsWith('fr')) return countryById('FRA');
  if (nav.startsWith('th')) return countryById('THA');
  if (nav.startsWith('es')) return countryById('MEX');
  // en / 其他：英文使用人口最多的國家
  if (nav.startsWith('en')) return countryById('USA');
  return countryById('USA');
}

/* v5.21 修：當年存活率 — 改用 l[]（cumulative survival probability），fallback 用通用曲線 */
function survivalRateForAge(c, sex, age) {
  if (!c) return null;
  try {
    const lt = lifeTable(c, sex);
    if (!lt || !lt.l || age < 0) return null;
    const i = Math.max(0, Math.min(110, Math.floor(age)));
    const v = lt.l[i];
    if (typeof v !== 'number' || isNaN(v)) return null;
    // 0歲顯示為 100%
    if (age === 0) return 1;
    return Math.max(0, Math.min(1, v));
  } catch (e) {
    // fallback：使用通用 GBD-style 簡化曲線
    if (age === 0) return 1;
    if (age < 5) return 0.99 - age * 0.001;
    if (age < 30) return 0.99 - (age-5) * 0.0008;
    if (age < 60) return 0.97 - (age-30) * 0.005;
    return Math.max(0.1, 0.82 - (age-60) * 0.02);
  }
}

/* v5.19：你是哪個家庭分位 (1-4) 的中文/英文短碼 */
function quartileLabel(q, isEn) {
  if (!q) return '—';
  if (isEn || LANG === 'fr') { const v = ['Bottom 25%','Lower-middle','Upper-middle','Top 25%'][q-1]; return v ? enfr(v, v) : ('Q' + q); }
  return ['最低 25%','中下 50%','中上 75%','最高 25%'][q-1] || ('Q' + q);
}

/* ==== 族譜：家族生成 ==== */
function generateFamily(countryCode, selfSex, fc) {
  const c = countryById(countryCode);
  if (!c) return { parents: [], siblings: [], grandparents: [], partner: null, kids: [] };
  const baseYear = (STATE.era === 'past' ? 1990 : STATE.era === 'future' ? 2080 : 2024);
  const war = c.war || 0;
  // 戰區孤兒機率：war 高 → 雙親存在率低
  const parentChance = Math.max(0.35, 1 - war * 0.4);
  const haveFather = Math.random() < parentChance;
  const haveMother = Math.random() < parentChance;
  // 寄養/收養：換父母
  let parentCountry = countryCode, parentCountryData = c;
  let parentNote = null;
  if (fc && fc.type === 'adopt') {
    // 從隨機另一個國家收養
    const adopters = ['USA','CAN','GBR','FRA','DEU','AUS','SWE','NOR'];
    const fcode = adopters[Math.floor(Math.random() * adopters.length)];
    parentCountry = fcode;
    parentCountryData = countryById(fcode) || c;
    parentNote = 'adoptive';
  } else if (fc && fc.type === 'foster') {
    parentNote = 'foster';
  }
  const fAge = 22 + Math.floor(Math.random() * 19);   // âge du père à la naissance
  const fatherName = haveFather ? randomName(parentCountryData, 'M') : null;
  const motherName = haveMother ? randomName(parentCountryData, 'F') : null;
  const father = haveFather ? {
    id: 'f_' + Math.random().toString(36).slice(2,8),
    name: fatherName.full || fatherName.full_en || '?',
    sex: 'M', country: parentCountry, countryData: parentCountryData,
    note: parentNote,
    birth: { year: baseYear - fAge },
    death: parentNote ? null : { year: baseYear - fAge + (parentNote === 'foster' ? 50 : 70) }
  } : null;
  const mother = haveMother ? {
    id: 'm_' + Math.random().toString(36).slice(2,8),
    name: motherName.full || motherName.full_en || '?',
    sex: 'F', country: parentCountry, countryData: parentCountryData,
    note: parentNote,
    birth: { year: baseYear - fAge + (Math.random() < 0.5 ? -2 : 3) },
    death: parentNote ? null : { year: baseYear - fAge + 75 }
  } : null;
  const parents = [father, mother].filter(Boolean);
  const familyLast = parentNote ? null : (fatherName || motherName)?.last || null;
  // 手足數：戰區小孩通常更少
  let nSib = 0;
  const sibR = Math.random();
  if (war > 0.5) nSib = sibR < 0.4 ? 0 : sibR < 0.75 ? 1 : 2;
  else nSib = sibR < 0.3 ? 0 : sibR < 0.6 ? 1 : sibR < 0.85 ? 2 : 3;
  const siblings = [];
  for (let i = 0; i < nSib; i++) {
    const sibSex = Math.random() < 0.5 ? 'M' : 'F';
    const nm = randomName(c, sibSex, familyLast);
    siblings.push({
      id: 's_' + Math.random().toString(36).slice(2,8),
      name: nm.full || nm.full_en || '?',
      sex: sibSex, country: countryCode, countryData: c,
      // jamais né avant que le plus jeune parent ait 17 ans
      birth: { year: Math.max(baseYear - 2 * (i + 1) - Math.floor(Math.random() * 2) + (Math.random() < 0.35 ? 2 * (i + 1) + 2 : 0), baseYear - fAge + 3 + 17) }
    });
  }
  // 祖父母：有父母才合理；戰區祖父母多半死亡
  const grandparents = [];
  const gpChance = parentNote ? 0.5 : Math.max(0.2, 0.7 - war * 0.3);
  if (father && Math.random() < gpChance) {
    const gf = randomName(parentCountryData, 'M', fatherName.last);
    grandparents.push({ id:'gf_'+Math.random().toString(36).slice(2,8), name: gf.full||gf.full_en||'?', sex:'M', country: parentCountry, countryData: parentCountryData, note: parentNote, birth:{year: father.birth.year - 28}, death:{year: father.birth.year + 35} });
  }
  if (mother && Math.random() < gpChance) {
    const gm = randomName(parentCountryData, 'F');
    grandparents.push({ id:'gm_'+Math.random().toString(36).slice(2,8), name: gm.full||gm.full_en||'?', sex:'F', country: parentCountry, countryData: parentCountryData, note: parentNote, birth:{year: mother.birth.year - 26}, death:{year: mother.birth.year + 38} });
  }
  // Les deux grands-parents de chaque côté (avant : un seul grand-père paternel et une seule grand-mère maternelle).
  grandparents.forEach(g => { g.childOf = g.sex === 'M' ? father?.id : mother?.id; });
  [[father, 'F', fatherName], [mother, 'M', motherName]].forEach(([par, sex, parName]) => {
    if (!par || Math.random() >= gpChance) return;
    const nm = randomName(parentCountryData, sex, sex === 'M' ? parName.last : undefined);
    grandparents.push({ id: 'g' + sex + '2_' + Math.random().toString(36).slice(2, 8), name: nm.full || nm.full_en || '?', sex,
      country: parentCountry, countryData: parentCountryData, note: parentNote, childOf: par.id,
      birth: { year: par.birth.year - 27 }, death: { year: par.birth.year + 37 } });
  });
  return { parents, siblings, grandparents, familyLast, partner: null, kids: [], fosterCare: fc?.type || null, adoptedFrom: fc?.type === 'adopt' ? countryCode : null };
}

// ==== 事件 ====
/* v5.59：依國家統計抽出個人教育上限（0–4）。
   刻度對應 i18n：0=未上學 1=小學 2=國中 3=高中 4=大學。
   eys = 預期受教育年數（UNESCO），ter = 高等教育粗在學率（%）。
   加一點個人變異，避免同一國家每個人讀一模一樣的書。 */
function rollEducation(c) {
  const base = Number.isFinite(c?.eys) ? c.eys : 12;
  const eys = base + (Math.random() * 6 - 3);          // ±3 年個人差異
  let lvl;
  if (eys < 6.5) lvl = 0;
  else if (eys < 9.5) lvl = 1;
  else if (eys < 12) lvl = 2;
  else if (eys < 15) lvl = 3;
  else lvl = 3;                                       // 有機會讀大學，但要看當地大學入學率
  if (eys >= 15) {
    const ter = Number.isFinite(c?.ter) ? c.ter : 30;
    if (Math.random() * 100 < ter) lvl = 4;
  }
  return lvl;
}


/* ==== Maladies suivies dans le temps ====
   Un diagnostic ouvre un parcours : choix du traitement (coût selon la part des soins payée par les ménages du pays),
   années de soins avec leurs aléas, puis rémission ou aggravation. Le coût annuel entre dans le budget de santé. */
function illnessAccess(c) { return Math.min(1, 0.45 + (c.ppp || 0) / 30000); }   // facilité d'accès aux soins spécialisés
function illnessCost(life, level) {
  const c = life.countryData || {}, base = 0.55 * (c.ppp || 12000), o = (c.oop ?? 30) / 100, t = life.illness.type;
  const k = t === 'cancer' ? 0.1 : t === 'heart' ? 0.03 : t === 'stroke' ? 0.05 : 0.02;
  return base * k * (0.3 + 3 * o) * (level === 'full' ? 1 : 0.45);
}
function startTreatment(life, level) {
  const ill = life.illness; if (!ill) return;
  ill.treated = level; ill.treatStart = life.age;
  life.careCost = level === 'none' ? 0 : illnessCost(life, level);
  if (level === 'none') { life.stats.happiness = Math.max(0, life.stats.happiness - 4); }
}
function illnessYear(life, newAge) {
  const ill = life.illness; if (!ill || ill.status === 'resolved' || ill.treated == null) return [];
  const fr = LANG === 'fr', out = [], s = life.stats, c = life.countryData || {};
  const say = (icon, txt) => out.push({ age: newAge, kind: 'illness', icon, text: genderize(txt, life) });
  if (ill.type === 'cancer') {
    if (ill.status === 'active') {
      if (ill.treated === 'none') {
        bumpHealth(life, -14); s.happiness = Math.max(0, s.happiness - 3);
        say('🥀', "La maladie progresse. Chaque semaine vous épuise un peu plus et vous renoncez à presque tout.");
      } else {
        bumpHealth(life, ill.treated === 'full' ? -4 : -7);
        say('💉', pick(["Une séance de traitement vous laisse épuisé{e} pour plusieurs jours.", "Vos cheveux tombent. Vous restez un long moment devant le miroir.", "Un proche vous accompagne à chaque séance et ne vous quitte pas des yeux.", "Vous comptez les semaines qui vous séparent du prochain examen."]));
        if (newAge - ill.treatStart >= 2) {
          const p = (ill.treated === 'full' ? 0.7 : 0.4) * illnessAccess(c);
          if (Math.random() < p) {
            ill.status = 'remission'; ill.remissionAt = newAge; life.careCost = illnessCost(life, 'partial') * 0.3;
            s.happiness = Math.min(100, s.happiness + 6);
            say('🌤️', "Les derniers examens sont clairs : vous êtes en rémission. Il faudra rester surveillé{e} pendant des années.");
          } else {
            ill.treatStart = newAge;
            say('😔', "Les examens montrent que la maladie résiste. Il faut poursuivre le traitement.");
          }
        }
      }
    } else if (ill.status === 'remission') {
      if (newAge - ill.remissionAt >= 5) { ill.status = 'resolved'; life.careCost = 0; say('🎉', "Cinq ans après, le médecin vous déclare guéri{e}. Vous n'osiez plus l'espérer."); }
      else if (Math.random() < 0.05) { ill.status = 'active'; ill.treatStart = newAge; life.careCost = illnessCost(life, ill.treated === 'none' ? 'partial' : ill.treated); say('⚠️', "Un contrôle révèle une récidive. Tout recommence."); }
      else if (Math.random() < 0.5) say('🩺', "Vous passez votre contrôle annuel. Tout va bien, cette fois encore.");
    }
  } else if (ill.type === 'heart' || ill.type === 'stroke') {
    if (ill.treated === 'none') { bumpHealth(life, -6); if (Math.random() < 0.6) say('😮‍💨', "Votre essoufflement s'aggrave : le moindre escalier devient une épreuve."); }
    else if (Math.random() < 0.4) say('💊', pick(["Votre cardiologue ajuste le traitement. Vous prenez vos comprimés chaque matin sans y penser.", "Un contrôle montre que votre cœur tient le coup. Vous respirez.", "Vous renoncez au sel et aux escaliers pressés, à contrecœur."]));
  } else if (ill.type === 'diabetes') {
    if (ill.treated === 'none') { bumpHealth(life, -3); }
    else if (Math.random() < 0.4) say('🩸', "Vous contrôlez votre glycémie chaque matin, comme un rituel.");
  }
  return out;
}
const illActive = (l) => !!(l.illness && l.illness.treated === null);

/* ==== Priorité de l'année ====
   Un choix permanent, modifiable à tout moment, qui oriente chaque année de la vie : jauges, revenu, loisirs. */
const PRIORITIES = {
  study:   { fr: 'Études', sub: 'Savoir↑ · moins de temps libre', fx: { know: 1.2, happy: -0.3 } },
  play:    { fr: 'Jeux et amis', sub: 'Bonheur↑ · Relations↑', fx: { happy: 1, social: 1 } },
  help:    { fr: 'Aider la famille', sub: 'Relations↑ · Savoir↓', fx: { social: 1, know: -0.3 } },
  sport:   { fr: 'Sport', sub: 'Santé↑', fx: { health: 1.2, happy: 0.3 } },
  work:    { fr: 'Priorité au travail', sub: 'Revenu et promotion↑ · Santé et Relations↓', fx: { health: -0.6, social: -0.8, happy: -0.2 }, legacy: 'work' },
  balance: { fr: 'Équilibre', sub: 'Un peu de tout', fx: { happy: 0.3, health: 0.2, social: 0.2 } },
  family:  { fr: 'Famille et amis', sub: 'Relations↑ · Bonheur↑', fx: { social: 1.2, happy: 0.6 }, legacy: 'family' },
  health:  { fr: 'Prendre soin de sa santé', sub: 'Santé↑ · Argent un peu↓', fx: { health: 1.5, happy: 0.2 }, legacy: 'health' },
  growth:  { fr: 'Développement personnel', sub: 'Savoir↑ · Offres d\'emploi↑ · Argent un peu↓', fx: { know: 1.5 }, legacy: 'study' },
  leisure: { fr: 'Loisirs', sub: 'Bonheur↑ · Niveau dans vos loisirs↑', fx: { happy: 1.5 }, legacy: 'play' },
  rest:    { fr: 'Repos', sub: 'Santé↑ · Bonheur↑', fx: { health: 0.8, happy: 0.8 }, legacy: 'rest' },
};
function priorityOptions(life) {
  const a = life.age;
  if (a < 6) return [];
  if (a < 12) return ['study', 'play', 'help', 'sport'];
  if (a < 18) return ['study', 'play', 'sport', 'help'];
  if (a < 25 || life.stats.employment === 'university') return ['growth', 'work', 'family', 'health', 'leisure'];
  if (a < 63) return ['work', 'balance', 'family', 'health', 'growth', 'leisure'];
  return ['health', 'family', 'leisure', 'rest', 'growth'];
}
function applyPriority(life) {
  const opts = priorityOptions(life);
  if (!opts.length) { life.priority = null; return; }
  if (!opts.includes(life.priority)) life.priority = opts.includes('balance') ? 'balance' : opts[0];
  const P = PRIORITIES[life.priority], s = life.stats;
  const clamp = v => Math.max(0, Math.min(100, v));
  if (P.fx.health) bumpHealth(life, P.fx.health);
  if (P.fx.happy) s.happiness = clamp(s.happiness + P.fx.happy);
  if (P.fx.social) s.social = clamp(s.social + P.fx.social);
  if (P.fx.know) s.knowledge = clamp(s.knowledge + P.fx.know);
  life.focusThisYear = P.legacy || null;   // oriente aussi le tirage des petits évènements
  // loisirs : les niveaux montent plus vite quand c'est la priorité
  Object.keys(life.hobbies || {}).forEach(h => { life.hobbies[h] = Math.min(30, life.hobbies[h] + (life.priority === 'leisure' ? 1 : 0.3)); });
}
function yearSocial(life, newAge) {
  const out = [], fr = LANG === 'fr';
  const taken = () => new Set([...(life.family?.siblings || []).map(x => String(x.name).split(' ')[0]), ...(life.friends || []).map(f => f.name)]);
  const first = () => { let n, g = 0; do { n = randomName(life.countryData, Math.random() < 0.5 ? 'M' : 'F').first; } while (taken().has(n) && g++ < 12); return n; };
  if (newAge === 7 && !life.friends) {
    life.friends = [{ name: first(), closeness: 'proche' }, { name: first(), closeness: 'proche' }];
    if (fr) out.push({ age: newAge, kind: 'milestone', icon: '👫', text: "Vous vous liez d'amitié avec " + life.friends[0].name + " et " + life.friends[1].name + " : on ne vous voit plus l'un sans l'autre." });
  }
  if (life.friends && newAge >= 10 && newAge % 4 === 0 && Math.random() < 0.25) {
    const f = pick(life.friends.filter(x => x.closeness === 'proche'));
    if (f && fr) { f.closeness = 'distante'; out.push({ age: newAge, kind: 'social', icon: '📞', text: "Avec " + f.name + ", les nouvelles se font plus rares. Chacun a sa vie maintenant." }); }
  }
  if (newAge === 8 && !life.hobbies) {
    const h = pick(['Football', 'Musique', 'Dessin', 'Course à pied', 'Danse', 'Lecture', 'Basket', 'Cuisine']);
    life.hobbies = { [h]: 1 };
    if (fr) out.push({ age: newAge, kind: 'milestone', icon: '🎯', text: "Vous vous passionnez pour une activité : " + h.toLowerCase() + ". Vous y passez tout votre temps libre." });
  }
  // relation avec les parents : elle évolue avec les années
  const rel = life.rel || (life.rel = { mother: 'proche', father: 'proche' });
  if (newAge >= 20 && newAge % 5 === 0 && Math.random() < 0.2 && rel.mother === 'proche') { rel.mother = 'distante'; if (fr) out.push({ age: newAge, kind: 'social', icon: '💭', text: "Vous parlez de moins en moins à votre mère. Aucune dispute : simplement la vie qui prend la place." }); }
  return out;
}
function milestoneEvents(life, newAge) {
  const events = [];
  // v5.59：教育歷程改為「往上限爬」而非用絕對值當門檻。
  // 舊碼只有 `education = 1` 這一個寫入點，因此 education >= 2 永不成立，
  // 連帶 employment 永遠不會是 'employed'（收入不累積、5 個決策事件形同虛設）。
  // 出生時先依國家統計抽出 eduTarget（0–4），之後每年齡把 education 往目標推進。
  const tgt = life.eduTarget ?? life.stats.education;
  if (newAge === 6) {
    if (tgt >= 1) life.stats.education = Math.max(life.stats.education, 1);
    events.push({ age: 6, kind: 'milestone', icon: '🎒', text: t('event.school.start') });
  }
  if (newAge === 12) {
    if (tgt >= 2) life.stats.education = Math.max(life.stats.education, 2);
    events.push({ age: 12, kind: 'milestone', icon: '📚', text: t('event.school.middle') });
  }
  if (newAge === 15 && life.stats.education === 2 && tgt < 3 && chance(0.5)) {
    life.stats.education = 1;  // 國中輟學
    events.push({ age: 15, kind: 'milestone', icon: '📖', text: t('event.education.low') });
  }
  if (life.smokeProne && !life.smoker && !life.exSmoker && newAge >= 16 && newAge <= 19 && chance(0.5)) {
    life.smoker = true;
    events.push({ age: newAge, kind: 'small', icon: '🚬', text: LANG === 'fr' ? "Vous allumez votre première cigarette avec des amis. Elle ne sera pas la dernière." : 'You light your first cigarette with friends.' });
  }
  if (newAge === 18) {
    if (tgt >= 3) {
      life.stats.education = 3;                       // 至少高中畢業
      life.stats.employment = life.stats.employment === 'none' ? 'seeking' : life.stats.employment;
      events.push({ age: 18, kind: 'milestone', icon: '🎓', text: t('event.school.graduate') });
    } else if (tgt >= 1) {
      life.stats.education = Math.max(life.stats.education, 1);
      life.stats.employment = 'employed';            // v5.59：舊碼忘了設，這裡補上
      events.push({ age: 18, kind: 'milestone', icon: '🔨', text: t('event.work.start') });
    }
  }
  if (newAge >= 19 && newAge <= 23 && life.stats.employment === 'seeking' && chance(0.4)) {
    life.stats.employment = 'employed';
  }
  // Université : entrée à 19 ans pour qui vise le niveau supérieur, trois ans d'études, puis réussite ou échec.
  if (newAge === 19 && life.stats.education >= 3 && tgt >= 4 && !life.univ && ['seeking', 'none'].includes(life.stats.employment)) {
    life.univ = { start: 19, status: 'enrolled' };
    life.stats.employment = 'university';
    events.push({ age: newAge, kind: 'milestone', icon: '🎓', text: LANG === 'fr' ? "Vous entrez à l'université. Trois années d'études vous attendent." : t('event.education.university') });
  }
  if (life.univ && life.univ.status === 'enrolled' && newAge >= life.univ.start + 3) {
    const pass = Math.max(0.25, Math.min(0.9, 0.6 + 0.25 * (life.stats.knowledge - 55) / 45 + 0.05 * (quartOf(life) - 2) - (life.stats.happiness < 40 ? 0.1 : 0)));
    life.stats.employment = 'employed';
    if (Math.random() < pass) {
      life.univ.status = 'graduated'; life.stats.education = 4;
      life.stats.happiness = Math.min(100, life.stats.happiness + 6);
      events.push({ age: newAge, kind: 'milestone', icon: '🎓', text: LANG === 'fr' ? "Vous obtenez votre diplôme universitaire. Votre famille est fière de vous." : 'You earn your university degree.' });
    } else {
      life.univ.status = 'failed'; life.univ.failedAt = newAge;
      life.stats.happiness = Math.max(0, life.stats.happiness - 6);
      events.push({ age: newAge, kind: 'milestone', icon: '📉', text: LANG === 'fr' ? "Vous échouez aux examens de dernière année et quittez l'université sans diplôme." : 'You fail your final exams and leave university without a degree.' });
    }
  }
  // Le mariage ne tombe plus du ciel : il vient d'un choix du joueur (rencontre, vie commune, demande, mariage arrangé).
  if (life.pendingMarriage && !life.stats.married) {
    life.pendingMarriage = false;
    life.stats.married = true;
    life.stats.relationship = 'married';
    life.marriedAt = newAge;
    if (!life.stats.partner) life.stats.partner = newPartner(life, 0);
    const partnerName = life.stats.partner.name;
    if (life.family) {
      life.family.partner = {
        id: 'p_' + Math.random().toString(36).slice(2,8),
        name: partnerName.full || partnerName.full_en || '?',
        nameEn: partnerName.full_en,
        sex: life.sex === 'M' ? 'F' : 'M',
        country: life.country,
        countryData: life.countryData,
        marriageAge: newAge,
        birth: { year: (life.year + life.yearOffset - life.age) - (newAge - Math.floor(Math.random()*5)) }
      };
    }
    events.push({ age: newAge, kind: 'milestone', icon: '💍', text: t('event.marriage', partnerName.full || partnerName.full_en || '') });
  }
  // Enfants : en couple marié ou non, à un rythme et jusqu'à un nombre qui suivent la fécondité du pays.
  if ((life.stats.married || life.stats.relationship === 'cohab') && life.stats.kids.length < Math.min(8, Math.round((life.countryData?.tfr || 2) + 1.5)) && newAge >= 18 && newAge <= 45 && chance(Math.min(0.3, (life.countryData?.tfr || 2) / 14))) {
    const sex = Math.random() < 0.5 ? 'M' : 'F';
    const child = { sex, bornAt: newAge };
    life.stats.kids.push(child);
    if (life.family) {
      life.family.kids = life.family.kids || [];
      const childBirth = { year: (life.year + life.yearOffset) };
      const childNode = {
        id: 'k_' + Math.random().toString(36).slice(2,8),
        name: randomName(life.countryData, sex, life.name.last).full || randomName(life.countryData, sex, life.name.last).full_en || '?',
        sex, country: life.country, countryData: life.countryData,
        birth: childBirth,
        // 依 country.im 機率夭折（5 歲以下死亡率）
        death: chance((life.countryData.im || 5) / 1000 * 0.3) ? { year: childBirth.year + Math.floor(Math.random() * 5) } : null
      };
      life.family.kids.push(childNode);
      if (childNode.death && !STATE.eduMode && !STATE.softMode) events.push({ age: newAge, kind: 'heavy', icon: '🕯️', text: LANG === 'en' ? `${childNode.name} died as an infant.` : LANG === 'fr' ? `${childNode.name} est mort(e) en bas âge.` : `${childNode.name} 在嬰幼兒時期夭折了。` });
    }
    events.push({ age: newAge, kind: 'milestone', icon: '👶', text: t('event.baby', life.stats.kids.length) });
  }
  { const ra = retireAge(life);
    if (newAge === ra && life.stats.employment !== 'university' && life.stats.employment !== 'retired') {
      if (hasPension(life)) {
        life.stats.employment = 'retired';
        events.push({ age: newAge, kind: 'milestone', icon: '🏖️', text: LANG === 'fr' ? `À ${ra} ans, l'âge légal de la retraite ici, vous cessez de travailler et touchez votre pension.` : t('event.retirement') });
      } else {
        events.push({ age: newAge, kind: 'milestone', icon: '🧺', text: LANG === 'fr' ? `À ${ra} ans, vous n'avez droit à aucune pension : vous continuez à travailler tant que vos forces le permettent.` : 'With no pension, you keep working.' });
      }
    } else if (newAge === 75 && life.stats.employment === 'employed' && !life.pensionRight) {
      life.stats.employment = 'retired';
      events.push({ age: newAge, kind: 'milestone', icon: '🪑', text: LANG === 'fr' ? "Vos forces déclinent : vous arrêtez de travailler et vivez de l'aide de vos proches." : 'You stop working and rely on relatives.' });
    } }
  // 偶發事件（教學版過濾掉疾病）
  // v5.62：只挑還沒得過的病 — 否則同一個人生會重複出現「罹患癌症」
  if (!STATE.eduMode && !STATE.softMode && newAge >= 18 && newAge <= 65 && !life.illness && chance(0.04)) {
    const fresh = ['cancer', 'heart', 'stroke', 'diabetes']
      .filter(c => !(c === 'stroke' ? life.conditions.heart : life.conditions[c]));
    if (fresh.length) {
      const cond = pick(fresh);
      life.conditions[cond === 'stroke' ? 'heart' : cond] = true;
      life.illness = { type: cond, since: newAge, treated: null, status: 'active' };
      const dx = { cancer: "Un examen de contrôle révèle une tumeur. On vous annonce un cancer ; le médecin parle de traitement, sans rien promettre.", heart: "Après un malaise, on vous diagnostique une maladie du cœur. Il faudra un traitement et un suivi.", stroke: "Un matin, votre bras ne répond plus : c'est un AVC.", diabetes: "Une prise de sang trahit un diabète. Il va falloir changer vos habitudes." };
      events.push({ age: newAge, kind: 'illness', icon: '💊', text: LANG === 'fr' ? dx[cond] : t('event.illness.' + cond) });
    }
  }
  events.push(...illnessYear(life, newAge));
  events.push(...yearSocial(life, newAge));
  if (newAge >= 12 && newAge <= 25 && chance(0.02)) {
    events.push({ age: newAge, kind: 'social', icon: '🎓', text: t('event.event.school.exam') });
  }
  // 印度種姓相關
  if (life.country === 'IND' && life.name.caste === 'SC' && newAge >= 8 && newAge <= 16 && chance(0.08)) {
    events.push({ age: newAge, kind: 'social', icon: '⚠️', text: t('event.caste.disc') });
  }
  // 紐澳原住民加成
  if ((life.country === 'NZL' || life.country === 'AUS') && newAge === 18 && chance(0.5)) {
    events.push({ age: newAge, kind: 'social', icon: '🌿', text: LANG === 'en' ? 'You identify as indigenous; get education & health support.' : LANG === 'fr' ? "Vous êtes reconnu(e) comme descendant(e) d'un peuple autochtone : aides pour l'école et la santé." : '你被認定為原住民後裔，獲得教育補助與健康資源。' });
  }
  // 戰爭/衝突（教學版過濾掉）
  // v5.62：每種戰爭事件一生只出現一次，全部用完就不再抽
  const warEvt = life.countryData?.war || 0;   // `wh` est le score de bonheur, pas le conflit
  if (!STATE.eduMode && !STATE.softMode && warEvt > 0.1 && newAge >= 1) {
    const pool = [
      LANG === 'en' ? 'Air raid sirens. The family shelters in the basement.' : LANG === 'fr' ? "Les sirènes d'alerte aérienne retentissent. Toute la famille se réfugie à la cave." : '空襲警報響起，全家躲進防空洞。',
      LANG === 'en' ? 'A neighbor dies in the fighting. You witness the scene.' : LANG === 'fr' ? "Un voisin est tué dans les combats. Vous assistez à la scène." : '鄰居在衝突中喪生，你目睹了場面。',
      LANG === 'en' ? 'Your father is conscripted. Months of silence.' : LANG === 'fr' ? "Votre père est mobilisé. Des mois sans nouvelles." : '父親被徵召上前線，數月無音訊。',
      LANG === 'en' ? 'The neighborhood is evacuated; supplies run short.' : LANG === 'fr' ? "Le quartier est évacué vers un camp provisoire ; les vivres manquent." : '鄰里被疏散到臨時營地，物資匱乏。',
      LANG === 'en' ? 'Fighting blocks the roads. School closes for a week.' : LANG === 'fr' ? "Les combats bloquent les routes. L'école ferme une semaine." : '武裝衝突封鎖道路，學校關閉一週。',
    ];
    // 用陣列不用 Set：整段人生會被 lifeExport 整包 JSON.stringify，Set 會變成 {}
    const seenWar = life.seenWar || (life.seenWar = []);
    const fresh = pool.filter(w => !seenWar.includes(w));
    if (fresh.length && chance(warEvt * 0.1)) {
      const w = pick(fresh);
      seenWar.push(w);
      events.push({ age: newAge, kind: 'heavy', icon: '⚔️', text: w });
    }
  }
  // 寄養（美/英/紐/澳/韓/日）— 教學版不觸發
  if (!STATE.eduMode && !STATE.softMode && ['USA','GBR','NZL','AUS','KOR','JPN'].includes(life.country) && newAge === 0) {
    if (chance(0.04)) {
      life.fc = { in: 1, system: 'state', type: 'foster' };
      life.family = generateFamily(life.country, life.sex, { type: 'foster' });
      events.push({ age: 0, kind: 'heavy', icon: '🏠', text: LANG === 'en' ? 'You enter foster care due to family circumstances.' : LANG === 'fr' ? "Vous êtes placé(e) en famille d'accueil à cause de la situation familiale." : '出生後因家庭變故，被送進寄養系統，由寄養父母撫養。' });
    }
  }
  // 國際收養（韓/中/越/柬/泰/印）
  if (['KOR','CHN','VNM','KHM','THA','IND'].includes(life.country) && newAge === 0 && chance(0.005)) {
    life.fc = { in: 1, system: 'international', type: 'adopt' };
    const oldCountry = life.country;
    const oldFlag = life.countryData?.flag || '';
    life.family = generateFamily(life.country, life.sex, { type: 'adopt' });
    // 遷徙：實際上 self 現在在收養國家
    const newCountry = life.family.parents[0]?.country || 'USA';
    const newCountryData = countryById(newCountry);
    const newFlag = newCountryData?.flag || '🏳️';
    life.country = newCountry;
    life.countryData = newCountryData;
    life.birthOrigin = { country: oldCountry, flag: oldFlag };  // 記錄出生國家
    events.push({ age: 0, kind: 'social', icon: '🌍', text: LANG === 'en' ? `You are adopted by a foreign family (${oldFlag} → ${newFlag}) and grow up in another country.` : LANG === 'fr' ? `Vous êtes adopté(e) par une famille étrangère (${oldFlag} → ${newFlag}) et grandissez dans un autre pays.` : `你被一對外國夫婦收養 ${oldFlag} → ${newFlag}，離開出生地到另一個國家長大。` });
    // 遷徙動畫 toast
    setTimeout(() => toast(`${oldFlag} → ${newFlag}  ${LANG==='en'?'Migration':LANG === 'fr' ? 'Migration' : '遷徙'}`), 200);
  }
  if (life.country === 'IND' && life.name.caste === 'SC' && newAge >= 18 && chance(0.05)) {
    events.push({ age: newAge, kind: 'social', icon: '📋', text: t('event.caste.form') });
  }
  // 5/15/30/50/70 暫停問題
  if ([5, 15, 30, 50, 70].includes(newAge) && !life.quotes[newAge]) {
    // v5.73 / v5.84：這一年若已經有別的 modal 開著，就不要再疊一個反思框上來。
    // v5.84 補上漏判：財務 modal 是 setTimeout(+100ms) 延遲開啟的，所以同一個 tick 裡
    // milestoneEvents 跑到這裡時 STATE.paused 還是 false，光看 paused 會漏掉 30／50 歲
    // 同時觸發財務 + 反思的情況（實測 pauseModal 與 financeModal 兩個視窗同時開著）。
    // 改看「今年是否已經記錄過任何一次打斷」，那是在排程當下同步寫的，不受延遲影響。
    const anyModalOpen = ['decisionModal', 'focusModal', 'financeModal', 'spendModal']
      .some(id => { const e = document.getElementById(id); return e && !e.hasAttribute('hidden'); });
    const alreadyShowing = STATE.paused || anyModalOpen || life.lastInterruptAge === newAge;
    if (alreadyShowing) {
      life.lastInterruptAge = newAge;
    } else {
      STATE.pendingDecision = { age: newAge, type: 'pause' };
      if (STATE.thoughtsEnabled && !STATE.autoDecide && STATE.view === 'life') {
        setTimeout(() => showPauseQuestion(), 50);
      }
    }
  }
  // v5.16：18/25/35/50 財務決策 — 改為手動觸發（不自動彈出）
  if ([18, 25, 35, 50].includes(newAge) && !life.financeDecisions?.find(d => d.age === newAge)) {
    // 只記標記（手動按鈕可觸發），不再自動彈出
    life.financeAgeAvailable = newAge;
  }
  // v5.14：每年保底事件（其他里程碑未觸發時）
  events.push(...familyDeathEvents(life, newAge));
  // Jusqu'à deux petits évènements par an, dès la première année de vie.
  for (let n = events.length; n < 2 && newAge >= 1; n++) {
    const evt = generateYearlyEvent(life);
    if (evt) {
      let text = genderize(LANG === 'fr' && evt.fr ? evt.fr : enfr(evt.en, evt.zh), life);
      if (evt.fx) {
        if (evt.fx.money) text += ' (' + (evt.fx.money < 0 ? '− ' : '+ ') + money(Math.abs(evt.fx.money * moneyScale(life))) + ')';
        applyFx(life, evt.fx, text.replace(/ \([^)]*\)$/, ''));
      }
      events.push({ age: newAge, kind: 'milestone', icon: evt.icon, text, zh: evt.zh });
      life.latestEvent = { age: newAge, icon: evt.icon, text };
    }
  }
  return events;
}

// ==== 主迴圈 ====
/* v5.24：再看一次最後的時刻 — 顯示生命最後 3 個事件 */
function replayLastMoments() {
  if (!STATE.life) return;
  const life = STATE.life;
  const isEn = LANG === 'en';
  const lastEvents = (life.log || []).slice(-5);  // 最後 5 條
  const list = $('#endLastMomentsList');
  if (!list) return;
  list.innerHTML = lastEvents.map(e => `<div class="elm-row"><span class="elm-age">${e.age} ${t('unit.years')}</span><span class="elm-icon">${e.icon || '·'}</span><span class="elm-text">${escapeHtml(e.text || '')}</span></div>`).join('') || `<span class="muted">${isEn?'No events':LANG === 'fr' ? "Aucun évènement" : '無事件'}</span>`;
  $('#endLastMoments')?.removeAttribute('hidden');
}

/* v5.24：提供意見送出 — 存 localStorage */
function submitFeedback() {
  const email = $('#feedbackEmail')?.value || '';
  const text = $('#feedbackText')?.value || '';
  if (!text || text.length < 5) {
    toast(LANG === 'en' ? 'Please write at least 5 characters' : LANG === 'fr' ? "Écrivez au moins 5 caractères" : '請至少寫 5 個字');
    return;
  }
  const feedbacks = JSON.parse(localStorage.getItem('born-somewhere-v2:feedbacks') || '[]');
  feedbacks.push({ ts: Date.now(), email, text, lang: LANG });
  localStorage.setItem('born-somewhere-v2:feedbacks', JSON.stringify(feedbacks));
  $('#feedbackModal')?.setAttribute('hidden', '');
  toast(LANG === 'en' ? 'Feedback sent (saved locally)' : LANG === 'fr' ? "Avis enregistré (sur cet appareil)" : '感謝您的意見（已存於本機）');
  if ($('#feedbackText')) $('#feedbackText').value = '';
  if ($('#feedbackEmail')) $('#feedbackEmail').value = '';
}

function startLife(countryCode, life) {
  stopTicker();
  STATE.life = life || newLife(countryCode);
  if (!STATE.life) return;
  if (!LANG.startsWith('zh')) STATE.life.currency = LANG === 'fr' ? '€' : 'US$';   // les montants sont en dollars PPA ; NT$ seulement pour les interfaces chinoises
  { const lbl = $('#currencyLabel'); if (lbl) lbl.textContent = STATE.life.currency || 'NT$'; }
  STATE.life.log.push({ age: 0, kind: 'birth', icon: '👶', text: birthIntro(STATE.life) });
  logLife(t('log.born_in', localize(STATE.life.countryData).name, ''));
  STATE.paused = false;
  STATE.speed = 1;
  STATE.tickMs = (STATE.paceSec || 5) * 1000;   // rythme choisi sur l'acte de naissance : secondes par année
  if (bgMusic) { stopMusic(); try { startMusic(musicStyleKey(STATE.life.countryData)); } catch (e) {} }
  setView('life');
  renderAll();
  startTicker();
}
function startTicker() {
  STATE.ticker = setInterval(() => tick(), STATE.tickMs / STATE.speed);
}
function stopTicker() {
  if (STATE.ticker) clearInterval(STATE.ticker);
  STATE.ticker = null;
}
function setSpeed(sp) {
  STATE.speed = sp;
  stopTicker();
  startTicker();
  renderSpeedBtns();
}
function tick() {
  if (!STATE.life || STATE.life.died || STATE.paused) return;
  // v5.33：5/15/30/50/70 暫停不阻擋 tick（顯示 modal 但生命繼續；用戶可手動互動）
  // 原本：if (STATE.pendingDecision) return;
  if (STATE.pendingDecision && !STATE.pendingDecision._dismissed) {
    // 第一次彈出 modal（已透過 milestoneEvents 觸發）；不阻擋生命
    STATE.pendingDecision._dismissed = true;
    return;
  }
  const c = STATE.life.countryData;
  const sex = STATE.life.sex;
  // v5.9：快轉到下一個抉擇 — 跳過直到遇到 pause decision
  if (STATE.fastForward) {
    STATE.fastForward = false;
    let tries = 0;
    while (tries++ < 500) {
      if (STATE.life.died || STATE.paused || STATE.pendingDecision) break;
      if (STATE.life.age === 0 && Math.random() < pDie(0, c, sex)) { dieNow(); break; }
      STATE.life.age += 1;
      STATE.life.yearOffset += 1;
      { const yd = yearDeath(STATE.life, c, sex); if (yd) { dieNow(yd === true ? undefined : yd); break; } }
      if ([5,15,30,50,70].includes(STATE.life.age)) {
        STATE.pendingDecision = { age: STATE.life.age, type: 'pause' };
        if (STATE.autoDecide) resolvePendingDecision();
        break;
      }
    }
    renderAll();
    return;
  }
  // Mortalité infantile : le risque de mourir avant le premier anniversaire n'était jamais tiré.
  if (STATE.life.age === 0 && Math.random() < pDie(0, c, sex)) { STATE.life.cause = null; dieNow(); return; }
  STATE.life.age += 1;
  STATE.life.yearOffset += 1;
  // 死亡判定
  { const yd = yearDeath(STATE.life, c, sex);
    if (yd) { dieNow(yd === true ? undefined : yd); return; } }
  // v5.8 新增：狀態自然衰減/成長
  // v5.90：健康不再「出生就頂在 100、六十歲後才開始掉」。
  // 舊版 newLife 給 health: 100，加上 60 歲後每年 −0.3，於是：
  //   (1) 前三十多年健康條完全不動，玩家看不到任何回饋；
  //   (2) 任何「+健康」的選擇都溢出（實測 64% 的人生結束時 health > 100，畫面直接顯示 108、112）。
  // 改成「往該年齡的健康上限靠攏」：上限隨年齡下降，身體靠 5%/年慢慢回到上限，
  // 所以選擇可以把健康推上去（好幾年才回來），也可以壓下來。
  {
    const hs = STATE.life.stats;
    const ceil_ = Math.max(40, 100 - Math.max(0, STATE.life.age - 18) * 0.55);
    hs.health += (ceil_ - hs.health) * 0.05;
    if (STATE.life.age > 60) hs.health -= 0.3;
    const Lh = STATE.life;
    if (Lh.smoker) hs.health -= 0.5;
    if (Lh.drinker) hs.health -= 0.5;
    if (Lh.addicted) hs.health -= 1.5;
    if (Lh.sporty) hs.health += 0.4;
    hs.health = Math.max(0, Math.min(100, hs.health));
  }
  // v5.59：年收入 — 舊碼 annualIncome 永遠是 0，所以「在職」也存不到錢。
  // 基準對齊原作 incomeAt(c, pct) ≈ c.ppp * 0.9，再依教育、家境分位調整。
  // 生活開銷依「自己的收入」而非人均 GDP 計算（否則低教育的人生會被壓成負資產）；
  // 儲蓄率隨分位提高 — 高收入家庭本來就存得比較多。
  applyYearBudget(STATE.life);
  // 知識隨教育成長
  if (STATE.life.stats.education >= 2 && STATE.life.stats.knowledge < 90) STATE.life.stats.knowledge = Math.min(100, STATE.life.stats.knowledge + 0.5);
  // v5.59：幸福會慢慢回到「當下處境決定的水位」— 沒有這個，happiness 只會被玩家的
  // 選擇單向推動，低落的時候（失業／病中／孤立／負債）永遠走不到，心理健康事件形同虛設。
  {
    const st = STATE.life.stats;
    const baseline = 45
      + (st.health - 60) * 0.35
      + (st.social - 60) * 0.12
      + (st.employment === 'employed' ? 8 : st.employment === 'university' ? 5 : st.employment === 'retired' ? 3 : -2)
      + (st.netAssets < 0 ? -8 : 0);
    // v5.86：回歸速率 0.06 -> 0.018。
    // 實測問題：永遠選第一個選項 平均幸福 68、永遠選最後一個 63 — 差了 5 分。
    // 6%/年的回歸會在幾年內把玩家累積的選擇效果抹掉，決定變得沒有意義。
    // 放慢到 1.8%／年（實測 0.011 與 0.018 的選擇影響都是 8 分，瓶頸在選項本身的增減幅度，不在回歸速度），讓一個選擇的好壞可以持續數十年（真實人生不會每年重置心情）。
    st.happiness += (baseline - st.happiness) * 0.018;
    st.happiness = Math.max(0, Math.min(100, st.happiness));
  }
  // 事件
  const events = milestoneEvents(STATE.life, STATE.life.age);
  for (const e of events) {
    STATE.life.log.push(e);
    if (e.kind === 'birth' || e.kind === 'milestone') {
      logLife(e.text);
    }
  }
  renderLife();
  recordTrajectory(STATE.life);
  // v5.16：年度焦點選擇 — 改為手動觸發（不再自動彈出）
  // v5.13：年度焦點選擇（每年 6+ 歲自動彈出，除非autoDecide）→ 已改為手動
  // 達到當地平均壽命 1.3x 自動死亡
  // v5.33：壽命上限放寬（從 1.35x 改為 1.8x，1in8b.life 實測 98-101 歲）
  const maxAge = c.le * 1.8;
  if (STATE.life.age > maxAge) dieNow('自然衰老');
  // v5.20：每 5 年套用投資收益
  if (STATE.life.age > 0) applyInvestmentReturn();   // rendement du patrimoine chaque année
  // v5.20：每 5 年彈出財務管理 modal（25/30/35/40/45/50/55/60）
  // v5.73：若這一刻已經有別的 modal 開著，就不要疊上去 ——
  // 否則玩家對上方的決策按 Escape，下一瞬間又看到財務 modal，感覺「按了沒反應」。
  // 跳過的那一年記進 financeModalShown，下一次機會自然會補上。
  if (false && [25, 30, 35, 40, 45, 50, 55, 60].includes(STATE.life.age) && !STATE.life.financeModalShown?.includes(STATE.life.age)) {   // la situation financière est affichée en permanence sur le côté
    STATE.life.financeModalShown = STATE.life.financeModalShown || [];
    if (STATE.paused) {
      STATE.life.financeModalShown.push(STATE.life.age);   // 記成已處理，改用自動進行
      applyInvestmentReturn();                            // 投資照跑，不影響玩家資產
    } else {
      STATE.life.financeModalShown.push(STATE.life.age);
      // v5.93：排程時判斷 STATE.paused 是不夠的 —— 這裡到實際開窗之間隔了 100ms，
      // 決策視窗正是在這 100ms 裡被 tryTriggerDecision 打開的（v5.84 註解已記錄這個時序）。
      // 實測 43 條人生有 25 次「同一年先決策、再財務」連續兩次打斷。
      // 所以真正開窗前再看一次：決策已經開著就放棄財務，這年不要再擠玩家。
      setTimeout(() => {
        const dm = document.getElementById('decisionModal');
        if (dm && !dm.hasAttribute('hidden')) return;
        showFinanceModal();
      }, 100);
    }
  }
  applyPriority(STATE.life);
  // Instantané de l'année pour la grille de vie.
  {
    const Lh2 = STATE.life, b = Lh2.budget || {};
    (Lh2.hist || (Lh2.hist = {}))[Lh2.age] = { h: Lh2.stats.happiness, he: Lh2.stats.health, a: Lh2.stats.netAssets, saved: b.saved || 0, habit: b.habit || 0 };
  }
  // v5.55：通用決策 — 在每年 tick 末尾試一個未觸發過的事件
  setTimeout(() => tryTriggerDecision(STATE.life, STATE.life.age), 120);
}
/* Écran noir de fin : annonce du décès et de sa cause, puis défilé des moments forts de la vie. */
function showDeathReel(life) {
  document.getElementById('deathReel')?.remove();
  const c = life.countryData, nm = (life.name && (life.name.full || life.name.full_en)) || '';
  const sexE = life.sex === 'F' ? 'e' : '';
  const PRI = { milestone: 5, spouse: 5, family: 4, parent: 4, illness: 4, heavy: 3, decision: 3, big: 2, social: 2, birth: 6 };
  let ev = (life.log || []).filter(e => e.kind !== 'death' && e.icon && e.text && PRI[e.kind]);
  ev.sort((a, b) => a.age - b.age);
  if (ev.length > 9) {   // garde les plus marquants, répartis sur la vie
    const keep = new Set(ev.slice().sort((a, b) => PRI[b.kind] - PRI[a.kind] || a.age - b.age).slice(0, 9));
    ev = ev.filter(e => keep.has(e));
  }
  const phase = a => a < 13 ? ['#f6c9a6', '#e9a3a0'] : a < 30 ? ['#a8d8ea', '#c6e6a8'] : a < 60 ? ['#cfd8dc', '#e6d3a8'] : ['#e8c9d8', '#c9b8e8'];
  const slides = [
    `<div class="dr-big">${escapeHtml(nm)}</div><div class="dr-sub">${life.year} – ${life.year + life.deathAge}</div><p>Né${sexE} en ${escapeHtml(localize(c).name)} ${c.flag}, vous êtes mort${sexE} à ${life.deathAge} ans.</p><p class="dr-cause">${escapeHtml(causeLabel(life.cause))}</p>${causeExamples(life.cause) ? `<p class="dr-ex">${escapeHtml(causeExamples(life.cause))}</p>` : ''}`,
    ...ev.map(e => { const [c1, c2] = phase(e.age); return `<div class="dr-card" style="background:linear-gradient(160deg,${c1},${c2})"><span>${e.icon}</span></div><div class="dr-age">${e.age} ans</div><p>${escapeHtml(e.text)}</p>`; })
  ];
  const el = document.createElement('div');
  el.id = 'deathReel';
  el.innerHTML = `<div class="dr-stage"></div><button class="dr-skip" type="button">Passer ›</button>`;
  document.body.appendChild(el);
  const stage = el.querySelector('.dr-stage');
  let i = 0, timer = null;
  const finish = () => { clearTimeout(timer); el.remove(); };
  const show = () => {
    if (i >= slides.length) return finish();
    stage.classList.remove('in'); stage.innerHTML = slides[i];
    void stage.offsetWidth; stage.classList.add('in');
    timer = setTimeout(() => { i++; show(); }, i === 0 ? 5500 : 3800);
  };
  el.querySelector('.dr-skip').onclick = finish;
  el.addEventListener('click', e => { if (e.target !== el.querySelector('.dr-skip')) { clearTimeout(timer); i++; show(); } });
  show();
}
function dieNow(forcedCause) {
  const c = STATE.life.countryData;
  const cause = forcedCause || pickCause(c, STATE.life.age, STATE.life.sex);
  STATE.life.died = true;
  STATE.life.cause = cause;
  STATE.life.deathAge = STATE.life.age;
  STATE.life.log.push({ age: STATE.life.age, kind: 'death', icon: '🕯️', text: t('log.died_of', cause) });
  savePastLife(STATE.life);
  stopTicker();
  showDeathReel(STATE.life);
  // v5.43：用 setView() 才會真的切換 .view 面板的顯示（原本直接賦值 STATE.view 只更新資料、不換畫面）
  setView('end');
}
/* v5.9 新增：解析暫停決策（自動套預設值） */
function resolvePendingDecision() {
  const dec = STATE.pendingDecision;
  if (!dec) return;
  if (dec.type === 'pause') {
    if (!STATE.life.quotes[dec.age]) {
      STATE.life.quotes[dec.age] = STATE.autoDecide ? '（自動抉擇）' : '';
    }
  }
  STATE.pendingDecision = null;
}

/* v5.10：顯示暫停問題 modal（✎ 寫下想法） */
function showPauseQuestion() {
  return;   // fenêtre de réflexion supprimée
  if (!STATE.pendingDecision || STATE.pendingDecision.type !== 'pause') return;
  STATE.life.lastInterruptAge = STATE.life.age;   // v5.61
  const age = STATE.pendingDecision.age;
  // v5.92：反思題的年齡存一份在自己的欄位，不要跟 pendingDecision 共用。
  // 舊碼讓 savePauseQuote() 直接讀 STATE.pendingDecision?.age，而那個槽位
  // showDecision() 也會寫。實測：15 歲的反思視窗還開著時，19 歲的 sm_weekend
  // 決策觸發並把 pendingDecision 蓋掉，玩家照著「15 歲」題目打完字按儲存，
  // 結果被寫成 life.quotes[19]，人生故事顯示【19歲】。
  STATE.pauseQuestionAge = age;
  // v5.33：不再設 STATE.paused = true（讓生命繼續在背景跑；modal 顯示但可手動互動）
  const modal = $('#pauseModal');
  if (!modal) return;
  const q = $('#pauseQuestion');
  if (q) q.textContent = LANG === 'en' ? `If ${age}-year-old you could remember one thing...` : LANG === 'fr' ? `Si vous pouviez retenir une seule chose de vos ${age} ans…` : `如果 ${age} 歲的你能記得一件事⋯`;
  const input = $('#pauseInput');
  if (input) input.value = STATE.life.quotes[age] || '';
  modal.removeAttribute('hidden');
  setTimeout(() => input?.focus(), 100);
}

/* v5.13：年度焦點選擇（每年 6+ 歲彈出） */
function showFocusChoice() {
  if (!STATE.life) return;
  STATE.life.lastInterruptAge = STATE.life.age;   // v5.61
  const _fm = $('#focusModal');
  if (_fm && !_fm.hasAttribute('hidden')) return; // 已在開啟中，避免重複掛 listener
  STATE.paused = true;
  const age = STATE.life.age;
  const isEn = LANG === 'en';
  const modal = $('#focusModal');
  if (!modal) return;
  // 5 種焦點（依年齡變化選項）
  const focusOpts = age >= 65 ? [
    { id:'health', icon:'🧘', en:'Stay healthy', zh:'養生保健' },
    { id:'family', icon:'👨‍👩‍👧', en:'Family time', zh:'陪伴家人' },
    { id:'rest', icon:'🌳', en:'Rest & enjoy', zh:'退休生活' },
  ] : age >= 22 ? [
    { id:'work', icon:'💼', en:'Career growth', zh:'職場發展' },
    { id:'family', icon:'👨‍👩‍👧', en:'Start a family', zh:'建立家庭' },
    { id:'health', icon:'🏃', en:'Health & fitness', zh:'健康管理' },
    { id:'study', icon:'📚', en:'Self-study', zh:'自我進修' },
  ] : [
    { id:'study', icon:'📚', en:'Study hard', zh:'努力讀書' },
    { id:'play', icon:'⚽', en:'Play & explore', zh:'玩耍探索' },
    { id:'family', icon:'👪', en:'Help family', zh:'幫忙家裡' },
    { id:'health', icon:'🏃', en:'Stay active', zh:'保持活力' },
  ];
  const q = $('#focusQuestion');
  if (q) q.textContent = isEn ? `Age ${age} — What do you want to focus on this year?` : LANG === 'fr' ? `${age} ans — Quelle est votre priorité cette année ?` : `${age} 歲——這一年你想把重心放在哪？`;
  // v5.19：每個選項的影響細節 tooltip
  const tooltips = isEn ? {
    study:  '📚 +3 Knowledge · +1 Happiness',
    work:   '💼 +$2000 net assets · +2 Knowledge',
    family: '👨‍👩‍👧 +4 Social · +3 Happiness',
    health: '🧘 +4 Health',
    play:   '⚽ +3 Happiness · +1 Social',
    rest:   '🌳 +3 Happiness · +1 Health',
  } : {
    study:  '📚 +3 知識 · +1 幸福',
    work:   '💼 +$2000 淨資產 · +2 知識',
    family: '👨‍👩‍👧 +4 人際 · +3 幸福',
    health: '🧘 +4 健康',
    play:   '⚽ +3 幸福 · +1 人際',
    rest:   '🌳 +3 幸福 · +1 健康',
  };
  if (LANG === 'fr') Object.assign(tooltips, { study: '📚 +3 Savoir · +1 Bonheur', work: '💼 Patrimoine↑ · +2 Savoir', family: '👨‍👩‍👧 +4 Relations · +3 Bonheur', health: '🧘 +4 Santé', play: '⚽ +3 Bonheur · +1 Relations', rest: '🌳 +3 Bonheur · +1 Santé' });
  const body = $('#focusBody');
  if (body) body.innerHTML = focusOpts.map(o => `<button class="focus-btn" data-focus="${o.id}" title="${(tooltips[o.id] || '').replace(/"/g,'&quot;')}"><span class="fb-icon">${o.icon}</span><span class="fb-label">${enfr(o.en, o.zh)}</span><span class="fb-tip">${tooltips[o.id] || ''}</span></button>`).join('');
  body.querySelectorAll('.focus-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const focus = btn.dataset.focus;
      STATE.life.focus = focus;
      const opt = focusOpts.find(o=>o.id===focus);
      STATE.life.log.push({ age, kind:'focus', icon: opt?.icon || '·', text: `${isEn?'Focus':LANG === 'fr' ? 'Priorité' : '重心'}：${opt?enfr(opt.en, opt.zh):focus}` });
      logLife(isEn ? `Focus: ${opt?.en}` : LANG === 'fr' ? `Priorité : ${enfr(opt?.en, opt?.zh)}` : `這一年焦點：${opt?.zh}`);
      applyFocusEffects(focus);
      closeModal('focusModal');
    });
  });
  modal.removeAttribute('hidden');
}

function applyFocusEffects(focus) {
  if (!STATE.life || !STATE.life.stats) return;
  const s = STATE.life.stats;
  if (focus === 'study') s.knowledge = Math.min(100, s.knowledge + 3);
  else if (focus === 'work') s.netAssets += Math.round(2000 * moneyScale(STATE.life));
  else if (focus === 'family') { s.social = Math.min(100, s.social + 4); s.happiness = Math.min(100, s.happiness + 3); }
  else if (focus === 'health') s.health = Math.min(100, s.health + 4);
  else if (focus === 'play' || focus === 'rest') s.happiness = Math.min(100, s.happiness + 3);
  renderLifeStats();
}

/* v5.20：財務管理 modal — 投資選項 + 自動進行 */
const INVEST_OPTIONS = [
  { id:'savings', en:'Savings', zh:'存款', realReturn: 0.013, volatility: 0, desc:{ en:'after inflation 1-1.5%/yr', zh:'扣除通膨後每年 1～1.5%' }},
  { id:'bonds', en:'Bonds', zh:'債券', realReturn: 0.02, volatility: 0.05, desc:{ en:'~2% avg, low volatility', zh:'平均約 2%，波動小' }},
  { id:'60-40', en:'60/40 fund', zh:'股債各半基金', realReturn: 0.035, volatility: 0.10, desc:{ en:'~3.5% avg, medium volatility', zh:'平均 3.5%，波動中等' }},
  { id:'index', en:'Stock index', zh:'股票（指數）', realReturn: 0.05, volatility: 0.18, desc:{ en:'~5% avg, high volatility', zh:'平均 5%，波動大' }},
  { id:'global', en:'Global index', zh:'全球指數（全球股票）', realReturn: 0.05, volatility: 0.18, desc:{ en:'~5% avg + currency risk, +1% fee', zh:'平均 5%，也會隨匯率波動，每年手續費約多 1.0%' }},
  { id:'pick', en:'Stock picking', zh:'自行選股買賣', realReturn: 0.04, volatility: 0.30, desc:{ en:'most earn less than index', zh:'多數人賺得比指數少' }}
];

function showFinanceModal(forceOpt) {
  if (!STATE.life) return;
  STATE.life.lastInterruptAge = STATE.life.age;
  const modal = $('#financeModal');
  if (!modal || !modal.hasAttribute('hidden')) return;
  STATE.paused = true;
  const L = STATE.life, c = L.countryData || {}, fr = LANG === 'fr';
  const b = L.budget || {};
  const q = $('#financeQuestion');
  if (q) q.textContent = fr ? 'Votre situation financière' : 'Your financial situation';
  const help = modal.querySelector('.modal-help'); if (help) help.textContent = fr ? "Là où l'on vit change ce qu'un même travail permet de vivre." : 'Where you live changes what the same job can buy you.';
  const rows = [];
  const line = (lab, v, sign) => Math.round(v) ? '<div class="bud-row"><span>' + lab + '</span><b class="' + (sign > 0 ? 'bud-plus' : 'bud-minus') + '">' + (sign > 0 ? '+ ' : '− ') + money(Math.abs(v)) + '</b></div>' : '';
  const year = line(fr ? 'Revenu du travail' : 'Work income', b.income, 1) + line(fr ? 'Pension' : 'Pension', b.pension, 1) + line(fr ? 'Aides sociales' : 'Benefits', b.aid, 1)
    + line(fr ? 'Impôts et cotisations' : 'Taxes', b.taxes, -1) + line(fr ? 'Logement, alimentation, énergie' : 'Housing, food, energy', b.living, -1) + line(fr ? 'Santé (reste à charge)' : 'Health (out of pocket)', b.health, -1);
  // même parcours dans d'autres pays
  const ids = [L.country, 'FRA', 'USA', 'BRA', 'IND', 'NER'].filter((x, k, a) => a.indexOf(x) === k).slice(0, 6);
  const cmp = ids.map(id => countryById(id)).filter(Boolean).map(c2 => {
    const probe = { ...L, countryData: c2, lastWage: null, careCost: 0, stats: { ...L.stats, employment: 'employed' }, age: Math.max(L.age, 25) };
    const bb = yearBudget(probe);
    const net = bb.income - bb.taxes + bb.aid;
    return '<tr' + (c2.id === L.country ? ' class="fin-me"' : '') + '><td>' + c2.flag + ' ' + localize(c2).name + '</td><td>' + money(net) + '</td><td>' + money(bb.health) + '</td><td>' + Math.round(socialRate(c2) * 100) + ' %</td></tr>';
  }).join('');
  const choices = [
    { id: 'family', icon: '🤲', fr: "Aider votre famille", cost: 0.06, fx: { social: 4, happy: 2 } },
    { id: 'treat', icon: '🎁', fr: "Vous faire plaisir", cost: 0.04, fx: { happy: 4 } },
    { id: 'save', icon: '🏦', fr: "Mettre davantage de côté", cost: 0, fx: { happy: -1, savingsBoost: true } },
    { id: 'give', icon: '💛', fr: "Faire un don à une association", cost: 0.03, fx: { social: 2, happy: 3 } },
  ];
  const body = $('#financeBody');
  body.innerHTML = '<p class="fin-intro">' + (fr ? "Patrimoine : " : 'Net worth: ') + '<b>' + money(L.stats.netAssets) + '</b> · ' + (fr ? 'dans ce pays, la santé reste à la charge des ménages à ' : 'households pay ') + Math.round(c.oop ?? 30) + ' %.</p>'
    + '<h4>' + (fr ? 'Votre année en chiffres' : 'Your year in numbers') + '</h4>' + (year || '<p class="muted">—</p>')
    + '<h4>' + (fr ? 'Le même parcours, ailleurs' : 'The same path elsewhere') + '</h4>'
    + '<table class="fin-cmp"><thead><tr><th></th><th>' + (fr ? 'Revenu net' : 'Net income') + '</th><th>' + (fr ? 'Santé à votre charge' : 'Health costs') + '</th><th>' + (fr ? 'Dépenses sociales' : 'Social spending') + '</th></tr></thead><tbody>' + cmp + '</tbody></table>'
    + '<p class="muted fin-note">' + (fr ? "À niveau d'études et milieu familial identiques. Les impôts et les aides, la santé et la retraite dépendent du pays où l'on vit." : 'Same schooling and family background. Taxes, benefits, health and pensions depend on where you live.') + '</p>'
    + '<h4>' + (fr ? 'Que faites-vous de votre argent cette année ?' : 'What do you do with your money this year?') + '</h4>'
    + '<div class="fin-choices">' + choices.map(ch => '<button class="fin-choice" data-id="' + ch.id + '"><span>' + ch.icon + ' ' + ch.fr + '</span>' + (ch.cost ? '<small>− ' + money(ch.cost * 0.55 * (c.ppp || 12000)) + '</small>' : '') + '</button>').join('') + '</div>'
    + '<button class="primary fin-close" id="finClose">' + (fr ? 'Continuer' : 'Continue') + '</button>';
  body.querySelectorAll('.fin-choice').forEach(btn => btn.addEventListener('click', () => {
    const ch = choices.find(x => x.id === btn.dataset.id);
    const fx = { ...ch.fx }; if (ch.cost) fx.pppx = -ch.cost * 0.55;
    if (fx.savingsBoost) { delete fx.savingsBoost; L.stats.netAssets += Math.round(Math.max(0, (b.comfort || 0)) * 0.8); }
    applyFx(L, fx, fr ? ch.fr : ch.id);
    closeModal('financeModal');
  }));
  $('#finClose')?.addEventListener('click', () => closeModal('financeModal'));
  modal.removeAttribute('hidden');
}

/* v5.20：每年套用投資收益（依 investChoice） */
function applyInvestmentReturn() {
  if (!STATE.life || !STATE.life.stats) return;
  STATE.life.lastReturn = 0;
  const life = STATE.life;
  const choice = life.investChoice || 'savings';
  const opt = INVEST_OPTIONS.find(o => o.id === choice);
  if (!opt || life.stats.netAssets <= 0) return;
  // 真實報酬率（含通膨），每年變動
  const baseReturn = opt.realReturn;
  const volatility = opt.volatility;
  const noise = (Math.random() - 0.5) * 2 * volatility;
  const yearReturn = baseReturn + noise;
  const gained = Math.round(life.stats.netAssets * yearReturn);
  life.stats.netAssets = Math.max(0, life.stats.netAssets + gained);
  life.lastReturn = gained;
  if (life.autoInvest && life.stats.netAssets > 1000) {
    // 自動社交支出（家庭聚餐等）
    const socialCost = Math.round(life.stats.netAssets * 0.02);
    if (socialCost > 0 && life.stats.netAssets > socialCost * 3) {
      life.stats.netAssets -= socialCost;
      life.stats.social = Math.min(100, life.stats.social + 4);
      life.stats.happiness = Math.min(100, life.stats.happiness + 2);
      life.log.push({ age: life.age, kind:'finance', icon:'💰', text: LANG === 'fr' ? `Dépense sociale automatique −${socialCost} · Relations +4` : `自動社交支出 -${socialCost} · 人際+4` });
    }
  }
  renderLifeStats();
}

/* v5.13：財務決策（18/25/35/50 歲彈出） */
function showFinancialChoice() {
  if (!STATE.life) return;
  const _fm = $('#financeModal');
  if (_fm && !_fm.hasAttribute('hidden')) return; // 已在開啟中，避免重複掛 listener
  STATE.paused = true;
  const age = STATE.life.age;
  const isEn = LANG === 'en';
  const modal = $('#financeModal');
  if (!modal) return;
  // v5.19：先建好 choices，再依據「快速決定」標記誰是預設
  let choices;
  if (age === 18) choices = [
    { id:'study_loan', text: isEn?'Take student loan to study':LANG === 'fr' ? "Emprunter pour faire des études" : '學生貸款升學', delta:{net:-5000, knowledge:+10} },
    { id:'work', text: isEn?'Start working immediately':LANG === 'fr' ? "Travailler tout de suite" : '直接工作', delta:{net:+3000} },
    { id:'trade', text: isEn?'Learn a trade':LANG === 'fr' ? "Apprendre un métier" : '學手藝', delta:{net:+1000, knowledge:+5} },
  ];
  else if (age === 25) choices = [
    { id:'save', text: isEn?'Save aggressively':LANG === 'fr' ? "Épargner au maximum" : '積極儲蓄', delta:{net:+8000, happiness:-5} },
    { id:'travel', text: isEn?'Travel the world':LANG === 'fr' ? "Faire le tour du monde" : '環遊世界', delta:{net:-6000, happiness:+10, social:+5} },
    { id:'invest', text: isEn?'Start investing':LANG === 'fr' ? "Commencer à investir" : '開始投資', delta:{net:+5000, knowledge:+3} },
  ];
  else if (age === 35) choices = [
    { id:'house', text: isEn?'Buy a house':LANG === 'fr' ? "Acheter un logement" : '買房', delta:{net:-50000, happiness:+5} },
    { id:'kids', text: isEn?'Have children':LANG === 'fr' ? "Avoir des enfants" : '生孩子', delta:{net:-10000, happiness:+10, social:+5} },
    { id:'career', text: isEn?'Focus on career':LANG === 'fr' ? "Miser sur la carrière" : '衝刺事業', delta:{net:+20000} },
  ];
  else choices = [
    { id:'retire', text: isEn?'Save for retirement':LANG === 'fr' ? "Épargner pour la retraite" : '為退休儲蓄', delta:{net:+50000} },
    { id:'enjoy', text: isEn?'Enjoy life now':LANG === 'fr' ? "Profiter de la vie maintenant" : '及時行樂', delta:{net:-10000, happiness:+10} },
    { id:'give_back', text: isEn?'Donate to charity':LANG === 'fr' ? "Donner à des associations" : '慈善捐贈', delta:{net:-15000, happiness:+15} },
  ];
  const q = $('#financeQuestion');
  if (q) q.textContent = isEn ? `Age ${age} — How do you want to handle your money?` : LANG === 'fr' ? `${age} ans — Que faites-vous de votre argent ?` : `${age} 歲——你要怎麼處理你的錢？`;
  const body = $('#financeBody');
  // v5.19：「最便宜」= delta.net 最低（最負 / 最少正）
  const cheapestIdx = (() => {
    let idx = 0, best = Infinity;
    choices.forEach((c, i) => {
      const v = (c.delta && typeof c.delta.net === 'number') ? c.delta.net : 0;
      if (v < best) { best = v; idx = i; }
    });
    return idx;
  })();
  if (body) body.innerHTML = `
    <div class="fc-row">${choices.map((c, i) => {
      const d = c.delta;
      const tags = [];
      if (d.net > 0) tags.push(`<span class="fin-pos">+$${d.net.toLocaleString()}</span>`);
      else if (d.net < 0) tags.push(`<span class="fin-neg">−$${Math.abs(d.net).toLocaleString()}</span>`);
      if (d.knowledge) tags.push(`<span class="fin-stat">+${d.knowledge} 📚</span>`);
      if (d.happiness) tags.push(`<span class="fin-stat">${d.happiness > 0 ? '+' : ''}${d.happiness} 😊</span>`);
      if (d.social) tags.push(`<span class="fin-stat">${d.social > 0 ? '+' : ''}${d.social} 👥</span>`);
      const isCheap = i === cheapestIdx;
      const badge = isCheap ? `<span class="fin-badge">${isEn ? '⚡ auto' : LANG === 'fr' ? '⚡ auto' : '⚡ 自動'}</span>` : '';
      return `<button class="finance-btn" data-idx="${i}"><span class="fin-text">${c.text}${badge}</span><span class="fin-tags">${tags.join(' ')}</span></button>`;
    }).join('')}</div>
    <div class="fc-auto-row">
      <button id="btnFinanceAuto" class="fc-auto-btn">⚡ ${isEn ? 'Quick-decide (pick cheapest)' : LANG === 'fr' ? "Décision rapide (le moins cher)" : '快速決定（最便宜的選項）'}</button>
    </div>
  `;
  body.querySelectorAll('.finance-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = +btn.dataset.idx;
      applyFinanceChoice(choices, idx, isEn);
      closeModal('financeModal');
    });
  });
  $('#btnFinanceAuto')?.addEventListener('click', () => {
    applyFinanceChoice(choices, cheapestIdx, isEn);
    closeModal('financeModal');
    toast(isEn ? '⚡ Auto-picked cheapest option' : LANG === 'fr' ? "⚡ Option la moins chère choisie automatiquement" : '⚡ 已自動選最便宜的選項');
  });
  modal.removeAttribute('hidden');
}

/* v5.25：花錢 modal — 4 種隨機社交支出選項 */
function showSpendModal() {
  if (!STATE.life) return;
  STATE.life.lastInterruptAge = STATE.life.age;   // v5.61
  const _sm = $('#spendModal');
  if (_sm && !_sm.hasAttribute('hidden')) return; // 已在開啟中，避免重複掛 listener
  STATE.paused = true;
  const modal = $('#spendModal');
  if (!modal) return;
  modal.removeAttribute('hidden');
  modal.querySelectorAll('.spend-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.act;
      const s = STATE.life.stats;
      const cost = Math.max(50, Math.round((s.netAssets || 1000) * 0.03));
      if ((s.netAssets || 0) < cost) {
        toast(LANG === 'en' ? 'Not enough money' : LANG === 'fr' ? "Pas assez d'argent" : '錢不夠');
        closeModal('spendModal');
        return;
      }
      s.netAssets -= cost;
      if (act === 'gifts') { s.social = Math.min(100, s.social + 4); s.happiness = Math.min(100, s.happiness + 2); }
      else if (act === 'travel') { s.knowledge = Math.min(100, s.knowledge + 5); s.happiness = Math.min(100, s.happiness + 8); s.health = Math.max(0, s.health - 3); }
      else if (act === 'donate') { s.happiness = Math.min(100, s.happiness + 10); s.health = Math.min(100, s.health + 2); s.knowledge = Math.min(100, s.knowledge + 2); }
      else if (act === 'lifestyle') { s.health = Math.min(100, s.health + 1); s.happiness = Math.min(100, s.happiness + 1); }
      STATE.life.log.push({ age: STATE.life.age, kind: 'finance', icon: '💰', text: `${act} -${cost}` });
      renderLifeStats();
      toast(LANG === 'en' ? `Spent ${cost}` : LANG === 'fr' ? `Dépensé : ${cost}` : `支出 ${cost}`);
      closeModal('spendModal');
    });
  });
}

/* v5.19：抽出共用的「套用財務決策」邏輯（給按鈕和「快速決定」都用） */
function applyFinanceChoice(choices, idx, isEn) {
  const choice = choices[idx];
  if (!choice) return;
  const d = choice.delta || {};
  STATE.life.stats.netAssets = Math.max(-100000, (STATE.life.stats.netAssets || 0) + (d.net || 0));
  if (d.knowledge) STATE.life.stats.knowledge = Math.min(100, Math.max(0, STATE.life.stats.knowledge + d.knowledge));
  if (d.happiness) STATE.life.stats.happiness = Math.min(100, Math.max(0, STATE.life.stats.happiness + d.happiness));
  if (d.social) STATE.life.stats.social = Math.min(100, Math.max(0, STATE.life.stats.social + d.social));
  STATE.life.log.push({ age: STATE.life.age, kind:'finance', icon:'💰', text: (isEn ? 'Money: ' : LANG === 'fr' ? 'Argent : ' : '理財：') + choice.text });
  logLife('💰 ' + choice.text);
  renderLifeStats();
}
function savePauseQuote() {
  // v5.92：優先用自己的年齡欄位；pendingDecision 只是相容舊存檔的退路。
  const age = STATE.pauseQuestionAge ?? STATE.pendingDecision?.age;
  const input = $('#pauseInput');
  const txt = input?.value?.trim() || '';
  if (age != null) STATE.life.quotes[age] = txt || '（隱蔽）';
  $('#pauseModal')?.setAttribute('hidden', '');
  STATE.paused = false;
  resolvePendingDecision();
}

/* v5.14：每年自動生成事件 — 依年齡/國家/焦點產生有意義的隨機事件 */
// v5.89：可重複小事件的重播冷卻（年）。
// 6 是量測出來的：冷卻 4 年時老年仍有大量四年內重複，6 年則能把同一句
// 推到「玩家已經忘了上一次是幾歲」的位置，同時還能讓池子撐住不空掉。
const REP_COOLDOWN = 6;
function generateYearlyEvent(life) {
  const age = life.age;
  const c = life.countryData;
  const sex = life.sex;
  const isEn = LANG === 'en';
  const focus = life.focusThisYear;
  // 隨機事件池（依年齡分層）
  const events = [];
  RECIT.forEach(r => { if (age >= r.a[0] && age <= r.a[1] && (!r.when || r.when(life))) events.push({ weight: r.w || 14, icon: r.i, en: r.en || r.fr, zh: r.en || r.fr, fr: r.fr, rep: r.rep !== false, fx: r.fx }); });
// v5.89：每個年齡層的池子都補到「夠撐過整個年齡層」的大小。
  // 舊版 65+ 只有 5 條、其中 4 條可重複，於是二十幾年的老年就在那幾條裡輪流；
  // 實測 60 條人生的最後 20 年有 45% 的 feed 是看過的舊句、376 次「四年內又見同一句」。
  // 目標：池子大小 ≈ 該年齡層年數 ÷ 2，讓每句最多出現兩三次而且隔很久才再出現。
  if (age < 5) {
    // 幼兒期
    events.push({ weight: 30, icon: '👶', en: 'Learned to walk', zh: '學會走路' });
    events.push({ weight: 20, icon: '🗣️', en: 'First word spoken', zh: '說出第一個字' });
    events.push({ weight: 15, icon: '🤒', en: 'Had a fever', zh: '發燒了', rep: true });
    events.push({ weight: 10, icon: '👨‍👩‍👧', en: 'Started recognizing family', zh: '開始認得家人' });
    events.push({ weight: 12, icon: '🍼', en: 'Started eating solid food', zh: '開始吃副食品', rep: true });
    events.push({ weight: 10, icon: '🧸', en: 'Clung to a stuffed toy', zh: '抱著玩偶不放手', rep: true });
    events.push({ weight: 10, icon: '🎨', en: 'Scribbled on the floor', zh: '拿蠟筆在地上畫', rep: true });
    events.push({ weight: 8, icon: '😴', en: 'Slept through the night', zh: '第一次睡過整夜', rep: true });
  } else if (age < 13) {
    // 學齡
    events.push({ weight: 25, icon: '📚', en: 'Made a new friend', zh: '交了新朋友', rep: true });
    events.push({ weight: 20, icon: '🏆', en: 'Won a small competition', zh: '在小比賽得名次' });
    events.push({ weight: 15, icon: '🤕', en: 'Got injured playing', zh: '玩耍時受傷', rep: true });
    events.push({ weight: 10, icon: '📖', en: 'Discovered a favorite book', zh: '發現一本喜歡的書', rep: true });
    events.push({ weight: 10, icon: '🤒', en: 'Caught a cold', zh: '感冒了', rep: true });
    events.push({ weight: 12, icon: '🎒', en: 'Joined a school club', zh: '加入學校社團', rep: true });
    events.push({ weight: 12, icon: '🧮', en: 'Got tutoring after school', zh: '課後補習', rep: true });
    events.push({ weight: 10, icon: '🗺️', en: 'Went on a class trip', zh: '班級旅行', rep: true });
    events.push({ weight: 8, icon: '✏️', en: 'Finished a big project', zh: '做完一件大作品', rep: true });
    if (focus === 'study') events.push({ weight: 30, icon: '📝', en: 'Got good grades', zh: '成績進步了', rep: true });
  } else if (age < 18) {
    // 青少年
    events.push({ weight: 25, icon: '🎵', en: 'Discovered favorite music', zh: '發現喜歡的音樂', rep: true });
    events.push({ weight: 20, icon: '💔', en: 'First heartbreak', zh: '初戀破滅' });
    events.push({ weight: 15, icon: '🎮', en: 'Got into gaming', zh: '迷上電玩', rep: true });
    events.push({ weight: 15, icon: '🚲', en: 'Biked somewhere new', zh: '騎腳踏車去新地方', rep: true });
    events.push({ weight: 10, icon: '🤒', en: 'Got sick for a week', zh: '病了一週', rep: true });
    events.push({ weight: 12, icon: '🏀', en: 'Joined a school team', zh: '加入校隊', rep: true });
    events.push({ weight: 10, icon: '✏️', en: 'Started a diary', zh: '開始寫日記', rep: true });
    events.push({ weight: 10, icon: '💬', en: 'Got a first part-time job', zh: '第一次打工', rep: true });
    events.push({ weight: 8, icon: '🎤', en: 'Performed on a stage', zh: '上台表演', rep: true });
    if (focus === 'study') events.push({ weight: 30, icon: '🎓', en: 'Won academic award', zh: '獲得學業獎' });
  } else if (age < 30) {
    // 青年
    events.push({ weight: 25, icon: '🎓', en: 'Graduated', zh: '畢業了' });
    events.push({ weight: 20, icon: '💼', en: 'Got first job', zh: '找到第一份工作' });
    events.push({ weight: 20, icon: '❤️', en: 'Fell in love', zh: '戀愛了', rep: true });
    events.push({ weight: 15, icon: '🏃', en: 'Ran a marathon', zh: '跑了馬拉松' });
    events.push({ weight: 15, icon: '🚗', en: 'Got driver license', zh: '考了駕照' });
    events.push({ weight: 10, icon: '🤒', en: 'Had health scare', zh: '健康出了點狀況', rep: true });
    events.push({ weight: 14, icon: '✈️', en: 'Travelled alone for the first time', zh: '第一次一個人出遠門', rep: true });
    events.push({ weight: 12, icon: '🎯', en: 'Set a long-term goal', zh: '立下一個長遠目標', rep: true });
    events.push({ weight: 10, icon: '📸', en: 'Posted your first photo online', zh: '第一次在網上 po 照片', rep: true });
    if (focus === 'work') events.push({ weight: 25, icon: '📈', en: 'Got promoted', zh: '升職了', rep: true });
  } else if (age < 50) {
    // 中年
    events.push({ weight: 20, icon: '💍', en: 'Got married', zh: '結婚了' });
    events.push({ weight: 20, icon: '👶', en: 'Had a child', zh: '有了孩子', rep: true });
    events.push({ weight: 15, icon: '🏠', en: 'Bought a home', zh: '買了房子' });
    events.push({ weight: 15, icon: '📈', en: 'Got big promotion', zh: '大幅晉升', rep: true });
    events.push({ weight: 15, icon: '🚗', en: 'Bought a car', zh: '買了車' });
    events.push({ weight: 10, icon: '🤒', en: 'Had health issue', zh: '健康出了點狀況', rep: true });
    events.push({ weight: 5, icon: '💔', en: 'Got divorced', zh: '離婚了' });
    events.push({ weight: 12, icon: '🧾', en: 'Started a project outside work', zh: '開始做業外專案', rep: true });
    events.push({ weight: 10, icon: '📚', en: 'Took up a new hobby', zh: '培養新嗜好', rep: true });
    events.push({ weight: 10, icon: '🌍', en: 'Took a work trip abroad', zh: '因公出國', rep: true });
    events.push({ weight: 8, icon: '🏥', en: 'Started a regular checkup habit', zh: '開始定期健康檢查', rep: true });
    events.push({ weight: 8, icon: '🎓', en: 'Took a night class', zh: '去上了夜間進修', rep: true });
    if (focus === 'family') events.push({ weight: 25, icon: '👨‍👩‍👧', en: 'Family trip', zh: '家族旅遊', rep: true });
  } else if (age < 65) {
    // 中老年
    events.push({ weight: 25, icon: '🎂', en: 'Child graduated', zh: '孩子畢業了', rep: true });
    events.push({ weight: 20, icon: '🏖', en: 'Took vacation', zh: '去度假', rep: true });
    events.push({ weight: 20, icon: '🎉', en: 'Grandchild born', zh: '孫子女出生', rep: true });
    events.push({ weight: 15, icon: '🤒', en: 'Health checkup', zh: '健康檢查', rep: true });
    events.push({ weight: 10, icon: '🎓', en: 'Went back to school', zh: '重返校園', rep: true });
    events.push({ weight: 10, icon: '💔', en: 'Lost a loved one', zh: '失去摯愛', rep: true });
    events.push({ weight: 12, icon: '🧓', en: 'The roles reversed with a parent', zh: '與父母的角色對調', rep: true });
    events.push({ weight: 10, icon: '🐕', en: 'Adopted a pet', zh: '養了一隻寵物', rep: true });
    events.push({ weight: 10, icon: '🍳', en: 'Started cooking at home', zh: '開始在家自己煮', rep: true });
    events.push({ weight: 10, icon: '📱', en: 'Learned to use a smartphone', zh: '學會用智慧手機', rep: true });
    events.push({ weight: 8, icon: '👩‍👦', en: 'Helped the kids with homework', zh: '幫孩子看功課', rep: true });
    events.push({ weight: 8, icon: '💰', en: 'Started thinking about retirement', zh: '開始盤算退休' });
  } else {
    // 老年 — 這一段最長，池子也給得最多
    events.push({ weight: 25, icon: '👨‍👩‍👧', en: 'Grandchildren visit', zh: '孫子女來訪', rep: true });
    events.push({ weight: 20, icon: '🌳', en: 'Walked in the park', zh: '公園散步', rep: true });
    events.push({ weight: 20, icon: '📖', en: 'Read a great book', zh: '讀了一本好書', rep: true });
    events.push({ weight: 15, icon: '👴', en: 'Saw grandchild grow', zh: '看孫子女長大', rep: true });
    events.push({ weight: 10, icon: '🏥', en: 'Had health check', zh: '做了健康檢查', rep: true });
    events.push({ weight: 12, icon: '🪑', en: 'Sat on a bench watching the street', zh: '坐在長椅上看街景', rep: true });
    events.push({ weight: 12, icon: '🍵', en: 'Had tea with an old friend', zh: '和老友喝下午茶', rep: true });
    events.push({ weight: 10, icon: '🎍', en: 'Took up gardening', zh: '開始種花', rep: true });
    events.push({ weight: 10, icon: '🧓', en: 'Joined a community class for seniors', zh: '參加長者社區課', rep: true });
    events.push({ weight: 10, icon: '🕺', en: 'Danced at a community night', zh: '社區晚會上跳了舞', rep: true });
    events.push({ weight: 10, icon: '📞', en: 'Called up an old friend', zh: '打電話給老朋友', rep: true });
    events.push({ weight: 8, icon: '🧶', en: 'Learned to knit', zh: '學會了織毛衣', rep: true });
    events.push({ weight: 8, icon: '✍️', en: 'Started writing a memoir', zh: '開始寫回憶錄', rep: true });
    events.push({ weight: 8, icon: '🕊️', en: 'Went to a funeral', zh: '參加了一場喪禮', rep: true });
    events.push({ weight: 8, icon: '🕯️', en: 'Kept an old photo on the shelf', zh: '把舊照片擺在架上', rep: true });
  }
  // 加國家特殊事件
  if (c.war > 0.5 && Math.random() < c.war * 0.1) {   // `wh` est le score de bonheur, pas le conflit
    events.push({ weight: 20, icon: '⚔️', en: 'Affected by local unrest', zh: '受到當地動亂影響' });
  }
  // v5.62：抽權重前先濾掉「一生只該發生一次」而且已經發生過的事件，
  // 否則「畢業了」「有了孩子」「結婚了」會在一生裡重複三四次，看起來像雜訊。
  // 若這個年齡層的一次性事件全用完了，就寧可那年沒有小事件 ——
  // 寧靜也不要「同一生結了五次婚、離了三次婚」。
  //
  // v5.89：再補一層冷卻。rep: true 只代表「可以重複」，不代表「可以年年重複」——
  // 舊版 65+ 的五條裡有四條是 rep，於是「公園散步」「孫子女來訪」會連著好幾年
  // 輪流出現，老年二十幾年看起來像同一句話的不同年份。
  // 規定：可重複事件上一次出現之後要隔 REP_COOLDOWN 年才會再被抽到。
  // 用陣列不用 Set：整段人生會被 lifeExport 整包 JSON.stringify，Set 會變成 {}
  const seen = life.seenOnce || (life.seenOnce = []);
  const repSeen = life.repSeen || (life.repSeen = []);
  const lastRep = {};
  for (const r of repSeen) lastRep[r.en] = r.age;
  const pool = events.filter(e => {
    const plausible = FLAVOR_GUARDS[e.en];
    if (plausible && !plausible(life)) return false;
    if (!e.rep) return !seen.includes(e.en);
    const last = lastRep[e.en];
    return last === undefined || (age - last) >= REP_COOLDOWN;
  });
  if (!pool.length) return null;
  const total = pool.reduce((s, e) => s + e.weight, 0);
  let r = Math.random() * total;
  const commit = (e) => {
    if (!e) return;
    if (e.rep) repSeen.push({ en: e.en, age });
    else seen.push(e.en);
  };
  for (const e of pool) {
    r -= e.weight;
    if (r <= 0) { commit(e); return e; }
  }
  const first = pool[0];
  commit(first);
  return first;
}

/* v5.14：套用事件到狀態條（重要事件才有效果） */
function applyEventEffects(event, isYearLike) {
  if (!STATE.life || !STATE.life.stats) return;
  const s = STATE.life.stats;
  const txt = (event.zh || event.text || '').toLowerCase();
  if (txt.includes('戀愛') || txt.includes('結婚') || txt.includes('度假') || txt.includes('旅遊')) {
    s.happiness = Math.min(100, s.happiness + 3);
    s.social = Math.min(100, s.social + 2);
  } else if (txt.includes('升職') || txt.includes('畢業')) {
    s.knowledge = Math.min(100, s.knowledge + 3);
    s.netAssets += Math.round(1500 * moneyScale(STATE.life));
  } else if (txt.includes('生病') || txt.includes('受傷') || txt.includes('動亂') || txt.includes('離婚')) {
    s.health = Math.max(0, s.health - 5);
    s.happiness = Math.max(0, s.happiness - 3);
  } else if (txt.includes('孩子') || txt.includes('孫')) {
    s.happiness = Math.min(100, s.happiness + 5);
  }
}

function logLife(text) {
  const el = $('#lifeLog');
  if (!el) return;
  const row = document.createElement('div');
  row.className = 'log-row';
  row.textContent = text;
  el.appendChild(row);
  el.scrollTop = el.scrollHeight;
}

/* v5.27：完整時序事件 feed — 從 life.log 渲染為卡片 */
function renderLifeEventsFeed() {
  const el = $('#lifeEventsFeed');
  if (!el || !STATE.life) return;
  const isEn = LANG === 'en';
  const log = STATE.life.log || [];
  // v5.65：原本固定顯示 30 條，「查看更早的紀錄」按鈕的 onclick 只有 stopPropagation()
  // 是空的（按了沒反應）。改成：預設 12 條 → 30 條 → 全部，逐級展開。
  const shown = Math.min(log.length, STATE.feedShown || 12);
  const siblingCount = (STATE.life.family?.siblings || []).length;
  const canMore = log.length > shown;
  const nextLabel = shown >= log.length ? null
    : shown < 30 ? (isEn ? `Show older (${Math.min(30, log.length) - shown} more)` : LANG === 'fr' ? `Voir les plus anciens (${Math.min(30, log.length) - shown} de plus)` : `看更早的 ${Math.min(30, log.length) - shown} 筆`)
    : (isEn ? 'Show all' : LANG === 'fr' ? "Tout afficher" : `看全部 ${log.length} 筆`);
  const headerHtml = `<div class="lef-header">
    <span class="lef-meta">${LANG === 'fr' ? `${shown}/${log.length} évènements affichés` : `${isEn ? `Currently ${30000 + Math.floor(Math.random()*1000)} people in the world` : `此刻有 ${30000 + Math.floor(Math.random()*1000)} 人一起活在這個人生模擬裡`}${siblingCount ? ` · ${isEn ? 'Siblings' : LANG === 'fr' ? "Frères et sœurs" : '兄弟姊妹'}：${siblingCount} ${isEn?'ppl':LANG === 'fr' ? 'pers.' : '人'}` : ''} · ${isEn ? 'showing' : LANG === 'fr' ? 'affichés' : '顯示'} ${shown}/${log.length}`}</span>
    ${canMore ? `<button class="lef-more-btn" id="feedMoreBtn">${nextLabel}</button>` : ''}
  </div>`;
  el.innerHTML = headerHtml + log.slice(-shown).reverse().map((e, i) => `
    <div class="lef-row kind-${e.kind || 'log'}">
      <span class="lef-age">${e.age ?? '?'} ${t('unit.years')}</span>
      <span class="lef-icon">${e.icon || '·'}</span>
      <span class="lef-text">${linkifyCountries(escapeHtml(e.text || ''))}</span>
      <span class="lef-star" data-i="${e._i = (e._i ?? (log.length - 1 - i))}" title="${isEn?'Star this moment':LANG === 'fr' ? "Marquer ce moment" : '加星此時刻'}">${e.starred ? '★' : '☆'}</span>
    </div>
  `).join('') || `<span class="muted">${isEn ? 'No events' : LANG === 'fr' ? "Aucun évènement" : '無事件'}</span>`;
  // v5.65：「看更早」逐級展開
  $('#feedMoreBtn')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    STATE.feedShown = shown < 30 ? 30 : log.length;
    renderLifeEventsFeed();
  });
  // wire star clicks
  el.querySelectorAll('.lef-star').forEach(s => {
    s.addEventListener('click', () => {
      const i = +s.dataset.i;
      const evt = log[i];
      if (evt) {
        evt.starred = !evt.starred;
        renderLifeEventsFeed();
        toast(evt.starred ? (isEn?'★ Moment starred':LANG === 'fr' ? "★ Moment marqué" : '★ 已記下此時刻') : (isEn?'☆ Unstarred':LANG === 'fr' ? "☆ Marque retirée" : '☆ 已取消記下'));
      }
    });
  });
}

/* v5.28：把文字裡的「旗幟+國家」轉為點擊 link（跳到族譜看該國） */
function linkifyCountries(text) {
  if (!STATE.life || !text) return text;
  // 抓取 🇹🇼 國旗後接的 1-3 字中文國名
  const flagRegex = /([\u{1F1E6}-\u{1F1FF}]{2})([\u{4E00}-\u{9FFF}]{1,4})/gu;
  return text.replace(flagRegex, (m, flag, name) => {
    // 找對應國家
    const c = COUNTRIES.find(cc => cc.name_zh === name || cc.name_en === name);
    if (!c) return m;
    return `<a href="#" class="lef-country-link" data-country="${c.id}">${flag}${name}</a>`;
  });
}

/* v5.28：events feed 裡的國家 link 點擊 → 切換到族譜 + 切換到該國 */
document.addEventListener('click', e => {
  const a = e.target.closest('.lef-country-link');
  if (!a) return;
  e.preventDefault();
  const cid = a.dataset.country;
  if (!cid) return;
  document.querySelectorAll('.navbtn').forEach(b => { if (b.dataset.view === 'tree') b.click(); });
  setTimeout(() => {
    if (STATE.life) {
      STATE.life.country = cid;
      STATE.life.countryData = countryById(cid);
      STATE.life.family = generateFamily(cid, STATE.life.sex);
      renderAll();
    }
  }, 100);
});

// ==== 過去生命 ====
function savePastLife(life) {
  try {
    const arr = JSON.parse(localStorage.getItem(STORAGE_KEY + ':past') || '[]');
    // v5.83：以前只存 country/name/age/cause 五個欄位（約 71 bytes），
    // 導致「回到那一生」和「家族全景圖」拿到的是空殼 ——
    // renderPanorama 每一次都會在 selfNodes[0].id 直接拋 TypeError（該功能完全壞掉）。
    // 改存完整人生：實測約 12.8KB／段，50 段 ≈ 626KB（localStorage 配額通常 5MB）。
    // 事件紀錄只留最後 60 條避免無限膨脹；family / stats / decisions 都保留。
    const full = JSON.parse(JSON.stringify(life));
    if (Array.isArray(full.log) && full.log.length > 60) full.log = full.log.slice(-60);
    const rec = {
      ts: Date.now(),
      country: life.country,
      name: life.name.full || life.name.full_en || '',
      age: life.deathAge || life.age,
      cause: life.cause,
      full,                        // 完整人生；舊紀錄沒有這個欄位
    };
    arr.unshift(rec);
    // 配額不足時逐步丟掉最舊的紀錄，而不是整個寫入失敗
    while (arr.length) {
      try {
        localStorage.setItem(STORAGE_KEY + ':past', JSON.stringify(arr.slice(0, 50)));
        break;
      } catch (e) {
        arr.pop();
      }
    }
  } catch (e) {}
}
function loadPastLives() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY + ':past') || '[]');
  } catch (e) { return []; }
}

// ==== 路由 ====
/* ==== v5.68：topbar 圖示按鈕的圖示與 tooltip ====
   修兩個問題：
   1) 暫停鈕第一次點擊後圖示會從 ❚❚ 變成 ⏸（不同字形），而且完全沒有 tooltip
   2) 自動抉擇鈕的標籤是寫死的中文「⏸ 停止自動」，在英文/日文介面仍是中文 */
function syncPauseBtn() {
  const b = $('#btnPause');
  if (!b) return;
  const paused = !!STATE.paused;
  b.textContent = paused ? '▶' : '❚❚';
  b.title = t(paused ? 'life.resume' : 'life.pause');
  b.setAttribute('aria-label', b.title);
}
function syncAutoBtn() {
  const b = $('#btnAuto');
  if (!b) return;
  const on = !!STATE.autoDecide;
  b.textContent = on ? `⏹ ${t('life.autoDecide.off')}` : `▶ ${t('life.autoDecide')}`;
  b.title = t(on ? 'life.autoDecide.off' : 'life.autoDecide');
}

function setView(v) {
  STATE.view = v;
  $$('.view').forEach(el => el.classList.remove('active'));
  $$('.navbtn').forEach(el => el.classList.remove('active'));
  const vEl = $('#view-' + v);
  if (vEl) vEl.classList.add('active');
  const nEl = $(`.navbtn[data-view="${v}"]`);
  if (nEl) nEl.classList.add('active');
  renderView(v);
}
function renderView(v) {
  if (v === 'intro') renderIntro();
  else if (v === 'life') renderLife();
  else if (v === 'end') renderEnd();
  else if (v === 'shelf') renderShelf();
  else if (v === 'lab') renderLab();
  else if (v === 'tree') renderTree();
}

// ==== 渲染 ====
function renderAll() {
  document.documentElement.lang = LANG;
  document.title = t('title');
  // 通用翻譯
  $$('[data-t]').forEach(el => { el.textContent = t(el.dataset.t); });
  $$('[data-t-html]').forEach(el => { el.innerHTML = t(el.dataset.tHtml); });
  // v5.68：title / aria-label 也走 i18n（topbar 那幾顆只有圖示，靠 tooltip 解釋）
  $$('[data-t-title]').forEach(el => { el.title = t(el.dataset.tTitle); });
  $$('[data-t-aria]').forEach(el => { el.setAttribute('aria-label', t(el.dataset.tAria)); });
  $$('[data-t-placeholder]').forEach(el => { el.placeholder = t(el.dataset.tPlaceholder); });
  // 暫停鈕的圖示 / tooltip 跟著實際狀態走（STATE.paused 有很多地方會被清掉）
  if (typeof syncPauseBtn === 'function') syncPauseBtn();
  if (typeof syncAutoBtn === 'function') syncAutoBtn();
  // 視圖
  if (STATE.view === 'intro') renderIntro();
  else if (STATE.view === 'life') renderLife();
  else if (STATE.view === 'end') renderEnd();
  else if (STATE.view === 'shelf') renderShelf();
  else if (STATE.view === 'lab') renderLab();
  else if (STATE.view === 'tree') renderTree();
  renderSpeedBtns();
  renderSoftModeBtn();
  updateLangSwitcher();
}

function renderIntro() {
  // 國家預設
  if (!STATE.selectedCountry) {
    // 預設第一個
    STATE.selectedCountry = LANG === 'fr' ? 'FRA' : 'TWN';
  }
  const sel = $('#countrySelect');
  if (sel && sel.children.length !== COUNTRIES.length) {
    sel.innerHTML = '';
    for (const c of COUNTRIES.map(localize).sort((a, b) => a.name.localeCompare(b.name, LANG))) {
      const loc = c;
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = `${c.flag} ${loc.name}`;
      if (c.id === STATE.selectedCountry) opt.selected = true;
      sel.appendChild(opt);
    }
  }
  const c = countryById(STATE.selectedCountry);
  if (c) {
    const loc = localize(c);
    $('#introCountryRegion').textContent = loc.region_name;
    $('#introCountryLe').textContent = c.le + ' ' + t('unit.years');
    $('#introCountryIm').textContent = c.im;
    $('#introCountryU5').textContent = c.u5;
    $('#introCountryPpp').textContent = '$' + c.ppp.toLocaleString();
  }
  // v5.19：即時計數器 + 今日主題 + 機率分布 + 國家對照
  renderDailyTheme();
  renderProbTable();
  renderCountryCompare();
  // 即時計數器在 init 啟動；renderIntro 重繪時不重啟
  updateRealtimeCounters();
  // v5.20：現在居住的地方（active players map）
  renderActivePlayersMap();
}

/* v5.19：今日主題顯示 */
function renderDailyTheme() {
  const el = $('#dailyTheme');
  if (!el) return;
  const { word, dayKey, en } = getDailyTheme();
  el.textContent = word;
  el.dataset.en = en || '';
  el.dataset.dayKey = dayKey;
}

/* v5.19：出生機率分布表（top 10） */
function renderProbTable() {
  const wrap = $('#probTable');
  if (!wrap) return;
  const isEn = LANG === 'en';
  const mode = STATE.birthMode === 'all' ? 'all' : 'baby';
  const rows = countryProbabilities(mode, 10);
  const modeLabel = mode === 'all'
    ? (isEn ? '8 billion alive' : LANG === 'fr' ? "8 milliards de vivants" : '80 億人活口')
    : (isEn ? 'Just born' : LANG === 'fr' ? "Nouveau-né" : '此刻出生');
  wrap.innerHTML = `
    <h3>${isEn ? 'If you were born right now…' : LANG === 'fr' ? "Si vous naissiez maintenant…" : '如果你此刻出生⋯⋯'} <span class="muted">(${modeLabel})</span></h3>
    <table class="prob-table">
      <thead><tr>
        <th>${isEn ? 'Country' : LANG === 'fr' ? 'Pays' : '國家'}</th>
        <th class="prob-pct">${isEn ? 'Probability' : LANG === 'fr' ? 'Probabilité' : '機率'}</th>
        <th class="prob-bar-col"></th>
      </tr></thead>
      <tbody>
        ${rows.map(r => {
          const loc = localize(r.c);
          return `<tr>
            <td><span class="prob-flag">${r.c.flag}</span><span class="prob-name">${escapeHtml(loc.name)}</span></td>
            <td class="prob-pct">${r.pct.toFixed(1)}%</td>
            <td class="prob-bar-col"><div class="prob-bar" style="width:${Math.max(2, r.pct * 5)}%"></div></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
    <p class="muted">${isEn ? 'Source: UN WPP 2024 (annual births / total population by country)' : LANG === 'fr' ? "Source : ONU, Perspectives de la population mondiale 2024 (naissances annuelles / population par pays)" : '資料來源：聯合國《世界人口展望 2024》（各國年度出生數／總人口）'}</p>
  `;
}

/* v5.19：「如果你現在出生」對照表 — 你的實際國家 vs 隨機國家 */
function renderCountryCompare() {
  const wrap = $('#countryCompare');
  if (!wrap) return;
  const isEn = LANG === 'en';
  const me = guessUserCountry();
  const random = chooseCountry(STATE.birthMode);
  if (!me || !random) { wrap.innerHTML = ''; return; }
  // 三項關鍵指標
  const meLe = me.le;
  const rLe = random.le;
  const meU5 = (me.u5 || 0) / 1000 * 100;
  const rU5 = (random.u5 || 0) / 1000 * 100;
  const mePpp = me.ppp || 0;
  const rPpp = random.ppp || 0;
  const loc = (c) => localize(c).name;
  const fmtPct = (n) => (n < 0.1 ? n.toFixed(2) : n.toFixed(1)) + '%';
  const fmtMoney = (n) => '$' + Math.round(n).toLocaleString();
  wrap.innerHTML = `
    <h3>${isEn ? 'If you were born now, your life vs. a random one' : LANG === 'fr' ? "Si vous naissiez maintenant : votre vie face à une vie tirée au sort" : '如果你此刻出生：你的人生 vs 隨機的人生'}</h3>
    <table class="cmp-table">
      <thead><tr>
        <th></th>
        <th>${me.flag} ${escapeHtml(loc(me))}<div class="cmp-sub">${isEn ? 'Where you probably are' : LANG === 'fr' ? "Là où vous êtes probablement" : '你實際所在地'}</div></th>
        <th>${random.flag} ${escapeHtml(loc(random))}<div class="cmp-sub">${isEn ? 'Random draw' : LANG === 'fr' ? "Tirage au sort" : '隨機抽中'}</div></th>
      </tr></thead>
      <tbody>
        <tr>
          <td class="cmp-k">${t('intro.bc.le')}</td>
          <td class="cmp-v">${meLe.toFixed(1)} ${t('unit.years')}</td>
          <td class="cmp-v">${rLe.toFixed(1)} ${t('unit.years')}</td>
        </tr>
        <tr>
          <td class="cmp-k">${t('intro.bc.u5')}</td>
          <td class="cmp-v">${fmtPct(meU5)}</td>
          <td class="cmp-v">${fmtPct(rU5)}</td>
        </tr>
        <tr>
          <td class="cmp-k">${t('intro.bc.ppp')}</td>
          <td class="cmp-v">${fmtMoney(mePpp)}</td>
          <td class="cmp-v">${fmtMoney(rPpp)}</td>
        </tr>
      </tbody>
    </table>
    <p class="muted">${isEn ? 'Detected from browser language / locale. You can override by selecting one in the country list above.' : LANG === 'fr' ? "Déduit de la langue de votre navigateur. Vous pouvez choisir un autre pays dans la liste ci-dessus." : '依瀏覽器語系／地區推測。你可以從上方國家清單覆寫。'}</p>
  `;
}

/* v5.19：完整出生登記卡 — 1in8b.life 風格 */
function buildBirthCertCard(c, life) {
  if (!c || !life) return '';
  const loc = localize(c);
  const fam = life.family || {};
  const father = fam.parents?.find(p => p.sex === 'M');
  const mother = fam.parents?.find(p => p.sex === 'F');
  const fd = life.fatherDetail || {};
  const md = life.motherDetail || {};
  // 父母住房（依國家統計推測：urb%、agr% 推）
  const housing = (() => {
    const isRural = (life.stats.birthPlaceType === 'rural');
    if (isRural) {
      const typ = (c.agr || 30) > 50 ? t('intro.bc.housing.farm')
                : (c.agr || 30) > 20 ? t('intro.bc.housing.village')
                : t('intro.bc.housing.suburban');
      return typ;
    }
    // 城市
    if ((c.ppp || 0) > 30000) return t('intro.bc.housing.modern');
    if ((c.ppp || 0) > 10000) return t('intro.bc.housing.block');
    return t('intro.bc.housing.slum');
  })();
  const sexLabel = life.sex === 'M' ? t('sex.male') : t('sex.female');
  const yr = life.year + life.yearOffset;
  const u5pct = ((c.u5 || 0) / 1000 * 100);
  return `
    <div class="bc-stamp">${t('intro.bc.stamp')}</div>
    <div class="bc-header">
      <div class="bc-flag">${c.flag}</div>
      <div class="bc-name">${escapeHtml(loc.name)}</div>
      <div class="bc-iso">${c.id}</div>
    </div>
    <div class="bc-reg">${t('intro.bc.regNo')}：<b>${escapeHtml(life.regNumber || (c.id + '-' + yr + '-0000000'))}</b></div>
    <div class="bc-reg">${t('intro.bc.dob')}：<b>${yr}-01-01</b></div>
    <table class="bc-table">
      <tbody>
        <tr><td class="bc-k">${t('intro.bc.name')}</td><td class="bc-v">${escapeHtml(life.name.full || life.name.full_en || '—')}</td></tr>
        <tr><td class="bc-k">${t('intro.bc.sex')}</td><td class="bc-v">${sexLabel}</td></tr>
        <tr><td class="bc-k">${t('intro.bc.country')}</td><td class="bc-v">${c.flag} ${escapeHtml(loc.name)}</td></tr>
        <tr><td class="bc-k">${t('intro.bc.place')}</td><td class="bc-v">${life.stats.birthPlaceType === 'rural' ? t('intro.bc.rural') : t('intro.bc.urban')} · ${escapeHtml(loc.region_name || '')}</td></tr>
        <tr><td class="bc-k">${t('intro.bc.income')}</td><td class="bc-v">${t('intro.bc.quartile')} Q${life.stats.incomeQuartile || 2} / 4</td></tr>
        <tr><td class="bc-k">${t('intro.bc.father')}</td><td class="bc-v">${father ? escapeHtml(father.name) : escapeHtml(t('intro.bc.fatherAbsent'))}${fd.age ? ` · ${fd.age} ${t('unit.years')}` : ''}${fd.job ? ` · ${escapeHtml(fd.job)}` : ''}</td></tr>
        <tr><td class="bc-k">${t('intro.bc.mother')}</td><td class="bc-v">${mother ? escapeHtml(mother.name) : escapeHtml(t('intro.bc.motherAbsent'))}${md.age ? ` · ${md.age} ${t('unit.years')}` : ''}${md.job ? ` · ${escapeHtml(md.job)}` : ''}</td></tr>
        <tr><td class="bc-k">${t('intro.bc.housing')}</td><td class="bc-v">${escapeHtml(housing)}</td></tr>
        <tr><td class="bc-k">${t('intro.bc.religion')}</td><td class="bc-v">${escapeHtml(life.stats.religion || '—')}</td></tr>
        <tr class="bc-stat"><td class="bc-k">${t('intro.bc.le')}</td><td class="bc-v">${c.le.toFixed(1)} ${t('unit.years')}</td></tr>
        <tr class="bc-stat"><td class="bc-k">${t('intro.bc.u5')}</td><td class="bc-v">${u5pct < 0.1 ? u5pct.toFixed(2) : u5pct.toFixed(1)}%</td></tr>
        <tr class="bc-stat"><td class="bc-k">${t('intro.bc.ppp')}</td><td class="bc-v">$${(c.ppp || 0).toLocaleString()}</td></tr>
      </tbody>
    </table>
  `;
}

/* v5.19：顯示出生登記卡 modal */
function showBirthCertModal(c) {
  const modal = $('#birthCertModal');
  if (!modal) return;
  // 先建立一個臨時的 life 物件（不啟動 ticker、不切換視圖）
  const life = newLife(c.id);
  if (!life) return;
  STATE.birthCertCountry = c;
  STATE.birthCertLife = life;   // la vie montrée sur l'acte est celle qui sera jouée
  const body = $('#birthCertBody');
  if (body) body.innerHTML = buildBirthCertCard(c, life);
  modal.removeAttribute('hidden');
  STATE.modal = 'birthCert';
}
function hideBirthCertModal() {
  const modal = $('#birthCertModal');
  if (modal) modal.setAttribute('hidden', '');
  if (STATE.modal === 'birthCert') STATE.modal = null;
  STATE.birthCertCountry = null;
}

/* v5.19：點「出 生」按鈕 — 隨機抽國家、顯示出生卡、確認後才開始 */
function startLifeWithCert() {
  const c = chooseCountry(STATE.birthMode);
  if (!c) return;
  rollCountry(c, () => showBirthCertModal(c));
}

function renderLife() {
  if (!STATE.life) return;
  const c = STATE.life.countryData;
  const loc = localize(c);
  const isEn = LANG === 'en';
  $('#lifeFlag').textContent = c.flag;
  $('#lifeName').textContent = loc.name;
  const yearTxt = STATE.life.year + STATE.life.yearOffset;
  $('#lifeYear').textContent = yearTxt;
  $('#lifeYear2') && ($('#lifeYear2').textContent = yearTxt);
  // v5.37：年齡大字（40px serif）含 inline 歲小字
  const ageEl = $('#lifeAge');
  if (ageEl) ageEl.innerHTML = (STATE.life.age || 0) + '<small>' + t('unit.years') + '</small>';
  $('#lifeName2').textContent = (STATE.life.name.full || STATE.life.name.full_en) || '...';
  {
    const age = STATE.life.age || 0;
    const ha = $('#heroAge'); if (ha) ha.textContent = age;
    const hw = $('#heroAssets'); if (hw) hw.textContent = money(STATE.life.stats.netAssets);
    const ppp = (v) => Math.round(v).toLocaleString(LANG === 'fr' ? 'fr-FR' : 'en-US') + ' $ US PPA';
    { const a = $('#heroAssetsSub'); if (a) a.textContent = ppp(STATE.life.stats.netAssets); const b2 = $('#heroIncomeSub'); if (b2) b2.textContent = STATE.life.stats.annualIncome ? ppp(STATE.life.stats.annualIncome) + ' · ' + money(STATE.life.stats.annualIncome / 12) + (LANG === 'fr' ? ' par mois' : ' a month') : ''; }
    renderBudget();
    renderFinSide();
    renderLifeGrid();
    renderIndicators();
    renderIdCard();
    renderFamilyLife();
    const hi = $('#heroIncome'); if (hi) hi.textContent = STATE.life.stats.annualIncome ? money(STATE.life.stats.annualIncome) : '—';
    const hb = $('#heroYearBar');
    if (hb) {
      // la barre se remplit pendant l'année en cours, puis repart à zéro
      if (hb.dataset.age !== String(age)) {
        hb.dataset.age = age;
        hb.style.animation = 'none';
        void hb.offsetWidth;
        hb.style.animation = 'lhYear ' + Math.round(STATE.tickMs / STATE.speed) + 'ms linear forwards';
      }
      hb.style.animationPlayState = (STATE.paused || STATE.life.died) ? 'paused' : 'running';
    }
  }
  $('#lifeLe').textContent = c.le;
  $('#lifeSex').textContent = STATE.life.sex === 'M' ? t('sex.male') : t('sex.female');
  // 教育：顯示 0-4 級距 + 已就讀年數
  const educLabels = ['—', t('edu.0')+'（'+t('edu.pre')+'）', t('edu.1'), t('edu.2'), t('edu.3'), t('edu.4')];
  $('#lifeEduc').textContent = educLabels[Math.min(STATE.life.stats.education + 1, educLabels.length - 1)];
  // 工作：顯示 sector + 是否在職
  $('#lifeJob').textContent = STATE.life.stats.employment === 'employed' ? (STATE.life.job ? genderize(LANG === 'fr' ? STATE.life.job.fr : STATE.life.job.en, STATE.life) : LANG === 'fr' ? jobLabel('employed') : `${jobLabel('employed')} · ${LANG==='en'?'employed':'在職'}`) : jobLabel(STATE.life.stats.employment);
  // 伴侶：顯示名字 + 年齡
  if (STATE.life.stats.partner) {
    const p = STATE.life.stats.partner;
    const pName = p.name?.full || p.name?.full_en || '';
    const pAge = p.age || ((STATE.life.year + STATE.life.yearOffset) - (p.birth?.year || 0));
    $('#lifePartner').textContent = ['fr', 'en'].includes(LANG) ? `${pName} (${pAge} ${t('unit.years')}) · ${relLabel(STATE.life)}` : `${pName}（${pAge} ${t('unit.years')}）`;
  } else {
    $('#lifePartner').textContent = ['fr', 'en'].includes(LANG) ? relLabel(STATE.life) : t('partner.no');
  }
  // 子女：顯示數量 + 最長子年齡
  if (STATE.life.stats.kids.length) {
    const ages = STATE.life.stats.kids.map(k => k.bornAt ? STATE.life.age - k.bornAt : null).filter(a => a !== null);
    const oldest = ages.length ? Math.max(...ages) : null;
    $('#lifeKids').textContent = `${STATE.life.stats.kids.length}${LANG==='en'?` (oldest: ${oldest})`:LANG === 'fr' ? ` (aîné : ${oldest})` : `（最大的 ${oldest} 歲）`}`;
  } else {
    $('#lifeKids').textContent = '0';
  }
  // v5.37：進度條（4px scaleX，位於 sticky topbar 內）
  const pct = Math.min(100, STATE.life.age / c.le * 100);
  const bar = $('#lifeBar');
  if (bar) bar.style.transform = `scaleX(${(pct / 100).toFixed(4)})`;
  // 角色簡介
  const portrait = $('#lifePortrait');
  if (portrait) {
    portrait.className = 'cert-figure';
    portrait.innerHTML = pixelPortraitSVG(STATE.life.countryData, STATE.life.age, STATE.life.sex);
  }
  // 出生地：rural/urban + 國家 + 地區
  const cInfo = $('#lifeCountryInfo');
  if (cInfo) {
    // v5.21 修：fallback 給舊存檔的 birthPlaceType 缺失
    if (!STATE.life.stats.birthPlaceType) {
      STATE.life.stats.birthPlaceType = Math.random() < 0.55 ? 'rural' : 'urban';
    }
    const bpType = STATE.life.stats.birthPlaceType === 'rural' ? (isEn ? '🌾 Rural' : LANG === 'fr' ? '🌾 Campagne' : '🌾 鄉村') : (isEn ? '🏙️ Urban' : LANG === 'fr' ? '🏙️ Ville' : '🏙️ 城市');
    cInfo.textContent = `${bpType} · ${c.flag} ${loc.name} · ${loc.region_name}`;
  }
  // 家族摘要
  renderFamilySummary();
  // v5.8 新增：狀態條 + 家庭背景 + 同伴
  renderLifeStats();
  renderLifeFamilyDetail();
  renderLifeCompanions();
  renderCountryStats();
  renderSurvivalCurve();
  renderThisYear();
  renderLifeEventsFeed();
  renderManualDecisions();
  renderLifeMap();
  renderIdentityRecord();
  // v5.20：本年死因分析
  renderLifeCauseThisYear();
  // v5.19：「如果你現在出生」vs 隨機 比較表 + 「狀態 ℹ️」綁定
  bindStateInfoButton();
  renderActualVsRandom();
}

/* v5.14：本年最重要事件 */
function renderThisYear() {
  if (!STATE.life) return;
  const wrap = $('#lifeThisYearBody');
  if (!wrap) return;
  const evt = STATE.life.latestEvent;
  const isEn = LANG === 'en';
  if (!evt) { wrap.innerHTML = `<span class="muted">${isEn ? '(no major event this year yet)':LANG === 'fr' ? "(pas encore d'évènement marquant cette année)" : '（今年尚無重大事件）'}</span>`; return; }
  wrap.innerHTML = `
    <div class="ty-event">
      <span class="ty-icon">${evt.icon}</span>
      <span class="ty-text">${escapeHtml(evt.text)}</span>
      <span class="ty-age">${isEn ? `Age ${evt.age}` : LANG === 'fr' ? `${evt.age} ans` : `${evt.age} 歲`}</span>
    </div>
  `;
}

/* v5.15：5 面向終身軌跡圖（健康/教育/收入/關係/家境） */
/* v5.18：人生地圖（格子圖，1格=1年，顏色=幸福度） */
function renderLifeMap() {
  if (!STATE.life) return;
  const wrap = $('#lifeMap');
  if (!wrap) return;
  const life = STATE.life;
  const isEn = LANG === 'en';
  const c = life.countryData;
  const cols = 10;
  const maxAge = 100;
  const rows = Math.ceil(maxAge / cols);
  const W = cols * 12;  // 12px per cell
  const H = rows * 12;
  // 每格 = 1 歲。顏色依該歲的幸福度（已知數據由 trajectory/events 推估；未知用推測）
  const yearHappiness = (age) => {
    if (life.latestEvent && life.latestEvent.age === age) return Math.min(100, (life.stats.happiness || 70) + 10);
    if (age < 6) return 70 + age * 2; // 嬰兒期偏中性
    if (age < 18) return 75 + Math.sin(age * 0.5) * 15;
    if (age < 30) return 70 + Math.cos(age * 0.3) * 20;
    if (age < 65) return 65 + Math.sin(age * 0.4) * 20;
    return 60 + Math.cos(age * 0.5) * 15;
  };
  let cells = '';
  for (let a = 0; a < maxAge; a++) {
    const col = a % cols;
    const row = Math.floor(a / cols);
    const x = col * 12, y = row * 12;
    const isCurrent = a === life.age;
    const isDead = life.died && a > life.deathAge;
    const happiness = yearHappiness(a);
    const fill = isDead ? '#d8cdb8' : happinessColor(happiness);
    cells += `<rect x="${x+1}" y="${y+1}" width="10" height="10" fill="${fill}" opacity="${isDead?0.3:0.85}" stroke="${isCurrent?'#8C1D3C':'none'}" stroke-width="${isCurrent?2:0}"/>`;
  }
  wrap.innerHTML = `
    <h4>🗺️ ${isEn ? 'Life Map' : LANG === 'fr' ? "Carte de la vie" : '人生地圖'} <span class="muted">${isEn ? '1 cell = 1 year · darker = happier':LANG === 'fr' ? "1 case = 1 an · plus foncé = plus heureux" : '1格=1年 · 顏色越深越幸福'}</span></h4>
    <svg viewBox="0 0 ${W} ${H}" class="life-map-svg" style="width:100%;max-width:480px;height:auto;display:block;margin:6px auto;">
      <rect x="0" y="0" width="${W}" height="${H}" fill="#faf7f0"/>
      ${cells}
    </svg>
    <p class="muted">${LANG === 'fr' ? "Cadre extérieur = espérance de vie moyenne du pays" : isEn?'Outer box = average life expectancy in this country':'外框格 = '+c.flag+(localize(c).name)+' 平均壽命 '+(c.le||70)+t('unit.years')}</p>
  `;
}

function happinessColor(h) {
  // 0-100 幸福度 → 紅(0) → 橘(50) → 綠(100)
  if (h < 30) return `rgb(${Math.round(220 - h*1.5)}, ${Math.round(80 + h)}, ${Math.round(60 + h*1.5)})`;
  if (h < 60) return `rgb(${Math.round(220 - (h-30)*3)}, ${Math.round(180 + (h-30)*1.5)}, ${Math.round(70 + (h-30)*0.5)})`;
  return `rgb(${Math.round(110 - (h-60)*1.5)}, ${Math.round(220 + (h-60)*0.3)}, ${Math.round(90 + (h-60)*0.5)})`;
}

function renderLifeTrajectory() {
  if (!STATE.life) return;
  const wrap = $('#lifeTrajectory');
  if (!wrap) return;
  const life = STATE.life;
  const isEn = LANG === 'en';
  const traj = life.trajectory || [];
  const W = 600, H = 220;
  const maxAge = Math.max(life.age, 20);
  const projX = (a) => 40 + (a / maxAge) * (W - 60);
  const projY = (v) => H - 30 - (v / 100) * (H - 50);
  const lines = [
    { key:'health', color:'#22c55e', en:'Health', zh:'健康' },
    { key:'knowledge', color:'#3b82f6', en:'Education', zh:'教育' },
    { key:'income', color:'#eab308', en:'Income', zh:'收入' },
    { key:'relationship', color:'#a855f7', en:'Relationship', zh:'關係' }
  ];
  // income 標準化：netAssets / 50 (cap 100)
  const norm = (k, v) => k === 'income' ? Math.min(100, Math.max(0, v / 80)) : Math.max(0, Math.min(100, v));
  let paths = '';
  lines.forEach(L => {
    const pts = traj.filter(p => p[L.key] != null).map(p => `${projX(p.age)},${projY(norm(L.key, p[L.key]))}`).join(' L ');
    if (pts) paths += `<path d="M ${pts}" fill="none" stroke="${L.color}" stroke-width="2"/>`;
  });
  // 家境：水平虛線（基本不改變）
  const familyY = projY(norm('relationship', life.stats.incomeQuartile * 25));  // 簡化顯示
  const familyPath = traj.length ? `M ${projX(0)} ${familyY} L ${projX(maxAge)} ${familyY}` : '';
  // 自己位置
  const myAge = life.age;
  let lifeAtAge = traj.find(p => p.age === myAge);
  const myPoints = lines.map(L => {
    const v = L.key === 'health' ? life.stats.health : L.key === 'knowledge' ? life.stats.knowledge : L.key === 'income' ? Math.min(100, life.stats.netAssets / 80) : L.key === 'relationship' ? life.stats.social : 50;
    return `<circle cx="${projX(myAge)}" cy="${projY(norm(L.key, v))}" r="3" fill="${L.color}" stroke="white" stroke-width="1"/>`;
  }).join('');
  wrap.innerHTML = `
    <h4>📊 ${isEn ? '5 Life Dimensions Over Time' : LANG === 'fr' ? "Les 5 dimensions de la vie au fil du temps" : '5 個面向終身軌跡'} <span class="muted">(${isEn ? 'past → present':LANG === 'fr' ? 'passé → présent' : '過去→現在'})</span></h4>
    <svg viewBox="0 0 ${W} ${H}" class="trajectory-svg" style="width:100%;height:auto;">
      <rect x="0" y="0" width="${W}" height="${H}" fill="#faf7f0"/>
      <line x1="40" y1="${H-30}" x2="${W-10}" y2="${H-30}" stroke="#999" stroke-width="1"/>
      <line x1="40" y1="20" x2="40" y2="${H-30}" stroke="#999" stroke-width="1"/>
      <text x="32" y="22" font-size="9" fill="#666" text-anchor="end">100</text>
      <text x="32" y="${H-32}" font-size="9" fill="#666" text-anchor="end">0</text>
      ${familyPath ? `<path d="${familyPath}" fill="none" stroke="#a16207" stroke-width="1.5" stroke-dasharray="6 4"/>` : ''}
      ${paths}
      ${myPoints}
      <text x="42" y="${H-15}" font-size="8" fill="#999">0</text>
      <text x="${W-12}" y="${H-15}" font-size="8" fill="#999" text-anchor="end">${maxAge}</text>
      <text x="${W/2}" y="${H-15}" font-size="8" fill="#999" text-anchor="middle">${isEn?'Age':LANG === 'fr' ? 'Âge' : '年齡'}</text>
      <g font-size="9" font-weight="600" transform="translate(${W-150}, 8)">
        <rect x="0" y="0" width="140" height="74" fill="white" stroke="#d8cdb8" rx="4"/>
        ${lines.map((L, i) => `<line x1="6" y1="${14 + i*15}" x2="20" y2="${14 + i*15}" stroke="${L.color}" stroke-width="2"/><text x="24" y="${17 + i*15}" fill="#5a4a3a">${enfr(L.en, L.zh)}</text>`).join('')}
        <line x1="6" y1="${14 + 4*15}" x2="20" y2="${14 + 4*15}" stroke="#a16207" stroke-width="1.5" stroke-dasharray="4 2"/><text x="24" y="${17 + 4*15}" fill="#5a4a3a">${isEn?'Family BG':LANG === 'fr' ? "Milieu familial" : '家境'}</text>
      </g>
    </svg>
    <p class="muted">${isEn?'Current values: ':LANG === 'fr' ? 'Valeurs actuelles : ' : '當前數值：'}🟢 ${isEn?'Health':LANG === 'fr' ? 'Santé' : '健康'} ${Math.round(life.stats.health)} · 🔵 ${isEn?'Education':LANG === 'fr' ? 'Éducation' : '教育'} ${Math.round(life.stats.knowledge)} · 🟡 ${isEn?'Income':LANG === 'fr' ? 'Revenu' : '收入'} PPP $${Math.round(life.stats.netAssets).toLocaleString()} · 🟣 ${isEn?'Relationship':LANG === 'fr' ? 'Relations' : '關係'} ${Math.round(life.stats.social)}</p>
  `;
}

/* v5.15：在 tick 內記錄 5 面向狀態（每 5 年取樣） */
function recordTrajectory(life) {
  if (!life) return;
  if (!life.trajectory) life.trajectory = [];
  const age = life.age;
  const s = life.stats;
  const last = life.trajectory[life.trajectory.length - 1];
  // 每 5 歲或重大事件記錄一次
  if (age % 5 !== 0 && (!last || age - last.age < 5)) return;
  life.trajectory.push({
    age,
    health: s.health,
    knowledge: s.knowledge,
    income: Math.min(100, Math.round(s.netAssets / 80)),
    relationship: s.social
  });
}

/* v5.8 新增：4 個狀態條 + 淨資產 */
/* v5.16：手動決策面板（玩家主動觸發） */
/* v5.19：新增「⚡ 快速決定」+ 「♪ 音樂」按鈕 */
function renderManualDecisions() {
  if (!STATE.life) return;
  const wrap = $('#lifeManualDecisions');
  if (!wrap) return;
  const life = STATE.life, fr = LANG === 'fr';
  const opts = priorityOptions(life);
  const c = life.countryData || {};
  const job = life.job ? genderize(fr ? life.job.fr : life.job.en, life) : (life.stats.employment === 'university' ? (fr ? 'Étudiant(e)' : 'Student') : life.stats.employment === 'retired' ? (fr ? 'Retraité(e)' : 'Retired') : life.age < 18 ? (fr ? 'Élève' : 'Pupil') : (fr ? 'Sans emploi' : 'Without work'));
  const where = (life.stats.birthPlaceType === 'rural' ? (fr ? 'Campagne' : 'Countryside') : (fr ? 'Ville' : 'City')) + ' · ' + localize(c).name;
  const jobBits = [genderize(job, life)];
  if (life.job && life.jobStart != null) jobBits.push((fr ? 'année ' : 'year ') + Math.max(1, life.age - life.jobStart + 1));
  if (life.job) jobBits.push(pppOf(life) < 8000 ? (fr ? 'emploi informel' : 'informal job') : (fr ? 'emploi formel' : 'formal job'));
  jobBits.push(where);
  wrap.innerHTML = '<h4>' + (fr ? "Priorité de l'année" : 'Priority of the year') + ' <span class="muted">' + (fr ? 'modifiable à tout moment' : 'change it any time') + '</span></h4>'
    + '<p class="pri-job">' + jobBits.join(' · ') + '</p>'
    + (opts.length
      ? '<div class="pri-chips">' + opts.map(id => '<button type="button" class="pri-chip' + (life.priority === id ? ' on' : '') + '" data-pri="' + id + '"><b>' + PRIORITIES[id].fr + '</b><small>' + PRIORITIES[id].sub + '</small></button>').join('') + '</div>'
      : '<p class="muted">' + (fr ? "Vous êtes encore un petit enfant : vos parents s'occupent de tout." : 'You are still a small child.') + '</p>')
    + '<div class="pri-actions"><button type="button" class="ghost" id="mdFinanceNow">' + (fr ? 'Votre situation financière' : 'Your financial situation') + '</button>'
    + '<button type="button" class="ghost" id="mdMusicBtn">' + (fr ? '♪ Musique de fond' : '♪ Background music') + '</button></div>';
  wrap.querySelectorAll('.pri-chip').forEach(b => b.addEventListener('click', () => {
    life.priority = b.dataset.pri;
    life.focusThisYear = PRIORITIES[life.priority].legacy || null;
    renderManualDecisions();
  }));
  $('#mdFinanceNow')?.addEventListener('click', () => showFinanceModal());
  $('#mdMusicBtn')?.addEventListener('click', toggleBackgroundMusic);
}

function renderLifeStats() {
  if (!STATE.life) return;
  const s = STATE.life.stats;
  const set = (valEl, barEl, v) => {
    if (!valEl || !barEl) return;
    // v5.90：數字也要夾。舊版只夾長條、數字直接印原值，於是健康條滿格但旁邊寫「108」。
    const c = Math.max(0, Math.min(100, v));
    valEl.textContent = Math.round(c);
    barEl.style.width = c + '%';
  };
  set($('#stateHealthVal'), $('#stateHealth'), s.health);
  set($('#stateHappyVal'), $('#stateHappy'), s.happiness);
  set($('#stateKnowledgeVal'), $('#stateKnowledge'), s.knowledge);
  set($('#stateSocialVal'), $('#stateSocial'), s.social);
  // 淨資產（PPP 美元）
  const na = $('#netAssets');
  if (na) na.textContent = money(s.netAssets);
  // v5.19：當年存活率
  renderSurvivalRate();
  // v5.19：你現在 vs 隨機國家 比較表
  renderActualVsRandom();
}

/* v5.19 新增：「狀態代表什麼？」展開說明 */
function bindStateInfoButton() {
  const btn = $('#btnStateInfo');
  const panel = $('#stateInfoPanel');
  if (!btn || !panel) return;
  // 避免重複綁定
  if (btn.__wired) return;
  btn.__wired = true;
  btn.addEventListener('click', () => {
    const isHidden = panel.hasAttribute('hidden');
    const isEn = LANG === 'en';
    if (isHidden) {
      panel.innerHTML = `
        <div class="si-row"><span class="si-k">${isEn ? 'Health' : LANG === 'fr' ? 'Santé' : '健康'}</span><span class="si-v">${isEn ? 'Starts at 100, then eases each year toward an age-based ceiling (100 falling 0.55 a year from 18, floored at 40). Drops faster after 60. Health choices push it up or down.' : LANG === 'fr' ? "Part de 100, puis se rapproche chaque année d'un plafond lié à l'âge (100, moins 0,55 par an après 18 ans, avec un minimum de 40). Baisse plus vite après 60 ans. Vos choix de santé la font monter ou descendre." : '出生時 100，之後每年往「該年齡的上限」靠（18 歲後每年降 0.55，最低 40）。60 歲後掉得更快。養生的選擇可以把它往上拉，也可以往下壓。'}</span></div>
        <div class="si-row"><span class="si-k">${isEn ? 'Knowledge' : LANG === 'fr' ? 'Savoir' : '知識'}</span><span class="si-v">${isEn ? 'Education level + life experience. Self-study focus +3, secondary school +0.5/yr.' : LANG === 'fr' ? "Niveau d'études et expérience de vie. Priorité à l'apprentissage : +3 ; collège et lycée : +0,5 par an." : '學歷 + 人生經歷。每年自我進修 +3、升上國中 +0.5。'}</span></div>
        <div class="si-row"><span class="si-k">${isEn ? 'Happiness' : LANG === 'fr' ? 'Bonheur' : '幸福'}</span><span class="si-v">${isEn ? 'Your choices push it directly, but each year it drifts 1.8% toward a baseline set by your circumstances: 45, plus health (×0.35), relationships (×0.12), +8 working / +5 studying / +3 retired / −2 jobless, and −8 if you owe money. A good choice therefore keeps pulling for years.' : LANG === 'fr' ? "Vos choix le modifient directement, mais chaque année il se rapproche de 1,8 % d'un niveau de base fixé par votre situation : 45, plus la santé (×0,35), les relations (×0,12), +8 si vous travaillez, +5 en études, +3 à la retraite, −2 sans emploi, et −8 si vous avez des dettes. Un bon choix agit donc pendant des années." : '你的選擇會直接推動它，但每年會以 1.8% 慢慢回到「當下處境決定的水位」：基準 45，加上健康（×0.35）、人際（×0.12），在職 +8／就學 +5／退休 +3／無業 −2，負債再 −8。所以一個好選擇可以維持很多年。'}</span></div>
        <div class="si-row"><span class="si-k">${isEn ? 'Social' : LANG === 'fr' ? 'Relations' : '人際'}</span><span class="si-v">${isEn ? 'Starts at 60, and your choices move it most — helping relatives, hosting friends, keeping in touch, sharing good news (+1 to +8); moving away or taking the cash instead (−1 to −3). Family focus +4, and an affordable yearly social expense adds +4.' : LANG === 'fr' ? "Part de 60, et ce sont surtout vos choix qui le font bouger : aider des proches, recevoir des amis, donner des nouvelles, partager une bonne nouvelle (+1 à +8) ; déménager loin ou préférer l'argent (−1 à −3). Priorité à la famille : +4 ; une dépense sociale annuelle abordable : +4." : '起始 60，主要由你的選擇推動 —— 幫忙親戚、招待朋友、保持聯絡、分喜訊（+1～+8）；搬家離開或只拿錢（−1～−3）。年度焦點選「家人」+4，每年負擔得起的社交支出再 +4。'}</span></div>
      `;
      panel.removeAttribute('hidden');
      btn.textContent = 'ℹ️✕';
    } else {
      panel.setAttribute('hidden', '');
      btn.textContent = 'ℹ️';
    }
  });
}

/* v5.8 新增：1in8b.life 風格家庭背景卡 */
function renderLifeFamilyDetail() {
  if (!STATE.life) return;
  const life = STATE.life;
  const wrap = $('#lifeFamilyDetail');
  if (!wrap) return;
  const isEn = LANG === 'en';
  const fd = life.fatherDetail || {};
  const md = life.motherDetail || {};
  wrap.innerHTML = `
    <h4>${isEn ? '👪 Family Background' : LANG === 'fr' ? "👪 Famille d'origine" : '👪 出身家庭'}</h4>
    <div class="fd-row">
      <div class="fd-cell">
        <div class="fd-role">${isEn ? 'Father' : LANG === 'fr' ? 'Père' : '父親'} · ${life.stats.incomeQuartile ? `Q${life.stats.incomeQuartile}` : 'Q?'}</div>
        <div class="fd-name">${isEn ? (life.family?.parents?.find(p=>p.sex==='M')?.name || '—') : (life.family?.parents?.find(p=>p.sex==='M')?.name || '—')}</div>
        <div class="fd-detail">${fd.age ? (fd.age + (isEn ? ' years old' : LANG === 'fr' ? ' ans' : '歲')) : ''} ${fd.job ? '· ' + fd.job : ''}</div>
      </div>
      <div class="fd-cell">
        <div class="fd-role">${isEn ? 'Mother' : LANG === 'fr' ? 'Mère' : '母親'}</div>
        <div class="fd-name">${life.family?.parents?.find(p=>p.sex==='F')?.name || '—'}</div>
        <div class="fd-detail">${md.age ? (md.age + (isEn ? ' years old' : LANG === 'fr' ? ' ans' : '歲')) : ''} ${md.job ? '· ' + md.job : ''}</div>
      </div>
      <div class="fd-cell">
        <div class="fd-role">${isEn ? 'Religion' : LANG === 'fr' ? 'Religion' : '宗教'} · ${isEn ? 'Place' : LANG === 'fr' ? 'Lieu' : '出生地'}</div>
        <div class="fd-name" style="font-size:13px;font-weight:500">${life.stats.religion || '—'}</div>
        <div class="fd-detail">${life.stats.birthPlaceType === 'rural' ? (isEn ? '🌾 Rural' : LANG === 'fr' ? '🌾 Campagne' : '🌾 鄉村') : (isEn ? '🏙️ Urban' : LANG === 'fr' ? '🏙️ Ville' : '🏙️ 城市')}</div>
      </div>
    </div>
    ${life.family?.siblings?.length ? `<div class="fd-sib"><strong>${isEn ? 'Siblings' : LANG === 'fr' ? "Frères et sœurs" : '兄弟姊妹'}：</strong> ${life.family.siblings.map(s => {
      const sAge = (life.year + life.yearOffset) - (s.birth?.year || life.year);
      return `${s.name} (${sAge} ${t('unit.years')})`;
    }).join(', ')}</div>` : ''}
  `;
}

/* v5.8 新增：4 位同伴（同時出生的人） */
/* v5.19 強化：補上「家庭背景」「父母職業」「出生地區」 */
function renderLifeCompanions() {
  if (!STATE.life || !STATE.life.companions) return;
  const wrap = $('#lifeCompanions');
  if (!wrap) return;
  const isEn = LANG === 'en';
  // v5.53：隨年齡更換的可愛插畫（<18 寶寶書本 / 18–64 時間種子 / 65+ 丘陵老人）
  const illusEl = $('#lifeIllus');
  if (illusEl) {
    const age = STATE.life.age;
    const src = age < 18 ? 'assets/illus-baby-book.jpg'
               : age < 65 ? 'assets/illus-time-seed.jpg'
               : 'assets/illus-elder-hill.jpg';
    if (illusEl.dataset.src !== src) {
      illusEl.dataset.src = src;
      illusEl.innerHTML = `<img src="${src}" alt="" loading="lazy" decoding="async">`;
    }
  }
  // v5.29：渲染場景描述（1in8b.life 風格「與父母和兄弟姊妹X人同住」）
  const sceneEl = $('#lifeScene');
  if (sceneEl) {
    const c = STATE.life.countryData;
    const loc = c ? localize(c) : { name: STATE.life.country };
    const place = STATE.life.stats.birthPlaceType === 'rural' ? (isEn ? 'rural' : LANG === 'fr' ? 'campagne' : '鄉村') : (isEn ? 'urban' : LANG === 'fr' ? 'ville' : '城市');
    const sibCount = (STATE.life.family?.siblings || []).length;
    const rural = STATE.life.stats.birthPlaceType === 'rural';
    const housing = enfr(rural ? 'small house' : 'apartment', rural ? '鄉間小屋' : '公寓');
    const familyText = isEn
      ? `${loc.name} ${place} · ${housing} · lives with parents and ${sibCount} siblings`
      : LANG === 'fr' ? `${loc.name}, ${place} · ${housing} · vit avec ses parents${sibCount ? ' et ' + sibCount + ' frère(s) ou sœur(s)' : ''}` : `${loc.name} ${place} · ${housing} · 與父母和兄弟姊妹${sibCount}人同住`;
    sceneEl.innerHTML = `<h4>🏡 ${isEn?'Where you live':LANG === 'fr' ? "Là où vous vivez" : '你住的地方'}</h4><p class="muted">${familyText}</p>`;
  }
  wrap.innerHTML = `
    <h4>${isEn ? '👶 Born in the same second' : LANG === 'fr' ? "👶 Nés à la même seconde" : '👶 在同一秒出生的人們'} <span class="muted">(${isEn ? 'growing up together' : LANG === 'fr' ? "ils grandissent en même temps que vous" : '一起長大'})</span></h4>
    <div class="lc-grid">${STATE.life.companions.map(c => `
      <div class="lc-cell">
        <div class="lc-flag">${c.flag}</div>
        <div class="lc-name">${c.name}</div>
        <div class="lc-meta">${(localize(c.countryData) || {}).name || c.country} · ${c.sex === 'M' ? (isEn || LANG === 'fr' ? '♂' : '男') : (isEn || LANG === 'fr' ? '♀' : '女')} · ${c.lifeExpectancy ? c.lifeExpectancy + (LANG === 'fr' ? ' ' : '') + t('unit.years') : ''}</div>
        <div class="lc-bg">
          <div class="lc-bg-row"><span class="lc-bg-k">${isEn ? 'Father' : LANG === 'fr' ? 'Père' : '父'}</span><span class="lc-bg-v">${c.parentJobFather || '—'}</span></div>
          <div class="lc-bg-row"><span class="lc-bg-k">${isEn ? 'Mother' : LANG === 'fr' ? 'Mère' : '母'}</span><span class="lc-bg-v">${c.parentJobMother || '—'}</span></div>
          <div class="lc-bg-row"><span class="lc-bg-k">${isEn ? 'Family' : LANG === 'fr' ? 'Famille' : '家境'}</span><span class="lc-bg-v lc-q">${quartileLabel(c.incomeQuartile, isEn)}</span></div>
          <div class="lc-bg-row"><span class="lc-bg-k">${isEn ? 'Born in' : LANG === 'fr' ? "Lieu de naissance" : '出生地'}</span><span class="lc-bg-v">${c.birthPlaceType === 'rural' ? (isEn ? '🌾 Rural' : LANG === 'fr' ? '🌾 Campagne' : '🌾 鄉村') : (isEn ? '🏙️ Urban' : LANG === 'fr' ? '🏙️ Ville' : '🏙️ 城市')}</span></div>
        </div>
      </div>
    `).join('')}</div>
  `;
}

/* v5.19 新增：「如果你現在出生」vs 隨機國家 比較表 */
function renderActualVsRandom() {
  if (!STATE.life) return;
  const wrap = $('#lifeActualVsRandom');
  if (!wrap) return;
  const c = STATE.life.countryData;
  if (!c) return;
  const isEn = LANG === 'en';
  const real = guessBirthCountry();
  const random = c;
  if (!real) return;
  wrap.hidden = real.id === c.id;   // comparer un pays à lui-même n'apprend rien
  if (wrap.hidden) return;
  const fr = LANG === 'fr';
  const nf = (v, d = 1) => (+v).toLocaleString(fr ? 'fr-FR' : 'en-US', { maximumFractionDigits: d });
  const LANGS_FR = { fr: 'français', ar: 'arabe', es: 'espagnol', en: 'anglais', pt: 'portugais', zh: 'chinois', hi: 'hindi', ru: 'russe', de: 'allemand', it: 'italien', tr: 'turc', fa: 'persan', id: 'indonésien', ja: 'japonais', ko: 'coréen', sw: 'swahili', bn: 'bengali', ur: 'ourdou', th: 'thaï', vi: 'vietnamien', pl: 'polonais', uk: 'ukrainien', nl: 'néerlandais', sv: 'suédois', ro: 'roumain', el: 'grec', he: 'hébreu', cs: 'tchèque', hu: 'hongrois', fi: 'finnois', da: 'danois', no: 'norvégien', am: 'amharique', ha: 'haoussa', yo: 'yoruba', zu: 'zoulou', af: 'afrikaans' };
  const langOf = (c2) => String(c2.lang || '').split(',').slice(0, 2).map(x => (LANGS_FR[x.split(':')[0]] || x.split(':')[0])).join(', ') || '—';
  const pct = (v) => v != null ? nf(v, 0) + ' %' : '—';
  // dir : 1 = plus haut vaut mieux, -1 = plus bas vaut mieux, 0 = sans jugement de valeur
  const R = (lab, dir, fmt, get) => ({ lab, dir, fmt, get });
  const rows = [
    R(fr ? 'Naissances par an' : 'Births per year', 0, v => v != null ? nf(v / 1e6, 1) + (fr ? ' million(s)' : ' million') : '—', c2 => c2.births),
    R(fr ? 'Population' : 'Population', 0, v => v != null ? nf(v / 1000, 1) + (fr ? ' million(s)' : ' million') : '—', c2 => c2.pop),
    R(fr ? 'Espérance de vie (F / H)' : 'Life expectancy (F / M)', 1, v => v != null ? nf(v + 0, 1) + (fr ? ' ans' : ' yrs') : '—', c2 => c2.le),
    R(fr ? 'Mortalité avant 5 ans' : 'Under-5 mortality', -1, v => v != null ? nf(v / 10, 2) + ' %' : '—', c2 => c2.u5),
    R(fr ? 'PIB par habitant (PPA)' : 'GDP per capita (PPP)', 1, v => v != null ? '$' + nf(v, 0) : '—', c2 => c2.ppp),
    R(fr ? 'Coefficient de Gini (inégalités)' : 'Gini coefficient', -1, v => v != null ? nf(v, 2) : '—', c2 => c2.gi),
    R(fr ? 'Population urbaine' : 'Urban population', 0, pct, c2 => c2.urb),
    R(fr ? 'Emploi dans l\'agriculture' : 'Farm employment', 0, pct, c2 => c2.agr),
    R(fr ? 'Années de scolarité attendues' : 'Expected school years', 1, v => v != null ? nf(v, 1) + (fr ? ' ans' : ' yrs') : '—', c2 => c2.eys),
    R(fr ? 'Accès à l\'enseignement supérieur' : 'Higher education enrolment', 1, pct, c2 => c2.ter),
    R(fr ? 'Utilisation d\'Internet' : 'Internet use', 1, pct, c2 => c2.net),
    R(fr ? 'Enfants par femme' : 'Children per woman', 0, v => v != null ? nf(v, 2) : '—', c2 => c2.tfr),
    R(fr ? 'Mortalité maternelle (pour 100 000 naissances)' : 'Maternal mortality (per 100,000 births)', -1, v => v != null ? nf(v, 0) : '—', c2 => c2.mmr),
    R(fr ? 'Prévalence du VIH (15-49 ans)' : 'HIV prevalence (15-49)', -1, v => v != null ? nf(v, 2) + ' %' : '—', c2 => c2.hiv),
    R(fr ? 'Taux d\'homicide (pour 100 000)' : 'Homicide rate (per 100,000)', -1, v => v != null ? nf(v, 1) : '—', c2 => c2.hom),
    R(fr ? 'Décès sur la route (pour 100 000)' : 'Road deaths (per 100,000)', -1, v => v != null ? nf(v, 1) : '—', c2 => c2.road),
    R(fr ? 'Paludisme (indice de 0 à 1,5)' : 'Malaria (index 0 to 1.5)', -1, v => v != null ? nf(v, 1) : '—', c2 => c2.mal),
    R(fr ? 'Tabagisme (hommes / femmes)' : 'Smoking (men / women)', -1, (v, c2) => c2 ? nf(c2.sm, 0) + ' % / ' + nf(c2.sf, 0) + ' %' : '—', c2 => c2.sm),
    R(fr ? 'Santé payée de sa poche' : 'Out-of-pocket health spending', -1, pct, c2 => c2.oop),
    R(fr ? 'Mariage avant 18 ans (femmes)' : 'Child marriage (women)', -1, pct, c2 => c2.cm),
    R(fr ? 'Satisfaction de vie (0-10)' : 'Life satisfaction (0-10)', 1, v => v != null ? nf(v, 1) : '—', c2 => c2.wh),
    R(fr ? 'Langues' : 'Languages', 0, (v, c2) => langOf(c2), c2 => null),
  ].map(r => ({ ...r, realVal: r.get(real), randVal: r.get(random), realC: real, randC: random }));
  wrap.innerHTML = `
    <h4>${isEn ? '🧭 If you were born now' : LANG === 'fr' ? "🧭 Si vous naissiez maintenant" : '🧭 如果你現在出生'} <span class="muted">${isEn ? 'vs your random country' : LANG === 'fr' ? "face au pays de cette vie" : 'vs 你的隨機出生地'}</span></h4>
    <table class="ar-table">
      <thead>
        <tr><th></th><th class="ar-you">${real.flag} ${localize(real).name} <span class="muted">${isEn?'(by your browser language)':LANG === 'fr' ? "(d'après la langue du navigateur)" : '（依瀏覽器語言推測）'}</span></th><th class="ar-rand">${random.flag} ${localize(random).name} <span class="muted">${isEn?'(random draw)':LANG === 'fr' ? '(cette vie)' : '（隨機）'}</span></th></tr>
      </thead>
      <tbody>${rows.map(r => {
        const half = (c2) => (c2.gap || 0) / 2;
        const fmtLe = (c2) => nf(c2.le + half(c2), 1) + ' / ' + nf(c2.le - half(c2), 1) + (fr ? ' ans' : ' yrs');
        const realV = r.lab.startsWith(fr ? 'Espérance' : 'Life expectancy') ? fmtLe(r.realC) : r.fmt(r.realVal, r.realC);
        const randV = r.lab.startsWith(fr ? 'Espérance' : 'Life expectancy') ? fmtLe(r.randC) : r.fmt(r.randVal, r.randC);
        const a = parseFloat(r.realVal), b = parseFloat(r.randVal);
        let winner = '';
        if (r.dir !== 0 && !isNaN(a) && !isNaN(b)) winner = a === b ? '⚪' : ((a > b) === (r.dir > 0) ? '🟢' : '🔴');
        return `<tr><td class="ar-k">${r.lab}${winner ? ' ' + winner : ''}</td><td class="ar-v" data-l="${real.flag}">${realV}</td><td class="ar-v" data-l="${(r.randC && r.randC.flag) || ''}">${randV}</td></tr>`;
      }).join('')}</tbody>
    </table>
    <p class="muted ar-note">${isEn ? '🟢 = better than random · 🔴 = worse · ⚪ = same. ' : LANG === 'fr' ? "🟢 = mieux que cette vie · 🔴 = moins bien · ⚪ = pareil. " : '🟢 = 比隨機好 · 🔴 = 比隨機差 · ⚪ = 一樣。'}</p>
  `;
}

/* v5.19 新增：在 cert-meta 加「當年存活率」欄位 */
function renderSurvivalRate() {
  const el = $('#lifeSurvival');
  if (!el) return;
  if (!STATE.life || !STATE.life.countryData) {
    el.textContent = '—';
    return;
  }
  const c = STATE.life.countryData;
  const sr = survivalRateForAge(c, STATE.life.sex, STATE.life.age);
  if (sr == null) {
    el.textContent = '—';
    return;
  }
  const pct = Math.round(sr * 100);
  el.textContent = pct + '%';
  el.style.color = pct >= 95 ? 'var(--good)' : pct >= 80 ? 'var(--gold)' : 'var(--bad)';
}

/* v5.9 新增：完整國家統計面板（16 個關鍵指標） */
function renderCountryStats() {
  if (!STATE.life) return;
  const c = STATE.life.countryData;
  if (!c) return;
  const wrap = $('#lifeCountryStats');
  if (!wrap) return;
  const isEn = LANG === 'en';
  const sex = STATE.life.sex;
  // 16 個統計指標（依國家資料）
  const rows = [
    [isEn?'Annual births':LANG === 'fr' ? "Naissances par an" : '每年出生人數', Math.round(c.births || 240000).toLocaleString() + (isEn?' people':LANG === 'fr' ? ' personnes' : '人')],
    // v5.97：c.pop 的單位是「千人」，不是「人」。
// 證據：172 國的 c.pop 加總 = 8,078,638，若視為千人剛好是 80.8 億（世界人口）；
// 若視為「人」則只有 0.0081 億。台灣 c.pop = 23317 = 2331.7 萬人。
// 舊碼除以 1,000,000，於是台灣顯示「0.0 百萬人」、印度「1.4 百萬人」（實際 1438.1）。
// 另外預設值 5000000 也跟錯單位，應該是 5000（千人）。
[isEn?'Population':LANG === 'fr' ? 'Population' : '人口', ((c.pop || 5000)/1000).toFixed(1) + (isEn?'M people':LANG === 'fr' ? " M d'habitants" : '百萬人')],
    [isEn?'Life expectancy F/M':LANG === 'fr' ? "Espérance de vie F/H" : '平均壽命 女/男', ((c.le || 70) + (isEn?'/':'/') + Math.max(0,(c.le||70) - 4)) + t('unit.years')],
    [isEn?'Under-5 mortality':LANG === 'fr' ? "Mortalité avant 5 ans" : '5歲以下死亡率', ((c.u5 || 25) / 1000 * 100).toFixed(1) + '%'],
    [isEn?'GDP per capita (PPP)':LANG === 'fr' ? "PIB par habitant (PPA)" : '人均GDP（PPP）', '$' + Math.round(c.ppp || 10000).toLocaleString()],
    [isEn?'Gini coefficient':LANG === 'fr' ? "Coefficient de Gini" : '所得吉尼係數', (c.gi || 0.35).toFixed(2)],
    [isEn?'Urban population %':LANG === 'fr' ? "Population urbaine (%)" : '都市人口比例', Math.round(c.urb || 50) + '%'],
    [isEn?'Agricultural workforce':LANG === 'fr' ? "Emploi agricole" : '從事農業', Math.round(c.agr || 30) + '%'],
    [isEn?'Expected education years':LANG === 'fr' ? "Années d'études attendues" : '預期受教育年數', (c.eys || 12).toFixed(1) + (isEn?' yrs':LANG === 'fr' ? ' ans' : '年')],
    [isEn?'Higher education rate':LANG === 'fr' ? "Accès aux études supérieures" : '高等教育粗在學率', Math.round(c.ter || 30) + '%'],
    [isEn?'Internet usage':LANG === 'fr' ? "Usage d'Internet" : '網路使用率', Math.round(c.net || 60) + '%'],
    [isEn?'Total fertility rate':LANG === 'fr' ? "Enfants par femme" : '總生育率', (c.tfr || 2).toFixed(2) + (isEn?' children':LANG === 'fr' ? ' enfants' : '人')],
    [isEn?'Maternal mortality':LANG === 'fr' ? "Mortalité maternelle" : '孕產婦死亡率（每10萬活產）', Math.round(c.mmr || 50)],
    [isEn?'HIV prevalence 15-49':LANG === 'fr' ? "VIH chez les 15-49 ans" : 'HIV 盛行率（15-49歲）', (c.hiv || 1).toFixed(2) + '%'],
    [isEn?'Homicide rate':LANG === 'fr' ? "Taux d'homicides" : '兇殺率（每10萬人）', Math.round(c.hom || 5) + (isEn?'/100k':LANG === 'fr' ? '/100 000' : '/10萬')],
    [isEn?'Traffic fatality':LANG === 'fr' ? "Morts sur la route" : '交通事故死亡（每10萬人）', Math.round(c.road || 15) + (isEn?'/100k':LANG === 'fr' ? '/100 000' : '/10萬')],
    [isEn?'Tobacco use M/F':LANG === 'fr' ? "Tabagisme H/F" : '菸草使用 男/女', (Math.round(c.sm * 0.8)) + '% / ' + (Math.round(c.sm * 0.1)) + '%'],
    [isEn?'Out-of-pocket health':LANG === 'fr' ? "Santé payée de sa poche" : '醫療費用自付比例', Math.round(c.oop || 30) + '%'],
    [isEn?'Child marriage (F)':LANG === 'fr' ? "Mariage d'enfants (F)" : '18歲前結婚（女性）', Math.round(c.cm || 20) + '%'],
    [isEn?'Life satisfaction (0-10)':LANG === 'fr' ? "Satisfaction de vie (0-10)" : '生活滿意度（0-10）', (c.ls || 5.5).toFixed(2)]
  ];
  wrap.innerHTML = `
    <h4>🌍 ${c.flag} ${localize(c).name} <span class="muted">(${isEn?'20 key stats':LANG === 'fr' ? "20 statistiques clés" : '20 個關鍵統計'})</span></h4>
    <table class="cs-table">
      <tbody>${rows.map(r => `<tr><td class="cs-k">${r[0]}</td><td class="cs-v">${r[1]}</td></tr>`).join('')}</tbody>
    </table>
    <p class="muted cs-source">${isEn?'Sources: UN WPP 2024, WB WDI, WHO, UNESCO UIS, UNDP HDR, ILO, UNAIDS, UNODC, UNICEF, World Happiness Report 2024':LANG === 'fr' ? "Sources : ONU WPP 2024, Banque mondiale, OMS, UNESCO, PNUD, OIT, ONUSIDA, ONUDC, UNICEF, Rapport mondial sur le bonheur 2024" : '資料來源：聯合國《世界人口展望2024》、世界銀行WDI、WHO、UNESCO UIS、UNDP HDR、ILO、UNAIDS、UNODC、UNICEF、生活滿意度報告2024'}</p>
  `;
  // v5.11：存活曲線圖
  renderSurvivalCurve();
  renderLifeTrajectory();
}

/* v5.11：存活曲線圖（國家 vs 世界平均 vs 自己年齡點） */
function renderSurvivalCurve() {
  if (!STATE.life) return;
  const wrap = $('#lifeSurvivalCurve');
  if (!wrap) return;
  const c = STATE.life.countryData;
  if (!c) return;
  const isEn = LANG === 'en';
  const sex = STATE.life.sex;
  const lifeExp = c.le || 70;
  // 計算國家男性的存活曲線（簡化 Gompertz）
  const lt = lifeTable(c, sex);
  const W = 500, H = 180;
  const maxAge = 100;
  const points = [];
  let surv = 1.0;
  for (let a = 0; a <= maxAge; a += 2) {
    points.push([a, surv]);
    surv *= (1 - lt.q[Math.min(a, 110)]);
  }
  const worldPoints = [];
  let wsurv = 1.0;
  // 世界平均：使用通用生命表 (UN WPP world)
  for (let a = 0; a <= maxAge; a += 2) {
    // 簡化世界 Gompertz：平均壽命 73 歲
    const wq = Math.exp(-Math.exp(0.1 * (a - 75))) * 0.0008;
    wsurv *= (1 - Math.min(0.5, wq));
    worldPoints.push([a, wsurv]);
  }
  // 縮放 + 平移
  const proj = (a, s) => [40 + (a/maxAge) * (W-50), H-30 - s * (H-50)];
  let path = `M ${proj(points[0][0], points[0][1])[0]} ${proj(points[0][0], points[0][1])[1]}`;
  for (let i = 1; i < points.length; i++) {
    path += ` L ${proj(points[i][0], points[i][1])[0]} ${proj(points[i][0], points[i][1])[1]}`;
  }
  let worldPath = `M ${proj(worldPoints[0][0], worldPoints[0][1])[0]} ${proj(worldPoints[0][0], worldPoints[0][1])[1]}`;
  for (let i = 1; i < worldPoints.length; i++) {
    worldPath += ` L ${proj(worldPoints[i][0], worldPoints[i][1])[0]} ${proj(worldPoints[i][0], worldPoints[i][1])[1]}`;
  }
  // 自己的位置
  const myAge = STATE.life.age;
  let mySurv = 1;
  for (let a = 0; a < Math.min(myAge, 110); a++) mySurv *= (1 - lt.q[a]);
  const myPos = proj(myAge, mySurv);
  const avgPoint = proj(lifeExp, 0.5);
  wrap.innerHTML = `
    <h4>📉 ${isEn ? 'Survival curve' : LANG === 'fr' ? "Courbe de survie" : '存活曲線'} <span class="muted">${isEn ? '% still alive at each age' : LANG === 'fr' ? "% encore en vie à chaque âge" : '同年出生的人當中仍存活的比例'}</span></h4>
    <svg viewBox="0 0 ${W} ${H}" class="survival-svg" style="width:100%;height:auto;">
      <rect x="0" y="0" width="${W}" height="${H}" fill="#faf7f0"/>
      <line x1="40" y1="${H-30}" x2="${W-10}" y2="${H-30}" stroke="#999" stroke-width="1"/>
      <line x1="40" y1="20" x2="40" y2="${H-30}" stroke="#999" stroke-width="1"/>
      <text x="${W-12}" y="${H-32}" font-size="9" fill="#666" text-anchor="end">${isEn ? 'Age':LANG === 'fr' ? 'Âge' : '年齡'}</text>
      <text x="32" y="22" font-size="9" fill="#666" text-anchor="end">100%</text>
      <text x="32" y="${H-32}" font-size="9" fill="#666" text-anchor="end">0%</text>
      <text x="42" y="${H-15}" font-size="8" fill="#999">0</text>
      <text x="${W/2}" y="${H-15}" font-size="8" fill="#999" text-anchor="middle">${Math.round(maxAge/2)}</text>
      <text x="${W-12}" y="${H-15}" font-size="8" fill="#999" text-anchor="end">${maxAge}</text>
      <path d="${worldPath}" fill="none" stroke="#999" stroke-width="1.5" stroke-dasharray="4 3"/>
      <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2"/>
      ${myAge <= maxAge ? `<circle cx="${myPos[0]}" cy="${myPos[1]}" r="5" fill="#ff8800" stroke="white" stroke-width="2"/>` : ''}
      <circle cx="${avgPoint[0]}" cy="${avgPoint[1]}" r="4" fill="white" stroke="#666" stroke-width="1.5"/>
      <g font-size="9" fill="#5a4a3a">
        <rect x="${W-130}" y="6" width="120" height="36" fill="white" stroke="#d8cdb8"/>
        <line x1="${W-122}" y1="16" x2="${W-110}" y2="16" stroke="var(--accent)" stroke-width="2"/>
        <text x="${W-105}" y="19">${c.flag} ${localize(c).name}</text>
        <line x1="${W-122}" y1="28" x2="${W-110}" y2="28" stroke="#999" stroke-width="1.5" stroke-dasharray="3 2"/>
        <text x="${W-105}" y="31">🌐 ${isEn?'World avg':LANG === 'fr' ? "Moyenne mondiale" : '世界平均'}</text>
      </g>
    </svg>
    <p class="muted">${LANG === 'fr' ? "Cadre extérieur = espérance de vie moyenne du pays" : isEn?'Outer box = average life expectancy in this country':'外框格 = '+c.flag+(localize(c).name)+' 平均壽命 '+lifeExp+t('unit.years')}</p>
  `;
}

/* v5.18：護照格式身分紀錄（1in8b.life 風格） */
function renderIdentityRecord() {
  if (!STATE.life) return;
  const wrap = $('#lifeIdentityRecord');
  if (!wrap) return;
  const life = STATE.life;
  const isEn = LANG === 'en';
  const surname = (life.name?.full || '').slice(0, 1);
  const givenName = (life.name?.full || '').slice(1);
  // MRZ-like format
  const mrz = `I<${life.country || 'XXX'}${surname.toUpperCase().padEnd(5)}<<${givenName.toUpperCase().padEnd(44)}<`.slice(0, 44);
  const year = life.year + life.yearOffset;
  const mm = String(Math.floor(Math.random()*12)+1).padStart(2, '0');
  const dd = String(Math.floor(Math.random()*28)+1).padStart(2, '0');
  const exp = String((year + 10) % 100).padStart(2, '0') + String(Math.floor(Math.random()*12)+1).padStart(2, '0') + String(Math.floor(Math.random()*28)+1).padStart(2, '0');
  wrap.innerHTML = `
    <h4>🛂 ${isEn ? 'Identity Record' : LANG === 'fr' ? "Fiche d'identité" : '身分紀錄'} <span class="muted">${life.country || ''} · ${life.regNumber || ''}</span></h4>
    <pre class="mrz-line">${mrz}${life.name?.full_en?.toUpperCase().replace(/[^A-Z]/g,'').padEnd(20,'<').slice(0,20) || ''}</pre>
    <pre class="mrz-line">${year}${mm}${dd}${life.sex}${exp}${life.country || 'XXX'}</pre>
    <div class="ir-meta">${surname} ${givenName} · ${life.sex === 'M' ? (isEn?'Male':LANG === 'fr' ? 'Homme' : '男') : (isEn?'Female':LANG === 'fr' ? 'Femme' : '女')} · ${year}/${life.regNumber?.split('-').pop() || ''}</div>
  `;
}

function renderFamilySummary() {
  const wrap = $('#certFamilyBody');
  const goBtn = $('#certFamilyGo');
  if (!wrap) return;
  if (!STATE.life || !STATE.life.family) { wrap.innerHTML = ''; return; }
  const f = STATE.life.family;
  const parts = [];
  // 父母
  const father = f.parents.find(p => p.sex === 'M');
  const mother = f.parents.find(p => p.sex === 'F');
  if (father && mother) parts.push(`👨 ${father.name} · 👩 ${mother.name}`);
  else if (father) parts.push(`👨 ${father.name}`);
  else if (mother) parts.push(`👩 ${mother.name}`);
  else parts.push(`<span class="fam-orphan">${LANG==='en'?'🕯️ Orphan':LANG === 'fr' ? '🕯️ Orphelin(e)' : '🕯️ 孤兒'}</span>`);
  // 手足
  if (f.siblings && f.siblings.length) {
    const liveSib = f.siblings.filter(s => !s.death?.year);
    const deadSib = f.siblings.filter(s => s.death?.year);
    let sibText = `👫 ${f.siblings.length} ${LANG==='en'?'siblings':LANG === 'fr' ? (f.siblings.length > 1 ? "frères et sœurs" : "frère ou sœur") : '手足'}`;
    if (liveSib.length < f.siblings.length) sibText += `（${liveSib.length} ${LANG==='en'?'alive':LANG === 'fr' ? 'en vie' : '存'}，${deadSib.length} †）`;
    parts.push(sibText);
  }
  // 祖父母
  if (f.grandparents && f.grandparents.length) {
    parts.push(`👴👵 ${f.grandparents.length} ${LANG==='en'?'grandparents':LANG === 'fr' ? (f.grandparents.length > 1 ? 'grands-parents' : 'grand-parent') : '祖父母'}`);
  }
  // 伴侶
  if (f.partner) parts.push(`💍 ${f.partner.name}`);
  // 子女
  if (f.kids && f.kids.length) {
    const deadKids = f.kids.filter(k => k.death?.year);
    let kidText = `👶 ${f.kids.length} ${LANG==='en'?'children':LANG === 'fr' ? (f.kids.length > 1 ? 'enfants' : 'enfant') : '子女'}`;
    if (deadKids.length) kidText += `（${deadKids.length} †）`;
    parts.push(kidText);
  }
  // 收養/寄養
  if (f.fosterCare === 'adopt') parts.push(`<span class="fam-flag">🧩 ${LANG==='en'?'Adopted':LANG === 'fr' ? 'Adopté(e)' : '收養家庭'}</span>`);
  else if (f.fosterCare === 'foster') parts.push(`<span class="fam-flag">🏠 ${LANG==='en'?'Foster':LANG === 'fr' ? "Famille d'accueil" : '寄養家庭'}</span>`);
  // 跨國遷徙
  if (STATE.life.birthOrigin) {
    parts.push(`<span class="fam-flag">${STATE.life.birthOrigin.flag}→${STATE.life.countryData.flag} ${LANG==='en'?'migrated':LANG === 'fr' ? 'a migré' : '遷徙'}</span>`);
  }
  wrap.innerHTML = parts.map(p => `<div class="fam-row">${p}</div>`).join('');
  if (goBtn) {
    goBtn.onclick = () => {
      document.querySelectorAll('.navbtn').forEach(b => { if (b.dataset.view === 'tree') b.click(); });
    };
  }
}

function jobLabel(j) {
  return ({none: t('job.none'), student: t('job.student'), employed: t('job.employed'), university: t('job.university'), retired: t('job.retired')})[j] || t('job.none');
}

function renderEnd() {
  if (!STATE.life) return;
  const life = STATE.life;
  const c = life.countryData;
  const loc = localize(c);
  $('#endCertTitle').textContent = t('end.cert_title');
  $('#endCountry').textContent = c.flag + ' ' + loc.name;
  $('#endBorn').textContent = life.year + '/' + t('event.born_in2', life.sex === 'M' ? t('sex.male') : t('sex.female'));
  $('#endAge').textContent = life.deathAge + ' ' + t('unit.years');
  $('#endCause').textContent = causeLabel(life.cause);
  { const ex = $('#endCauseEx'); if (ex) { ex.textContent = causeExamples(life.cause); ex.hidden = !ex.textContent; } }
  $('#endName').textContent = life.name.full || life.name.full_en || '—';
  $('#endPortrait').innerHTML = pixelPortraitSVG(life.countryData, life.age, life.sex);
  $('#endLe').textContent = t('end.lifespan_le', { age: life.deathAge, le: c.le });
  const past = loadPastLives();
  $('#endPastCount').textContent = past.length;
  // 證書（guilloche）
  const cert = $('#certCanvas');
  if (cert) {
    cert.innerHTML = drawGuilloche(680, 420);
  }
  // v5.20：死亡原因分析（本年 + 一生 Top 3）
  renderEndCauseAnalysis();
  // v5.78：這一生做過的決定
  renderEndDecisions();
  // v5.31：前世紀錄面板
  renderEndPastRecords(past);
}

/* v5.31：前世紀錄面板 — 顯示最近 5 段人生 + 全部操作按鈕 */
function renderEndPastRecords(past) {
  const wrap = $('#endPastRecords');
  const list = $('#endPastList');
  const meta = $('#endPastMeta');
  if (!wrap || !list) return;
  if (!past || past.length === 0) {
    list.innerHTML = `<div class="muted">—</div>`;
    if (meta) meta.textContent = '';
    return;
  }
  const avg = (past.reduce((s, p) => s + (p.age || 0), 0) / past.length).toFixed(1);
  if (meta) meta.textContent = LANG === 'fr' ? `${past.length} vie(s) · ${avg} ans en moyenne` : `${past.length} 段 · 平均 ${avg} 歲`;
  list.innerHTML = past.slice(0, 5).map((p, i) => `
    <div class="pr-row" data-i="${i}">
      <div class="pr-info">
        <strong>${p.name || '—'}</strong>
        <span class="muted">${p.country || '—'} · ${LANG === 'fr' ? (p.sex === 'M' ? 'H' : (p.sex === 'F' ? 'F' : '?')) : (p.sex === 'M' ? '男' : (p.sex === 'F' ? '女' : '?'))} · ${p.age || 0} ${t('unit.years')} · ${causeLabel(p.cause) || '—'}</span>
      </div>
      <div class="pr-actions">
        <button class="ghost pr-replay" data-i="${i}">↻ ${LANG === 'fr' ? 'Revoir' : '再看一次'}</button>
        <button class="ghost pr-del" data-i="${i}">🗑️</button>
      </div>
    </div>
  `).join('');
  list.querySelectorAll('.pr-replay').forEach(b => b.addEventListener('click', () => {
    const i = +b.dataset.i;
    const ls = loadPastLives();
    const lifeData = ls[i];
    if (lifeData && lifeData.full) {
      STATE.life = lifeData.full;
      STATE.view = 'end';
      setView('end');
    } else {
      showLifeModal(ls[i]);
    }
  }));
  list.querySelectorAll('.pr-del').forEach(b => b.addEventListener('click', () => {
    const i = +b.dataset.i;
    const ls = loadPastLives();
    ls.splice(i, 1);
    localStorage.setItem(STORAGE_KEY + ':past', JSON.stringify(ls));
    renderEnd();
  }));
}

function drawGuilloche(w, h) {
  // 簡化 guilloche：多個同心橢圓 + 文字水印
  const cx = w / 2, cy = h / 2;
  let svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg" style="position:absolute;top:0;left:0;pointer-events:none;opacity:0.08;">`;
  for (let r = 30; r < w; r += 18) {
    const rx = r, ry = r * 0.6;
    svg += `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="#8C1D3C" stroke-width="0.5" />`;
  }
  for (let r = 24; r < w; r += 22) {
    const rx = r, ry = r * 0.5;
    svg += `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="#0F6E68" stroke-width="0.4" />`;
  }
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4;
    const x = cx + Math.cos(a) * 200;
    const y = cy + Math.sin(a) * 100;
    svg += `<text x="${x}" y="${y}" text-anchor="middle" font-size="10" fill="#8C1D3C" transform="rotate(${a*180/Math.PI} ${x} ${y})">${escapeHtml(t('brand'))}</text>`;
  }
  svg += `</svg>`;
  return svg;
}

function portraitFor(age, sex) {
  if (age < 5) return sex === 'M' ? '👶🏻' : '👶🏻';
  if (age < 18) return sex === 'M' ? '👦' : '👧';
  if (age < 60) return sex === 'M' ? '🧑' : '👩';
  return sex === 'M' ? '👴' : '👵';
}

// 依國家 + 年齡 + 性別生成 SVG 像素頭像
function pixelPortraitSVG(country, age, sex) {
  const region = country?.region || 'eap';
  const skinMap = {
    'eap': '#f0d5b1', 'sa': '#c8a47c', 'eca': '#fde0c8', 'mena': '#e0c098',
    'ssa': '#704020', 'lac': '#d4a574', 'na': '#f0d5b1', 'hi': '#f0d5b1',
  };
  const skin = skinMap[region] || '#f0d5b1';
  const hairMap = {
    'eap': '#1a1a1a', 'sa': '#0a0a0a', 'eca': '#3a2410', 'mena': '#1a0a05',
    'ssa': '#0a0a0a', 'lac': '#1a0a05', 'na': '#3a2410', 'hi': '#3a2410',
  };
  const hair = hairMap[region] || '#1a1a1a';
  const stage = age < 5 ? 'baby' : age < 12 ? 'child' : age < 18 ? 'teen' : age < 60 ? 'adult' : 'elder';
  const W = 200, H = 200, cx = W/2, cy = H/2;
  const headSizes = { baby: 90, child: 80, teen: 70, adult: 70, elder: 75 };
  const hr = headSizes[stage] / 2;
  const parts = [];
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${W*0.45}" fill="#f5efe2"/>`);
  parts.push(`<circle cx="${cx}" cy="${cy - 10}" r="${hr}" fill="${skin}"/>`);
  if (stage === 'baby') {
    parts.push(`<ellipse cx="${cx}" cy="${cy - 10 - hr + 8}" rx="${hr - 10}" ry="8" fill="${hair}"/>`);
  } else if (stage === 'child') {
    parts.push(`<path d="M ${cx - hr + 5} ${cy - 10 - hr + 5} Q ${cx} ${cy - 10 - hr - 10} ${cx + hr - 5} ${cy - 10 - hr + 5} L ${cx + hr - 5} ${cy - 10 - hr + 25} L ${cx - hr + 5} ${cy - 10 - hr + 25} Z" fill="${hair}"/>`);
  } else if (stage === 'teen') {
    parts.push(`<path d="M ${cx - hr + 3} ${cy - 10 - hr + 5} Q ${cx} ${cy - 10 - hr - 15} ${cx + hr - 3} ${cy - 10 - hr + 5} L ${cx + hr + 5} ${cy - 10 - hr + 30} L ${cx - hr - 5} ${cy - 10 - hr + 30} Z" fill="${hair}"/>`);
  } else {
    parts.push(`<path d="M ${cx - hr + 3} ${cy - 10 - hr + 5} Q ${cx} ${cy - 10 - hr - 18} ${cx + hr - 3} ${cy - 10 - hr + 5} L ${cx + hr + 8} ${cy - 10 - hr + 35} L ${cx - hr - 8} ${cy - 10 - hr + 35} Z" fill="${hair}"/>`);
    if (stage === 'elder') {
      parts.push(`<circle cx="${cx - 15}" cy="${cy - 10 - hr - 5}" r="2" fill="#cccccc"/>`);
      parts.push(`<circle cx="${cx + 18}" cy="${cy - 10 - hr - 3}" r="2" fill="#cccccc"/>`);
    }
  }
  if (stage === 'baby') {
    parts.push(`<circle cx="${cx - 12}" cy="${cy - 10}" r="3" fill="#1a1a1a"/>`);
    parts.push(`<circle cx="${cx + 12}" cy="${cy - 10}" r="3" fill="#1a1a1a"/>`);
  } else {
    parts.push(`<circle cx="${cx - 14}" cy="${cy - 8}" r="2.5" fill="#1a1a1a"/>`);
    parts.push(`<circle cx="${cx + 14}" cy="${cy - 8}" r="2.5" fill="#1a1a1a"/>`);
  }
  if (stage === 'baby') {
    parts.push(`<path d="M ${cx - 6} ${cy + 12} Q ${cx} ${cy + 8} ${cx + 6} ${cy + 12}" stroke="#1a1a1a" stroke-width="1.5" fill="none"/>`);
  } else if (stage === 'elder') {
    parts.push(`<path d="M ${cx - 8} ${cy + 10} Q ${cx} ${cy + 18} ${cx + 8} ${cy + 10}" stroke="#1a1a1a" stroke-width="1.5" fill="none"/>`);
  } else {
    parts.push(`<path d="M ${cx - 6} ${cy + 12} Q ${cx} ${cy + 16} ${cx + 6} ${cy + 12}" stroke="#1a1a1a" stroke-width="1.5" fill="none"/>`);
  }
  if (country?.flag) {
    parts.push(`<text x="8" y="${H-8}" font-size="30">${country.flag}</text>`);
  }
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="display:block;margin:0 auto;">${parts.join('')}</svg>`;
}

function renderShelf() {
  const shelf = $('#shelfGrid');
  if (!shelf) return;
  const lives = loadPastLives();
  shelf.innerHTML = '';
  // 頂部加「家族全景圖」按鈕
  if (lives.length > 1) {
    const btn = document.createElement('div');
    btn.className = 'shelf-panorama';
    btn.innerHTML = `<button class="primary" id="shelfPanoramaBtn">🌐 ${t('shelf.panorama') || '家族全景圖'}</button><p class="muted">${t('shelf.panoramaSub') || '合併 ' + lives.length + ' 段人生，找出共同親屬'}</p>`;
    shelf.appendChild(btn);
    btn.querySelector('#shelfPanoramaBtn').addEventListener('click', () => renderPanorama(lives));
  }
  // 世界地圖：標出歷來人生去過的國家
  if (lives.length > 0) {
    const worldWrap = document.createElement('div');
    worldWrap.className = 'shelf-world';
    worldWrap.appendChild(renderShelfWorldMap(lives));
    shelf.appendChild(worldWrap);
  }
  // v5.81：書架書本也是無上限的 — 37 本 = 2738px，50 本（savePastLife 的上限）
  // 會到 3700px。書本比較小，先顯示 12 本再逐批展開。
  const BOOK_PAGE = 12;
  const shownBooks = STATE.shelfShown || BOOK_PAGE;
  for (const life of lives.slice(0, shownBooks)) {
    const c = countryById(life.country);
    const flag = c ? c.flag : '🏳️';
    const book = document.createElement('div');
    book.className = 'shelf-book';
    book.innerHTML = `
      <div class="shelf-cover">
        <div class="shelf-flag">${flag}</div>
        <div class="shelf-spine"></div>
        <div class="shelf-info">
          <div class="shelf-name">${life.name || '—'}</div>
          <div class="shelf-meta">${life.age} ${t('unit.years')} · ${flag}</div>
        </div>
      </div>
    `;
    book.title = `${life.name} · ${causeLabel(life.cause)}`;
    book.addEventListener('click', () => showLifeModal(life));
    shelf.appendChild(book);
    // v5.22：右鍵 / long-press 觸發「繼續這段人生」選單（雙擊 = 從當年齡接續）
    let clickTime = 0;
    book.addEventListener('dblclick', () => continueOldLife(life));
  }
  // v5.81：書本「看更多 / 收合」
  if (lives.length > BOOK_PAGE) {
    const more = document.createElement('button');
    more.className = 'shared-more-btn';
    more.style.gridColumn = '1/-1';
    if (shownBooks >= lives.length) {
      more.textContent = t('shared.less');
      more.addEventListener('click', () => { STATE.shelfShown = BOOK_PAGE; renderShelf(); });
    } else {
      more.textContent = t('shared.more', { n: Math.min(BOOK_PAGE, lives.length - shownBooks), left: lives.length - shownBooks });
      more.addEventListener('click', () => {
        STATE.shelfShown = Math.min(lives.length, shownBooks + BOOK_PAGE);
        renderShelf();
      });
    }
    shelf.appendChild(more);
  }
  // v5.23：整理紀錄按鈕 + 音樂 toggle + PWA badges
  const manageWrap = document.createElement('div');
  manageWrap.className = 'shelf-manage';
  manageWrap.style.cssText = 'grid-column:1/-1;text-align:center;margin-top:12px;';
  manageWrap.innerHTML = `<button class="ghost" id="manageRecordsBtn">📋 ${LANG==='en'?'Manage records':LANG === 'fr' ? "Gérer les vies" : '整理紀錄'}</button> <button class="ghost" id="toggleMusicBtn" style="margin-left:6px;">♪ ${LANG==='en'?'Music':LANG === 'fr' ? 'Musique' : '音樂'}</button>`;
  shelf.appendChild(manageWrap);
  $('#manageRecordsBtn')?.addEventListener('click', showManageRecordsModal);
  $('#toggleMusicBtn')?.addEventListener('click', toggleBackgroundMusic);
  // v5.20：追思館（Memorial Wall） + 大家分享的人生
  renderMemorialWall(lives);
  renderSharedLives(lives);
}

/* v5.23：整理紀錄 modal — 列出 / 刪除 / 重新展開 */
function showManageRecordsModal() {
  const lives = loadPastLives();
  // v6.02：按鈕的 data-i 指的是這份快照的位置，點擊時要靠 ts 找回現存位置。
  const livesSnapshot = lives.slice();
  document.querySelector('#manageModal')?.remove();
  const isEn = LANG === 'en';
  const modal = document.createElement('div');
  modal.id = 'manageModal';
  modal.className = 'life-modal';
  modal.innerHTML = `
    <div class="life-modal-card" style="max-width:520px;">
      <button class="lm-close" onclick="document.getElementById('manageModal').remove()">×</button>
      <h2 class="lm-title">📋 ${isEn ? 'Manage Records' : LANG === 'fr' ? "Gérer les vies" : '紀錄整理'}</h2>
      <p class="muted" style="font-size:12px;">${isEn ? 'Show or delete each past life.':LANG === 'fr' ? "Afficher ou supprimer chaque vie passée." : '可逐本檢視或刪除過去的人生。'}</p>
      <div class="manage-list">
        ${lives.length === 0 ? '<span class="muted">—</span>' : lives.map((l, i) => `
          <div class="manage-row">
            <div class="manage-info">
              <strong>${l.name || '—'}</strong>
              <span class="muted">${l.year || '?'} – ${l.year + l.yearOffset} · ${l.age}${t('unit.years')} · ${l.cause || ''}</span>
            </div>
            <div class="manage-actions">
              <button class="ghost" data-act="show" data-i="${i}">${isEn?'Show':LANG === 'fr' ? 'Afficher' : '檢視'}</button>
              <button class="ghost" data-act="del" data-i="${i}">🗑️</button>
            </div>
          </div>
        `).join('')}
      </div>
      ${lives.length > 0 ? `<button class="ghost" id="manageClearAll" style="margin-top:8px;">🗑️ ${isEn?'Delete all':LANG === 'fr' ? "Tout supprimer" : '全部刪除'}</button>` : ''}
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  modal.querySelectorAll('button[data-act]').forEach(btn => {
    btn.addEventListener('click', () => {
      const renderIdx = +btn.dataset.i;
      const act = btn.dataset.act;
      const ls = loadPastLives();
      // v6.02：原本直接用 data-i 當 loadPastLives() 的索引。問題是按鈕的索引是
      // 「渲染當下」定下的，但 ls 是「點擊當下」才重新讀的。
      // 只要兩者之間紀錄數量變了（例如在另一處刪掉、或用另一個分頁刪掉），
      // idx 就會指向不存在的位置，ls[idx] 是 undefined，
      // showLifeModal(undefined) 會丟 TypeError，按了什麼反應都沒有。
      // 實測：渲染時 4 筆、點擊前剩 2 筆，按 data-i="3" → 無聲無息。
      //
      // 修法：用紀錄唯一的 ts 找回它在現存清單裡的位置，找不到就代表這筆已經被刪了。
      const target = livesSnapshot[renderIdx];
      let idx = target ? ls.findIndex(r => r.ts === target.ts) : -1;
      if (!target || idx < 0) {
        modal.remove();
        renderShelf();
        toast(isEn ? 'This record has already been deleted' : LANG === 'fr' ? "Cette vie a déjà été supprimée" : '這段紀錄已經被刪除了');
        return;
      }
      if (act === 'show') showLifeModal(ls[idx]);
      else if (act === 'del') {
        ls.splice(idx, 1);
        localStorage.setItem(STORAGE_KEY + ':past', JSON.stringify(ls));
        modal.remove();
        renderShelf();
        toast(isEn ? 'Life deleted' : LANG === 'fr' ? "Vie supprimée" : '已刪除');
      }
    });
  });
  $('#manageClearAll')?.addEventListener('click', () => {
    if (confirm(LANG==='en' ? 'Delete all past lives?' : LANG === 'fr' ? "Supprimer toutes les vies passées ?" : '刪除所有過去的人生？')) {
      localStorage.setItem(STORAGE_KEY + ':past', '[]');
      modal.remove();
      renderShelf();
      toast(LANG==='en' ? 'All deleted' : LANG === 'fr' ? "Tout est supprimé" : '已全部刪除');
    }
  });
}

/* v5.23：背景音樂（Web Audio API 簡單環境音） */
let bgMusic = null;
// Musique générée par le navigateur (aucun fichier audio) : gamme, rythme et timbre selon la région du pays.
// step = durée d'un pas en secondes ; mel = probabilité d'une note à chaque pas ; bass = demi-tons au-dessus de la tonique.
const MUSIC_STYLES = {
  namerica: { fr: 'Amérique du Nord', en: 'North America', root: 110, scale: [0,3,5,6,7,10], step: 0.30, swing: 0.62, wave: 'triangle', decay: 0.5, mel: [.9,.3,.6,.4,.8,.3,.6,.5], bass: [0,null,null,0,null,7,null,null] },
  lac:      { fr: 'Amérique latine', en: 'Latin America', root: 130.8, scale: [0,2,4,5,7,9,11], step: 0.27, wave: 'triangle', decay: 0.35, mel: [.8,.5,.3,.8,.5,.3,.8,.4], bass: [0,null,null,7,null,null,7,null] },
  europe:   { fr: 'Europe', en: 'Europe', root: 146.8, scale: [0,2,3,5,7,8,10], step: 0.33, wave: 'sine', decay: 0.9, mel: [.9,.3,.6,.3,.6,.3], bass: [0,null,7,null,7,null] },
  mena:     { fr: 'Moyen-Orient et Afrique du Nord', en: 'Middle East & North Africa', root: 146.8, scale: [0,1,4,5,7,8,10], step: 0.34, wave: 'sawtooth', decay: 0.45, drone: true, mel: [.9,.5,.4,.7,.8,.3,.7,.4], bass: [0,null,null,null,0,null,null,null] },
  africa:   { fr: 'Afrique subsaharienne', en: 'Sub-Saharan Africa', root: 174.6, scale: [0,2,4,7,9], step: 0.19, wave: 'sine', decay: 0.3, mel: [.8,.4,.7,.5,.7,.4,.8,.4,.7,.5,.7,.4], bass: [0,null,null,7,null,null,0,null,null,7,null,null] },
  sasia:    { fr: 'Asie du Sud', en: 'South Asia', root: 138.6, scale: [0,1,4,5,7,8,11], step: 0.42, wave: 'sawtooth', decay: 0.8, drone: true, mel: [.8,.3,.5,.3,.7,.3,.5,.4], bass: [] },
  easia:    { fr: "Asie de l'Est", en: 'East Asia', root: 196, scale: [0,2,4,7,9], step: 0.5, wave: 'triangle', decay: 1.3, mel: [.8,.2,.4,.2,.6,.2,.4,.2], bass: [0,null,null,null,null,null,null,null] },
};
function musicStyleKey(c) {
  if (!c) return 'europe';
  if (c.region === 'hi') {   // « revenu élevé » n'est pas une région géographique
    if (c.id === 'USA' || c.id === 'CAN') return 'namerica';
    if (['JPN', 'SGP', 'KOR', 'TWN', 'HKG', 'MAC'].includes(c.id)) return 'easia';
    return c.id === 'ISR' ? 'mena' : 'europe';
  }
  return ({ eap: 'easia', sa: 'sasia', eca: 'europe', mena: 'mena', ssa: 'africa', lac: 'lac' })[c.region] || 'europe';
}
function startMusic(key) {
  const st = MUSIC_STYLES[key] || MUSIC_STYLES.europe;
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const master = ctx.createGain(); master.gain.value = 0.14;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = st.wave === 'sawtooth' ? 1400 : 2600;
  const delay = ctx.createDelay(); delay.delayTime.value = st.step * 1.5;
  const fb = ctx.createGain(); fb.gain.value = 0.25;
  lp.connect(master); lp.connect(delay); delay.connect(fb); fb.connect(delay); fb.connect(master);
  master.connect(ctx.destination);
  const note = (freq, when, vol, dec, wave) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = wave; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(vol, when + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dec);
    o.connect(g).connect(lp); o.start(when); o.stop(when + dec + 0.05);
  };
  if (st.drone) [0.5, 0.75].forEach(m => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = st.root * m; g.gain.value = 0.12;
    o.connect(g).connect(lp); o.start();
  });
  const semi = n => Math.pow(2, n / 12);
  let i = 0, deg = st.scale.length, next = ctx.currentTime + 0.1;   // deg : position dans la gamme, sur deux octaves
  const timer = setInterval(() => {
    while (next < ctx.currentTime + 0.3) {
      const k = i % st.mel.length;
      const when = next + (st.swing && k % 2 ? (st.swing - 0.5) * 2 * st.step : 0);
      const b = st.bass[k];
      if (b != null) note(st.root / 2 * semi(b), when, 0.5, st.decay * 1.6, 'sine');
      if (Math.random() < st.mel[k]) {
        deg = Math.max(0, Math.min(st.scale.length * 2, deg + [-2, -1, -1, 0, 1, 1, 2][Math.floor(Math.random() * 7)]));
        note(st.root * 2 * semi(st.scale[deg % st.scale.length] + 12 * Math.floor(deg / st.scale.length)), when, 0.45, st.decay, st.wave);
      }
      i++; next += st.step;
    }
  }, 100);
  bgMusic = { ctx, timer, key };
}
function stopMusic() {
  if (!bgMusic) return;
  clearInterval(bgMusic.timer);
  try { bgMusic.ctx.close(); } catch (e) {}
  bgMusic = null;
}
function toggleBackgroundMusic() {
  if (bgMusic) {
    stopMusic();
    toast(LANG === 'en' ? '♪ Music off' : LANG === 'fr' ? "♪ Musique coupée" : '♪ 音樂已關閉');
    return;
  }
  try {
    const key = musicStyleKey(STATE.life && STATE.life.countryData);
    startMusic(key);
    const st = MUSIC_STYLES[key];
    toast(LANG === 'fr' ? '♪ Musique : ' + st.fr : LANG === 'en' ? '♪ Music: ' + st.en : '♪ 音樂已開啟');
  } catch (e) { toast('Audio not supported'); }
}

/* ==== Shelf 世界地圖 ==== */
function renderShelfWorldMap(lives) {
  const W = 720, H = 360;
  // 計算各國家被經歷次數 + 平均壽命
  const countryStats = {};
  lives.forEach(l => {
    if (!countryStats[l.country]) countryStats[l.country] = { count: 0, totalAge: 0, deaths: [] };
    countryStats[l.country].count++;
    countryStats[l.country].totalAge += l.age || 0;
    countryStats[l.country].deaths.push(l.cause);
  });
  // 經度→x: (lng + 180) / 360 * W; 緯度→y: (90 - lat) / 180 * H
  const proj = (lng, lat) => [((lng + 180) / 360) * W, ((90 - lat) / 180) * H];
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'world-map', style: 'max-width:100%;height:auto;background:var(--bg-3);border-radius:8px;' });
  // 大陸輪廓（簡化用矩形網格代替）
  const grid = svgEl('rect', { x: 0, y: 0, width: W, height: H, fill: '#dde6e8' }, svg);
  // 為每個經歷國家繪製點
  const visited = Object.keys(countryStats);
  const tooltipLines = [];
  visited.forEach(iso => {
    const coords = window.WORLD_COORDS && window.WORLD_COORDS[iso];
    if (!coords) return;
    const [lng, lat] = coords;
    const [x, y] = proj(lng, lat);
    const stat = countryStats[iso];
    const avgAge = (stat.totalAge / stat.count).toFixed(1);
    const c = countryById(iso);
    const flag = c ? c.flag : '🏳️';
    // 主圓點：依去過次數調整大小
    const r = 4 + Math.min(stat.count * 2, 12);
    const circle = svgEl('circle', { cx: x, cy: y, r, fill: 'var(--accent)', stroke: 'white', 'stroke-width': 1, opacity: 0.85 }, svg);
    circle.addEventListener('mouseenter', e => showMapTooltip(e, `${flag} ${(localize(c) || {}).name || iso}<br>${LANG==='en'?'Lived':LANG === 'fr' ? 'Vécu' : '活過'} ${stat.count} ${LANG==='en'?'lives':LANG === 'fr' ? 'vies' : '次'}, ${LANG==='en'?'avg':LANG === 'fr' ? 'moyenne' : '平均'} ${avgAge} ${t('unit.years')}`));
    circle.addEventListener('mouseleave', hideMapTooltip);
    // 國旗 emoji 標記
    const flagText = svgEl('text', { x: x, y: y - r - 4, 'font-size': 12, 'text-anchor': 'middle' }, svg);
    flagText.textContent = flag;
    tooltipLines.push(`${flag} ${(localize(c) || {}).name || iso}: ${stat.count} ${LANG==='en'?'times':LANG === 'fr' ? 'fois' : '次'}`);
  });
  // 圖例
  const legend = svgEl('text', { x: 8, y: H - 8, 'font-size': 10, fill: '#5a4a3a' }, svg);
  legend.textContent = `${LANG==='en'?'Lived in':LANG === 'fr' ? "A vécu dans" : '曾活過'} ${visited.length} ${LANG==='en'?'countries':LANG === 'fr' ? 'pays' : '個國家'}`;
  return svg;
}

/* ==== v5.20：追思館 (Memorial Wall) ==== */
let _memorialIdx = 0;
function getMemorialState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY + ':memorial_state');
    if (!raw) return { candlesByLife: {}, heartsByLife: {} };
    return JSON.parse(raw);
  } catch (e) {
    return { candlesByLife: {}, heartsByLife: {} };
  }
}
function saveMemorialState(s) {
  try {
    localStorage.setItem(STORAGE_KEY + ':memorial_state', JSON.stringify(s));
  } catch (e) { /* quota exceeded */ }
}
function lifeMemorialId(life) {
  // 用生命唯一識別：country|year|name|age|cause hash
  const base = `${life.country || '?'}|${life.year || '?'}|${life.name || '?'}|${life.age || '?'}|${life.cause || '?'}`;
  let h = 0;
  for (let i = 0; i < base.length; i++) h = ((h << 5) - h) + base.charCodeAt(i) | 0;
  return 'm_' + (h >>> 0).toString(36);
}
function getLifeSummary(life) {
  // 一句總結：取一個有意義的 quote，或用一句合成
  if (!life) return '';
  const quotes = life.quotes || {};
  const ages = Object.keys(quotes).map(Number).sort((a, b) => a - b);
  for (const a of ages) {
    const q = (quotes[a] || '').trim();
    if (q && q !== '（自動抉擇）' && q !== '（隱蔽）') return q;
  }
  const c = countryById(life.country);
  const loc = localize(c);
  const flag = c ? c.flag : '🏳️';
  const cause = life.cause || '';
  const age = life.age || '?';
  if (LANG === 'en') return `Lived ${age} years in ${flag} ${loc?.name || ''}. ${cause ? 'Cause: ' + cause + '.' : ''}`;
  if (LANG === 'fr') return `A vécu ${age} ans, ${flag} ${loc?.name || ''}. ${cause ? 'Cause : ' + causeLabel(cause) + '.' : ''}`;
  return `在 ${flag} ${loc?.name || ''} 活了 ${age} 歲。${cause ? '原因：' + cause + '。' : ''}`;
}
function getLifeOneLine(life) {
  // 短摘：用第一個非空 quote
  if (!life) return '';
  const quotes = life.quotes || {};
  const ages = Object.keys(quotes).map(Number).sort((a, b) => a - b);
  for (const a of ages) {
    const q = (quotes[a] || '').trim();
    if (q && q !== '（自動抉擇）' && q !== '（隱蔽）') return q;
  }
  return '';
}
function getLifeStory(life) {
  // 完整故事：所有 quote 串起來 + 重大事件
  if (!life) return '';
  const quotes = life.quotes || {};
  const ages = Object.keys(quotes).map(Number).sort((a, b) => a - b);
  const lines = [];
  for (const a of ages) {
    const q = (quotes[a] || '').trim();
    if (q && q !== '（自動抉擇）' && q !== '（隱蔽）') {
      lines.push(`【${a}${t('unit.years')}】${q}`);
    }
  }
  if (lines.length === 0) {
    if (LANG === 'en') return '(No words left behind.)';
    return LANG === 'fr' ? '(aucun mot laissé)' : '（沒有留下任何話）';
  }
  return lines.join('\n');
}
function renderMemorialWall(lives) {
  const wall = $('#memorialWall');
  if (!wall) return;
  if (!lives || lives.length === 0) {
    wall.querySelector('.memorial-empty').hidden = false;
    wall.querySelector('.memorial-content').hidden = true;
    return;
  }
  wall.querySelector('.memorial-empty').hidden = true;
  wall.querySelector('.memorial-content').hidden = false;
  if (_memorialIdx >= lives.length) _memorialIdx = 0;
  const life = lives[_memorialIdx];
  const c = countryById(life.country);
  const flag = c ? c.flag : '🏳️';
  const loc = localize(c);
  const card = $('#memorialCard');
  if (!card) return;
  const summary = getLifeSummary(life);
  const state = getMemorialState();
  const id = lifeMemorialId(life);
  const candles = state.candlesByLife[id] || 0;
  const hearts = state.heartsByLife[id] || 0;
  card.innerHTML = `
    <div class="memorial-candle-display">
      ${candles > 0 ? `<span class="candle-flame">🕯️×${candles}</span>` : ''}
    </div>
    <div class="memorial-card-content">
      <div class="memorial-flag">${flag}</div>
      <div class="memorial-name">${escapeHtml(life.name || '—')}</div>
      <div class="memorial-years">${life.year || ''} → ${(life.year || 0) + (life.yearOffset || 0)} · ${life.age || '?'} ${t('unit.years')}</div>
      <div class="memorial-country">${escapeHtml(loc?.name || life.country || '?')}</div>
      <div class="memorial-summary">${escapeHtml(summary)}</div>
    </div>
  `;
  // 計數
  const cn = $('#memorialCandles');
  const hn = $('#memorialHearts');
  if (cn) cn.textContent = candles > 0 ? `🕯️ ${t('memorial.candles', candles)}` : '';
  if (hn) hn.textContent = hearts > 0 ? `🤍 ${t('memorial.hearts', hearts)}` : '';
  $('#memorialCounter').textContent = `${_memorialIdx + 1} / ${lives.length}`;
  // 按鈕事件（綁定一次即可，但每次重渲染時重新綁以保證指向當前 life）
  const lifeRef = life;
  const bind = (sel, fn) => {
    const el = $(sel);
    if (!el) return;
    el.onclick = () => fn(lifeRef, id);
  };
  bind('#memorialPrev', (l) => {
    _memorialIdx = (_memorialIdx - 1 + lives.length) % lives.length;
    renderMemorialWall(lives);
  });
  bind('#memorialNext', (l) => {
    _memorialIdx = (_memorialIdx + 1) % lives.length;
    renderMemorialWall(lives);
  });
  bind('#memorialCandle', (l, mid) => {
    const s = getMemorialState();
    s.candlesByLife[mid] = (s.candlesByLife[mid] || 0) + 1;
    saveMemorialState(s);
    renderMemorialWall(lives);
    toast(LANG === 'en' ? 'A candle lit 🕯️' : LANG === 'fr' ? "Une bougie allumée 🕯️" : '已點一支蠟燭 🕯️', 1500);
  });
  bind('#memorialHeart', (l, mid) => {
    const s = getMemorialState();
    s.heartsByLife[mid] = (s.heartsByLife[mid] || 0) + 1;
    saveMemorialState(s);
    renderMemorialWall(lives);
    toast(LANG === 'en' ? 'Kept in heart 🤍' : LANG === 'fr' ? "Gardé en mémoire 🤍" : '已記在心裡 🤍', 1500);
  });
  bind('#memorialVisit', (l) => showLifeModal(l));
  bind('#memorialRandom', () => {
    if (lives.length > 1) {
      let ni;
      do { ni = Math.floor(Math.random() * lives.length); } while (ni === _memorialIdx && lives.length > 1);
      _memorialIdx = ni;
      renderMemorialWall(lives);
    }
  });
}

/* ==== v5.20：大家分享的人生 (Shared Lives Feed) ==== */
function getSharedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY + ':shared_state');
    if (!raw) return { heartsByLife: {}, reportedByLife: {} };
    return JSON.parse(raw);
  } catch (e) {
    return { heartsByLife: {}, reportedByLife: {} };
  }
}
function saveSharedState(s) {
  try {
    localStorage.setItem(STORAGE_KEY + ':shared_state', JSON.stringify(s));
  } catch (e) { /* quota */ }
}
function renderSharedLives(lives) {
  const wrap = $('#sharedFeed');
  if (!wrap) return;
  if (!lives || lives.length === 0) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  const list = $('#sharedList');
  if (!list) return;
  list.innerHTML = '';
  const state = getSharedState();
  // v5.80：過去人生一多，這一區會長到 7000px 以上（實測 34 條 = 7101px）。
  // 先顯示前 SHARED_PAGE 張，其餘按「看更多」逐批展開。
  const SHARED_PAGE = 8;
  const shown = STATE.sharedShown || SHARED_PAGE;
  const slice = lives.slice(0, shown);

  slice.forEach((life) => {
    const c = countryById(life.country);
    const flag = c ? c.flag : '🏳️';
    const loc = localize(c);
    const id = lifeMemorialId(life);
    const oneLine = getLifeOneLine(life);
    const fullStory = getLifeStory(life);
    const hearts = state.heartsByLife[id] || 0;
    const reported = !!state.reportedByLife[id];
    const sexLabel = life.sex === 'M' ? t('sex.male') : t('sex.female');
    const card = document.createElement('div');
    card.className = 'shared-card';
    card.dataset.id = id;
    card.innerHTML = `
      <div class="shared-head">
        <span class="shared-flag">${flag}</span>
        <div>
          <div class="shared-name">${escapeHtml(life.name || '—')}</div>
          <div class="shared-meta">${escapeHtml(loc?.name || life.country || '?')} · ${sexLabel} · ${life.age || '?'} ${t('unit.years')}</div>
        </div>
      </div>
      <div class="shared-quote ${oneLine ? '' : 'shared-empty'}">${oneLine ? escapeHtml(oneLine) : (LANG==='en'?'(no words left behind)':LANG === 'fr' ? "(aucun mot laissé)" : '（沒有留下任何話）')}</div>
      <div class="shared-story" data-story>${escapeHtml(fullStory).replace(/\n/g, '<br/>')}</div>
      <div class="shared-actions">
        <button class="shared-action-btn heart ${hearts > 0 ? 'active' : ''}" data-act="heart">${hearts > 0 ? '♥' : '♡'} ${hearts > 0 ? hearts : ''} ${LANG==='en'?'Keep in heart':LANG === 'fr' ? "Garder en mémoire" : '記在心裡'}</button>
        <button class="shared-action-btn report ${reported ? 'active' : ''}" data-act="report">${reported ? '✓' : '⚐'} ${LANG==='en'?'Report':LANG === 'fr' ? 'Signaler' : '檢舉'}</button>
        <button class="shared-expand-btn" data-act="expand">${LANG==='en'?'Expand ▼':LANG === 'fr' ? 'Déplier ▼' : '展開 ▼'}</button>
      </div>
    `;
    // 事件
    card.querySelector('[data-act="heart"]').addEventListener('click', (e) => {
      e.stopPropagation();
      const s = getSharedState();
      s.heartsByLife[id] = (s.heartsByLife[id] || 0) + 1;
      saveSharedState(s);
      renderSharedLives(lives);
    });
    card.querySelector('[data-act="report"]').addEventListener('click', (e) => {
      e.stopPropagation();
      const s = getSharedState();
      if (!s.reportedByLife[id]) {
        s.reportedByLife[id] = Date.now();
        saveSharedState(s);
        toast(t('shared.reported'));
      }
      renderSharedLives(lives);
    });
    card.querySelector('[data-act="expand"]').addEventListener('click', (e) => {
      e.stopPropagation();
      const story = card.querySelector('[data-story]');
      const isExpanded = story.classList.toggle('expanded');
      e.currentTarget.textContent = isExpanded
        ? (LANG === 'en' ? '▲ Collapse' : LANG === 'fr' ? '▲ Replier' : '▲ 收合')
        : (LANG === 'en' ? 'Expand ▼' : LANG === 'fr' ? 'Déplier ▼' : '展開 ▼');
    });
    list.appendChild(card);
  });

  // v5.80：剩餘的按「看更多」逐批展開
  if (lives.length > shown) {
    const more = document.createElement('button');
    more.className = 'shared-more-btn';
    more.textContent = t('shared.more', { n: Math.min(SHARED_PAGE, lives.length - shown), left: lives.length - shown });
    more.addEventListener('click', () => {
      STATE.sharedShown = Math.min(lives.length, shown + SHARED_PAGE);
      renderSharedLives(lives);
    });
    list.appendChild(more);
  } else if (shown > SHARED_PAGE) {
    const less = document.createElement('button');
    less.className = 'shared-more-btn';
    less.textContent = t('shared.less');
    less.addEventListener('click', () => {
      STATE.sharedShown = SHARED_PAGE;
      renderSharedLives(lives);
    });
    list.appendChild(less);
  }
}

/* ==== v5.20：現在居住的地方 (Active Players Map, intro) ==== */
function renderActivePlayersMap() {
  const wrap = $('#introPlayersMap');
  if (!wrap) return;
  // 收集目前「進行中」的 life：來自 STATE.life（若有）以及任何未死的 pastLives
  const points = [];
  if (STATE.life && !STATE.life.died) {
    const c = countryById(STATE.life.country);
    if (c) {
      points.push({
        country: STATE.life.country,
        flag: c.flag,
        name: STATE.life.name?.full || STATE.life.name?.full_en || '—',
        age: STATE.life.age,
        sex: STATE.life.sex,
        active: true
      });
    }
  }
  // 過去 lives 中若 died 為 false 也算 active（理論上 loadPastLives 只存死亡，保留相容）
  const past = loadPastLives();
  past.forEach(l => {
    if (!l.died) {
      const c = countryById(l.country);
      if (c) {
        points.push({
          country: l.country,
          flag: c.flag,
          name: l.name,
          age: l.age,
          sex: l.sex,
          active: false
        });
      }
    }
  });
  if (points.length === 0) {
    wrap.innerHTML = `<div class="players-empty">${t('intro.players.empty')}</div>`;
    return;
  }
  const W = 720, H = 360;
  const proj = (lng, lat) => [((lng + 180) / 360) * W, ((90 - lat) / 180) * H];
  const svg = svgEl('svg', {
    viewBox: `0 0 ${W} ${H}`,
    class: 'world-map',
    style: 'max-width:100%;height:auto;background:var(--bg-3);border-radius:8px;'
  });
  svgEl('rect', { x: 0, y: 0, width: W, height: H, fill: '#dde6e8' }, svg);
  // 已去過國家（過去 lives）淡化顯示
  const pastCountries = new Set(past.map(l => l.country));
  const tooltipLines = [];
  // 畫目前進行中（亮）
  points.forEach(p => {
    const coords = window.WORLD_COORDS && window.WORLD_COORDS[p.country];
    if (!coords) return;
    const [lng, lat] = coords;
    const [x, y] = proj(lng, lat);
    const r = p.active ? 6 : 4;
    const circle = svgEl('circle', {
      cx: x, cy: y, r,
      fill: p.active ? '#c2185b' : '#8C1D3C',
      stroke: 'white', 'stroke-width': 1.5,
      opacity: p.active ? 1 : 0.7
    }, svg);
    circle.addEventListener('mouseenter', e => showMapTooltip(e, `${p.flag} ${escapeHtml(p.name)}<br>${LANG==='en'?'Age':LANG === 'fr' ? 'Âge' : '年齡'} ${p.age}${LANG===''?' ':' '}<br>${p.active ? (LANG==='en'?'● Active':LANG === 'fr' ? '● En cours' : '● 進行中') : (LANG==='en'?'○ Past':LANG === 'fr' ? '○ Passées' : '○ 過去')}`));
    circle.addEventListener('mouseleave', hideMapTooltip);
    const flagText = svgEl('text', { x, y: y - r - 4, 'font-size': 12, 'text-anchor': 'middle' }, svg);
    flagText.textContent = p.flag;
  });
  // 圖例
  const legend = svgEl('text', { x: 8, y: H - 8, 'font-size': 10, fill: '#5a4a3a' }, svg);
  legend.textContent = `${LANG==='en'?'Active lives':LANG === 'fr' ? "Vies en cours" : '進行中人生'} ${points.length}${LANG===''?'':' '}${LANG==='en'?'/ past countries':LANG === 'fr' ? "/ pays des vies passées" : '/ 過去國家'} ${pastCountries.size}`;
  wrap.innerHTML = '';
  wrap.appendChild(svg);
}

/* ==== v5.20：本年死因（life view） ==== */
function renderLifeCauseThisYear() {
  const wrap = $('#lifeCauseThisYear');
  if (!wrap || !STATE.life) return;
  const life = STATE.life;
  if (life.died) {
    // 已死：本年分析改用死因年齡
    const age = life.deathAge || life.age;
    const w = causeWeights(life.countryData, age, life.sex);
    const entries = Object.entries(w).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const total = entries.reduce((a, b) => a + b[1], 0);
    wrap.innerHTML = `
      <h4>⚖️ ${t('life.causeThisYear')}</h4>
      <div class="lcw-list">
        ${entries.map(([c, n]) => {
          const pct = total > 0 ? (n / total * 100).toFixed(1) : 0;
          return `<div class="lcw-row">
            <span class="lcw-name">${escapeHtml(causeLabel(c))}</span>
            <span class="lcw-bg"><span class="lcw-fi" style="width:${pct}%"></span></span>
            <span class="lcw-pct">${pct}%</span>
          </div>`;
        }).join('')}
      </div>
    `;
    return;
  }
  const age = life.age;
  const w = causeWeights(life.countryData, age, life.sex);
  const entries = Object.entries(w).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const total = entries.reduce((a, b) => a + b[1], 0);
  wrap.innerHTML = `
    <h4>${t('life.causeThisYear')}</h4>
    <p class="muted" style="font-size:11px;margin:0 0 8px;">${t('life.causeThisYearAge', age)}</p>
    <div class="lcw-list">
      ${entries.map(([c, n]) => {
        const pct = total > 0 ? (n / total * 100).toFixed(1) : 0;
        return `<div class="lcw-row">
          <span class="lcw-name">${escapeHtml(causeLabel(c))}</span>
          <span class="lcw-bg"><span class="lcw-fi" style="width:${pct}%"></span></span>
          <span class="lcw-pct">${pct}%</span>
        </div>`;
      }).join('')}
    </div>
  `;
}

/* ==== v5.20：一生主要死因 Top 3（end view） ==== */
function computeLifetimeCauses(life) {
  // 模擬每年 age→cause weights，整合為一生的死因分布
  if (!life) return { top: [], byAge: {} };
  const c = life.countryData;
  const sex = life.sex;
  const causeAccum = {};
  // Probabilité de mourir de chaque cause sur toute la vie : survivants à l'âge a × risque de décès × part de la cause.
  const lt = lifeTable(c, sex);
  for (let a = 0; a < 110; a++) {
    const dead = (lt.l[a] / lt.l[0]) * pDie(a, c, sex);
    if (!(dead > 0)) continue;
    const w = causeWeights(c, a, sex);
    const sum = Object.values(w).reduce((x, y) => x + y, 0);
    if (!(sum > 0)) continue;
    for (const [k, v] of Object.entries(w)) causeAccum[k] = (causeAccum[k] || 0) + dead * v / sum;
  }
  const total = Object.values(causeAccum).reduce((a, b) => a + b, 0);
  const sorted = Object.entries(causeAccum).sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 3).map(([k, v]) => ({ cause: k, pct: total > 0 ? (v / total * 100) : 0 }));
  return { top, byAge: causeAccum };
}
/* v5.78：訃聞頁的「你做過的決定」
   決策事件一直只寫進 life.log / life.decisions，訃聞頁完全沒有提到它們。
   這裡把一生做過的選擇整理出來，讓互動有回報。 */
const DECISION_KIND_LABEL = {
  big: 'dec.kind.big',
  small: 'dec.kind.small',
  family: 'dec.kind.family',
};
function renderEndDecisions() {
  const wrap = $('#endDecisions');
  if (!wrap || !STATE.life) return;
  const life = STATE.life;
  // 決定是在作答當下記下的，標籤也是那個時候的語言。
  // 如果玩家中途換語言，整塊用「當初記錄時的語言」呈現，避免清單跟著標題變、
  // 內容卻停在另一種語言。
  const recorded = (life.decisions || []).find(d => d && d.lang)?.lang;
  const prevLang = LANG;
  if (recorded && recorded !== LANG) { LANG = recorded; }
  try { renderEndDecisionsInner(wrap, life); }
  finally { if (recorded && recorded !== prevLang) LANG = prevLang; }
}

function renderEndDecisionsInner(wrap, life) {
  const decided = (life.decisions || []).filter(d => d && d.key && d.key !== 'skipped');
  const skipped = (life.decisions || []).filter(d => d && d.key === 'skipped');
  if (!decided.length && !skipped.length) {
    wrap.innerHTML = `<h3>${t('dec.end.title')}</h3><p class="muted">${t('dec.end.none')}</p>`;
    return;
  }
  // 用事件 id 找回當初的 label（choices 內的 icon / label 不存起來，這裡重建）
  const byId = {};
  for (const d of DECISIONS) byId[d.id] = d;
  const rows = decided.map(r => {
    // label / icon 在作答當下就存進紀錄了；舊紀錄沒有就退回事件 id
    const label = r.label || r.id;
    const icon = r.icon || '✦';
    // v6.04：把玩家自己寫的note顯示出來。
    // 舊碼在作答當下把 note 存進 life.decisions[]（showDecision 第 160 行），
    // 但整個檔案沒有任何地方讀它 —— 玩家被要求「寫下當時的想法」，
    // 寫完之後那個字再也沒有出現在畫面上，等於白寫。
    // （'（自動抉擇）'/'（隱蔽）' 是系統代填的，不是玩家寫的，不顯示。）
    const noteText = (r.note || '').trim();
    const showNote = noteText && noteText !== '（自動抉擇）' && noteText !== '（隱蔽）';
    return `<div class="ed-row">
      <span class="ed-age">${r.age ?? '?'}</span>
      <span class="ed-icon">${escapeHtml(icon)}</span>
      <span class="ed-text">${escapeHtml(label)}</span>
      ${showNote ? `<span class="ed-note">「${escapeHtml(noteText)}」</span>` : ''}
    </div>`;
  }).join('');

  const kindCount = {};
  for (const r of decided) {
    const k = byId[r.id]?.kind || 'small';
    kindCount[k] = (kindCount[k] || 0) + 1;
  }
  const chips = Object.entries(kindCount).map(([k, n]) =>
    `<span class="ed-chip ed-chip-${k}">${t(DECISION_KIND_LABEL[k] || k)} ${n}</span>`).join('');

  wrap.innerHTML = `
    <h3>${t('dec.end.title')}</h3>
    <p class="muted" style="font-size:12px;margin:0 0 10px;">${t('dec.end.count', { n: decided.length })}</p>
    <div class="ed-chips">${chips}${skipped.length ? `<span class="ed-chip ed-chip-skip">${t('dec.end.skipped', { n: skipped.length })}</span>` : ''}</div>
    <div class="ed-list">${rows}</div>`;
}

function renderEndCauseAnalysis() {
  const wrap = $('#endCauseAnalysis');
  if (!wrap || !STATE.life) return;
  const life = STATE.life;
  // 本年（死那年）死因
  const deathAge = life.deathAge || life.age;
  const yearW = causeWeights(life.countryData, deathAge, life.sex);
  const yearEntries = Object.entries(yearW).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const yearTotal = yearEntries.reduce((a, b) => a + b[1], 0);
  // 一生 top 3
  const { top } = computeLifetimeCauses(life);
  const isEn = LANG === 'en';
  wrap.innerHTML = `
    <h3>${isEn ? '⚖️ Death cause analysis' : LANG === 'fr' ? "⚖️ Analyse des causes de décès" : '⚖️ 死亡原因分析'}</h3>
    <div class="eca-section">
      <h4 style="font-size:13px;color:var(--ink-2);margin:0 0 8px;">${t('end.causeYear')}</h4>
      <p class="muted" style="font-size:11px;margin:0 0 8px;">${t('end.causeYearAge', deathAge)}</p>
      <div class="eca-list">
        ${yearEntries.length === 0 ? `<div class="eca-empty">${t('end.causeNot')}</div>` : yearEntries.map(([c, n]) => {
          const pct = yearTotal > 0 ? (n / yearTotal * 100).toFixed(1) : 0;
          return `<div class="eca-row">
            <span class="eca-name">${escapeHtml(causeLabel(c))}</span>
            <span class="eca-bg"><span class="eca-fi" style="width:${pct}%"></span></span>
            <span class="eca-pct">${t('end.causeShare', pct)}</span>
          </div>`;
        }).join('')}
      </div>
    </div>
    <div class="eca-section">
      <h4 style="font-size:13px;color:var(--ink-2);margin:14px 0 8px;">${t('end.topCauseLifetime')}</h4>
      <div class="eca-list">
        ${top.length === 0 ? `<div class="eca-empty">${t('end.causeNot')}</div>` : top.map(({ cause, pct }) => {
          return `<div class="eca-row">
            <span class="eca-name">${escapeHtml(causeLabel(cause))}</span>
            <span class="eca-bg"><span class="eca-fi" style="width:${pct.toFixed(1)}%"></span></span>
            <span class="eca-pct">${t('end.causeShare', pct.toFixed(1))}</span>
          </div>`;
        }).join('')}
      </div>
    </div>
  `;
}

let _mapTooltip = null;
function showMapTooltip(e, html) {
  hideMapTooltip();
  _mapTooltip = document.createElement('div');
  _mapTooltip.className = 'map-tooltip';
  _mapTooltip.innerHTML = html;
  _mapTooltip.style.left = (e.pageX + 12) + 'px';
  _mapTooltip.style.top = (e.pageY + 12) + 'px';
  document.body.appendChild(_mapTooltip);
}
function hideMapTooltip() {
  if (_mapTooltip) { _mapTooltip.remove(); _mapTooltip = null; }
}

function showShortcutsModal() {
  document.querySelector('#shortcutsModal')?.remove();
  const isEn = LANG === 'en';
  const rows = [
    ['Space', isEn ? 'Pause / Resume life' : LANG === 'fr' ? "Mettre en pause / reprendre" : '暫停 / 繼續'],
    ['1 / 2 / 4 / 8', isEn ? 'Speed 1× / 2× / 4× / 8×' : LANG === 'fr' ? "Vitesse 1× / 2× / 4× / 8×" : '速度 1× / 2× / 4× / 8×'],
    ['I / L / S / T / E', isEn ? 'Switch tab: Intro / Lab / Shelf / Tree / End' : LANG === 'fr' ? "Changer d'onglet" : '切換 tab：開始 / Lab / 書架 / 族譜 / 訃聞'],
    ['R', isEn ? 'Rebirth (new country)' : LANG === 'fr' ? "Renaître (nouveau pays)" : '重新出生（換國家）'],
    ['?', isEn ? 'This shortcuts modal' : LANG === 'fr' ? "Cette fenêtre de raccourcis" : '本快捷鍵說明']
  ];
  const html = `
    <div id="shortcutsModal" class="life-modal">
      <div class="life-modal-card shortcuts-card">
        <button class="lm-close" onclick="document.getElementById('shortcutsModal').remove()">×</button>
        <h2 class="lm-title">⌨️ ${isEn ? 'Keyboard shortcuts' : LANG === 'fr' ? "Raccourcis clavier" : '鍵盤快捷鍵'}</h2>
        <table class="shortcuts-table">
          <thead><tr><th>${isEn ? 'Key' : LANG === 'fr' ? 'Touche' : '按鍵'}</th><th>${isEn ? 'Action' : LANG === 'fr' ? 'Action' : '動作'}</th></tr></thead>
          <tbody>${rows.map(r => `<tr><td><kbd>${r[0]}</kbd></td><td>${r[1]}</td></tr>`).join('')}</tbody>
        </table>
        <p class="muted" style="margin-top:12px;">${isEn ? 'Press <kbd>?</kbd> anytime to toggle this. Shortcuts skip when typing in inputs.' : LANG === 'fr' ? "Appuyez sur <kbd>?</kbd> à tout moment pour afficher ou masquer cette fenêtre. Les raccourcis sont ignorés pendant la saisie." : '隨時按 <kbd>?</kbd> 切換本說明。在輸入框中會自動跳過。'}</p>
      </div>
    </div>`;
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  document.body.appendChild(wrap.firstElementChild);
  const modal = document.querySelector('#shortcutsModal');
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

/* v6.03：取一個人類看得懂的名字。
   完整人生的 life.name 是物件 {last, first, full, full_en}，
   而書架摘要殼（v5.82 以前、沒有 .full 的那種）與部分紀錄裡的 name 是字串。
   兩邊都會流到同一段顯示程式碼，舊碼直接 escapeHtml(life.name) ——
   物件會被 String() 變成 "[object Object]"，於是書架的「檢視」視窗
   標題和家族樹裡的自己都印成「🇭🇰 [object Object]」。
   這個檔案裡 name?.full || name?.full_en 這段已經重複出現 8 次，
   集中成一個函式之後，兩種形狀都處理得掉。 */
function displayNameOf(x, fallback = '') {
  if (!x) return fallback;
  if (typeof x === 'string') return x;
  return x.full || x.full_en || fallback;
}

function showLifeModal(rec) {
  // 移除舊的
  document.querySelector('#lifeModal')?.remove();
  // v5.83：完整人生放在 .full 裡（v5.82 以前只有摘要殼，這裡的 family / quotes /
  // year / yearOffset 全部拿不到，詳情視窗永遠是空的）
  const life = rec.full || rec;
  const isEn = LANG === 'en';
  const c = countryById(life.country);
  const modal = document.createElement('div');
  modal.id = 'lifeModal';
  modal.className = 'life-modal';
  modal.innerHTML = `
    <div class="life-modal-card">
      <button class="lm-close" type="button">×</button>
      <h2 class="lm-title">${c?.flag || ''} ${escapeHtml(displayNameOf(life.name, rec.name || '—'))}</h2>
      <div class="lm-meta">
        <span>${life.year || ''} → ${life.year + life.yearOffset || ''}</span>
        <span>·</span>
        <span>${life.age} ${t('unit.years')}</span>
        <span>·</span>
        <span>${escapeHtml(causeLabel(life.cause))}</span>
        ${life.family?.fosterCare ? `<span class="badge badge-foster">🏠 ${t('tree.noteFoster')}</span>` : ''}
        ${life.family?.adoptedFrom ? `<span class="badge badge-adopt">🧩 ${t('tree.noteAdoptive')}</span>` : ''}
      </div>
      <div id="lifeTree" class="life-tree"></div>
      <div class="life-quotes">
        <h4>${isEn ? 'Memorable moments' : LANG === 'fr' ? "Moments marquants" : '☆ 值得記住的時刻'}</h4>
        <div class="lq-list">${Object.entries(life.quotes || {}).map(([age, q]) => `<div class="ql-row"><span class="ql-age">${age} ${t('unit.years')}</span><span class="ql-text">${escapeHtml(q)}</span></div>`).join('') || '<span class="muted">—</span>'}</div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  // v6.00：× 移除「自己」這個 modal，不依賴 getElementById 的文件順序
  modal.querySelector('.lm-close')?.addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  // 渲染該生命的 tree（如果 family 存在）
  if (life.family) {
    renderLifeTreeInto(life, $('#lifeTree'));
  }
}

function renderLifeTreeInto(life, container) {
  if (!container) return;
  const f = life.family;
  // 重建 people + edges（用該 life 為中心）
  const self = {
    id: 'self_life',
    name: displayNameOf(life.name, ''),
    sex: life.sex,
    country: life.country,
    countryData: countryById(life.country),
    birth: { year: life.year },
    death: life.died ? { year: life.year + life.yearOffset } : null
  };
  const people = { [self.id]: self };
  (f.parents || []).forEach(p => { people[p.id] = p; });
  (f.siblings || []).forEach(p => { people[p.id] = p; });
  (f.grandparents || []).forEach(p => { people[p.id] = p; });
  const edges = [];
  (f.parents || []).forEach((p, idx) => {
    if (idx === 0) edges.push({ parentId: p.id, childId: self.id });
    else if (idx === 1) edges.push({ parentId: p.id, childId: self.id });
  });
  (f.siblings || []).forEach(s => {
    (f.parents || []).forEach(p => edges.push({ parentId: p.id, childId: s.id }));
  });
  (f.grandparents || []).forEach(gp => {
    const par = (f.parents || []).find(p => p.sex === gp.sex && Math.abs((p.birth?.year||0) - (gp.birth?.year||0)) < 35);
    if (par) edges.push({ parentId: gp.id, childId: par.id });
  });
  // 簡化版：只渲染祖上 1 層（父母 + 祖父母），避免 modal 太大
  renderMiniTree(container, self.id, 2, people, edges);
}

function renderMiniTree(container, rootId, maxGen, people, edges) {
  container.innerHTML = '';
  const nodes = [];
  const links = [];
  function recurse(id, gen, xSlot) {
    if (!id || !people[id]) return;
    if (gen > maxGen) return;
    if (nodes.find(n => n.id === id)) return;
    nodes.push({ id, gen, xSlot });
    if (gen < maxGen) {
      const parents = edges.filter(e => e.childId === id).map(e => e.parentId);
      const half = Math.pow(2, maxGen - gen - 1) / 2;
      const xs = parents.length >= 2 ? [xSlot - half, xSlot + half] : [xSlot];
      parents.slice(0, 2).forEach((pid, n) => {
        recurse(pid, gen + 1, xs[n]);
        links.push({ from: { gen: gen + 1, xSlot: xs[n] }, to: { gen, xSlot } });
      });
    }
  }
  recurse(rootId, 0, Math.pow(2, maxGen) / 2 - 0.5);
  const slotW = 200, rowH = 110, marginX = 30, marginY = 30;
  const totalSlots = Math.pow(2, maxGen);
  const w = marginX * 2 + totalSlots * slotW;
  const h = marginY * 2 + (maxGen + 1) * rowH;
  const svg = svgEl('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: 'xMidYMid meet', style:'max-width:100%;height:auto;' });
  for (const { from, to } of links) {
    const fn = nodes.find(n => n.xSlot === from.xSlot && n.gen === from.gen);
    const tn = nodes.find(n => n.xSlot === to.xSlot && n.gen === to.gen);
    if (!fn || !tn) continue;
    const fx = marginX + fn.xSlot * slotW + slotW/2;
    const fy = marginY + fn.gen * rowH + 40;
    const tx = marginX + tn.xSlot * slotW + slotW/2;
    const ty = marginY + tn.gen * rowH + 80;
    svgEl('path', { d: `M ${fx} ${fy} L ${fx} ${fy + (ty-fy)/2} L ${tx} ${fy + (ty-fy)/2} L ${tx} ${ty}`, class: 'tree-link' }, svg);
  }
  for (const n of nodes) {
    drawPersonNode(svg, people[n.id], marginX + n.xSlot * slotW, marginY + n.gen * rowH, slotW - 12, 70, n.id === rootId);
  }
  container.appendChild(svg);
}

function renderPanorama(lives) {
  // v6.00：先移除既有的 lifeModal。
  // 舊碼直接 append，沒有這一行 —— 玩家每按一次「家族全景圖」就多疊一層視窗，
  // 兩個視窗 z-index 相同、完全重疊。更糟的是 × 鈕寫的是
  // document.getElementById('lifeModal').remove()，getElementById 回傳的是
  // 文件順序裡「第一個」，也就是被压在下面那個 ——
  // 實測：按兩次全景圖後點 ×，底下那個被移除、眼前這個還在，× 鈕看起來沒反應。
  // showLifeModal() 本來就有這行移除，這裡是漏掉的。
  document.querySelector('#lifeModal')?.remove();
  // 合併多段人生的 family，找出共同祖先
  // 合併邏輯：同一個人以 name+birthYear+deathYear 為 key
  const allPeople = {};
  const allEdges = [];
  const selfNodes = [];
  function keyOf(p) {
    return `${p.name}|${p.birth?.year || '?'}|${p.death?.year || ''}|${p.sex || ''}|${p.country || ''}`;
  }
  const idMap = {};
  for (const rec of lives) {
    // v5.83：紀錄裡的完整人生放在 .full（v5.82 以前是沒有 .full 的摘要殼）
    const life = rec.full || rec;
    if (!life.family) continue;
    const f = life.family;
    const selfId = 'self_' + Math.random().toString(36).slice(2,9);
    const selfNode = {
      id: selfId,
      name: life.name?.full || life.name?.full_en || rec.name || '',
      sex: life.sex,
      country: life.country,
      countryData: countryById(life.country),
      birth: { year: life.year },
      death: life.died || rec.cause ? { year: (life.year || 0) + (life.yearOffset || 0) } : null,
      isSelf: true,
      lifeAge: rec.age ?? life.age,
      lifeCause: life.cause || rec.cause
    };
    allPeople[selfId] = selfNode;
    selfNodes.push(selfNode);
    const upsertPerson = (p) => {
      const k = keyOf(p);
      if (idMap[k]) return idMap[k];
      const newId = 'p_' + Math.random().toString(36).slice(2,9);
      idMap[k] = newId;
      allPeople[newId] = { ...p, id: newId };
      return newId;
    };
    (f.parents || []).forEach(p => {
      const pid = upsertPerson(p);
      allEdges.push({ parentId: pid, childId: selfId });
    });
    (f.siblings || []).forEach(s => {
      const sid = upsertPerson(s);
      (f.parents || []).forEach(p => {
        const pid = upsertPerson(p);
        allEdges.push({ parentId: pid, childId: sid });
      });
    });
    (f.grandparents || []).forEach(gp => {
      const gpid = upsertPerson(gp);
      const par = (f.parents || []).find(p => p.sex === gp.sex && Math.abs((p.birth?.year||0) - (gp.birth?.year||0)) < 35);
      if (par) {
        const pid = upsertPerson(par);
        allEdges.push({ parentId: gpid, childId: pid });
      }
    });
  }
  // v5.83：舊紀錄（v5.82 以前存的）沒有 family，selfNodes 會是空的，
  // 直接 selfNodes[0].id 會拋 TypeError。改成顯示訊息而不是整片空白 + console error。
  if (!selfNodes.length) {
    toast(t('shelf.noFamilyData'));
    return;
  }
  const commonAncestors = findCommonAncestors(selfNodes, allEdges, allPeople);
  // v6.05：樹原本固定以 selfNodes[0] 為根。
  // 問題是「第一段人生」常常是孤兒（實測 20 條人生裡約 5% 沒有父母），
  // 那時整張樹只有自己一個節點，玩家看到「合併 4 段人生」下面只有一個人，
  // 會以為合併失敗。
  // 改成挑「往上最多代」的那一段人生當根 —— 有親屬的才畫得出東西。
  const ancestorCount = (id) => allEdges.filter(e => e.childId === id).length;
  let rootSelf = selfNodes[0];
  let best = ancestorCount(rootSelf.id);
  for (const s of selfNodes) {
    const c = ancestorCount(s.id);
    if (c > best) { best = c; rootSelf = s; }
  }
  const modal = document.createElement('div');
  modal.id = 'lifeModal';
  modal.className = 'life-modal';
  modal.innerHTML = `
    <div class="life-modal-card life-modal-wide">
      <button class="lm-close" type="button">×</button>
      <h2 class="lm-title">🌐 ${t('shelf.panorama') || '家族全景圖'}</h2>
      <p class="muted">${t('shelf.panoramaSub') || '合併 ' + lives.length + ' 段人生的族譜。共同祖先以紅框標示。'}</p>
      ${commonAncestors.length ? `<div class="panorama-common"><b>${t('shelf.commonAncestors') || '共同親屬'}：</b> ${commonAncestors.map(c => escapeHtml(c.name)).join('、')}</div>` : `<div class="panorama-common"><span class="muted">${t('shelf.noCommon') || '無共同親屬'}</span></div>`}
      <div class="panorama-root muted">${LANG === 'en'
        ? `Tree shown from <b>${escapeHtml(rootSelf.name || '—')}</b>, two generations up.`
        : LANG === 'fr' ? `Arbre affiché à partir de <b>${escapeHtml(rootSelf.name || '—')}</b>, sur deux générations.` : `下方的樹以 <b>${escapeHtml(rootSelf.name || '—')}</b> 為中心，往上兩代。`}</div>
      <div id="lifeTree" class="life-tree"></div>
    </div>
  `;
  document.body.appendChild(modal);
  // v6.00：× 移除「自己」這個 modal，不依賴 getElementById 的文件順序
  modal.querySelector('.lm-close')?.addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  renderMiniTree($('#lifeTree'), rootSelf.id, 2, allPeople, allEdges);
  setTimeout(() => {
    document.querySelectorAll('#lifeTree .tree-node').forEach(n => {
      const name = n.querySelector('.node-name')?.textContent;
      if (commonAncestors.some(c => c.name === name)) {
        n.querySelector('.node-rect')?.setAttribute('stroke', '#a04040');
        n.querySelector('.node-rect')?.setAttribute('stroke-width', '3');
      }
    });
  }, 100);
}

function findCommonAncestors(selfNodes, edges, allPeople) {
  // 共同親屬：直接出現在 ≥2 個 self 的「家族清單」（parents + grandparents + siblings）
  // 注意：不要走 parent-of-parent 路徑，因為那會把 A 的祖父錯算成 B 的祖父（除非 B 也明確收錄）
  const counts = new Map();
  for (const self of selfNodes) {
    const ancestors = edges.filter(e => e.childId === self.id).map(e => e.parentId);
    ancestors.forEach(a => {
      if (!counts.has(a)) counts.set(a, new Set());
      counts.get(a).add(self.id);
    });
  }
  const common = [];
  counts.forEach((selves, pid) => {
    if (selves.size >= 2 && allPeople[pid] && !allPeople[pid].isSelf) {
      common.push({ id: pid, name: allPeople[pid].name, count: selves.size });
    }
  });
  return common;
}

function renderSpeedBtns() {
  $$('.ltb-speed-btn').forEach(b => {
    b.classList.toggle('active', +b.dataset.speed === STATE.speed);
  });
}

function updateLangSwitcher() {
  const sel = $('#langSwitcher');
  if (sel) sel.value = LANG;
}

// ==== Lab 模式：批次模擬 ====
function runLab(countryCode, era, sexMode, N) {
  // 跑 N 條人生，收集統計
  const deaths = []; // age of death
  const causes = {}; // cause -> count
  const country = countryById(countryCode);
  if (!country) return null;
  const adjustEra = { past: 1990, future: 2080, any: 2024, now: 2024 }[era] || 2024;
  for (let i = 0; i < N; i++) {
    const sex = sexMode === 'random' ? (Math.random() < 0.5 ? 'M' : 'F') : sexMode;
    const life = newLife(countryCode);
    life.sex = sex;
    life.year = adjustEra;
    life.yearOffset = 0;
    // 跑到死
    while (!life.died && life.age < 120) {
      life.age += 1;
      life.yearOffset += 1;
      if (Math.random() < pDie(life.age, life.countryData, sex)) {
        life.died = true;
        life.deathAge = life.age;
        const cause = pickCause(life.countryData, life.age, sex);
        life.cause = cause;
        break;
      }
    }
    if (!life.died) {
      life.deathAge = life.age;
      life.cause = '自然衰老';
    }
    deaths.push(life.deathAge);
    causes[life.cause] = (causes[life.cause] || 0) + 1;
  }
  deaths.sort((a, b) => a - b);
  const avg = deaths.reduce((a, b) => a + b, 0) / deaths.length;
  const median = deaths[Math.floor(deaths.length / 2)];
  // 家族統計
  const famStats = runFamilyLab(countryCode, Math.min(N, 200));
  return { deaths, causes, avg, median, country, N, era: adjustEra, famStats };
}

/* ==== Lab 家族統計：批次產生 N 個家族，看孤兒率/手足數/收養率 ==== */
function runFamilyLab(countryCode, N) {
  const c = countryById(countryCode);
  if (!c) return null;
  let adopted = 0, fostered = 0, orphan = 0, withFather = 0, withMother = 0, twoParents = 0;
  let sibTotal = 0, gpTotal = 0;
  for (let i = 0; i < N; i++) {
    const f = generateFamily(countryCode, Math.random() < 0.5 ? 'M' : 'F');
    if (f.fosterCare === 'adopt') adopted++;
    if (f.fosterCare === 'foster') fostered++;
    if (f.parents.length === 0) orphan++;
    const hasFather = f.parents.some(p => p.sex === 'M');
    const hasMother = f.parents.some(p => p.sex === 'F');
    if (hasFather) withFather++;
    if (hasMother) withMother++;
    if (hasFather && hasMother) twoParents++;
    sibTotal += f.siblings.length;
    gpTotal += (f.grandparents || []).length;
  }
  return {
    N,
    adoptedPct: (adopted / N * 100).toFixed(1),
    fosteredPct: (fostered / N * 100).toFixed(1),
    orphanPct: (orphan / N * 100).toFixed(1),
    twoParentsPct: (twoParents / N * 100).toFixed(1),
    withFatherPct: (withFather / N * 100).toFixed(1),
    withMotherPct: (withMother / N * 100).toFixed(1),
    avgSib: (sibTotal / N).toFixed(2),
    avgGP: (gpTotal / N).toFixed(2)
  };
}

function renderLab() {
  const countrySel = $('#labCountry');
  const countryBSel = $('#labCountryB');
  if (countrySel && countrySel.children.length !== COUNTRIES.length) {
    countrySel.innerHTML = '';
    for (const c of COUNTRIES) {
      const loc = localize(c);
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = `${c.flag} ${loc.name}`;
      countrySel.appendChild(opt);
    }
    if (countryBSel) {
      countryBSel.innerHTML = '<option value="">—</option>';
      for (const c of COUNTRIES) {
        const loc = localize(c);
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = `${c.flag} ${loc.name}`;
        countryBSel.appendChild(opt);
      }
    }
  }
}

function displayLabResults(result) {
  const target = $('#labResults');
  if (!target) return;
  if (!result) {
    target.innerHTML = '<div class="lab-section" style="text-align:center;color:var(--ink-3);">—</div>';
    return;
  }
  const { deaths, causes, avg, median, country, N, era } = result;
  // 直方圖分箱
  const minA = Math.min(...deaths), maxA = Math.max(...deaths);
  const bins = {};
  const binSize = Math.max(1, Math.ceil((maxA - minA) / 20));
  for (let i = 0; i < N; i++) {
    const b = Math.floor(deaths[i] / binSize) * binSize;
    bins[b] = (bins[b] || 0) + 1;
  }
  const sortedBins = Object.keys(bins).map(Number).sort((a, b) => a - b);
  const maxCount = Math.max(...Object.values(bins));
  // 死因排序
  const sortedCauses = Object.entries(causes).sort((a, b) => b[1] - a[1]);
  // 格式化
  const flag = country.flag;
  const loc = localize(country);
  const deathPercent = (deaths.filter(d => d < 5).length / N * 100).toFixed(1);
  let html = `
    <div class="lab-stats">
      <div class="lab-stat"><div class="k">${flag} ${loc.name}</div><div class="v">${N}</div><div class="sub">${t('lab.run').toLowerCase()}</div></div>
      <div class="lab-stat"><div class="k">${t('lab.avg_age')}</div><div class="v">${avg.toFixed(1)}</div><div class="sub">${t('unit.years')}</div></div>
      <div class="lab-stat"><div class="k">${t('lab.median_age')}</div><div class="v">${median}</div><div class="sub">${t('unit.years')}</div></div>
      <div class="lab-stat"><div class="k">5 歲以下死亡</div><div class="v">${deathPercent}%</div><div class="sub">${N} 人中 ${deaths.filter(d => d < 5).length} 人</div></div>
      <div class="lab-stat"><div class="k">${t('lab.top_cause')}</div><div class="v" style="font-size:16px;">${sortedCauses[0] ? sortedCauses[0][0] : '—'}</div><div class="sub">${sortedCauses[0] ? (sortedCauses[0][1] / N * 100).toFixed(1) + '%' : ''}</div></div>
    </div>
    <div class="lab-section">
      <h3>${t('lab.distribution')}</h3>
      <div class="lab-bars">
  `;
  for (const b of sortedBins) {
    const h = (bins[b] / maxCount) * 140;
    html += `<div class="lab-bar-col"><div class="val">${bins[b]}</div><div class="lab-bar" style="height:${h}px"></div><div class="lbl">${b}</div></div>`;
  }
  html += `</div></div><div class="lab-section"><h3>${t('lab.top_cause')} ${t('lab.distribution')}</h3><div class="lab-causes">`;
  const maxC = sortedCauses[0] ? sortedCauses[0][1] : 1;
  for (const [cause, count] of sortedCauses) {
    const pct = (count / N * 100).toFixed(1);
    const width = (count / maxC * 100).toFixed(0);
    html += `<div class="lab-cause"><span class="nm">${cause}</span><span class="bg"><span class="fi" style="width:${width}%"></span></span><span class="ct">${count} (${pct}%)</span></div>`;
  }
  html += `</div></div>`;
  // 家族統計
  if (result.famStats) {
    const fs = result.famStats;
    html += `<div class="lab-section"><h3>${t('lab.familyStats')}</h3><div class="fam-stats-grid">
      <div class="lab-stat"><div class="k">${t('lab.famOrphan')}</div><div class="v">${fs.orphanPct}%</div><div class="sub">${fs.N} 個家族</div></div>
      <div class="lab-stat"><div class="k">${t('lab.famTwoParents')}</div><div class="v">${fs.twoParentsPct}%</div><div class="sub">${t('lab.famFull')}</div></div>
      <div class="lab-stat"><div class="k">${t('lab.famAdopted')}</div><div class="v">${fs.adoptedPct}%</div><div class="sub">${t('lab.famAdoptedHint')}</div></div>
      <div class="lab-stat"><div class="k">${t('lab.famAvgSib')}</div><div class="v">${fs.avgSib}</div><div class="sub">${t('lab.famAvgSibHint')}</div></div>
      <div class="lab-stat"><div class="k">${t('lab.famAvgGP')}</div><div class="v">${fs.avgGP}</div><div class="sub">${t('lab.famAvgGPHint')}</div></div>
      <div class="lab-stat"><div class="k">${t('lab.famFostered')}</div><div class="v">${fs.fosteredPct}%</div><div class="sub">${t('lab.famFosteredHint')}</div></div>
    </div></div>`;
  }
  target.innerHTML = html;
}

/* ==== Lab 國家比較模式 ==== */
function displayLabResultsCompare(rA, rB) {
  const target = $('#labResults');
  if (!target) return;
  const flag = (c) => c.flag || '🏳️';
  const stat = (label, a, b, fmt, lowerBetter) => {
    const da = (a ?? 0), db = (b ?? 0);
    const wa = lowerBetter ? (da < db ? '▲' : da > db ? '▼' : '=') : (da > db ? '▲' : da < db ? '▼' : '=');
    const wb = lowerBetter ? (db < da ? '▲' : db > da ? '▼' : '=') : (db > da ? '▲' : db < da ? '▼' : '=');
    return `<tr><td>${label}</td><td>${fmt(da)} ${wa}</td><td>${fmt(db)} ${wb}</td></tr>`;
  };
  const fmt1 = x => x?.toFixed ? x.toFixed(1) : x;
  const fmt0 = x => Math.round(x ?? 0);
  const html = `
    <div class="lab-section"><h3>${flag(rA.country)} ${localize(rA.country).name} vs ${flag(rB.country)} ${localize(rB.country).name}</h3>
      <p class="muted">${rA.N} ${LANG==='en'?'lives per country':LANG === 'fr' ? "vies par pays" : '人/國家'} · ${LANG==='en'?'avg lifespan, family stats':LANG === 'fr' ? "durée de vie moyenne, statistiques familiales" : '平均壽命、家庭統計'}</p>
      <table class="lab-compare">
        <thead><tr><th></th><th>${flag(rA.country)} ${localize(rA.country).name}</th><th>${flag(rB.country)} ${localize(rB.country).name}</th></tr></thead>
        <tbody>
          ${stat(t('lab.avg_age'), rA.avg, rB.avg, fmt1)}
          ${stat(t('lab.median_age'), rA.median, rB.median, fmt0)}
          ${stat('5歲以下死亡%', (rA.deaths.filter(d => d < 5).length / rA.N * 100), (rB.deaths.filter(d => d < 5).length / rB.N * 100), fmt1, true)}
          ${stat(t('lab.famOrphan'), parseFloat(rA.famStats.orphanPct), parseFloat(rB.famStats.orphanPct), fmt1, true)}
          ${stat(t('lab.famTwoParents'), parseFloat(rA.famStats.twoParentsPct), parseFloat(rB.famStats.twoParentsPct), fmt1)}
          ${stat(t('lab.famAdopted'), parseFloat(rA.famStats.adoptedPct), parseFloat(rB.famStats.adoptedPct), fmt1)}
          ${stat(t('lab.famAvgSib'), parseFloat(rA.famStats.avgSib), parseFloat(rB.famStats.avgSib), fmt1)}
          ${stat(t('lab.famAvgGP'), parseFloat(rA.famStats.avgGP), parseFloat(rB.famStats.avgGP), fmt1)}
        </tbody>
      </table>
    </div>
    <div class="lab-section"><h3>${LANG==='en'?'Top causes':LANG === 'fr' ? "Principales causes" : '死因分布對比'}</h3>
      <div class="lab-compare-causes">
        <div><h4>${flag(rA.country)} ${localize(rA.country).name}</h4>${renderCauseList(rA.causes)}</div>
        <div><h4>${flag(rB.country)} ${localize(rB.country).name}</h4>${renderCauseList(rB.causes)}</div>
      </div>
    </div>`;
  target.innerHTML = html;
}

function renderCauseList(causes) {
  const sorted = Object.entries(causes).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const total = Object.values(causes).reduce((a, b) => a + b, 0);
  return '<ol class="lab-causes">' + sorted.map(([c, n]) =>
    `<li><span class="lab-cause">${c}</span><span class="lab-cause-n">${(n/total*100).toFixed(1)}%</span></li>`
  ).join('') + '</ol>';
}

// ==== 事件 ====
function wire() {
  // v5.51：任何關閉 modal 的方式（× / 點背景 / 空白鍵）都必須恢復計時
  $$('[data-close-modal]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
  });
  $$('.modal').forEach(m => {
    m.addEventListener('mousedown', e => { if (e.target === m) closeModal(m.id); });
  });
  document.addEventListener('keydown', e => {
    const openAll = $$('.modal').filter(el => !el.hasAttribute('hidden'));
    // v5.72：焦點圈住 — modal 開著時 Tab 只能在 modal 裡面循環。
    // 實測原本按兩次 Tab 就會跳出到 modal 背後的頁面元件（例如右下角的 ? 按鈕），
    // 鍵盤使用者會在不知不覺中操作到被遮住的控制項。
    if (e.key === 'Tab' && openAll.length) {
      const m = openAll[openAll.length - 1];
      const f = $$('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])', m)
        .filter(el => !el.hasAttribute('hidden') && el.offsetParent !== null && el.tabIndex !== -1);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      const active = document.activeElement;
      if (!m.contains(active)) { e.preventDefault(); first.focus(); return; }
      if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); return; }
      if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); return; }
      return;
    }
    if (e.key !== 'Escape') return;
    const open = PAUSING_MODALS.map(i => document.getElementById(i))
      .filter(el => el && !el.hasAttribute('hidden'));
    if (open.length) { closeModal(open[0].id); e.preventDefault(); }
  });
  // 導覽
  $$('.navbtn').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  // 語言
  const ls = $('#langSwitcher');
  if (ls) ls.addEventListener('change', e => setLang(e.target.value));
  // 國家選擇
  const sel = $('#countrySelect');
  if (sel) sel.addEventListener('change', e => { STATE.selectedCountry = e.target.value; renderIntro(); });
  // 出生模式
  $$('[data-birth-mode]').forEach(b => b.addEventListener('click', () => {
    $$('[data-birth-mode]').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    STATE.birthMode = b.dataset.birthMode;
  }));
  // 年代
  $$('[data-era]').forEach(b => b.addEventListener('click', () => {
    $$('[data-era]').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    STATE.era = b.dataset.era;
  }));
  // 開始按鈕（v5.19：先顯示出生登記卡 modal，等使用者確認才 startLife）
  const start = $('#btnStart');
  if (start) start.addEventListener('click', () => {
    startLifeWithCert();
  });
  // 選特定國家開始（v5.19：同樣先顯示出生卡）
  const startSelected = $('#btnStartSelected');
  if (startSelected) startSelected.addEventListener('click', () => {
    const c = countryById(STATE.selectedCountry);
    if (c) showBirthCertModal(c);
  });
  // v5.19：出生卡 modal 的確認按鈕
  // Mise en page : les jauges rejoignent la fiche du personnage, sous le compteur d'âge.
  { const hero = document.querySelector('.life-hero'), st = $('#lifeStats'); if (hero && st) hero.after(st); }
  // Les panneaux quittent leurs trois colonnes d'origine pour une seule grille, dans l'ordre de lecture voulu.
  {
    const grid = document.querySelector('#view-life .life-grid');
    if (grid) {
      const cols = [...grid.querySelectorAll(':scope > .life-col')];
      const rest = cols.flatMap(c => [...c.children]);
      // « Situation » (sexe, études, travail, conjoint…) et « Famille » sortent de la fiche pour l'alléger.
      const situation = document.createElement('div');
      situation.id = 'lifeSituation';
      situation.append(...['.cert-age-row', '.cert-meta'].map(q => document.querySelector('#lifeCert ' + q)).filter(Boolean));
      { const ind = document.createElement('div'); ind.id = 'lifeIndicators'; const st0 = $('#lifeStats'); if (st0) st0.appendChild(ind);
        const idc = document.createElement('div'); idc.id = 'lifeIdCard'; const hero0 = document.querySelector('.life-hero'); if (hero0) hero0.after(idc); const fin0 = $('#finSide'); if (hero0 && fin0) hero0.after(fin0); }
      const famLife = document.createElement('div'); famLife.id = 'lifeFamilyLife';
      const budget = document.createElement('div');
      budget.id = 'lifeBudget';
      const lgrid = document.createElement('div');
      lgrid.id = 'lifeGrid';
      situation.hidden = true;
      const first = [document.getElementById('lifeThisYear'), document.getElementById('lifeManualDecisions'), document.getElementById('lifeEventsFeed'), famLife, lgrid, situation, budget,
        ...['lifeActualVsRandom', 'lifeScene', 'lifeCompanions'].map(id => document.getElementById(id))]
        .filter(Boolean);
      const toggle = document.getElementById('btnDetailToggle');
      const isDetail = e => e.classList.contains('life-detail-only');
      [...first, ...rest.filter(e => !first.includes(e) && e !== toggle && !isDetail(e)), toggle, ...rest.filter(isDetail)]
        .forEach(e => e && grid.appendChild(e));
      cols.forEach(c => c.remove());
    }
  }
  $('#treeBackLife')?.addEventListener('click', () => setView(STATE.life && STATE.life.died ? 'end' : 'life'));
  // Rythme choisi au lancement : secondes par année de vie
  const paceBtns = $$('#paceSeg [data-pace]');
  const setPace = (sec) => {
    STATE.paceSec = sec;
    try { localStorage.setItem(STORAGE_KEY + ':pace', sec); } catch (e) {}
    paceBtns.forEach(b => b.classList.toggle('active', +b.dataset.pace === sec));
  };
  paceBtns.forEach(b => b.addEventListener('click', () => setPace(+b.dataset.pace)));
  let savedPace = 5;
  try { savedPace = +localStorage.getItem(STORAGE_KEY + ':pace'); } catch (e) {}
  setPace([5, 10, 15, 20].includes(savedPace) ? savedPace : 5);
  const birthCertConfirm = $('#birthCertConfirm');
  if (birthCertConfirm) birthCertConfirm.addEventListener('click', () => {
    const c = STATE.birthCertCountry;
    const life = STATE.birthCertLife;
    hideBirthCertModal();
    if (c) startLife(c.id, life);
  });
  // v5.19：出生卡 modal 的取消按鈕
  const birthCertCancel = $('#birthCertCancel');
  if (birthCertCancel) birthCertCancel.addEventListener('click', () => {
    hideBirthCertModal();
  });
  // v5.19：出生卡 modal 的「換一個國家」
  const birthCertReroll = $('#birthCertReroll');
  if (birthCertReroll) birthCertReroll.addEventListener('click', () => {
    const c = chooseCountry(STATE.birthMode);
    if (c) showBirthCertModal(c);
  });
  // v5.19：modal 點背景關閉
  const birthCertModal = $('#birthCertModal');
  if (birthCertModal) birthCertModal.addEventListener('click', (e) => {
    if (e.target === birthCertModal) hideBirthCertModal();
  });
  // 生命控制
  const pauseBtn = $('#btnPause');
  if (pauseBtn) pauseBtn.addEventListener('click', () => {
    STATE.paused = !STATE.paused;
    syncPauseBtn();
  });
  syncPauseBtn();
  $$('.ltb-speed-btn').forEach(b => b.addEventListener('click', () => setSpeed(+b.dataset.speed)));
  // v5.9：自動抉擇模式
  const autoBtn = $('#btnAuto');
  if (autoBtn) autoBtn.addEventListener('click', () => {
    STATE.autoDecide = !STATE.autoDecide;
    autoBtn.classList.toggle('active', STATE.autoDecide);
    syncAutoBtn();
    if (STATE.autoDecide && STATE.pendingDecision) resolvePendingDecision();
  });
  // v5.9：快轉到下一個抉擇
  const skipBtn = $('#btnSkip');
  if (skipBtn) skipBtn.addEventListener('click', () => {
    if (STATE.pendingDecision) { resolvePendingDecision(); return; }
    STATE.fastForward = true;
  });
  // v5.10：✎ 寫下想法 modal 啟用開關 + 暫停問題
  const thoughtsBtn = $('#btnThoughts');
  if (thoughtsBtn) thoughtsBtn.addEventListener('click', () => {
    STATE.thoughtsEnabled = !STATE.thoughtsEnabled;
    thoughtsBtn.classList.toggle('active', STATE.thoughtsEnabled);
    if (STATE.thoughtsEnabled && STATE.pendingDecision) showPauseQuestion();
  });
  // v5.22：貨幣切換 + 主題切換
  const currencyBtn = $('#currencyToggle');
  const currencies = ['€', 'US$', 'NT$', 'HK$', 'MOP$', 'CNY'];
  if (currencyBtn) currencyBtn.addEventListener('click', () => {
    const i = currencies.indexOf(STATE.life?.currency || 'NT$');
    const next = currencies[(i + 1) % currencies.length];
    setCurrency(next);
    const lbl = $('#currencyLabel');
    if (lbl) lbl.textContent = next;
    toast(LANG === 'en' ? `Currency: ${next}` : LANG === 'fr' ? `Devise : ${next}` : `貨幣：${next}`);
  });
  const themeBtn = $('#themeToggle');
  if (themeBtn) themeBtn.addEventListener('click', () => {
    const order = ['theme-light','theme-dark','theme-sepia'];
    const cur = order.find(c => document.body.classList.contains(c)) || 'theme-light';
    const next = order[(order.indexOf(cur) + 1) % order.length];
    setTheme(next);
    toast(LANG === 'en' ? `Theme: ${next.replace('theme-','')}` : LANG === 'fr' ? `Thème : ${next.replace('theme-','')}` : `主題：${next.replace('theme-','')}`);
  });
  // v5.50：略過可怕的情節（1in8b.life softBtn / softBtn2）— topbar 與 intro 兩處共用
  ['#btnSoftMode', '#softBtnIntro'].forEach(sel => {
    const btn = $(sel);
    if (btn) btn.addEventListener('click', toggleSoftMode);
  });
  // v5.61：詳細資料展開／收合（記住偏好）
  const detailBtn = $('#btnDetailToggle');
  if (detailBtn) {
    const apply = () => {
      const on = localStorage.getItem(STORAGE_KEY + ':detail') === '1';
      $('#view-life')?.classList.toggle('show-detail', on);
      detailBtn.setAttribute('aria-expanded', on ? 'true' : 'false');
      syncDetailToggleLabel();
    };
    detailBtn.addEventListener('click', () => {
      const on = $('#view-life')?.classList.contains('show-detail');
      localStorage.setItem(STORAGE_KEY + ':detail', on ? '0' : '1');
      apply();
    });
    apply();
  }
  const pauseSave = $('#pauseSave');
  if (pauseSave) pauseSave.addEventListener('click', savePauseQuote);
  const pauseSkip = $('#pauseSkip');
  if (pauseSkip) pauseSkip.addEventListener('click', () => {
    resolvePendingDecision();
    closeModal('pauseModal');
  });
  // 死亡
  const dieBtn = $('#btnDieNow');
  if (dieBtn) dieBtn.addEventListener('click', () => { if (STATE.life && !STATE.life.died) dieNow('自行結束'); });
  const rebirthBtn = $('#btnRebirth');
  if (rebirthBtn) rebirthBtn.addEventListener('click', () => {
    const c = chooseCountry(STATE.birthMode);
    if (c) {
      stopTicker();
      toast(LANG==='en' ? `Reborn in ${c.flag} ${c.name_zh}` : LANG === 'fr' ? `Renaissance : ${c.flag} ${localize(c).name}` : `在 ${c.flag} ${c.name_zh} 重新出生`);
      startLife(c.id);
    }
  });
  // v5.12 / v5.20：分享出生卡（下載 PNG + 複製 base64 URL）
  const shareCardBtn = $('#btnShareCard');
  if (shareCardBtn) shareCardBtn.addEventListener('click', () => {
    downloadBirthCardPNG();
    copyBirthCardShareURL();
  });
  // 結束畫面
  const restart = $('#btnRestart');
  if (restart) restart.addEventListener('click', () => setView('intro'));
  const newLife = $('#btnNewLife');
  if (newLife) newLife.addEventListener('click', () => {
    const c = chooseCountry(STATE.birthMode);
    if (c) startLife(c.id);
  });
  const downloadCert = $('#btnDownloadCert');
  if (downloadCert) downloadCert.addEventListener('click', downloadLifeCertPNG);
  // v5.24：再看一次最後的時刻 + 提供意見
  const replayLast = $('#btnReplayLast');
  if (replayLast) replayLast.addEventListener('click', replayLastMoments);
  $('#endCloseReplay')?.addEventListener('click', () => $('#endLastMoments')?.setAttribute('hidden', ''));
  // v5.31：前世紀錄面板按鈕
  $('#endShowMore9')?.addEventListener('click', () => {
    const past = loadPastLives();
    const more = past.slice(5, 14);
    const html = more.map((p, i) => `<div class="pr-row"><div class="pr-info"><strong>${p.name || '—'}</strong><span class="muted">${p.country || '—'} · ${p.age} ${t('unit.years')}</span></div></div>`).join('');
    const wrap = document.createElement('div');
    wrap.innerHTML = html || '<div class="muted">—</div>';
    document.querySelector('#endPastList')?.appendChild(wrap);
    toast(LANG==='en' ? `Showing ${more.length} more` : LANG === 'fr' ? `${more.length} de plus affichées` : `顯示 ${more.length} 段過去`);
  });
  $('#endViewShelf')?.addEventListener('click', () => setView('shelf'));
  $('#endResumeLife')?.addEventListener('click', () => {
    if (!STATE.life || !STATE.life.died) return;
    STATE.life.died = false;
    STATE.life.cause = null;
    STATE.life.deathAge = null;
    STATE.paused = false;
    setView('life');
    startTicker();
    toast(LANG==='en' ? 'Life resumed' : LANG === 'fr' ? "Vie reprise" : '已回到那一生');
  });
  $('#endOrganize')?.addEventListener('click', () => {
    setView('shelf');
    setTimeout(() => document.querySelector('#manageRecordsBtn')?.click(), 200);
  });
  $('#endDeleteAll')?.addEventListener('click', () => {
    if (confirm(LANG==='en' ? 'Delete all past lives?' : LANG === 'fr' ? "Supprimer toutes les vies passées ?" : '刪除所有過去的人生？')) {
      localStorage.setItem(STORAGE_KEY + ':past', '[]');
      renderEnd();
      toast(LANG==='en' ? 'All deleted' : LANG === 'fr' ? "Tout est supprimé" : '已全部刪除');
    }
  });
  const feedbackSubmit = $('#feedbackSubmit');
  if (feedbackSubmit) feedbackSubmit.addEventListener('click', submitFeedback);
  $('#footerFeedbackBtn')?.addEventListener('click', () => $('#feedbackModal')?.removeAttribute('hidden'));
  // esc 關閉
  document.addEventListener('keydown', e => {
    // 跳過輸入框
    if (['INPUT','TEXTAREA','SELECT'].includes((e.target.tagName||'').toUpperCase())) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (k === ' ') { if (STATE.view === 'life') $('#btnPause')?.click(); e.preventDefault(); return; }
    // 速度 1/2/4/8
    if (['1','2','4','8'].includes(k)) {
      const btn = document.querySelector(`.ltb-speed-btn[data-speed="${k}"]`);
      if (btn) { btn.click(); e.preventDefault(); }
      return;
    }
    const navMap = { i:'intro', l:'lab', s:'shelf', t:'tree', e:'end' };
    if (navMap[k]) {
      document.querySelectorAll('.navbtn').forEach(b => { if (b.dataset.view === navMap[k]) b.click(); });
      e.preventDefault();
      return;
    }
    // R = 重新出生
    if (k === 'r' || k === 'R') {
      if (STATE.life && STATE.view === 'life') {
        $('#btnRebirth')?.click();
        e.preventDefault();
      }
      return;
    }
    // ? = 快捷鍵說明
    if (k === '?' || (k === '/' && e.shiftKey)) {
      showShortcutsModal();
      e.preventDefault();
    }
  });
  // Lab
  const labRun = $('#labRun');
  if (labRun) labRun.addEventListener('click', () => {
    const code = $('#labCountry').value;
    const codeB = $('#labCountryB')?.value;
    const era = $('#labEra').value;
    const sex = $('#labSex').value;
    const N = +$('#labN').value;
    const result = runLab(code, era, sex, N);
    if (codeB) {
      const resultB = runLab(codeB, era, sex, N);
      displayLabResultsCompare(result, resultB);
    } else {
      displayLabResults(result);
    }
  });
  // Tree (族譜)
  $('#treeRoot')?.addEventListener('change', e => { TREE_STATE.rootId = e.target.value; renderTree(); });
  $('#treeMode')?.addEventListener('change', e => { TREE_STATE.mode = e.target.value; renderTree(); });
  $('#treeDepth')?.addEventListener('change', e => { TREE_STATE.depth = +e.target.value; renderTree(); });
  $('#treeSearch')?.addEventListener('input', e => highlightTreeSearch(e.target.value));
  $('#treeRefresh')?.addEventListener('click', () => {
    if (STATE.life) {
      STATE.life.family = generateFamily(STATE.life.country, STATE.life.sex);
      TREE_STATE.rootId = 'self';
      renderTree();
    }
  });
  $('#treeExport')?.addEventListener('click', exportGEDCOM);
  $('#treeShare')?.addEventListener('click', shareTreeLink);
  $('#lifeExport')?.addEventListener('click', exportLifeJSON);
  $('#lifeImport')?.addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) importLifeJSON(file);
    e.target.value = '';
  });
}

/* ==== URL hash 分享：序列化 life 到 LZ-string-ish JSON base64 ==== */
function shareTreeLink() {
  if (!STATE.life) { toast(LANG === 'en' ? 'Start a life first' : LANG === 'fr' ? "Commencez d'abord une vie" : '請先開始一段人生'); return; }
  const { people, edges } = treePeopleGraph();
  const payload = {
    meta: { title: '族譜 · ' + (STATE.life.name.full || 'born-somewhere'), ts: Date.now() },
    people: Object.values(people).map(p => ({
      id: p.id, name: p.name, sex: p.sex, country: p.country,
      birth: p.birth, death: p.death, note: p.note, family: p.family
    })),
    edges
  };
  const json = JSON.stringify(payload);
  const b64 = btoa(unescape(encodeURIComponent(json)));
  const url = `${location.origin}${location.pathname}#tree=${b64}`;
  navigator.clipboard?.writeText(url).then(() => {
    toast(t('share.copied') || '已複製');
  }, () => {
    prompt(LANG === 'en' ? 'Copy this URL:' : LANG === 'fr' ? "Copiez cette adresse :" : '複製此連結：', url);
  });
}

/* ==== 完整生涯 JSON 匯出/匯入 ==== */
function exportLifeJSON() {
  if (!STATE.life) { toast(LANG === 'en' ? 'Start a life first' : LANG === 'fr' ? "Commencez d'abord une vie" : '請先開始一段人生'); return; }
  const payload = {
    type: 'born-somewhere-life',
    version: 1,
    exportedAt: new Date().toISOString(),
    state: {
      life: STATE.life,
      pastLives: loadPastLives(),
      importedFamily: STATE.importedFamily || null
    }
  };
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeName = (STATE.life.name?.full || STATE.life.name?.full_en || 'life').replace(/[\/\\<>:"|?*\u0000-\u001f]/g, '_');
  a.href = url; a.download = `born-somewhere-${safeName}-${Date.now()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(LANG === 'en' ? 'Life exported' : LANG === 'fr' ? "Vie exportée" : '已匯出生涯');
}

/* v5.22：繼續一段過去的人生（從 shelf 載入並接續從當年齡） */
function continueOldLife(pastLife) {
  if (!pastLife || pastLife.died) {
    toast(LANG === 'en' ? 'Life already ended' : LANG === 'fr' ? "Cette vie est déjà terminée" : '這段人生已結束');
    return;
  }
  stopTicker();
  // v5.83：v5.82 以前只存摘要，這裡會拿到空殼人生；新紀錄有 full 欄位就用它。
  const src = pastLife.full || pastLife;
  STATE.life = JSON.parse(JSON.stringify(src));  // 深拷貝
  STATE.life.died = false;
  STATE.life.cause = null;
  STATE.life.deathAge = null;
  STATE.life.financeModalShown = [];  // 重開財務 modal 選項
  STATE.life.focusThisYear = null;
  STATE.feedShown = 12;               // v5.65：重開人生時事件紀錄收回到 12 筆
  setView('life');
  setTimeout(() => {
    startTicker();
    toast(LANG === 'en' ? `Continuing from age ${STATE.life.age}` : LANG === 'fr' ? `Reprise à ${STATE.life.age} ans` : `從 ${STATE.life.age} 歲接續這一生`);
  }, 100);
}

/* v5.22：貨幣切換 — 即時換算 netAssets */
/* ==== Budget annuel ====
   Modèle volontairement simple, en dollars PPA. Ce sont des ordres de grandeur, pas des statistiques officielles.
   - Revenu : revenu moyen par adulte du pays (55 % du PIB par habitant), modulé par la place de la famille dans
     l'échelle des revenus (indice de Gini), le niveau d'études et l'expérience.
   - Redistribution : part de la richesse nationale consacrée aux dépenses sociales. Elle fixe à la fois les
     impôts et cotisations (progressifs), les aides aux bas revenus et aux familles, et la retraite.
   - Dépenses : logement, alimentation, énergie ; santé restant à charge (donnée `oop` du pays) ; études ; loisirs. */
const SOCIAL_RATE = { FRA: .31, ITA: .30, AUT: .29, FIN: .29, BEL: .29, ESP: .28, DEU: .27, DNK: .26, JPN: .25, PRT: .25, GRC: .24, SWE: .24,
  USA: .23, POL: .23, GBR: .22, NOR: .21, NLD: .18, CHE: .17, KOR: .15, IRL: .13, TUR: .12, MEX: .07 };
function socialRate(c) { return SOCIAL_RATE[c.id] ?? Math.max(0.03, Math.min(0.2, 0.03 + 0.17 * (c.ppp || 0) / 50000)); }
// Revenu d'un quart de la population rapporté à la moyenne du pays, déduit de l'indice de Gini (loi log-normale).
function quartileShare(c, q) {
  const g = Math.min(0.7, Math.max(0.2, c.gi || 0.38));
  const pr = (g + 1) / 2;
  const sigma = Math.SQRT2 * 4.91 * (Math.pow(pr, 0.14) - Math.pow(1 - pr, 0.14));   // approximation de la loi normale inverse
  return Math.exp(sigma * [-1.15, -0.319, 0.319, 1.15][q - 1] - sigma * sigma / 2);
}
function yearBudget(life) {
  const c = life.countryData || {}, s = life.stats, age = life.age;
  const base = 0.55 * (c.ppp || 12000);
  const r = socialRate(c);
  const q = Math.min(4, Math.max(1, s.incomeQuartile || 2));
  const zero = { income: 0, pension: 0, taxes: 0, aid: 0, living: 0, health: 0, school: 0, habit: 0, comfort: 0, saved: 0, r };
  if (age < 18) return zero;
  let income = 0;
  if (s.employment === 'employed') {
    const edu = [0.6, 0.75, 0.9, 1.0, 1.4][Math.min(s.education, 4)] ?? 0.9;
    const experience = Math.min(1, 0.6 + (age - 18) * 0.02);
    income = base * Math.pow(quartileShare(c, q), 0.7) * edu * experience * (life.job?.mult || 1) * (life.priority === 'work' ? 1.06 : life.priority === 'growth' ? 1.02 : 1);
    life.lastWage = income;
    if (age >= 66) income *= age >= 72 ? 0.5 : 0.75;   // on travaille moins vite quand les forces baissent
  }
  const basicPension = (c.ppp || 0) > 6000 || r > 0.08 ? 0.12 * base : 0;   // minimum vieillesse là où il existe
  const pension = s.employment === 'retired' ? (hasPension(life) ? (life.lastWage || base * 0.6) * Math.min(0.7, r * 2.3) * (life.retireSaver ? 1.15 : 1) : basicPension) : 0;
  if (life.herd) income += (HERD[life.herd.type]?.inc || 0.05) * base * (life.herd.n || 1);
  const gross = income + pension;
  const taxes = gross * Math.min(0.5, r * [0.6, 0.9, 1.15, 1.5][q - 1]);
  const kidsAtHome = (s.kids || []).filter(k => age - k.bornAt < 20).length;
  const aid = r * 1.5 * Math.max(0, 0.6 * base - gross) + r * 0.15 * base * kidsAtHome;
  const net = gross - taxes + aid;
  const couple = s.married || s.relationship === 'cohab';
  const fullLiving = 0.42 * base * (s.birthPlaceType === 'rural' ? 0.85 : 1.15) * (couple ? 0.8 : 1) * (1 + 0.2 * kidsAtHome);
  const hs = life.housing;
  if (hs && hs.type === 'mortgage' && age >= hs.end) hs.type = 'own';   // prêt remboursé
  const housingAdj = !hs ? 1 : hs.type === 'own' ? 0.85 : hs.type === 'family' ? 0.7 : 1;
  const vehicle = (life.hasCar ? 0.08 * base : 0) + (life.hasMoto ? 0.04 * base : 0);
  const mortgage = hs && hs.type === 'mortgage' ? hs.annual : 0;
  const living = Math.min(fullLiving * housingAdj + vehicle + mortgage, Math.max(0, net * 0.9));      // les plus pauvres se privent : on ne dépense pas ce qu'on n'a pas
  const insPremium = life.insured ? 0.025 * base : 0;
  const health = 0.07 * base * (age < 40 ? 0.5 : age < 60 ? 1 : age < 75 ? 1.8 : 2.6) * (c.oop ?? 30) / 100 * (life.insured ? 0.5 : 1) + (life.careCost || 0) * (life.insured ? 0.5 : 1) + insPremium;
  const school = s.employment === 'university' ? 0.25 * base * (1 - Math.min(0.9, r * 3)) : 0;
  // On ne dépense pas en tabac ou en alcool ce qu'on n'a pas : le coût est plafonné au disponible après les dépenses de base.
  const habitRaw = (life.smoker ? 0.03 * base : 0) + (life.drinker ? 0.025 * base : 0) + (life.addicted ? 0.15 * base : 0);
  const habit = Math.min(habitRaw, Math.max(0, net - living - health - school));
  const priCost = ({ health: 0.02, growth: 0.015, leisure: 0.02, family: 0.01 })[life.priority] || 0;
  const comfort = Math.max(0, net - living - health - school - habit) * 0.5 + Math.min(priCost * base, Math.max(0, net - living - health - school - habit) * 0.4);
  return { income, pension, taxes, aid, living, health, school, habit, comfort, saved: net - living - health - school - habit - comfort, r };
}
function applyYearBudget(life) {
  const b = yearBudget(life);
  life.budget = b;
  life.stats.annualIncome = Math.round(b.income + b.pension);
  life.stats.netAssets += Math.round(b.saved);
}
/* ==== Grille de vie ====
   Une case par année : la couleur suit le bonheur, une lettre marque les grands évènements.
   Au survol (ou au toucher) d'une case, une fenêtre sombre résume l'année. */
const GRID_MARKS = [['É', /🎓|📚|🎒|🧑‍🏫|📖/], ['T', /💼|🏭|📈|🧱|🛠|📉/], ['♡', /❤|💍|💞|💔|💐/], ['✿', /🕯|🕊/], ['→', /✈|🧳|🌍|🚤|🏠|📦|🛂/], ['+', /👶|🍼/]];
function gridMark(entries, age) {
  const icons = entries.map(e => e.icon || '').join('');
  for (const [ch, re] of GRID_MARKS) { if (re.test(icons.replace(age === 0 ? /👶/g : '', ''))) return ch; }
  return '';
}
function gridColor(h) {
  const t = Math.max(0, Math.min(1, (h - 40) / 45));
  const a = [214, 218, 168], b = [43, 110, 106];
  return 'rgb(' + a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',') + ')';
}
function ensureGridTip() {
  let tip = document.getElementById('lgTip');
  if (!tip) { tip = document.createElement('div'); tip.id = 'lgTip'; tip.className = 'lg-tip'; tip.hidden = true; document.body.appendChild(tip); }
  return tip;
}
function showGridTip(cell) {
  const L = STATE.life; if (!L) return;
  const age = +cell.dataset.age;
  const fr = LANG === 'fr';
  const hist = (L.hist || {})[age];
  const year = L.year + age;
  const lines = ['<b>' + age + (fr ? ' ans' : ' y') + ' · ' + year + '</b>'];
  if (hist) {
    lines.push((fr ? 'Bonheur ' : 'Happiness ') + Math.round(hist.h) + ' · ' + (fr ? 'Santé ' : 'Health ') + Math.round(hist.he) + ' · ' + (fr ? 'patrimoine net ' : 'net worth ') + money(hist.a));
    const bits = [];
    if (hist.habit) bits.push((fr ? 'Tabac, alcool, drogues −' : 'Tobacco, alcohol, drugs −') + money(hist.habit));
    if (hist.saved) bits.push((fr ? 'Mis de côté ' : 'Saved ') + (hist.saved < 0 ? '−' : '+') + money(Math.abs(hist.saved)));
    if (bits.length) lines.push(bits.join(' · '));
  }
  L.log.filter(e => e.age === age).slice(0, 5).forEach(e => lines.push((e.icon ? e.icon + ' ' : '') + escapeHtml(e.text)));
  const tip = ensureGridTip();
  tip.innerHTML = lines.join('<br>');
  tip.hidden = false;
  const r = cell.getBoundingClientRect();
  const w = Math.min(340, innerWidth - 24);
  tip.style.width = w + 'px';
  tip.style.left = Math.max(12, Math.min(innerWidth - w - 12, r.left + r.width / 2 - w / 2)) + 'px';
  const below = r.bottom + 10;
  tip.style.top = (below + tip.offsetHeight > innerHeight ? Math.max(8, r.top - tip.offsetHeight - 10) : below) + 'px';
}
function hideGridTip() { const t = document.getElementById('lgTip'); if (t) t.hidden = true; }
function renderLifeGrid() {
  const el = $('#lifeGrid');
  if (!el || !STATE.life) return;
  const L = STATE.life, fr = LANG === 'fr';
  const c = L.countryData || {};
  const le = Math.round(L.sex === 'M' ? (c.le || 75) - (c.gap || 5) / 2 : (c.le || 75) + (c.gap || 5) / 2);
  const total = Math.ceil(Math.max(le + 8, L.age + 4) / 10) * 10;
  let html = '<h4>' + (fr ? 'Grille de vie' : 'Life grid') + ' <span class="muted">' + (fr ? '1 case = 1 an' : '1 cell = 1 year') + '</span></h4><div class="lg-grid" role="list">';
  for (let a = 0; a < total; a++) {
    const past = a <= L.age, hist = (L.hist || {})[a];
    const entries = past ? L.log.filter(e => e.age === a) : [];
    const mark = past ? gridMark(entries, a) : '';
    const style = past ? ' style="background:' + gridColor(hist ? hist.h : L.stats.happiness) + '"' : '';
    html += '<button type="button" class="lg-cell' + (a === L.age ? ' now' : '') + (a === le ? ' le' : '') + (past ? '' : ' future') + '" data-age="' + a + '"' + style + (past ? '' : ' disabled') + ' aria-label="' + a + (fr ? ' ans' : '') + '">' + mark + '</button>';
  }
  html += '</div><p class="muted lg-legend">' + (fr ? 'Plus le vert est foncé, plus l\'année a été heureuse. É études · T travail · ♡ amour · ✿ deuil · → déménagement · + naissance. Case encadrée en gris : espérance de vie de votre pays pour ' + (L.sex === 'M' ? 'un homme' : 'une femme') + ' (' + le + ' ans).'
    : 'The darker the green, the happier the year. Grey outline: life expectancy for your country (' + le + ' years).') + '</p>';
  el.innerHTML = html;
  el.querySelectorAll('.lg-cell:not(.future)').forEach(cell => {
    cell.addEventListener('mouseenter', () => showGridTip(cell));
    cell.addEventListener('focus', () => showGridTip(cell));
    cell.addEventListener('click', (e) => { e.stopPropagation(); showGridTip(cell); });
    cell.addEventListener('mouseleave', hideGridTip);
    cell.addEventListener('blur', hideGridTip);
  });
}
document.addEventListener('click', () => hideGridTip());

/* ==== Indicateurs complémentaires (colonne de gauche) ==== */
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
function sigmaOfGini(gi) {
  const g = Math.min(0.7, Math.max(0.2, gi || 0.38)), pr = (g + 1) / 2;
  return Math.SQRT2 * 4.91 * (Math.pow(pr, 0.14) - Math.pow(1 - pr, 0.14));
}
function topPercent(income, mean, sigma) {
  if (!(income > 0)) return null;
  return Math.max(0.1, Math.min(99.9, (1 - normCdf((Math.log(income / mean) + sigma * sigma / 2) / sigma)) * 100));
}
function vehicleOf(life) {
  const c = life.countryData || {}, base = 0.55 * (c.ppp || 12000);
  const r = (life.stats.annualIncome || 0) / base;
  if (life.age < 18) return null;
  if (r >= 0.9 && (c.ppp || 0) >= 12000) return 'car';
  if ((c.ppp || 0) >= 2500 && (c.road || 0) > 12 && r >= 0.4) return 'moto';
  if (r >= 0.3) return 'bike';
  return null;
}
function renderIndicators() {
  const el = $('#lifeIndicators');
  if (!el || !STATE.life) return;
  const L = STATE.life, c = L.countryData || {}, fr = LANG === 'fr';
  const T = fr
    ? { pos: 'Position de revenu', top: 'dans le top', world: 'Monde', year: 'Patrimoine net, année écoulée', assets: 'Vos biens', move: 'Déplacements', split: "Où va le revenu d'une année (estimation)",
        home: 'Logement', parents: 'chez vos parents', owner: 'propriétaire', tenant: 'locataire', phone: 'Smartphone', basic: 'Téléphone simple', car: 'Voiture', moto: 'Moto', bike: 'Vélo', savings: 'Épargne', debt: 'Dette',
        foot: 'À pied', bus: 'Bus', metro: 'Métro et bus', cycle: 'Vélo', carMove: 'Voiture', motoMove: 'Moto', saved: "Mis de côté sur vos revenus", habit: 'Tabac, alcool, drogues', none: 'Aucun mouvement notable',
        cat: { taxes: 'Impôts et cotisations', food: 'Alimentation', housing: 'Logement et énergie', transport: 'Transports', health: 'Santé', school: 'Études', habit: 'Tabac, alcool, drogues', comfort: 'Loisirs et équipement', saved: 'Épargne' } }
    : { pos: 'Income position', top: 'in the top', world: 'World', year: 'Net worth, past year', assets: 'Your belongings', move: 'Getting around', split: 'Where a year of income goes (estimate)',
        home: 'Housing', parents: 'with your parents', owner: 'owner', tenant: 'tenant', phone: 'Smartphone', basic: 'Basic phone', car: 'Car', moto: 'Motorbike', bike: 'Bicycle', savings: 'Savings', debt: 'Debt',
        foot: 'On foot', bus: 'Bus', metro: 'Metro and bus', cycle: 'Bicycle', carMove: 'Car', motoMove: 'Motorbike', saved: 'Saved from your income', habit: 'Tobacco, alcohol, drugs', none: 'Nothing notable',
        cat: { taxes: 'Taxes', food: 'Food', housing: 'Housing and energy', transport: 'Transport', health: 'Health', school: 'Education', habit: 'Tobacco, alcohol, drugs', comfort: 'Leisure and equipment', saved: 'Savings' } };
  const base = 0.55 * (c.ppp || 12000);
  const inc = L.stats.annualIncome > 0 ? L.stats.annualIncome : base * quartileShare(c, Math.min(4, Math.max(1, L.stats.incomeQuartile || 2)));
  const topC = topPercent(inc, base, sigmaOfGini(c.gi)), topW = topPercent(inc, 0.55 * 22000, 1.15);
  const fmtTop = (v) => v == null ? '—' : (v < 10 ? v.toFixed(1) : Math.round(v)) + ' %';
  const pos = '<div class="ind-block"><div class="ind-h">' + T.pos + '</div><div class="ind-v">' + localize(c).name + ' : ' + T.top + ' ' + fmtTop(topC) + ' · ' + T.world + ' : ' + T.top + ' ' + fmtTop(topW) + '</div></div>';
  // flux de l'année
  const b = L.budget || {};
  const flows = (L.flows || []).filter(f => f.age === L.age);
  const rows = [];
  if (b.saved) rows.push([b.saved < 0 ? (fr ? 'Prélevé sur vos économies' : 'Taken from savings') : T.saved, b.saved]);
  flows.forEach(f => rows.push([f.label || (fr ? 'Divers' : 'Other'), f.amt]));
  if (b.habit) rows.push([T.habit, -b.habit]);
  const delta = rows.reduce((a, r) => a + r[1], 0);
  const yearHtml = '<div class="ind-block"><div class="ind-h">' + T.year + ' : ' + (delta < 0 ? '−' : '+') + money(Math.abs(delta)) + '</div>'
    + (rows.length ? rows.map(r => '<div class="ind-row"><span>' + escapeHtml(r[0]) + '</span><b class="' + (r[1] < 0 ? 'bud-minus' : 'bud-plus') + '">' + (r[1] < 0 ? '−' : '+') + money(Math.abs(r[1])) + '</b></div>').join('') : '<div class="ind-row muted">' + T.none + '</div>') + '</div>';
  // biens
  const veh = vehicleOf(L), items = [];
  items.push(T.home + ' : ' + (L.age < 18 ? T.parents : L.ownsHome ? T.owner : T.tenant));
  if (L.age >= 10) items.push(L.stats.netAssets >= 30 && (c.net || 0) >= 30 ? T.phone : T.basic);
  if (veh) items.push(T[veh]);
  items.push(L.stats.netAssets >= 0 ? T.savings + ' : ' + money(L.stats.netAssets) : T.debt + ' : ' + money(-L.stats.netAssets));
  const assetsHtml = '<div class="ind-block"><div class="ind-h">' + T.assets + '</div><div class="ind-v">' + items.join(' · ') + '</div></div>';
  // déplacements
  const urban = L.stats.birthPlaceType !== 'rural';
  const mode = veh === 'car' ? T.carMove : veh === 'moto' ? T.motoMove : ['NLD', 'DNK'].includes(L.country) ? T.cycle : (urban && (c.ppp || 0) >= 20000) ? T.metro : (urban || (c.ppp || 0) >= 8000) ? T.bus : T.foot;
  const moveHtml = '<div class="ind-block"><div class="ind-h">' + T.move + '</div><div class="ind-v">' + mode + '</div></div>';
  // répartition
  let splitHtml = '';
  if (b && L.age >= 18 && (b.income + b.pension + b.aid) > 0) {
    const parts = [['taxes', b.taxes], ['food', b.living * 0.45], ['housing', b.living * 0.4], ['transport', b.living * 0.15], ['health', b.health], ['school', b.school], ['habit', b.habit], ['comfort', b.comfort], ['saved', Math.max(0, b.saved)]].filter(x => x[1] > 0);
    const sum = parts.reduce((a, x) => a + x[1], 0) || 1;
    const colors = { taxes: '#5f6b70', food: '#9a7430', housing: '#7d2037', transport: '#2b6e6a', health: '#a63e32', school: '#4a6da8', habit: '#444', comfort: '#c8d0cc', saved: '#162126' };
    splitHtml = '<div class="ind-block"><div class="ind-h">' + T.split + '</div><div class="ind-bar">'
      + parts.map(x => '<i style="width:' + (x[1] / sum * 100).toFixed(1) + '%;background:' + colors[x[0]] + '" title="' + T.cat[x[0]] + '"></i>').join('') + '</div><div class="ind-legend">'
      + parts.map(x => '<span><i style="background:' + colors[x[0]] + '"></i>' + T.cat[x[0]] + ' ' + Math.round(x[1] / sum * 100) + ' %</span>').join('') + '</div></div>';
  }
  el.innerHTML = pos + yearHtml + assetsHtml + moveHtml + splitHtml;
}

/* ==== Fiche d'identité et « Famille et vie » ==== */
function eduLabel(life) {
  const e = life.stats.education, fr = LANG === 'fr';
  if (life.age < 6) return fr ? "Pas encore à l'école" : 'Not in school yet';
  if (life.stats.employment === 'university') return fr ? "Université (en cours)" : 'University (ongoing)';
  return (fr ? ['Aucune scolarité', 'Primaire', 'Collège', 'Lycée', 'Université (diplômé{e})'] : ['No schooling', 'Primary', 'Lower secondary', 'Upper secondary', 'University graduate'])[Math.min(4, Math.max(0, e))];
}
function jobLine(life) {
  const fr = LANG === 'fr';
  if (life.age < 6) return fr ? 'Enfant' : 'Child';
  if (life.job && life.stats.employment === 'employed') return genderize(fr ? life.job.fr : life.job.en, life);
  if (life.stats.employment === 'university') return fr ? 'Étudiant{e}' : 'Student';
  if (life.stats.employment === 'retired') return fr ? 'Retraité{e}' : 'Retired';
  if (life.age < 18) return fr ? 'Élève' : 'Pupil';
  if (life.stats.employment === 'seeking') return fr ? 'En recherche d\'emploi' : 'Job seeking';
  return life.stats.employment === 'employed' ? (fr ? 'En poste' : 'Employed') : '—';
}
function renderIdCard() {
  const el = $('#lifeIdCard');
  if (!el || !STATE.life) return;
  const L = STATE.life, c = L.countryData || {}, fr = LANG === 'fr';
  const home = L.birthOrigin ? countryById(L.birthOrigin.country) : c;
  const G = (t2) => genderize(t2, L);
  const dots = '●'.repeat(L.stats.incomeQuartile || 1) + '○'.repeat(4 - (L.stats.incomeQuartile || 1));
  const rows = [
    [fr ? 'Sexe' : 'Sex', L.sex === 'M' ? (fr ? 'Homme' : 'Male') : (fr ? 'Femme' : 'Female')],
    [fr ? 'Naissance' : 'Born', localize(home).name + ' · ' + (L.year) ],
    [fr ? 'Résidence' : 'Residence', (L.stats.birthPlaceType === 'rural' ? (fr ? 'Campagne, ' : 'Countryside, ') : (fr ? 'Ville, ' : 'City, ')) + localize(c).name + (L.birthOrigin ? (fr ? " (à l'étranger)" : ' (abroad)') : '')],
  ];
  if (L.birthOrigin) rows.push([fr ? 'Nationalité' : 'Nationality', localize(home).name + (L.naturalized ? ' · ' + localize(c).name + (fr ? ' (double nationalité)' : ' (dual)') : '')]);
  rows.push([fr ? 'Religion' : 'Religion', L.stats.religion || '—'],
            [fr ? 'Milieu familial' : 'Family background', dots],
            [fr ? 'Études' : 'Education', G(eduLabel(L))],
            [fr ? 'Profession' : 'Occupation', G(jobLine(L))]);
  if (L.age >= 15) {
    const k = (L.stats.kids || []).length, pn = L.stats.partner && L.stats.partner.name;
    rows.push([fr ? 'Situation' : 'Status', G(relLabel(L)) + (pn && L.stats.relationship !== 'single' ? ' · ' + escapeHtml(pn.first || pn.full || '') : '')]);
    if (k) rows.push([fr ? 'Enfants' : 'Children', k + ' (' + L.stats.kids.map(x => (L.age - x.bornAt) + (fr ? ' ans' : '')).join(', ') + ')']);
    const pets = (L.pets || []).filter(x => x.to == null);
    if (pets.length) rows.push([fr ? 'Animaux' : 'Pets', pets.map(x => (x.type === 'dog' ? '🐕 ' : '🐈 ') + x.name).join(', ')]);
    if (L.herd) rows.push([fr ? 'Bétail' : 'Livestock', (HERD[L.herd.type]?.icon || '') + ' ' + (HERD[L.herd.type]?.fr || '')]);
    const H = L.housing;
    rows.push([fr ? 'Logement' : 'Home', L.age < 18 ? (fr ? 'Chez vos parents' : 'With parents') : !H ? (L.ownsHome ? (fr ? 'Propriétaire' : 'Owner') : (fr ? 'Locataire' : 'Renting')) : ({ own: fr ? 'Propriétaire' : 'Owner', mortgage: fr ? 'Propriétaire (prêt en cours)' : 'Owner (mortgage)', rent: fr ? 'Locataire' : 'Renting', family: fr ? 'Chez la famille' : 'With family' })[H.type]]);
    const tr = [L.hasCar && '🚗', L.hasMoto && '🏍️', L.hasBike && '🚲'].filter(Boolean).join(' ');
    if (tr) rows.push([fr ? 'Transport' : 'Transport', tr]);
  }
  if (L.traits) rows.push([fr ? 'Tempérament' : 'Temperament', G(L.traits.temperament)], [fr ? 'Talents' : 'Talents', G(L.traits.talents)], [fr ? 'Rêve d\'enfant' : 'Childhood dream', G(L.traits.dream)]);
  const iso = (c.id || '').toString();
  el.innerHTML = '<div class="id-head"><span>' + (fr ? "Fiche d'identité" : 'Identity card') + ' · ' + iso + '</span><span>' + (L.year) + '</span></div>'
    + rows.map(r => '<div class="id-line"><span>' + r[0] + '</span><b>' + r[1] + '</b></div>').join('');
}
function renderFamilyLife() {
  const el = $('#lifeFamilyLife');
  if (!el || !STATE.life) return;
  const L = STATE.life, fr = LANG === 'fr', year = L.year + L.yearOffset;
  const F = L.family || { parents: [], siblings: [] };
  const rel = L.rel || {};
  const person = (p, relKey, label, detail) => {
    if (!p) return '<div class="fl-row"><span>' + label + '</span><b class="muted">' + (fr ? 'Ne vit pas avec vous' : 'Not part of your life') + '</b></div>';
    const dead = pastDeathYear(p), age = (dead || year) - (p.birth?.year || year);
    const r = rel[relKey] === 'distante' ? ' <em>· ' + (fr ? 'relation distante' : 'distant') + '</em>' : '';
    return '<div class="fl-row"><span>' + label + '</span><b' + (dead ? ' class="gone"' : '') + '>' + escapeHtml(p.name) + ' · ' + age + (fr ? ' ans' : '') + (dead ? ' ✝' : '') + r + (detail ? '<small>' + detail + '</small>' : '') + '</b></div>';
  };
  const mother = (F.parents || []).find(p => p.sex === 'F'), father = (F.parents || []).find(p => p.sex === 'M');
  const jobOf = (p, d) => (d && d.job ? (year - (p.birth?.year || year) >= 62 ? d.job + (fr ? ' à la retraite' : ' (retired)') : d.job) : '');
  let h = '<h4>' + (fr ? 'Famille et vie' : 'Family and life') + '</h4>';
  h += person(mother, 'mother', fr ? 'Mère' : 'Mother', jobOf(mother, L.motherDetail));
  h += person(father, 'father', fr ? 'Père' : 'Father', jobOf(father, L.fatherDetail));
  const sibs = (F.siblings || []).map(x => escapeHtml(x.name.split(' ')[0]) + ' (' + (year - (x.birth?.year || year)) + ')').join(', ');
  h += '<div class="fl-row"><span>' + (fr ? 'Frères et sœurs' : 'Siblings') + '</span><b>' + (sibs || (fr ? 'Aucun' : 'None')) + '</b></div>';
  if (L.stats.partner) { const pn = L.stats.partner.name; h += '<div class="fl-row"><span>' + (fr ? 'Conjoint(e)' : 'Partner') + '</span><b>' + escapeHtml(pn.full || pn.full_en || '') + ' · ' + relLabel(L) + '</b></div>'; }
  if ((L.stats.kids || []).length) h += '<div class="fl-row"><span>' + (fr ? 'Enfants' : 'Children') + '</span><b>' + L.stats.kids.map(k => (L.age - k.bornAt) + (fr ? ' ans' : '')).join(', ') + '</b></div>';
  if (L.friends && L.friends.length) h += '<div class="fl-row"><span>' + (fr ? 'Amis' : 'Friends') + '</span><b>' + L.friends.map(f => escapeHtml(f.name) + (f.closeness === 'distante' ? ' <em>· ' + (fr ? 'relation distante' : 'distant') + '</em>' : '')).join(', ') + '</b></div>';
  if (L.pets && L.pets.length) h += '<div class="fl-row"><span>' + (fr ? 'Animal de compagnie' : 'Pets') + '</span><b>' + L.pets.map(x => '<span' + (x.to != null ? ' class="gone"' : '') + '>' + x.name + ' (' + (x.type === 'dog' ? (fr ? 'chien' : 'dog') : (fr ? 'chat' : 'cat')) + ')</span>').join(', ') + '</b></div>';
  const hb = Object.entries(L.hobbies || {}).map(([k, v]) => k + ' Lv.' + Math.round(v)).join(', ');
  if (hb) h += '<div class="fl-row"><span>' + (fr ? 'Loisirs' : 'Hobbies') + '</span><b>' + hb + '</b></div>';
  const habits = [L.smoker ? (fr ? 'Tabac' : 'Smoking') : L.exSmoker ? (fr ? 'Ancien fumeur' : 'Ex-smoker') : null, L.drinker ? (fr ? 'Alcool' : 'Alcohol') : null, L.addicted ? (fr ? 'Drogues' : 'Drugs') : null, L.sporty ? (fr ? 'Sport régulier' : 'Regular sport') : null].filter(Boolean);
  if (habits.length) h += '<div class="fl-row"><span>' + (fr ? 'Habitudes' : 'Habits') + '</span><b>' + habits.join(', ') + '</b></div>';
  if (L.illness && L.illness.status !== 'resolved') h += '<div class="fl-row"><span>' + (fr ? 'Santé' : 'Health') + '</span><b>' + ({ cancer: fr ? 'Cancer' : 'Cancer', heart: fr ? 'Maladie du cœur' : 'Heart disease', stroke: 'AVC', diabetes: fr ? 'Diabète' : 'Diabetes' })[L.illness.type] + (L.illness.status === 'remission' ? (fr ? ' · en rémission' : ' · remission') : L.illness.treated === 'none' ? (fr ? ' · non soigné' : ' · untreated') : '') + '</b></div>';
  el.innerHTML = h;
}
function renderFinSide() {
  const el = $('#finSide');
  if (!el || !STATE.life) return;
  { const hero = document.querySelector('.life-hero'); if (hero && el.previousElementSibling !== hero) hero.after(el); }   // juste sous l'âge et le patrimoine, dans la colonne de gauche
  const L = STATE.life, b = L.budget || {}, fr = LANG === 'fr', H = L.housing;
  const row = (k, v, cls) => '<div class="fs-row"><span>' + k + '</span><b' + (cls ? ' class="' + cls + '"' : '') + '>' + v + '</b></div>';
  const sgn = (v) => (v >= 0 ? '+ ' : '− ') + money(Math.abs(v));
  let h = '<h4>💶 ' + (fr ? 'Situation financière' : 'Finances') + '</h4>';
  if (L.age < 18) h += '<p class="fs-note">' + (fr ? 'Vos parents subviennent à vos besoins.' : 'Your parents provide for you.') + '</p>';
  else {
    h += row(fr ? 'Dépenses par an' : 'Spending / year', money((b.taxes || 0) + (b.living || 0) + (b.health || 0) + (b.school || 0) + (b.habit || 0) + (b.comfort || 0)));
    h += row(fr ? 'Épargne par an' : 'Saved / year', sgn(b.saved || 0), (b.saved || 0) < 0 ? 'neg' : 'pos');
    const lodge = L.age < 18 ? '' : !H ? (L.ownsHome ? (fr ? 'propriétaire' : 'owner') : (fr ? 'locataire' : 'renting')) : ({ own: fr ? 'propriétaire' : 'owner', mortgage: (fr ? 'prêt jusqu\'à ' : 'mortgage until ') + H.end + (fr ? ' ans' : ''), rent: fr ? 'locataire' : 'renting', family: fr ? 'chez la famille' : 'with family' })[H.type];
    if (lodge) h += row(fr ? 'Logement' : 'Home', lodge);
    if (L.herd) h += row(fr ? 'Bétail' : 'Livestock', (HERD[L.herd.type]?.icon || '') + ' ' + (HERD[L.herd.type]?.fr || ''));
    if (L.stats.netAssets < 0) h += '<p class="fs-note warn">' + (fr ? 'Vous êtes endetté : chaque année, vos remboursements pèsent sur le budget.' : 'You are in debt.') + '</p>';
  }
  h += '<button type="button" class="fs-more" id="finSideMore">' + (fr ? 'Comparer avec d\'autres pays' : 'Compare with other countries') + '</button>';
  el.innerHTML = h;
  $('#finSideMore')?.addEventListener('click', () => showFinanceModal());
}
function renderBudget() {
  const el = $('#lifeBudget');
  if (!el || !STATE.life) return;
  const T = LANG === 'fr'
    ? { title: "Budget de l'année", child: "Vos parents subviennent à vos besoins jusqu'à 18 ans.", income: 'Revenu du travail', pension: 'Pension de retraite', aid: 'Aides et prestations sociales',
        taxes: 'Impôts et cotisations', living: 'Logement, alimentation, énergie', health: 'Santé (reste à charge)', school: "Frais d'études", habit: 'Tabac, alcool, drogues', comfort: 'Loisirs et équipement', saved: "Épargne de l'année",
        note: 'Dépenses sociales du pays : environ {r} % de la richesse nationale (estimation). Plus ce taux est élevé, plus les impôts, les aides et la retraite pèsent dans le budget.' }
    : { title: "This year's budget", child: 'Your parents provide for you until 18.', income: 'Work income', pension: 'Retirement pension', aid: 'Benefits and allowances',
        taxes: 'Taxes and contributions', living: 'Housing, food, energy', health: 'Health (out of pocket)', school: 'Tuition', habit: 'Tobacco, alcohol, drugs', comfort: 'Leisure and equipment', saved: "This year's savings",
        note: "The country's social spending: about {r}% of national income (estimate). The higher it is, the more taxes, benefits and pensions weigh in the budget." };
  const b = STATE.life.budget;
  const prevSnap = (STATE.life.hist || {})[STATE.life.age - 1];
  let tailRows = '';
  if (b && prevSnap) {
    const delta = STATE.life.stats.netAssets - prevSnap.a, ret = STATE.life.lastReturn || 0, ev = delta - (b.saved || 0) - ret;
    const fr2 = LANG === 'fr';
    const sg = (v) => (v < 0 ? '− ' : '+ ') + money(Math.abs(v));
    tailRows = (Math.round(ret) ? '<div class="bud-row"><span>' + (fr2 ? "Rendement de l'épargne" : 'Return on savings') + '</span><b>' + sg(ret) + '</b></div>' : '')
      + (Math.round(ev) ? '<div class="bud-row"><span>' + (fr2 ? 'Évènements et imprévus de l\'année' : 'Events and surprises') + '</span><b>' + sg(ev) + '</b></div>' : '')
      + '<div class="bud-row bud-total"><span>' + (fr2 ? 'Variation du patrimoine' : 'Change in net worth') + '</span><b>' + sg(delta) + '</b></div>';
  }
  if (!b || STATE.life.age < 18) { el.innerHTML = '<h4>💶 ' + T.title + '</h4><p class="muted">' + T.child + '</p>'; return; }
  const row = (label, v, sign) => Math.round(v) ? '<div class="bud-row"><span>' + label + '</span><b class="' + (sign > 0 ? 'bud-plus' : 'bud-minus') + '">' + (sign > 0 ? '+ ' : '− ') + money(Math.abs(v)) + '</b></div>' : '';
  el.innerHTML = '<h4>💶 ' + T.title + '</h4>'
    + row(T.income, b.income, 1) + row(T.pension, b.pension, 1) + row(T.aid, b.aid, 1)
    + row(T.taxes, b.taxes, -1) + row(T.living, b.living, -1) + row(T.health, b.health, -1) + row(T.school, b.school, -1) + row(T.habit, b.habit, -1) + row(T.comfort, b.comfort, -1)
    + '<div class="bud-row bud-total"><span>' + T.saved + '</span><b>' + (b.saved < 0 ? '− ' : '+ ') + money(Math.abs(b.saved)) + '</b></div>'
    + tailRows
    + '<p class="muted bud-note">' + T.note.replace('{r}', Math.round(b.r * 100)) + '</p>';
}

// Les montants du jeu sont en dollars PPA ; taux fixes approximatifs pour l'affichage.
const CURRENCY_RATES = { 'NT$': 30, 'HK$': 7.8, 'MOP$': 8.05, 'CNY': 7.2, 'US$': 1, '€': 0.92 };
function money(usd) {
  const cur = (STATE.life && STATE.life.currency) || (LANG.startsWith('zh') ? 'NT$' : LANG === 'fr' ? '€' : 'US$');
  const v = Math.round((usd || 0) * (CURRENCY_RATES[cur] || 1));
  return cur === '€' ? v.toLocaleString('fr-FR') + ' €' : cur + v.toLocaleString();
}
function setCurrency(cur) {
  if (!STATE.life) return;
  STATE.life.currency = cur;
  const s = STATE.life.stats;
  if (!CURRENCY_RATES[cur]) return;
  const na = $('#netAssets');
  if (na) na.textContent = money(s.netAssets);
  document.querySelectorAll('.fin-price').forEach(el => {
    if (el.dataset.basePrice) el.textContent = money(parseFloat(el.dataset.basePrice));
  });
  renderLife();
}

/* v5.22：主題切換（light/dark/sepia） */
function setTheme(theme) {
  document.body.classList.remove('theme-light','theme-dark','theme-sepia');
  if (theme === 'auto') theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'theme-dark' : 'theme-light';
  document.body.classList.add(theme);
  localStorage.setItem('born-somewhere-v2:theme', theme);
}

function importLifeJSON(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const payload = JSON.parse(reader.result);
      if (payload.type !== 'born-somewhere-life') throw new Error(LANG === 'en' ? 'Invalid format' : LANG === 'fr' ? "Format invalide" : '格式不正確');
      if (payload.state?.life) {
        STATE.life = payload.state.life;
        if (payload.state.pastLives) localStorage.setItem(STORAGE_KEY + ':past', JSON.stringify(payload.state.pastLives));
        if (payload.state.importedFamily) STATE.importedFamily = payload.state.importedFamily;
        stopTicker();
        setView('life');
        renderAll();
        toast(LANG === 'en' ? 'Life imported — press ⏸/▶ to resume' : LANG === 'fr' ? "Vie importée — appuyez sur ⏸/▶ pour reprendre" : '已匯入生涯，按 ⏸/▶ 繼續');
      } else { throw new Error('No life data'); }
    } catch (e) {
      console.error(e);
      toast(LANG === 'en' ? 'Import failed: ' + e.message : '匯入失敗：' + e.message);
    }
  };
  reader.readAsText(file);
}

function loadFromHash() {
  const m = location.hash.match(/#tree=([^&]+)/);
  if (!m) return false;
  try {
    const json = decodeURIComponent(escape(atob(m[1])));
    const payload = JSON.parse(json);
    if (!payload.people || !payload.people.length) return false;
    STATE.importedFamily = { _meta: payload.meta, people: {} };
    payload.people.forEach(p => { STATE.importedFamily.people[p.id] = p; });
    const self = payload.people.find(p => p.id === 'self') || payload.people[0];
    STATE.life = {
      country: self.country || 'TWN',
      countryData: countryById(self.country || 'TWN'),
      name: { full: self.name, full_en: self.nameEn || '' },
      sex: self.sex || 'U',
      age: 30, year: new Date().getFullYear(),
      yearOffset: 0,
      family: { parents: [], siblings: [], grandparents: [], partner: null, kids: [] }
    };
    TREE_STATE.rootId = 'self';
    setView('tree');
    renderTree();
    toast(LANG === 'en' ? 'Loaded from URL' : LANG === 'fr' ? "Chargé depuis l'adresse" : '已從連結載入');
    return true;
  } catch (e) { console.error(e); return false; }
}
  $('#treeImport')?.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = reader.result;
        const parsed = window.Gedcom.import(text);
        STATE.importedFamily = parsed;  // 存到 STATE 供 GEDCOM.parse 之後用
        if (!STATE.life) {
          toast(LANG === 'en' ? 'Start a life first, then import GEDCOM' : LANG === 'fr' ? "Commencez une vie avant d'importer un fichier GEDCOM" : '請先開始一段人生，再匯入 GEDCOM');
          return;
        }
        const f = STATE.life.family;
        f.parents = [];
        f.grandparents = [];
        f.siblings = [];
        // 自動找 self：用 @self@ xref 或姓名/出生年匹配現有 self
        const selfP = findSelfInGedcom(parsed);
        if (!selfP) {
          toast(LANG === 'en' ? 'GEDCOM imported — pick a person from Tree dropdown' : LANG === 'fr' ? "GEDCOM importé — choisissez une personne dans la liste de l'arbre" : '已匯入 GEDCOM，請從族譜中心人物選擇');
        } else {
          // 灌入 self 的家族
          const fMembers = buildFamilyAround(selfP, parsed);
          f.parents = fMembers.parents;
          f.siblings = fMembers.siblings;
          f.grandparents = fMembers.grandparents;
        }
        TREE_STATE.rootId = selfP ? 'self' : Object.keys(parsed.people)[0];
        renderTree();
        const n = Object.keys(parsed.people).length;
        toast(t('io.imported', n));
      } catch (err) {
        console.error(err);
        toast(LANG === 'en' ? 'GEDCOM parse failed: ' + err.message : 'GEDCOM 解析失敗：' + err.message);
      }
    };
    reader.readAsText(file);
  });

/* 從 zu-pu/gedcom.js 解析結果找 self：
   1) 先看有沒有 xref "@self@" 標記的
   2) 否則用 STATE.life 的名字 + 出生年匹配 */
function findSelfInGedcom(parsed) {
  const ps = Object.values(parsed.people);
  const selfTagged = ps.find(p => p.notes && p.notes.includes('@self@'));
  if (selfTagged) return selfTagged;
  if (!STATE.life) return ps[0];
  const lifeName = STATE.life.name.full || STATE.life.name.full_en || '';
  const lifeYear = STATE.life.year + STATE.life.yearOffset - STATE.life.age;
  return ps.find(p => p.name === lifeName && p.birth && p.birth.year === lifeYear) || ps[0];
}

function buildFamilyAround(selfP, parsed) {
  const ps = parsed.people;
  const parents = (selfP.parents || []).map(pid => ps[pid]).filter(Boolean);
  const siblings = [];
  // 同父母的其他人 = 手足
  parents.forEach(par => {
    (par.spouses || []).forEach(spid => {
      // 找所有 children of FAM(parents)
    });
  });
  // 直接從 parents 的 children 找
  const allSibs = new Set();
  ps[parents[0]?.id] && (ps[parents[0].id].spouses || []).forEach(spid => {
    // 這對配偶的 FAM 的 children
  });
  // 簡化：找自我以外的所有人，其 parents 包含自我任一 parent
  Object.values(ps).forEach(p => {
    if (p.id === selfP.id) return;
    if ((p.parents || []).some(pid => parents.find(par => par.id === pid))) {
      siblings.push(p);
    }
  });
  const grandparents = [];
  parents.forEach(par => {
    (par.parents || []).forEach(gpid => {
      const gp = ps[gpid];
      if (gp && !grandparents.find(g => g.id === gp.id)) grandparents.push(gp);
    });
  });
  // 轉成 born-somewhere family 格式
  return {
    parents: parents.map(p => ({
      id: 'g_' + p.id,
      name: p.name || p.nameEn || '?',
      sex: p.gender === 'F' ? 'F' : 'M',
      country: p.birthPlace || STATE.life.country,
      countryData: countryById(p.birthPlace) || STATE.life.countryData,
      birth: p.birth ? { year: p.birth.year } : null,
      death: p.death ? { year: p.death.year } : null,
      note: null,
      sourceGedcomId: p.id
    })),
    siblings: siblings.map(p => ({
      id: 'g_' + p.id,
      name: p.name || p.nameEn || '?',
      sex: p.gender === 'F' ? 'F' : 'M',
      country: p.birthPlace || STATE.life.country,
      countryData: countryById(p.birthPlace) || STATE.life.countryData,
      birth: p.birth ? { year: p.birth.year } : null,
      death: p.death ? { year: p.death.year } : null,
      note: null,
      sourceGedcomId: p.id
    })),
    grandparents: grandparents.map(p => ({
      id: 'g_' + p.id,
      name: p.name || p.nameEn || '?',
      sex: p.gender === 'F' ? 'F' : 'M',
      country: p.birthPlace || STATE.life.country,
      countryData: countryById(p.birthPlace) || STATE.life.countryData,
      birth: p.birth ? { year: p.birth.year } : null,
      death: p.death ? { year: p.death.year } : null,
      note: null,
      sourceGedcomId: p.id
    }))
  };
}

async function init() {
  await loadData();
  document.documentElement.lang = LANG;
  // v5.39：預設跟隨系統（1in8b.life 行為）；沒存過就用 auto
  const savedTheme = localStorage.getItem('born-somewhere-v2:theme') || 'auto';
  setTheme(savedTheme);  // v5.22：套用保存的主題
  checkEduMode();      // v5.19: 教學版旗標 (?edu=1)
  wire();
  renderAll();
  injectHelpFab();
  injectFooter();      // v5.19: footer + 工具列
  registerServiceWorker(); // v5.19: PWA
  setupPWAInstall();   // v5.19: beforeinstallprompt
  startRealtimeCounters(); // v5.19: 即時計數器（每秒更新）
  if (location.hash.includes('tree=')) loadFromHash();
  // v5.19 dev: hash 直接打開對應 modal（截圖 / 深連結用）
  if (location.hash === '#feedback') setTimeout(renderFeedbackModal, 200);
  if (location.hash === '#changelog') setTimeout(renderChangelogModal, 200);
  if (location.hash === '#privacy') setTimeout(renderPrivacyModal, 200);
  if (location.hash === '#terms') setTimeout(renderTermsModal, 200);
}
init();

/* =====================================================================
   v5.19 新增：footer + 工具列（feedback / changelog / privacy / terms /
   contact / PWA install）+ 教學版模式 + 版本歷史
   ===================================================================== */

// v5.98：APP_VERSION / APP_BUILD 已移到檔案最上方，與匯出圖共用同一份。

// 版本歷史（每個版本：v / date / items；每個 item 含 emoji badge + 文字）
// 為節省空間與維護成本，所有語言文字都用 i18n key；徽章 emoji 是視覺標記。
const CHANGELOG = [
  { v: '6.09', date: '2026-10-24', items: [
      { tag: 'fix', icon: '🌐', key: 'cl.6.09.ageUnit' },
    ] },
  { v: '6.08', date: '2026-10-24', items: [
      { tag: 'fix', icon: '📇', key: 'cl.6.08.birthCert' },
    ] },
  { v: '6.07', date: '2026-10-24', items: [
      { tag: 'fix', icon: '🙏', key: 'cl.6.07.religion' },
    ] },
  { v: '6.06', date: '2026-10-24', items: [
      { tag: 'fix', icon: '🖤', key: 'cl.6.06.suicide' },
    ] },
  { v: '6.05', date: '2026-10-24', items: [
      { tag: 'fix', icon: '🌳', key: 'cl.6.05.panoramaRoot' },
    ] },
  { v: '6.04', date: '2026-10-24', items: [
      { tag: 'fix', icon: '✍️', key: 'cl.6.04.decisionNote' },
    ] },
  { v: '6.03', date: '2026-10-24', items: [
      { tag: 'fix', icon: '👤', key: 'cl.6.03.nameFix' },
    ] },
  { v: '6.02', date: '2026-10-24', items: [
      { tag: 'fix', icon: '📋', key: 'cl.6.02.manageRecords' },
    ] },
  { v: '6.01', date: '2026-10-24', items: [
      { tag: 'fix', icon: '🗑️', key: 'cl.6.01.deleteAll' },
    ] },
  { v: '6.00', date: '2026-10-24', items: [
      { tag: 'fix', icon: '🌐', key: 'cl.6.00.panoramaStack' },
    ] },
  { v: '5.99', date: '2026-10-23', items: [
      { tag: 'fix', icon: '🧬', key: 'cl.5.99.gedcomSource' },
    ] },
  { v: '5.98', date: '2026-10-23', items: [
      { tag: 'fix', icon: '🔖', key: 'cl.5.98.versionSource' },
    ] },
  { v: '5.97', date: '2026-10-23', items: [
      { tag: 'fix', icon: '👥', key: 'cl.5.97.population' },
    ] },
  { v: '5.96', date: '2026-10-23', items: [
      { tag: 'fix', icon: '🖼️', key: 'cl.5.96.certPattern' },
    ] },
  { v: '5.95', date: '2026-10-23', items: [
      { tag: 'fix', icon: 'ℹ️', key: 'cl.5.95.statExplainer' },
    ] },
  { v: '5.94', date: '2026-10-23', items: [
      { tag: 'fix', icon: '📄', key: 'cl.5.94.bornLine' },
      { tag: 'fix', icon: '🔄', key: 'cl.5.94.swPrecache' },
    ] },
  { v: '5.93', date: '2026-10-23', items: [
      { tag: 'fix', icon: '⏱️', key: 'cl.5.93.doublePrompt' },
    ] },
  { v: '5.92', date: '2026-10-23', items: [
      { tag: 'fix', icon: '✍️', key: 'cl.5.92.reflectionAge' },
    ] },
  { v: '5.91', date: '2026-10-23', items: [
      { tag: 'fix', icon: '📱', key: 'cl.5.91.financeModal' },
    ] },
  { v: '5.90', date: '2026-10-23', items: [
      { tag: 'fix', icon: '❤️', key: 'cl.5.90.healthRange' },
    ] },
  { v: '5.89', date: '2026-10-23', items: [
      { tag: 'fix', icon: '🎲', key: 'cl.5.89.eventCooldown' },
    ] },
  { v: '5.20 – 5.88', date: '2026-10-23', items: [
      { tag: 'feat', icon: '💰', key: 'cl.5.20.finance' },
      { tag: 'feat', icon: '📖', key: 'cl.5.22.resume' },
      { tag: 'feat', icon: '📋', key: 'cl.5.23.shelf' },
      { tag: 'feat', icon: '🎬', key: 'cl.5.24.replay' },
      { tag: 'feat', icon: '⏱️', key: 'cl.5.25.duration' },
      { tag: 'feat', icon: '✦', key: 'cl.5.55.decisions' },
      { tag: 'feat', icon: '🔧', key: 'cl.5.59.deadValues' },
      { tag: 'feat', icon: '📊', key: 'cl.5.85.calibration' },
    ] },
  { v: '5.19', date: '2026-10-18', items: [
      { tag: 'new',    icon: '📲', key: 'cl.5.19.pwa' },
      { tag: 'new',    icon: '🎓', key: 'cl.5.19.edu' },
      { tag: 'feat',   icon: '💌', key: 'cl.5.19.feedback' },
      { tag: 'feat',   icon: '📜', key: 'cl.5.19.changelog' },
      { tag: 'feat',   icon: '🔒', key: 'cl.5.19.privacy' },
    ] },
  { v: '5.18', date: '2026-10-15', items: [
      { tag: 'feat',   icon: '🗺️', key: 'cl.5.18.map' },
      { tag: 'feat',   icon: '🛂', key: 'cl.5.18.passport' },
    ] },
  { v: '5.17', date: '2026-10-10', items: [
      { tag: 'fix',    icon: '🐛', key: 'cl.5.17.bugfix' },
      { tag: 'style',  icon: '🎨', key: 'cl.5.17.style' },
    ] },
  { v: '5.16', date: '2026-10-05', items: [
      { tag: 'feat',   icon: '🎯', key: 'cl.5.16.manual' },
      { tag: 'fix',    icon: '⚙️', key: 'cl.5.16.focus' },
    ] },
  { v: '5.15', date: '2026-09-28', items: [
      { tag: 'feat',   icon: '📈', key: 'cl.5.15.trajectory' },
    ] },
  { v: '5.14', date: '2026-09-20', items: [
      { tag: 'feat',   icon: '🎲', key: 'cl.5.14.events' },
      { tag: 'feat',   icon: '🛡️', key: 'cl.5.14.protect' },
    ] },
  { v: '5.13', date: '2026-09-10', items: [
      { tag: 'feat',   icon: '⏱️', key: 'cl.5.13.tick' },
      { tag: 'feat',   icon: '🎯', key: 'cl.5.13.focus' },
      { tag: 'feat',   icon: '💰', key: 'cl.5.13.finance' },
    ] },
  { v: '5.12', date: '2026-08-25', items: [
      { tag: 'feat',   icon: '📤', key: 'cl.5.12.share' },
    ] },
  { v: '5.11', date: '2026-08-12', items: [
      { tag: 'feat',   icon: '📉', key: 'cl.5.11.survival' },
    ] },
  { v: '5.10', date: '2026-07-30', items: [
      { tag: 'feat',   icon: '✎', key: 'cl.5.10.thoughts' },
    ] },
  { v: '5.9',  date: '2026-07-15', items: [
      { tag: 'feat',   icon: '⏭', key: 'cl.5.9.auto' },
      { tag: 'feat',   icon: '⏩', key: 'cl.5.9.skip' },
    ] },
  { v: '5.8',  date: '2026-07-01', items: [
      { tag: 'new',    icon: '⚖️', key: 'cl.5.8.status' },
      { tag: 'new',    icon: '💵', key: 'cl.5.8.assets' },
      { tag: 'new',    icon: '👨‍👩‍👧', key: 'cl.5.8.family' },
      { tag: 'new',    icon: '👥', key: 'cl.5.8.companions' },
    ] },
  { v: '5.7',  date: '2026-06-15', items: [
      { tag: 'feat',   icon: '🌳', key: 'cl.5.7.tree' },
      { tag: 'feat',   icon: '📚', key: 'cl.5.7.shelf' },
    ] },
  { v: '5.6',  date: '2026-06-01', items: [
      { tag: 'feat',   icon: '🧪', key: 'cl.5.6.lab' },
    ] },
  { v: '5.5',  date: '2026-05-20', items: [
      { tag: 'style',  icon: '🌐', key: 'cl.5.5.i18n' },
    ] },
  { v: '5.0',  date: '2026-05-01', items: [
      { tag: 'new',    icon: '🚀', key: 'cl.5.0.engine' },
    ] },
  { v: '4.x',  date: '2026-03-15', items: [
      { tag: 'feat',   icon: '🌏', key: 'cl.4.country' },
    ] },
  { v: '3.x',  date: '2026-01-20', items: [
      { tag: 'feat',   icon: '🎭', key: 'cl.3.character' },
    ] },
  { v: '2.x',  date: '2025-11-10', items: [
      { tag: 'feat',   icon: '🧬', key: 'cl.2.stats' },
    ] },
  { v: '1.0',  date: '2025-10-01', items: [
      { tag: 'new',    icon: '👶', key: 'cl.1.first' },
    ] },
];

// ==== 教學版模式 (?edu=1) ====
function checkEduMode() {
  const params = new URLSearchParams(location.search);
  STATE.eduMode = params.get('edu') === '1';
  // v5.39：略過可怕的情節 — 從 localStorage 還原；教學版一律開啟
  STATE.softMode = STATE.eduMode || localStorage.getItem(STORAGE_KEY + ':soft') === '1';
  if (STATE.softMode) localStorage.setItem(STORAGE_KEY + ':soft', '1');
  if (STATE.eduMode) {
    document.documentElement.classList.add('edu-mode');
    // 預設自動抉擇
    STATE.autoDecide = true;
    // 隱藏訃聞 + 書架 tab（書架 = 追思館）
    $$('.navbtn[data-view="end"]').forEach(el => el.hidden = true);
    $$('.navbtn[data-view="shelf"]').forEach(el => el.hidden = true);
    // 顯示教學版 badge
    const badge = $('#eduBadge');
    if (badge) badge.hidden = false;
    // 文案提示
    const sub = $('#introCountryInfoSub');
    // 不要覆蓋既有 intro.sub，避免破壞既有 i18n
  }
}

// ==== Footer 注入 ====
function injectFooter() {
  const f = $('#appFooter');
  if (!f) return;
  f.hidden = false;
  // 綁定事件
  $('#btnFeedback')?.addEventListener('click', renderFeedbackModal);
  $('#btnChangelog')?.addEventListener('click', renderChangelogModal);
  $('#btnPrivacy')?.addEventListener('click', e => { e.preventDefault(); renderPrivacyModal(); });
  $('#btnTerms')?.addEventListener('click', e => { e.preventDefault(); renderTermsModal(); });
  // contact 是 mailto，預設瀏覽器處理
  // install 按鈕在 setupPWAInstall() 處理
  // 套翻譯
  $$('#appFooter [data-t]').forEach(el => { el.textContent = t(el.dataset.t); });
}

// ==== Feedback modal ====
const FEEDBACK_MAX = 500;
function renderFeedbackModal() {
  document.querySelector('#feedbackModal')?.remove();
  const isEn = LANG === 'en';
  const html = `
    <div id="feedbackModal" class="life-modal">
      <div class="life-modal-card">
        <button class="lm-close" onclick="document.getElementById('feedbackModal').remove()">×</button>
        <h2 class="lm-title">💌 ${t('feedback.title')}</h2>
        <p class="modal-help">${t('feedback.help')}</p>
        <textarea id="feedbackInput" class="feedback-textarea" maxlength="${FEEDBACK_MAX}" placeholder="${t('feedback.placeholder')}"></textarea>
        <div class="feedback-meta">
          <span>${t('feedback.local')}</span>
          <span id="feedbackCount">0 / ${FEEDBACK_MAX}</span>
        </div>
        <div class="modal-actions" style="margin-top:14px;">
          <button class="ghost" onclick="document.getElementById('feedbackModal').remove()">${t('feedback.cancel')}</button>
          <button class="primary" id="feedbackSend">${t('feedback.send')}</button>
        </div>
      </div>
    </div>`;
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  document.body.appendChild(wrap.firstElementChild);
  const modal = $('#feedbackModal');
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  const input = $('#feedbackInput');
  const count = $('#feedbackCount');
  input.addEventListener('input', () => {
    const len = input.value.length;
    count.textContent = `${len} / ${FEEDBACK_MAX}`;
    count.classList.toggle('over', len >= FEEDBACK_MAX);
  });
  $('#feedbackSend').addEventListener('click', () => {
    const text = (input.value || '').trim().slice(0, FEEDBACK_MAX);
    if (!text) {
      toast(t('feedback.empty'));
      return;
    }
    try {
      const KEY = STORAGE_KEY + ':feedback';
      const list = JSON.parse(localStorage.getItem(KEY) || '[]');
      list.push({ ts: Date.now(), lang: LANG, v: APP_VERSION, text });
      // 只保留最近 50 則
      while (list.length > 50) list.shift();
      localStorage.setItem(KEY, JSON.stringify(list));
    } catch (e) { /* localStorage 滿了就靜默忽略 */ }
    modal.remove();
    toast(t('feedback.thanks'));
  });
}

// ==== Changelog modal ====
function renderChangelogModal() {
  document.querySelector('#changelogModal')?.remove();
  const items = CHANGELOG.map(entry => `
    <div class="changelog-entry">
      <div>
        <span class="changelog-ver">v${escapeHtml(entry.v)}</span>
        <span class="changelog-date">${escapeHtml(entry.date)}</span>
      </div>
      <ul class="changelog-items">
        ${entry.items.map(it => `
          <li>
            <span class="cl-badge cl-badge-${it.tag}">${escapeHtml(t('cl.tag.' + it.tag))}</span>
            <span>${it.icon}</span>
            <span>${escapeHtml(t(it.key))}</span>
          </li>`).join('')}
      </ul>
    </div>`).join('');
  const html = `
    <div id="changelogModal" class="life-modal">
      <div class="life-modal-card life-modal-wide">
        <button class="lm-close" onclick="document.getElementById('changelogModal').remove()">×</button>
        <h2 class="lm-title">📜 ${t('changelog.title')} <span class="muted" style="font-size:13px;font-weight:400;margin-left:6px;">v${APP_VERSION} · ${APP_BUILD}</span></h2>
        <p class="modal-help">${t('changelog.intro')}</p>
        <div class="changelog-list">${items}</div>
        <div class="modal-actions" style="margin-top:14px;">
          <button class="primary" onclick="document.getElementById('changelogModal').remove()">${t('changelog.close')}</button>
        </div>
      </div>
    </div>`;
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  document.body.appendChild(wrap.firstElementChild);
  const modal = $('#changelogModal');
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

// ==== Privacy modal ====
function renderPrivacyModal() {
  showLegalModal('privacyModal', '🔒 ' + t('privacy.title'), `
    <p>${t('privacy.p1')}</p>
    <p>${t('privacy.p2')}</p>
    <ul>
      <li>${t('privacy.p3')}</li>
      <li>${t('privacy.p4')}</li>
      <li>${t('privacy.p5')}</li>
    </ul>
    <p class="legal-helpline"><strong>${t('privacy.licenseTitle')}</strong><br/>${t('privacy.license')}</p>
  `);
}

// ==== Terms modal ====
function renderTermsModal() {
  showLegalModal('termsModal', '📋 ' + t('terms.title'), `
    <p>${t('terms.p1')}</p>
    <p>${t('terms.p2')}</p>
    <ul>
      <li>${t('terms.p3')}</li>
      <li>${t('terms.p4')}</li>
    </ul>
    <p>${t('terms.p5')}</p>
    <p class="legal-helpline">${t('terms.helpline')}</p>
  `);
}

function showLegalModal(id, title, html) {
  document.querySelector('#' + id)?.remove();
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div id="${id}" class="life-modal">
      <div class="life-modal-card">
        <button class="lm-close" onclick="document.getElementById('${id}').remove()">×</button>
        <h2 class="lm-title">${title}</h2>
        <div class="legal-body">${html}</div>
        <div class="modal-actions" style="margin-top:14px;">
          <button class="primary" onclick="document.getElementById('${id}').remove()">${t('changelog.close')}</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(wrap.firstElementChild);
  const modal = document.querySelector('#' + id);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

/* v5.39：略過可怕的情節 — 按鈕狀態同步（topbar + intro 兩處） */
function renderSoftModeBtn() {
  const on = STATE.softMode;
  ['#btnSoftMode', '#softBtnIntro'].forEach(sel => {
    const b = $(sel);
    if (!b) return;
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.classList.toggle('active', on);
    // v5.82：intro 那顆以前沒有 tooltip（只有 topbar 有），順手補上並走 i18n
    b.title = t(on ? 'soft.on' : 'soft.off');
  });
}

/* v5.50：切換「略過可怕的情節」的共用邏輯（topbar / intro 兩處呼叫） */
function toggleSoftMode() {
  STATE.softMode = !STATE.softMode;
  localStorage.setItem(STORAGE_KEY + ':soft', STATE.softMode ? '1' : '0');
  renderSoftModeBtn();
  renderAll();
  toast(STATE.softMode
    ? (LANG === 'en' ? 'Heavy events are hidden' : LANG === 'fr' ? "Les évènements lourds sont masqués" : '已略過可怕的情節')
    : (LANG === 'en' ? 'Heavy events are shown' : LANG === 'fr' ? "Les évènements lourds sont affichés" : '會顯示全部情節'));
}

// ==== Service Worker 註冊（PWA 離線快取）====
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // 開發/檔案模式跳過（sw.js 需 HTTP 協議）
  if (location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').then(reg => {
    // 監聽更新
    reg.addEventListener('updatefound', () => {
      const ni = reg.installing;
      if (!ni) return;
      ni.addEventListener('statechange', () => {
        if (ni.state === 'activated' && navigator.serviceWorker.controller) {
          // 新 SW 已接管
        }
      });
    });
  }).catch(() => { /* 靜默失敗，不影響主程式 */ });
}

// ==== PWA 安裝提示（beforeinstallprompt） ====
let pwaDeferredPrompt = null;
function setupPWAInstall() {
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    pwaDeferredPrompt = e;
    // 顯示 footer 的安裝按鈕
    const btn = $('#btnInstall');
    if (btn) {
      btn.hidden = false;
      btn.addEventListener('click', promptPWAInstall, { once: true });
    }
    // 在 help-fab 上加 pulse 提示
    document.querySelector('.help-fab')?.classList.add('install-ready');
  });
  window.addEventListener('appinstalled', () => {
    pwaDeferredPrompt = null;
    const btn = $('#btnInstall');
    if (btn) { btn.hidden = true; }
    document.querySelector('.help-fab')?.classList.remove('install-ready');
    toast(t('install.installed'));
  });
}
async function promptPWAInstall() {
  if (!pwaDeferredPrompt) {
    showInstallHelp();
    return;
  }
  try {
    pwaDeferredPrompt.prompt();
    const choice = await pwaDeferredPrompt.userChoice;
    pwaDeferredPrompt = null;
    if (choice?.outcome === 'accepted') {
      // appinstalled 會處理
    } else {
      const btn = $('#btnInstall');
      if (btn) btn.addEventListener('click', promptPWAInstall, { once: true });
    }
  } catch (e) {
    showInstallHelp();
  }
}
function showInstallHelp() {
  const btn = $('#btnInstall');
  if (btn) btn.hidden = true;
  showLegalModal('installHelp', '📲 ' + t('install.title'), `
    <p>${t('install.text')}</p>
    <div class="install-card">
      <span class="install-emoji">📲</span>
      <div>
        <div><strong>${t('install.androidHint')}</strong></div>
        <div class="install-hint">${t('install.androidStep')}</div>
      </div>
    </div>
    <div class="install-card">
      <span class="install-emoji">🍎</span>
      <div>
        <div><strong>${t('install.iosHint')}</strong></div>
        <div class="install-hint">${t('install.iosStep')}</div>
      </div>
    </div>
    <p class="install-hint" style="margin-top:10px;">${t('install.unavailable')}</p>
  `);
}

function injectHelpFab() {
  if (document.querySelector('.help-fab')) return;
  const btn = document.createElement('button');
  btn.className = 'help-fab';
  btn.title = LANG === 'en' ? 'Keyboard shortcuts (?)' : LANG === 'fr' ? "Raccourcis clavier (?)" : '鍵盤快捷鍵 (?)';
  btn.textContent = '?';
  btn.addEventListener('click', showShortcutsModal);
  document.body.appendChild(btn);
}

/* =====================================================================
   族譜模組 (zu-pu 移植)：以目前人生為中心，產生祖上/子孫 SVG 樹
   ===================================================================== */
const TREE_STATE = { rootId: null, mode: 'ancestor', depth: 3 };

function treePeopleGraph() {
  if (!STATE.life || !STATE.life.family) return { people: {}, edges: [] };
  const f = STATE.life.family;
  const selfCaste = STATE.life.country === 'IND' ? STATE.life.name.caste : null;
  const self = {
    id: 'self',
    name: STATE.life.name.full || STATE.life.name.full_en || 'You',
    nameEn: STATE.life.name.full_en || '',
    sex: STATE.life.sex,
    country: STATE.life.country,
    countryData: STATE.life.countryData,
    birthOrigin: STATE.life.birthOrigin,
    birth: { year: STATE.life.year + STATE.life.yearOffset - STATE.life.age },
    death: STATE.life.died ? { year: (STATE.life.year + STATE.life.yearOffset - STATE.life.age) + STATE.life.deathAge } : null,
    family: selfCaste
  };
  const people = { [self.id]: self };
  // v5.71：這些陣欄位未必都存在（重開舊人生時 JSON 可能是舊格式），一律補上預設值。
  // 原本只有 grandparents / kids 有 || []，parents / siblings 沒有，
  // 讀到舊人生會直接 forEach undefined 而整個族譜頁崩掉。
  const parents = f.parents || [];
  const siblings = f.siblings || [];
  parents.forEach(p => { 
    if (selfCaste && p.country === 'IND' && !p.family) p.family = selfCaste;
    people[p.id] = p; 
  });
  siblings.forEach(p => { 
    if (selfCaste && !p.family) p.family = selfCaste;
    people[p.id] = p; 
  });
  (f.grandparents||[]).forEach(p => { 
    if (selfCaste && p.country === 'IND' && !p.family) p.family = selfCaste;
    people[p.id] = p; 
  });
  if (f.partner) people[f.partner.id] = f.partner;
  (f.kids || []).forEach(p => { 
    if (selfCaste && !p.family) p.family = selfCaste;
    people[p.id] = p; 
  });
  const edges = [];
  if (parents[0]) edges.push({ parentId: parents[0].id, childId: 'self', kind: 'parent' });
  if (parents[1]) edges.push({ parentId: parents[1].id, childId: 'self', kind: 'parent' });
  siblings.forEach(s => {
    if (parents[0]) edges.push({ parentId: parents[0].id, childId: s.id, kind: 'parent' });
    if (parents[1]) edges.push({ parentId: parents[1].id, childId: s.id, kind: 'parent' });
  });
  (f.grandparents||[]).forEach(gp => {
    const par = gp.childOf ? parents.find(p => p.id === gp.childOf)
      : parents.find(p => p.sex === gp.sex && Math.abs((p.birth?.year||0) - (gp.birth?.year||0)) < 35);
    if (par) edges.push({ parentId: gp.id, childId: par.id, kind: 'parent' });
  });
  if (f.partner) edges.push({ parentId: 'self', childId: f.partner.id, kind: 'spouse' });
  (f.kids || []).forEach(k => {
    edges.push({ parentId: 'self', childId: k.id, kind: 'parent' });
    if (f.partner) edges.push({ parentId: f.partner.id, childId: k.id, kind: 'parent' });
  });
  return { people, edges };
}

function nowYear() { return STATE.life ? STATE.life.year + STATE.life.yearOffset : 2024; }
// Année de décès seulement si elle est déjà passée dans la vie en cours.
function pastDeathYear(p) {
  const d = p && p.death && p.death.year;
  return d != null && d <= nowYear() ? d : null;
}
function renderTree() {
  const canvas = $('#treeCanvas');
  if (!canvas) return;
  canvas.innerHTML = '';
  if (!STATE.life) {
    canvas.innerHTML = `<div class="muted" style="padding:24px;text-align:center;">${t('intro.cta.hint')}</div>`;
    return;
  }
  const { people, edges } = treePeopleGraph();
  const ids = Object.keys(people);
  if (!ids.length) {
    canvas.innerHTML = `<div class="muted" style="padding:24px;text-align:center;">—</div>`;
    return;
  }
  // root 預設：self
  let rootId = TREE_STATE.rootId || 'self';
  if (!people[rootId]) rootId = 'self';
  TREE_STATE.rootId = rootId;
  // 同步選單
  const sel = $('#treeRoot');
  if (sel && sel.children.length !== ids.length) {
    sel.innerHTML = '';
    for (const id of ids) {
      const p = people[id];
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = `${p.name}${p.birth?.year ? ' ('+p.birth.year+')' : ''}${id==='self'?' · '+t('label.center',''):''}`;
      if (id === rootId) opt.selected = true;
      sel.appendChild(opt);
    }
  } else if (sel) {
    // 語言切換後重畫 option 文字
    Array.from(sel.options).forEach((opt) => {
      const id = opt.value;
      const p = people[id];
      if (!p) return;
      opt.textContent = `${p.name}${p.birth?.year ? ' ('+p.birth.year+')' : ''}${id==='self'?' · '+t('label.center',''):''}`;
    });
    sel.value = rootId;
  }

  const mode = TREE_STATE.mode;
  const depth = +TREE_STATE.depth;
  if (mode === 'ancestor') renderAncestorTree(canvas, rootId, depth, people, edges);
  else if (mode === 'descendant') renderDescendantTree(canvas, rootId, depth, people, edges);
  else renderBothTree(canvas, rootId, depth, people, edges);
}

function getAncestorLayout(rootId, maxGen, people, edges) {
  const nodes = [];
  const links = [];
  function recurse(id, gen, xSlot) {
    if (!id || !people[id]) return;
    if (gen > maxGen) return;
    if (nodes.find(n => n.id === id)) return;
    nodes.push({ id, gen, xSlot });
    if (gen < maxGen) {
      const parents = edges.filter(e => e.childId === id).map(e => e.parentId);
      const half = Math.pow(2, maxGen - gen - 1) / 2;
      const xs = parents.length >= 2 ? [xSlot - half, xSlot + half] : [xSlot];
      parents.slice(0, 2).forEach((pid, n) => {
        recurse(pid, gen + 1, xs[n]);
        links.push({ from: { gen: gen + 1, xSlot: xs[n] }, to: { gen, xSlot } });
      });
    }
  }
  recurse(rootId, 0, Math.pow(2, maxGen) / 2 - 0.5);
  return { nodes, links, totalSlots: Math.pow(2, maxGen) };
}

function renderAncestorTree(canvas, rootId, maxGen, people, edges) {
  let layout = getAncestorLayout(rootId, maxGen, people, edges);
  // ne pas réserver de place pour des générations absentes : l'arbre reste compact
  const deepest = Math.max(...layout.nodes.map(n => n.gen));
  if (deepest >= 1 && deepest < maxGen) { maxGen = deepest; layout = getAncestorLayout(rootId, maxGen, people, edges); }
  const slotW = 220, rowH = 130, marginX = 30, marginY = 30;
  const w = marginX * 2 + layout.totalSlots * slotW;
  const h = marginY * 2 + (maxGen + 1) * rowH;
  const usedX = layout.nodes.map(n => n.xSlot);
  const cropX = Math.min(...usedX) * slotW;
  const cropW = (Math.max(...usedX) - Math.min(...usedX) + 1) * slotW + marginX * 2;
  const svg = svgEl('svg', { width: cropW, height: h, viewBox: `${cropX} 0 ${cropW} ${h}`, preserveAspectRatio: 'xMidYMid meet', style:'max-width:100%;height:auto;' });
  for (const { from, to } of layout.links) {
    const fn = layout.nodes.find(n => n.xSlot === from.xSlot && n.gen === from.gen);
    const tn = layout.nodes.find(n => n.xSlot === to.xSlot && n.gen === to.gen);
    if (!fn || !tn) continue;
    const fx = marginX + fn.xSlot * slotW + slotW/2;
    const fy = marginY + fn.gen * rowH + 40;
    const tx = marginX + tn.xSlot * slotW + slotW/2;
    const ty = marginY + tn.gen * rowH + 90;
    svgEl('path', { d: `M ${fx} ${fy} L ${fx} ${fy + (ty-fy)/2} L ${tx} ${fy + (ty-fy)/2} L ${tx} ${ty}`, class: 'tree-link' }, svg);
  }
  // 伴侶邊（水平虛線）— 在 self 同層右側
  const spouseEdges = edges.filter(e => e.kind === 'spouse');
  for (const e of spouseEdges) {
    const a = layout.nodes.find(n => n.id === e.parentId);
    const b = layout.nodes.find(n => n.id === e.childId);
    if (!a || !b) continue;
    const ax = marginX + a.xSlot * slotW + slotW - 12;
    const ay = marginY + a.gen * rowH + 40;
    const bx = marginX + b.xSlot * slotW;
    const by = marginY + b.gen * rowH + 40;
    svgEl('line', { x1: ax, y1: ay, x2: bx, y2: by, stroke: '#0F6E68', 'stroke-width': 2, 'stroke-dasharray': '6 4' }, svg);
    svgEl('circle', { cx: (ax+bx)/2, cy: (ay+by)/2, r: 4, fill: '#0F6E68' }, svg);
  }
  for (const n of layout.nodes) {
    drawPersonNode(svg, people[n.id], marginX + n.xSlot * slotW, marginY + n.gen * rowH, slotW - 12, 80, n.id === TREE_STATE.rootId);
  }
  canvas.appendChild(svg);
}

function renderDescendantTree(canvas, rootId, maxGen, people, edges) {
  const nodes = [{ id: rootId, gen: 0 }];
  const subEdges = [];
  function recurse(id, gen) {
    if (gen >= maxGen) return;
    const kids = edges.filter(e => e.parentId === id).map(e => e.childId);
    for (const k of kids) {
      nodes.push({ id: k, gen: gen + 1 });
      subEdges.push({ parentId: id, childId: k });
      recurse(k, gen + 1);
    }
  }
  recurse(rootId, 0);
  const genCounts = [];
  for (let g = 0; g <= maxGen; g++) genCounts.push(nodes.filter(n => n.gen === g).length);
  const maxInGen = Math.max(...genCounts, 1);
  const slotW = 240, rowH = 130, marginX = 30, marginY = 30;
  const totalW = marginX * 2 + maxInGen * slotW;
  const totalH = marginX * 2 + (maxGen + 1) * rowH;
  const genOffsets = genCounts.map(c => (maxInGen - c) * slotW / 2);
  const nodePos = {};
  for (let g = 0; g <= maxGen; g++) {
    nodes.filter(n => n.gen === g).forEach((n, i) => {
      nodePos[n.id] = { x: marginX + genOffsets[g] + i * slotW, y: marginY + g * rowH };
    });
  }
  const svg = svgEl('svg', { width: totalW, height: totalH, viewBox: `0 0 ${totalW} ${totalH}`, preserveAspectRatio: 'xMidYMid meet', style:'max-width:100%;height:auto;' });
  for (const e of subEdges) {
    const a = nodePos[e.parentId], b = nodePos[e.childId];
    if (!a || !b) continue;
    svgEl('path', { d: `M ${a.x + slotW/2} ${a.y + 80} L ${a.x + slotW/2} ${a.y + (b.y-a.y)/2} L ${b.x + slotW/2} ${a.y + (b.y-a.y)/2} L ${b.x + slotW/2} ${b.y}`, class: 'tree-link' }, svg);
  }
  for (const n of nodes) drawPersonNode(svg, people[n.id], nodePos[n.id].x, nodePos[n.id].y, slotW - 12, 80, n.id === TREE_STATE.rootId);
  canvas.appendChild(svg);
}

function renderBothTree(canvas, rootId, maxGen, people, edges) {
  renderAncestorTree(canvas, rootId, Math.max(1, Math.floor(maxGen/2)), people, edges);
}

function drawPersonNode(svg, p, x, y, w, h, selected) {
  const g = svgEl('g', { class: 'tree-node' + (selected ? ' selected' : ''), transform: `translate(${x}, ${y})` }, svg);
  const genderColor = p.sex === 'M' ? '#4a6da8' : p.sex === 'F' ? '#b86998' : '#c2b693';
  const deceased = !!pastDeathYear(p);
  const dash = deceased ? '4 5' : '';
  const op = deceased ? 0.6 : 1;
  svgEl('rect', { class: 'node-rect ' + (p.sex === 'M' ? 'node-m' : p.sex === 'F' ? 'node-f' : 'node-u'),
    x: 0, y: 0, width: w, height: h, rx: 8, ry: 8,
    fill: '#faf7f0', stroke: genderColor, 'stroke-width': selected ? 2.5 : 1.5, 'stroke-dasharray': dash, opacity: op }, g);
  // 點擊開 detail panel
  g.style.cursor = 'pointer';
  g.addEventListener('click', () => {
    TREE_STATE.selectedId = p.id;
    showPersonDetail(p);
  });
  // head
  const portrait = svgEl('svg', { x: 6, y: 4, width: 56, height: 70, viewBox: '0 0 200 200' }, g);
  portrait.innerHTML = pixelPortraitSVG(p.countryData, computeAge(p), p.sex).match(/<svg[^>]*>(.*)<\/svg>/)?.[1] || '';
  // name
  const nameY = 22;
  const nameEl = svgEl('text', { class: 'node-name', x: 70, y: nameY, 'font-size': 14, 'font-weight': 500, fill: '#1a1a1a' }, g);
  nameEl.textContent = p.name || '?';
  if (p.nameEn && p.nameEn !== p.name) {
    const ne = svgEl('text', { class: 'node-en', x: 70, y: nameY + 14, 'font-size': 10, fill: '#7a7a7a' }, g);
    ne.textContent = p.nameEn;
  }
  const lifeText = p.birth?.year ? `${p.birth.year || '?'} – ${pastDeathYear(p) || ''}` : '';
  if (lifeText) {
    const lt = svgEl('text', { class: 'node-life', x: 70, y: h - 8, 'font-size': 10, fill: '#7a7a7a' }, g);
    lt.textContent = lifeText;
  }
  if (deceased) {
    const c = svgEl('text', { x: w - 12, y: 16, 'font-size': 14, fill: '#a04040', 'text-anchor': 'end' }, g);
    c.textContent = '†';
  }
  if (p.note === 'adoptive') {
    const m = svgEl('text', { x: w - 14, y: h - 4, 'font-size': 11, fill: '#0F6E68', 'text-anchor': 'end' }, g);
    m.textContent = '🧩';
  } else if (p.note === 'foster') {
    const m = svgEl('text', { x: w - 14, y: h - 4, 'font-size': 11, fill: '#8C1D3C', 'text-anchor': 'end' }, g);
    m.textContent = '🏠';
  }
  // 跨國遷徙：顯示原國旗
  if (p.birthOrigin) {
    const ob = svgEl('text', { x: 4, y: 14, 'font-size': 12 }, g);
    ob.textContent = p.birthOrigin.flag + '→';
    ob.setAttribute('fill', '#a04040');
    const c = svgEl('text', { x: 32, y: 14, 'font-size': 12 }, g);
    c.textContent = (p.countryData?.flag || '🏳️');
  }
  // 印度種姓標記（依 p.family 或 self.country='IND' + 隨機 caste）
  if (p.family || p._caste) {
    const caste = p.family || p._caste;
    const cw = svgEl('rect', { class: 'caste-marker caste-' + caste, x: 70, y: h - 22, width: 50, height: 12, rx: 3 }, g);
    const ct = svgEl('text', { x: 95, y: h - 12, 'font-size': 9, fill: 'white', 'text-anchor': 'middle', 'font-weight': 600 }, g);
    ct.textContent = t('tree.caste.' + caste);
  }
}

/* ==== 生命交叉事件計算 ==== */
function computeCrossLifeEvents(p) {
  if (!STATE.life || p.id === 'self') return [];
  const self = STATE.life;
  const events = [];
  const selfBirthYear = self.year + self.yearOffset - self.age;
  const selfAgeAt = (year) => Math.max(0, year - selfBirthYear);
  // 他出生時我幾歲
  if (p.birth?.year) {
    const myAge = selfAgeAt(p.birth.year);
    const sexTerm = LANG === 'en' ? (p.sex === 'M' ? 'your brother/brother-in-law' : 'your sister/sister-in-law')
                  : (p.sex === 'M' ? '兄弟/手足' : '姊妹/手足');
    events.push({
      icon: '👶',
      text: LANG === 'en' ? `${p.name} was born when you were ${myAge}.` : LANG === 'fr' ? `${p.name} est né(e) quand vous aviez ${myAge} ans.` : `${p.name}出生時，你 ${myAge} 歲。`
    });
  }
  // 他去世時我幾歲
  if (pastDeathYear(p)) {
    const myAge = selfAgeAt(pastDeathYear(p));
    if (myAge >= 0 && myAge <= self.age) {
      if (!STATE.eduMode && !STATE.softMode) {
        events.push({
          icon: '🕯️',
          text: LANG === 'en' ? `${p.name} passed away when you were ${myAge}.` : LANG === 'fr' ? `${p.name} est mort(e) quand vous aviez ${myAge} ans.` : `${p.name} 過世時，你 ${myAge} 歲。`,
          kind: 'heavy'
        });
      }
    } else if (myAge > self.age) {
      events.push({
        icon: '🕯️',
        text: LANG === 'en' ? `${p.name} would have been ${pastDeathYear(p) - selfBirthYear} years older than you.` : LANG === 'fr' ? `${p.name} aurait eu ${pastDeathYear(p) - selfBirthYear} ans de plus que vous.` : `${p.name} 將在你 ${myAge} 歲時離世（在你身後）。`,
        kind: 'forecast'
      });
    }
  }
  // 他出生時自己幾歲（年齡差）
  if (p.birth?.year && selfBirthYear) {
    const diff = p.birth.year - selfBirthYear;
    if (diff > 0 && diff < 30 && p.id !== 'self') {
      const role = p.sex === 'M' ? (LANG === 'en' ? 'elder brother' : LANG === 'fr' ? 'grand frère' : '兄長') : (LANG === 'en' ? 'elder sister' : LANG === 'fr' ? 'grande sœur' : '姊姊');
      events.push({
        icon: '👫',
        text: LANG === 'en' ? `${p.name} is ${diff} years older than you (${role}).` : LANG === 'fr' ? `${p.name} a ${diff} ans de plus que vous (${role}).` : `${p.name} 比你大 ${diff} 歲（${role}）。`
      });
    } else if (diff < 0 && diff > -30) {
      const role = p.sex === 'M' ? (LANG === 'en' ? 'younger brother' : LANG === 'fr' ? 'petit frère' : '弟弟') : (LANG === 'en' ? 'younger sister' : LANG === 'fr' ? 'petite sœur' : '妹妹');
      events.push({
        icon: '👫',
        text: LANG === 'en' ? `${p.name} is ${-diff} years younger than you (${role}).` : LANG === 'fr' ? `${p.name} a ${-diff} ans de moins que vous (${role}).` : `${p.name} 比你小 ${-diff} 歲（${role}）。`
      });
    }
  }
  return events;
}

function showPersonDetail(p) {
  let panel = $('#personDetail');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'personDetail';
    panel.className = 'person-detail';
    document.querySelector('.tree-canvas')?.parentNode.insertBefore(panel, document.querySelector('#treeCanvas').nextSibling);
  }
  const age = computeAge(p);
  const rel = relationLabel(p);
  const crossEvents = computeCrossLifeEvents(p);
  // self 的事件（從 STATE.life.log 摘要）
  let ownEventsHtml = '';
  if (p.id === 'self' && STATE.life && STATE.life.log) {
    const recent = STATE.life.log.filter(e => e.kind !== 'log').slice(-8);
    ownEventsHtml = recent.length ? `<div class="pd-cross"><h4>${LANG==='en'?'Life milestones':LANG === 'fr' ? "Étapes de la vie" : '生命里程碑'}</h4>${recent.map(e => `<div class="pd-cross-row"><span class="pd-cross-icon">${e.icon||'·'}</span><span>${escapeHtml(e.text)}</span></div>`).join('')}</div>` : '';
  }
  panel.innerHTML = `
    <div class="pd-head">
      <div class="pd-portrait">${pixelPortraitSVG(p.countryData, age, p.sex)}</div>
      <div class="pd-meta">
        <h3 class="pd-name">${escapeHtml(p.name || '?')} ${deceasedMark(p)}</h3>
        <div class="pd-relation"><span class="badge">${rel}</span> ${p.note === 'adoptive' ? `<span class="badge badge-adopt">🧩 ${t('tree.noteAdoptive')}</span>` : p.note === 'foster' ? `<span class="badge badge-foster">🏠 ${t('tree.noteFoster')}</span>` : ''}</div>
        <div class="pd-life">${p.birth?.year || '?'} – ${pastDeathYear(p) || t('legend.m')}</div>
        <div class="pd-country">${p.countryData?.flag || ''} ${p.country || ''}${p.birthOrigin ? ' <span class="fam-flag">' + p.birthOrigin.flag + '→</span>' : ''}</div>
      </div>
      <button class="pd-close" onclick="document.getElementById('personDetail').remove()">×</button>
    </div>
    ${ownEventsHtml}
    ${crossEvents.length ? `<div class="pd-cross"><h4>${t('person.cross')}</h4>${crossEvents.map(e => `<div class="pd-cross-row kind-${e.kind||''}"><span class="pd-cross-icon">${e.icon}</span><span>${escapeHtml(e.text)}</span></div>`).join('')}</div>` : ''}
  `;
  // 高亮選中
  document.querySelectorAll('.tree-node').forEach(n => n.classList.remove('selected'));
  document.querySelectorAll('.tree-node').forEach(n => {
    if (n.querySelector('.node-name')?.textContent === (p.name || '?')) n.classList.add('selected');
  });
}

function relationLabel(p) {
  if (!STATE.life || !STATE.life.family) return '';
  const f = STATE.life.family;
  if (f.parents && f.parents.includes(p)) return t('relation.' + (p.sex === 'M' ? 'father' : 'mother'));
  if (f.siblings && f.siblings.includes(p)) {
    const diff = (p.birth?.year || 0) - (STATE.life.year + STATE.life.yearOffset - STATE.life.age);
    if (diff > 0) return t('relation.' + (p.sex === 'M' ? 'uncle' : 'aunt'));
    return t('relation.' + (p.sex === 'M' ? 'sibling' : 'sibling'));
  }
  if (f.grandparents && f.grandparents.includes(p)) return t('relation.' + (p.sex === 'M' ? 'grandfather' : 'grandmother'));
  if (f.partner === p) return t('relation.' + (p.sex === 'M' ? 'spouse' : 'spouse.f'));
  if (f.kids && f.kids.includes(p)) return t('relation.' + (p.sex === 'M' ? 'child' : 'child.f'));
  return '';
}

function deceasedMark(p) {
  return pastDeathYear(p) ? '<span class="pd-deceased">†</span>' : '';
}

function escapeHtml(s) {
  return String(s || '').replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
}

function highlightTreeSearch(query) {
  const q = (query || '').trim().toLowerCase();
  const all = document.querySelectorAll('#treeCanvas .tree-node');
  let hits = 0;
  all.forEach(node => {
    const name = node.querySelector('.node-name')?.textContent || '';
    const en = node.querySelector('.node-en')?.textContent || '';
    const match = q && (name.toLowerCase().includes(q) || en.toLowerCase().includes(q));
    const rect = node.querySelector('.node-rect');
    if (rect) {
      if (match) {
        rect.setAttribute('stroke', '#ff8800');
        rect.setAttribute('stroke-width', '3');
        hits++;
      } else {
        rect.setAttribute('stroke', rect.getAttribute('data-orig-stroke') || rect.getAttribute('stroke'));
        rect.setAttribute('stroke-width', '1.5');
      }
    }
  });
  const hint = $('#treeSearchHint');
  if (hint) hint.textContent = q ? (LANG==='en' ? `${hits} matches` : LANG === 'fr' ? `${hits} résultat(s)` : `${hits} 個符合`) : '';
}

function svgEl(tag, attrs, parent) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) {
    if (Object.prototype.hasOwnProperty.call(attrs, k)) {
      const v = attrs[k];
      if (v !== undefined && v !== null) el.setAttribute(k, String(v));
    }
  }
  if (parent) parent.appendChild(el);
  return el;
}

function computeAge(p) {
  const by = p.birth?.year || 1990;
  const ey = pastDeathYear(p) || nowYear();
  return Math.max(0, ey - by);
}

/* ==== GEDCOM 5.5.1 簡易版（只匯出） ==== */
function exportGEDCOM() {
  const { people, edges } = treePeopleGraph();
  // 轉成 zu-pu/gedcom.js 的 DB 格式
  const DB = { _meta: { title: '族譜 · ' + (STATE.life?.name?.full || 'born-somewhere') }, people: {} };
  for (const id of Object.keys(people)) {
    const p = people[id];
    DB.people[id] = {
      id,
      name: p.name || '',
      nameEn: p.nameEn || '',
      gender: p.sex || 'U',
      birth: p.birth ? { year: p.birth.year, month: p.birth.month, day: p.birth.day } : null,
      death: p.death ? { year: p.death.year } : null,
      birthPlace: p.country || '',
      deathPlace: '',
      notes: id === 'self' ? '@self@' : (p.note || ''),
      parents: edges.filter(e => e.childId === id && e.kind !== 'spouse').map(e => e.parentId),
      spouses: edges.filter(e => (e.childId === id || e.parentId === id) && e.kind === 'spouse').map(e => e.parentId === id ? e.childId : e.parentId)
    };
  }
  const ged = window.Gedcom.export(DB);
  const blob = new Blob([ged], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `born-somewhere-${Date.now()}.ged`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(t('io.exported', Object.keys(people).length));
}

/* ==== 生命證書下載為 PNG ==== */
function downloadLifeCertPNG() {
  if (!STATE.life) { toast(LANG==='en' ? 'No life' : LANG === 'fr' ? 'Aucune vie' : '沒有當前人生'); return; }
  const life = STATE.life;
  const c = life.countryData;
  const loc = c ? localize(c) : { name: life.country };
  const W = 700, H = 480;
  const svgParts = [];
  svgParts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`);
  // 背景紙質
  svgParts.push(`<rect width="${W}" height="${H}" fill="#faf7f0"/>`);
  // 邊框
  svgParts.push(`<rect x="6" y="6" width="${W-12}" height="${H-12}" fill="none" stroke="#8C1D3C" stroke-width="2" rx="8"/>`);
  svgParts.push(`<rect x="14" y="14" width="${W-28}" height="${H-28}" fill="none" stroke="#0F6E68" stroke-width="1" rx="6"/>`);
  // guilloche 簡化紋路
  for (let r = 30; r < W; r += 28) {
    svgParts.push(`<ellipse cx="${W/2}" cy="${H/2}" rx="${r}" ry="${r*0.6}" fill="none" stroke="#8C1D3C" stroke-width="0.3" opacity="0.18"/>`);
  }
  // 標題列
  svgParts.push(`<rect x="20" y="40" width="${W-40}" height="60" fill="#8C1D3C"/>`);
  svgParts.push(`<text x="40" y="80" font-size="24" fill="white" font-weight="bold">${c?.flag || '🏳️'} ${escapeHtml(loc.name)}</text>`);
  svgParts.push(`<text x="${W-40}" y="80" font-size="20" fill="white" text-anchor="end">${life.year + life.yearOffset}</text>`);
  // 姓名
  svgParts.push(`<text x="${W/2}" y="160" font-size="36" fill="#8C1D3C" text-anchor="middle" font-weight="bold">${escapeHtml(life.name.full || life.name.full_en || '—')}</text>`);
  if (life.name.full_en && life.name.full_en !== life.name.full) {
    svgParts.push(`<text x="${W/2}" y="186" font-size="14" fill="#7a6a5a" text-anchor="middle" font-style="italic">${escapeHtml(life.name.full_en)}</text>`);
  }
  // 大字歲數
  svgParts.push(`<text x="${W/2}" y="250" font-size="48" fill="#1a1a1a" text-anchor="middle" font-weight="bold">${life.deathAge || life.age} ${t('unit.years')}</text>`);
  // 副標題
  svgParts.push(`<text x="${W/2}" y="285" font-size="14" fill="#5a4a3a" text-anchor="middle">${LANG==='en'?'Life Expectancy':LANG === 'fr' ? "Espérance de vie" : '預期壽命'} ${c?.le || '—'} ${t('unit.years')}</text>`);
  // 詳情
  const rowY = 320;
  const rows = [
    [LANG==='en'?'Sex':LANG === 'fr' ? 'Sexe' : '性別', life.sex === 'M' ? t('sex.male') : t('sex.female')],
    [LANG==='en'?'Born':LANG === 'fr' ? 'Naissance' : '出生', life.year || '?'],
    [LANG==='en'?'Died':LANG === 'fr' ? 'Décès' : '逝世', life.died ? `${life.year + life.yearOffset}` : '—'],
    [LANG==='en'?'Cause':LANG === 'fr' ? 'Cause' : '原因', escapeHtml(life.cause || (LANG==='en'?'(still alive)':LANG === 'fr' ? '(en vie)' : '仍在世'))]
  ];
  rows.forEach((r, i) => {
    const yy = rowY + i * 28;
    svgParts.push(`<text x="40" y="${yy}" font-size="13" fill="#5a4a3a">${r[0]}</text>`);
    svgParts.push(`<text x="${W-40}" y="${yy}" font-size="14" fill="#1a1a1a" text-anchor="end">${r[1]}</text>`);
  });
  // 章戳
  svgParts.push(`<circle cx="${W-110}" cy="430" r="36" fill="none" stroke="#8C1D3C" stroke-width="1.5" opacity="0.7"/>`);
  svgParts.push(`<text x="${W-110}" y="425" font-size="10" fill="#8C1D3C" text-anchor="middle">${LANG==='en'?'BORN-SOMEWHERE':'選出生地'}</text>`);
  svgParts.push(`<text x="${W-110}" y="440" font-size="8" fill="#8C1D3C" text-anchor="middle">EST. 2024</text>`);
  // 底部
  svgParts.push(`<text x="40" y="450" font-size="9" fill="#9a8a7a">${LANG==='en'?'Life certificate':LANG === 'fr' ? "Certificat de vie" : '生命證書'} · born-somewhere v${APP_VERSION} · ${LANG==='en'?'Real statistics':LANG === 'fr' ? "Statistiques réelles" : '真實統計'}</text>`);
  svgParts.push(`</svg>`);
  const svgStr = svgParts.join('');
  // 轉成 PNG via canvas
  const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    const scale = 2; // 高解析度
    const canvas = document.createElement('canvas');
    canvas.width = W * scale;
    canvas.height = H * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    canvas.toBlob(pngBlob => {
      const pngUrl = URL.createObjectURL(pngBlob);
      const a = document.createElement('a');
      const safeName = (life.name.full || life.name.full_en || 'life').replace(/[\/\\<>:"|?*\u0000-\u001f]/g, '_');
      a.href = pngUrl; a.download = `${safeName}-${LANG==='en'?'certificate':'證書'}-${Date.now()}.png`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => { URL.revokeObjectURL(url); URL.revokeObjectURL(pngUrl); }, 1000);
      toast(LANG==='en'?'Certificate downloaded':LANG === 'fr' ? "Certificat téléchargé" : '證書已下載');
    }, 'image/png');
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    toast(LANG==='en'?'Image conversion failed':LANG === 'fr' ? "Échec de la conversion en image" : '圖片轉換失敗');
  };
  img.src = url;
}

/* v5.12：分享出生卡（1in8b.life 風格登記證） */
function downloadBirthCardPNG() {
  if (!STATE.life) return;
  const life = STATE.life;
  const c = life.countryData;
  if (!c) return;
  const loc = localize(c);
  const isEn = LANG === 'en';
  const W = 800, H = 520;
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`);
  // 背景
  parts.push(`<rect width="${W}" height="${H}" fill="#faf7f0"/>`);
  // guilloche
  for (let r = 40; r < W; r += 24) {
    parts.push(`<ellipse cx="${W/2}" cy="${H/2}" rx="${r}" ry="${r*0.5}" fill="none" stroke="#8C1D3C" stroke-width="0.4" opacity="0.15"/>`);
  }
  // 邊框
  parts.push(`<rect x="6" y="6" width="${W-12}" height="${H-12}" fill="none" stroke="#8C1D3C" stroke-width="2.5" rx="10"/>`);
  parts.push(`<rect x="14" y="14" width="${W-28}" height="${H-28}" fill="none" stroke="#0F6E68" stroke-width="1" rx="8"/>`);
  // 標題
  parts.push(`<rect x="20" y="30" width="${W-40}" height="60" fill="#8C1D3C"/>`);
  parts.push(`<text x="36" y="68" font-size="22" fill="white" font-weight="bold">${c.flag} ${escapeHtml(loc.name)}</text>`);
  parts.push(`<text x="${W-36}" y="68" font-size="18" fill="white" text-anchor="end">${life.year + life.yearOffset}</text>`);
  // 註冊編號
  parts.push(`<text x="${W/2}" y="120" font-size="11" fill="#8C1D3C" text-anchor="middle" font-weight="bold" letter-spacing="0.1em">${isEn?'BIRTH REGISTRATION':LANG === 'fr' ? "ACTE DE NAISSANCE" : '出生登記'} · ${escapeHtml(life.regNumber || '')}</text>`);
  // 名字
  parts.push(`<text x="${W/2}" y="170" font-size="40" fill="#8C1D3C" text-anchor="middle" font-weight="bold">${escapeHtml(life.name?.full || '?')}</text>`);
  if (life.name?.full_en && life.name.full_en !== life.name.full) {
    parts.push(`<text x="${W/2}" y="195" font-size="14" fill="#7a6a5a" text-anchor="middle" font-style="italic">${escapeHtml(life.name.full_en)}</text>`);
  }
  // 大字年齡
  parts.push(`<text x="${W/2}" y="270" font-size="56" fill="#1a1a1a" text-anchor="middle" font-weight="bold">${life.age} ${t('unit.years')}</text>`);
  // 副標題
  parts.push(`<text x="${W/2}" y="305" font-size="14" fill="#5a4a3a" text-anchor="middle">${isEn?'Life expectancy':LANG === 'fr' ? "Espérance de vie" : '預期壽命'} ${c.le} ${t('unit.years')} · ${isEn?'Born in':LANG === 'fr' ? "Lieu de naissance" : '出生於'} ${escapeHtml(loc.name)}</text>`);
  // 家庭背景
  const fd = life.fatherDetail || {};
  const md = life.motherDetail || {};
  parts.push(`<line x1="60" y1="335" x2="${W-60}" y2="335" stroke="#d8cdb8" stroke-width="1"/>`);
  parts.push(`<text x="${W/2}" y="362" font-size="13" fill="#8C1D3C" text-anchor="middle" font-weight="bold">${isEn?'👪 Family Background':LANG === 'fr' ? "👪 Famille d'origine" : '👪 出身家庭'}</text>`);
  const fRows = [
    [isEn?'Father':LANG === 'fr' ? 'Père' : '父親', `${(life.family?.parents||[]).find(p=>p.sex==='M')?.name || '—'} · ${fd.age ? fd.age + t('unit.years') : ''}${fd.job ? ' · ' + fd.job : ''}`],
    [isEn?'Mother':LANG === 'fr' ? 'Mère' : '母親', `${(life.family?.parents||[]).find(p=>p.sex==='F')?.name || '—'} · ${md.age ? md.age + t('unit.years') : ''}${md.job ? ' · ' + md.job : ''}`],
    [isEn?'Religion · Place':LANG === 'fr' ? 'Religion · Lieu' : '宗教 · 出生地', `${life.stats.religion || '—'} · ${life.stats.birthPlaceType === 'rural' ? (isEn?'🌾 Rural':LANG === 'fr' ? '🌾 Campagne' : '🌾 鄉村') : (isEn?'🏙️ Urban':LANG === 'fr' ? '🏙️ Ville' : '🏙️ 城市')}`]
  ];
  fRows.forEach((r, i) => {
    const yy = 392 + i * 24;
    parts.push(`<text x="60" y="${yy}" font-size="12" fill="#7a6a5a">${r[0]}</text>`);
    parts.push(`<text x="160" y="${yy}" font-size="12" fill="#1a1a1a">${r[1]}</text>`);
  });
  // 底部 — 同伴
  if (life.companions && life.companions.length) {
    parts.push(`<text x="${W/2}" y="475" font-size="11" fill="#5a4a3a" text-anchor="middle">${isEn?'Born in the same second: ':LANG === 'fr' ? "Nés à la même seconde : " : '同一秒出生：'}${' '}${life.companions.slice(0,4).map(c=>c.flag + ' ' + (isEn?(c.nameEn||c.name):c.name)).join(' · ')}</text>`);
  }
  // 章戳
  parts.push(`<circle cx="${W-110}" cy="${H-25}" r="20" fill="none" stroke="#8C1D3C" stroke-width="1.5" opacity="0.7"/>`);
  parts.push(`<text x="${W-110}" y="${H-22}" font-size="8" fill="#8C1D3C" text-anchor="middle" font-weight="bold">BORN-SOMEWHERE</text>`);
  parts.push(`<text x="${W-110}" y="${H-12}" font-size="7" fill="#8C1D3C" text-anchor="middle">EST. 2024</text>`);
  // 底部 watermark
  parts.push(`<text x="40" y="${H-12}" font-size="8" fill="#9a8a7a">${isEn?'Birth certificate · born-somewhere v'+APP_VERSION:'出生登記 · born-somewhere v'+APP_VERSION} · ${isEn?'Real statistics':LANG === 'fr' ? "Statistiques réelles" : '真實統計'}</text>`);
  parts.push(`</svg>`);
  const svgStr = parts.join('');
  const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = W * scale;
    canvas.height = H * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    canvas.toBlob(pngBlob => {
      const pngUrl = URL.createObjectURL(pngBlob);
      const a = document.createElement('a');
      const safeName = (life.name?.full || life.name?.full_en || 'life').replace(/[\/\\<>:"|?*\u0000-\u001f]/g, '_');
      a.href = pngUrl; a.download = `${safeName}-${isEn?'birth-card':'出生卡'}-${Date.now()}.png`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => { URL.revokeObjectURL(url); URL.revokeObjectURL(pngUrl); }, 1000);
      toast(isEn ? 'Birth card downloaded' : LANG === 'fr' ? "Carte de naissance téléchargée" : '出生卡已下載');
    }, 'image/png');
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    toast(isEn ? 'Image conversion failed' : LANG === 'fr' ? "Échec de la conversion en image" : '圖片轉換失敗');
  };
  img.src = url;
}

/* v5.20：複製出生卡 base64 data URL 到剪貼簿（並顯示 toast） */
function copyBirthCardShareURL() {
  if (!STATE.life) return;
  const life = STATE.life;
  const c = life.countryData;
  if (!c) return;
  // 構建一個精簡版 life 物件，序列化後 base64 成 URL hash
  try {
    const minimal = {
      name: life.name?.full || life.name?.full_en || '',
      country: life.country,
      year: life.year,
      yearOffset: life.yearOffset,
      age: life.age,
      sex: life.sex,
      regNumber: life.regNumber,
      cause: life.cause
    };
    const json = JSON.stringify(minimal);
    const b64 = btoa(unescape(encodeURIComponent(json)));
    const url = `${location.origin}${location.pathname}#life=${b64}`;
    const ok = navigator.clipboard?.writeText(url);
    if (ok && typeof ok.then === 'function') {
      ok.then(() => toast(t('share.linkCopied')))
        .catch(() => toast(t('share.linkCopied')));
    } else {
      toast(t('share.linkCopied'));
    }
  } catch (e) {
    // btoa 失敗時靜默
  }
}

function toast(msg, ms=2200) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, ms);
}
