require('dotenv').config();
const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ─────────────────────────────────────────
//  Vocab learning system
// ─────────────────────────────────────────
const VOCAB_FILE = path.join(__dirname, 'vocab.json');

function loadVocab() {
  try {
    if (fs.existsSync(VOCAB_FILE)) {
      return JSON.parse(fs.readFileSync(VOCAB_FILE, 'utf8'));
    }
  } catch (e) { console.error('Error loading vocab:', e); }
  return {
    common_phrases: [],
    equipment_names: [],
    watch_items: [],
    ob_sources: [],
    writing_patterns: [],
    last_updated: null,
  };
}

function saveVocab(vocab) {
  try {
    fs.writeFileSync(VOCAB_FILE, JSON.stringify(vocab, null, 2));
  } catch (e) { console.error('Error saving vocab:', e); }
}

// ─────────────────────────────────────────
//  Progress bar builder
// ─────────────────────────────────────────
function buildScoreboard(ibActual, ibShiftGoal, obActual, obShiftGoal, blockLabel) {
  const parse = (val) => {
    if (!val) return 0;
    const str = val.toString().trim().toLowerCase().replace(/,/g, '');
    if (str.endsWith('k')) return Math.round(parseFloat(str) * 1000);
    return parseInt(str, 10) || 0;
  };

  // Q pace multipliers — how much of the shift goal should be done by this Q
  const qPace = { Q1: 0.25, Q2: 0.50, Q3: 0.75, Q4: 1.00 };
  const pace = qPace[blockLabel] || 0.25;

  const ib   = parse(ibActual);
  const ibSG = parse(ibShiftGoal);
  const ob   = parse(obActual);
  const obSG = parse(obShiftGoal);

  // Q target = shift goal × pace for current Q
  const ibQTarget = Math.round(ibSG * pace);
  const obQTarget = Math.round(obSG * pace);

  const bar = (actual, qTarget, shiftGoal) => {
    if (!qTarget) return '';
    const pct = Math.round((actual / qTarget) * 100);
    const barFilled = Math.min(Math.round(pct / 5), 20);
    const barEmpty  = 20 - barFilled;
    const barStr    = '█'.repeat(barFilled) + '░'.repeat(barEmpty);
    const dot       = pct >= 100 ? '🟢' : pct >= 90 ? '🟡' : '🔴';
    return `${barStr} ${pct}% ${dot}`;
  };

  const ibBar = ibQTarget ? bar(ib, ibQTarget, ibSG) : '';
  const obBar = obQTarget ? bar(ob, obQTarget, obSG) : '';

  const ibLine = ibSG
    ? `🦀 IB  ${ib.toLocaleString()} / ${ibQTarget.toLocaleString()} (${blockLabel} target)`
    : `🦀 IB  ${ibActual || 'N/A'}`;
  const obLine = obSG
    ? `🦑 OB  ${ob.toLocaleString()} / ${obQTarget.toLocaleString()} (${blockLabel} target)`
    : `🦑 OB  ${obActual || 'N/A'}`;

  const ibGoalLine = ibSG ? `Shift Goal: ${ibSG.toLocaleString()}` : '';
  const obGoalLine = obSG ? `Shift Goal: ${obSG.toLocaleString()}` : '';

  return [
    '```',
    '┌──────────────────────────────────────┐',
    `│ ${ibLine.padEnd(36)} │`,
    ibBar ? `│ ${ibBar.padEnd(36)} │` : null,
    ibGoalLine ? `│ ${ibGoalLine.padEnd(36)} │` : null,
    '│                                      │',
    `│ ${obLine.padEnd(36)} │`,
    obBar ? `│ ${obBar.padEnd(36)} │` : null,
    obGoalLine ? `│ ${obGoalLine.padEnd(36)} │` : null,
    '└──────────────────────────────────────┘',
    '```',
  ].filter(Boolean).join('\n');
}

function buildVocabContext(vocab) {
  if (!vocab.common_phrases.length && !vocab.equipment_names.length) return '';
  return `
=== YOUR PERSONAL VOCABULARY (learned from past shifts) ===
Use these naturally in the summary — they reflect how this PA writes and speaks:
${vocab.common_phrases.length ? `Common phrases: ${vocab.common_phrases.slice(0, 15).join(', ')}` : ''}
${vocab.equipment_names.length ? `Equipment/sources referenced often: ${vocab.equipment_names.slice(0, 15).join(', ')}` : ''}
${vocab.watch_items.length ? `Common watch items: ${vocab.watch_items.slice(0, 8).join(', ')}` : ''}
${vocab.ob_sources.length ? `Common OB sources: ${vocab.ob_sources.slice(0, 10).join(', ')}` : ''}
${vocab.writing_patterns.length ? `Writing patterns: ${vocab.writing_patterns.slice(0, 8).join(', ')}` : ''}
`;
}

async function extractAndUpdateVocab(notes) {
  if (!notes || notes.length < 20) return;
  const vocab = loadVocab();

  const extractPrompt = `You are analyzing shift notes from an Amazon IXD PA to extract their personal vocabulary and writing patterns.

Notes: "${notes}"

Extract ONLY what is explicitly in the notes above. Return a JSON object with these fields:
- common_phrases: short operational phrases the writer uses (e.g. "heavy OB recirc", "balance cc", "no major issues")
- equipment_names: specific equipment, door numbers, chutes, OB sources mentioned (e.g. "DD131", "Robot 2", "XAB4")
- watch_items: things they tell the next team to watch (e.g. "keep an eye on SS presort")
- ob_sources: OB flow sources mentioned (e.g. "XAB4_CASE", "BWI2")
- writing_patterns: how they structure sentences (e.g. "starts with 'we started Q with'", "uses 'no major issues' for clean quarters")

Return ONLY valid JSON, no extra text. Keep each list to max 5 items extracted from THIS note only.`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: extractPrompt }],
    });

    const rawText = response.content[0].text.trim();
    const cleanText = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const extracted = JSON.parse(cleanText);

    // Merge with existing vocab, avoiding duplicates
    const merge = (existing, newItems) => {
      if (!Array.isArray(newItems)) return existing;
      const combined = [...new Set([...existing, ...newItems])];
      return combined.slice(0, 30); // keep max 30 per category
    };

    vocab.common_phrases  = merge(vocab.common_phrases,  extracted.common_phrases);
    vocab.equipment_names = merge(vocab.equipment_names, extracted.equipment_names);
    vocab.watch_items     = merge(vocab.watch_items,     extracted.watch_items);
    vocab.ob_sources      = merge(vocab.ob_sources,      extracted.ob_sources);
    vocab.writing_patterns = merge(vocab.writing_patterns, extracted.writing_patterns);
    vocab.last_updated    = new Date().toISOString();

    saveVocab(vocab);
    console.log('✅ Vocab updated from shift notes');
  } catch (e) {
    console.error('Error extracting vocab:', e);
  }
}

// ─────────────────────────────────────────
//  Block schedule
// ─────────────────────────────────────────
const BLOCK_SCHEDULE = {
  Q1: { blockTime: '7:00pm – 9:30pm',  upNext: 'Break 9:30–9:45pm',   isLast: false },
  Q2: { blockTime: '9:45pm – 12:00am', upNext: 'Lunch 12:00–12:30am', isLast: false },
  Q3: { blockTime: '12:30am – 2:45am', upNext: 'Break 2:45–3:00am',   isLast: false },
  Q4: { blockTime: '3:00am – 5:30am',  upNext: 'End of Shift',        isLast: true  },
};

const BLOCK_NAMES = {
  Q1: 'First Quarter',
  Q2: 'Second Quarter',
  Q3: 'Third Quarter',
  Q4: 'Fourth Quarter (Final)',
};

// ─────────────────────────────────────────
//  Target channels
// ─────────────────────────────────────────
const QREPORT_CHANNELS  = ['C040FPKF8N9', 'C0B2PG28M0W']; // Q report channels
const CF_LEAD_CHANNEL     = 'C040FPKF8N9'; // #teb9-cf-lead
const SHIFTREPORT_CHANNEL = 'C03AK45DJF8'; // Shift handoff channel

// ─────────────────────────────────────────
//  Building context for AI
// ─────────────────────────────────────────
const BUILDING_CONTEXT = `
=== IXD BUILDING OPERATIONS CONTEXT ===
You write shift reports for Amazon IXD site managers and operations leaders. Use this context to understand terminology and building operations accurately.

--- CARRIERS (CC) ---
- CC = carriers — the units circulating through the building on the XBelt
- Low CC (below 300cc): unhealthy, poor flow — a concern
- Healthy CC (300–800cc): normal, smooth operations
- High CC (above 800cc): strong flow, no concern
- When CC drops low, Presort or PIDs are deliberately cut (turned off) to recover carriers
- Low CC is often caused by high recirc, No Reads, or sort volume

--- XBELT / CB (Main Crossbelt) ---
- XBelt and CB = same thing: the main conveyor belt of the building
- XBelt stoppage = the main belt stopped due to a jam — always a notable event
- Common causes (only reference if user mentions them):
  * Door chutes: DD + number, upper or lower (e.g. DD324 lower, DD131 upper)
  * MP chutes: MP1–MP8 upper or lower
  * CR chutes: CR1–CR8 upper or lower
  * Bank chutes: Bank 1–Bank 6 upper or lower
  * Robot chutes: Robot 1–Robot 5 lower or upper
  * Sort Lane chutes: Sort Lane K/L upper, etc.
  * IS12: E-stop related stoppage
  * Bypass 1: belt bypass area
- XBelt DT = downtime minutes caused only by XBelt stoppages
- A chute can be "disabled" after a stoppage if RME cannot fully resolve it
- Presort DT is separate from XBelt DT

--- PRESORT / PIDs ---
- IB has 6 PIDs that feed work (cases/boxes/totes) into the building
- IB has 2 presorts: Presort North (NS) and Presort South (SS)
- SL2 = Sort Lane 2, can be cut to help build carriers
- "Cut Presort/PIDs/SL2" = deliberately turning them OFF to recover carriers
- Cutting is a controlled operational decision, not a failure

--- DEPARTMENTS & EQUIPMENT ---
- IB (Inbound): feeds packages via 2 presorts (North/South) and 6 PIDs
- OB (Outbound): sends packages out — high OB recirc = packages recirculating
- Sort: 5LBS, Mansort, 20LBS — "MOB departments" = multiple OB departments
- RPND: separate department
- EOL: MP1–MP8 and Robot 1–Robot 5
- MHE: Material Handling Equipment — "MHE down" = equipment outage
- MH2: specific MHE area
- Jackpot NS/SS: scanning equipment, can have misaligned PE
- Viper: equipment associated with Bank/DD chutes
- RME: Maintenance team — resolves equipment issues, opens tickets (tt/TT)
- Safety stand down: mandatory safety stop across the building

--- COMMON OB RECIRC SOURCES ---
XAB4_CASE, BOS3_CASE, BWI2_CASE, MTN1_TOTE, PVD2_CASE, HGR5_CASE, dz-P-MANSORTTOTE, dz-P-DOCKSORT, dz-P-AUTOSORTTOTE_20LB

--- COMMON ISSUES ---
- No Reads / Unknowns: packages that can't be scanned — cause recirc and low CC
- ECC burnout / bad MRD: electrical failure on a PID
- Misaligned PE: photo eye misalignment
- Ripped belt / loose PE: physical equipment damage
- E-stop / IS stop: emergency stop events
- Big boxes from IB causing jams in MOB departments

--- KEY TERMS ---
- Recirc = recirculation of packages
- SOS = Start of Shift | EOS = End of Shift
- "Cut" = turn off
- "Heavy" or "High" = large volume or elevated levels
- HC = healthy carriers
- SL2 = Sort Lane 2
- FHD = Floor Handoff Document / the name used to address the incoming team ("Good morning FHDs")

--- SHIFT STRUCTURE ---
- Full shift: 7:00pm to 5:30am — Q1, Q2, Q3, Q4
- Q1 = start of shift | Q4 = end of shift (day shift handoff)

--- CRITICAL: DO NOT ASSUME ---
ONLY include what the user explicitly provided. Do not add times, causes, RME actions, or details not in the notes.

--- WRITING RULES ---
ALWAYS:
- "carriers" or "cc" NOT "carrier counts" or "carrier inventory"
- "recirc" NOT "recirculation"
- "high" or "heavy" NOT "elevated"
- "cut" NOT "taken offline"
- Write in first person plural ("we started", "we had", "we were able to")

NEVER:
- "carrier inventory" or "carrier counts"
- "environment" unless user said it
- "kickoff" unless user said it
- "requiring RME intervention" unless user mentioned RME
- "deliberate Presort cuts and focused operational adjustments"
- "managed the flow through..."
- "The incoming Q_ team"
- Anything the user did not explicitly state
`;

// ─────────────────────────────────────────
//  Helper — generate Q summary via Claude
// ─────────────────────────────────────────
async function generateQSummary(blockLabel, blockTime, notes) {
  const blockName = BLOCK_NAMES[blockLabel];
  const isLast = BLOCK_SCHEDULE[blockLabel].isLast;
  const vocab = loadVocab();
  const vocabContext = buildVocabContext(vocab);

  const prompt = BUILDING_CONTEXT + vocabContext + `
=== TASK ===
Write a summary for ${blockLabel} (${blockName} — ${blockTime}) based ONLY on the notes below.
Notes: ${notes}

=== WRITING INSTRUCTIONS ===
- 2 short paragraphs, 4–8 sentences TOTAL
- Paragraph 1: What happened this quarter
- Paragraph 2: What improved/resolved + one watch item${isLast ? ' for day shift' : ''}
- Do NOT start with "During the..."
- No headers, no titles, no bullet points, no markdown
- Only include what is in the notes — do not assume anything
- Match the vocabulary and writing style from the personal vocabulary section above
- If notes say "no issues" or are minimal, write a short clean summary — do NOT invent details
- NEVER print field names like "Barriers:", "Wins/Resolutions:" in the summary
- NEVER say "carry this momentum", "required intervention", "environment", "kickoff"
- NEVER assume equipment issues or monitoring needs unless explicitly stated
`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content[0].text.trim();
}

// ─────────────────────────────────────────
//  /qreport — Single Q report modal
// ─────────────────────────────────────────
app.command('/qreport', async ({ ack, body, client }) => {
  await ack();

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'qreport_modal',
      title: { type: 'plain_text', text: '📋 Q Block Report' },
      submit: { type: 'plain_text', text: 'Generate Report' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'input', block_id: 'channel_1',
          label: { type: 'plain_text', text: '📢 Send To (Channel 1)' },
          element: { type: 'conversations_select', action_id: 'channel_1_input',
            placeholder: { type: 'plain_text', text: 'Select first channel' },
            filter: { include: ['public', 'private'], exclude_bot_users: true } },
        },
        {
          type: 'input', block_id: 'channel_2', optional: true,
          label: { type: 'plain_text', text: '📢 Send To (Channel 2 — optional)' },
          element: { type: 'conversations_select', action_id: 'channel_2_input',
            placeholder: { type: 'plain_text', text: 'Select second channel (optional)' },
            filter: { include: ['public', 'private'], exclude_bot_users: true } },
        },
        // Schedule option
        {
          type: 'input', block_id: 'post_type',
          label: { type: 'plain_text', text: '⏰ Post Type' },
          element: { type: 'static_select', action_id: 'post_type_input',
            placeholder: { type: 'plain_text', text: 'Post now or schedule?' },
            options: [
              { text: { type: 'plain_text', text: '📤 Post Now' },  value: 'now' },
              { text: { type: 'plain_text', text: '⏰ Schedule' },   value: 'schedule' },
            ] },
        },
        {
          type: 'input', block_id: 'schedule_time', optional: true,
          label: { type: 'plain_text', text: '🕖 Schedule Time (if scheduling)' },
          element: { type: 'plain_text_input', action_id: 'schedule_time_input',
            placeholder: { type: 'plain_text', text: 'e.g. 9:30pm or 21:30' } },
        },
        {
          type: 'input', block_id: 'block_label',
          label: { type: 'plain_text', text: 'Select Block' },
          element: { type: 'static_select', action_id: 'block_label_input',
            placeholder: { type: 'plain_text', text: 'Choose Q1, Q2, Q3 or Q4' },
            options: [
              { text: { type: 'plain_text', text: 'Q1 — 7:00pm to 9:30pm' },  value: 'Q1' },
              { text: { type: 'plain_text', text: 'Q2 — 9:45pm to 12:00am' }, value: 'Q2' },
              { text: { type: 'plain_text', text: 'Q3 — 12:30am to 2:45am' }, value: 'Q3' },
              { text: { type: 'plain_text', text: 'Q4 — 3:00am to 5:30am' },  value: 'Q4' },
            ] },
        },
        {
          type: 'input', block_id: 'xbelt_stoppages',
          label: { type: 'plain_text', text: 'XBelt Stoppages (this Q)' },
          element: { type: 'plain_text_input', action_id: 'xbelt_stoppages_input',
            placeholder: { type: 'plain_text', text: 'e.g. 2' } },
        },
        {
          type: 'input', block_id: 'xbelt_dt_total', optional: true,
          label: { type: 'plain_text', text: 'XBelt DT (shift total so far)' },
          element: { type: 'plain_text_input', action_id: 'xbelt_dt_total_input',
            placeholder: { type: 'plain_text', text: 'e.g. 11min total across Q1–Q3' } },
        },
        {
          type: 'input', block_id: 'presort_dt', optional: true,
          label: { type: 'plain_text', text: 'Presort DT (this Q)' },
          element: { type: 'plain_text_input', action_id: 'presort_dt_input',
            placeholder: { type: 'plain_text', text: 'e.g. 16min due to low carriers' } },
        },
        {
          type: 'input', block_id: 'barriers', optional: true,
          label: { type: 'plain_text', text: '⚠️ Barriers / Issues' },
          element: { type: 'plain_text_input', action_id: 'barriers_input', multiline: true,
            placeholder: { type: 'plain_text', text: 'e.g. Heavy OB recirc from XAB4_CASE. Short staffed on MHE.' } },
        },
        {
          type: 'input', block_id: 'extra_details', optional: true,
          label: { type: 'plain_text', text: '✅ Wins / Resolutions' },
          element: { type: 'plain_text_input', action_id: 'extra_details_input', multiline: true,
            placeholder: { type: 'plain_text', text: 'e.g. Carriers recovered. Recirc brought under control.' } },
        },
        {
          type: 'input', block_id: 'pending_tickets', optional: true,
          label: { type: 'plain_text', text: 'Pending Tickets (one per line)' },
          element: { type: 'plain_text_input', action_id: 'pending_tickets_input', multiline: true,
            placeholder: { type: 'plain_text', text: 'e.g.\nDD208 Missing Roller (M3)' } },
        },
        {
          type: 'input', block_id: 'volume_ib', optional: true,
          label: { type: 'plain_text', text: 'IB Online (non-PR) Carton' },
          element: { type: 'plain_text_input', action_id: 'volume_ib_input',
            placeholder: { type: 'plain_text', text: 'e.g. 22,763' } },
        },
        {
          type: 'input', block_id: 'goal_ib', optional: true,
          label: { type: 'plain_text', text: 'IB Shift Goal (e.g. 60k)' },
          element: { type: 'plain_text_input', action_id: 'goal_ib_input',
            placeholder: { type: 'plain_text', text: 'e.g. 60k or 60,000' } },
        },
        {
          type: 'input', block_id: 'volume_ob', optional: true,
          label: { type: 'plain_text', text: 'OB Volume' },
          element: { type: 'plain_text_input', action_id: 'volume_ob_input',
            placeholder: { type: 'plain_text', text: 'e.g. 25,873' } },
        },
        {
          type: 'input', block_id: 'goal_ob', optional: true,
          label: { type: 'plain_text', text: 'OB Shift Goal (e.g. 78k)' },
          element: { type: 'plain_text_input', action_id: 'goal_ob_input',
            placeholder: { type: 'plain_text', text: 'e.g. 78k or 78,000' } },
        },
      ],
    },
  });
});

// ─────────────────────────────────────────
//  /qreport modal submit
// ─────────────────────────────────────────
app.view('qreport_modal', async ({ ack, body, view, client }) => {
  await ack();

  const values         = view.state.values;
  const channel1       = values.channel_1.channel_1_input.selected_conversation;
  const channel2       = values.channel_2?.channel_2_input?.selected_conversation || null;
  const targetChannels = [channel1, channel2].filter(Boolean);
  const postType       = values.post_type.post_type_input.selected_option.value;
  const scheduleTime   = values.schedule_time?.schedule_time_input?.value || '';
  const blockLabel     = values.block_label.block_label_input.selected_option.value;
  const { blockTime, upNext, isLast } = BLOCK_SCHEDULE[blockLabel];
  const xbeltStoppages = values.xbelt_stoppages.xbelt_stoppages_input.value;
  const xbeltDTTotal   = values.xbelt_dt_total.xbelt_dt_total_input.value || 'N/A';
  const presortDT      = values.presort_dt.presort_dt_input.value || 'None';
  const barriers       = values.barriers.barriers_input.value || '';
  const extraDetails   = values.extra_details.extra_details_input.value || '';
  const pendingTickets = values.pending_tickets.pending_tickets_input.value || '';
  const volumeIB       = values.volume_ib.volume_ib_input.value || '';
  const goalIB         = values.goal_ib.goal_ib_input.value || '';
  const volumeOB       = values.volume_ob.volume_ob_input.value || '';
  const goalOB         = values.goal_ob.goal_ob_input.value || '';

  // Time parser helper
  const parseScheduleTime = (timeStr) => {
    const now = new Date();
    const match = timeStr.match(/(\d+):(\d+)\s*(am|pm)?/i);
    if (!match) return null;
    let hours = parseInt(match[1]);
    const mins = parseInt(match[2]);
    const period = match[3]?.toLowerCase();
    if (period === 'pm' && hours < 12) hours += 12;
    if (period === 'am' && hours === 12) hours = 0;
    const scheduled = new Date(now);
    scheduled.setHours(hours, mins, 0, 0);
    if (scheduled <= now) scheduled.setDate(scheduled.getDate() + 1);
    return Math.floor(scheduled.getTime() / 1000);
  };

  // If scheduling — build report and schedule it
  if (postType === 'schedule') {
    if (!scheduleTime) {
      await Promise.all(targetChannels.map(ch =>
        client.chat.postMessage({ channel: ch, text: `❌ Please enter a schedule time (e.g. 9:30pm).` })
      ));
      return;
    }

    const postAt = parseScheduleTime(scheduleTime);
    if (!postAt) {
      await Promise.all(targetChannels.map(ch =>
        client.chat.postMessage({ channel: ch, text: `❌ Could not parse time "${scheduleTime}". Use format like *9:30pm* or *21:30*` })
      ));
      return;
    }

    // Generate the report first
    const notes = [
      barriers && barriers !== '0' && `Barriers: ${barriers}`,
      extraDetails && extraDetails !== '0' && `Wins/Resolutions: ${extraDetails}`,
      presortDT && presortDT !== 'None' && presortDT !== '0' && `Presort DT: ${presortDT}`,
      xbeltDTTotal !== 'N/A' && `Shift total XBelt DT so far: ${xbeltDTTotal}`,
    ].filter(Boolean).join('\n');

    const qSummary   = await generateQSummary(blockLabel, blockTime, notes || 'Clean quarter — no major issues reported.');
    const now2       = new Date();
    const timeStr2   = new Date(postAt * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const dateStr2   = now2.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const ticketLines2 = pendingTickets ? pendingTickets.split('\n').filter(Boolean).map(t => '• ' + t.trim()).join('\n') : '• None';

    const report2 = [
      `🏭 *${blockLabel} Block Report — ${dateStr2}*`,
      `*Building:* IXD  |  *Block Time:* ${blockTime}  |  *Up Next:* ${upNext}`,
      '',
      `:alert: *XBelt Stoppages (this Q):* ${xbeltStoppages}`,
      `⏱️ *XBelt DT (shift total):* ${xbeltDTTotal}`,
      `⏱️ *Presort DT (this Q):* ${presortDT}`,
      '',
      `:ticketing-simt: *Pending Tickets:*`,
      ticketLines2,
      '',
      `📊 *Volume vs Goal:*`,
      buildScoreboard(volumeIB, goalIB, volumeOB, goalOB, blockLabel),
      '',
      `:spiral_note_pad: *${blockLabel} Operational Summary:*`,
      qSummary,
      '',
      `_IXD Shift Bot • Generated ${timeStr2}_`,
    ].join('\n');

    // Schedule to all channels
    await Promise.all(targetChannels.map(ch =>
      client.chat.scheduleMessage({ channel: ch, text: report2, post_at: postAt, mrkdwn: true })
    ));

    // Confirm to user
    await client.chat.postMessage({
      channel: channel1,
      text: `✅ *${blockLabel} Block Report scheduled for ${timeStr2}!*\nUse \`/qreport cancel\` to cancel it.`,
      mrkdwn: true,
    });
    return;
  }

  await Promise.all(targetChannels.map(ch =>
    client.chat.postMessage({ channel: ch, text: `⏳ Generating *${blockLabel} Block Report*... hang tight!` })
  ));

  try {
    const notes = [
      barriers && barriers !== '0' && `Barriers: ${barriers}`,
      extraDetails && extraDetails !== '0' && `Wins/Resolutions: ${extraDetails}`,
      presortDT && presortDT !== 'None' && presortDT !== '0' && `Presort DT: ${presortDT}`,
      xbeltDTTotal !== 'N/A' && `Shift total XBelt DT so far: ${xbeltDTTotal}`,
    ].filter(Boolean).join('\n');

    const qSummary = await generateQSummary(blockLabel, blockTime, notes || 'Clean quarter — no major issues reported.');

    const now     = new Date();
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const dateStr = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const ticketLines = pendingTickets ? pendingTickets.split('\n').filter(Boolean).map(t => '• ' + t.trim()).join('\n') : '• None';

    const report = [
      `🏭 *${blockLabel} Block Report — ${dateStr}*`,
      `*Building:* IXD  |  *Block Time:* ${blockTime}  |  *Up Next:* ${upNext}`,
      '',
      `:alert: *XBelt Stoppages (this Q):* ${xbeltStoppages}`,
      `⏱️ *XBelt DT (shift total):* ${xbeltDTTotal}`,
      `⏱️ *Presort DT (this Q):* ${presortDT}`,
      '',
      `:speaking_head_in_silhouette: *Pending Tickets:*`,
      ticketLines,
      '',
      `📊 *Volume vs Goal:*`,
      buildScoreboard(volumeIB, goalIB, volumeOB, goalOB, blockLabel),
      '',
      `:spiral_note_pad: *${blockLabel} Operational Summary:*`,
      qSummary,
      '',
      `_IXD Shift Bot • Generated ${timeStr}_`,
    ].join('\n');

    await Promise.all(targetChannels.map(ch =>
      client.chat.postMessage({ channel: ch, text: report, mrkdwn: true })
    ));

    // Auto-learn from notes in background
    extractAndUpdateVocab(notes);

  } catch (err) {
    console.error('Error:', err);
    await Promise.all(targetChannels.map(ch =>
      client.chat.postMessage({ channel: ch, text: `❌ Error: ${err.message}` })
    ));
  }
});

// ─────────────────────────────────────────
//  /shiftreport — Full shift handoff modal
// ─────────────────────────────────────────
app.command('/shiftreport', async ({ ack, body, client }) => {
  await ack();

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'shiftreport_modal',
      title: { type: 'plain_text', text: '🏭 Shift Handoff' },
      submit: { type: 'plain_text', text: 'Generate Handoff' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        // Greeting name
        {
          type: 'input', block_id: 'greeting',
          label: { type: 'plain_text', text: 'Greeting (who are you addressing?)' },
          element: { type: 'plain_text_input', action_id: 'greeting_input',
            placeholder: { type: 'plain_text', text: 'e.g. FHDs, Day Team, Managers' } },
        },
        { type: 'divider' },
        { type: 'section', text: { type: 'mrkdwn', text: '*🕖 Q1 — 7:00pm to 9:30pm*' } },
        {
          type: 'input', block_id: 'q1_notes', optional: true,
          label: { type: 'plain_text', text: 'Q1 Notes' },
          element: { type: 'plain_text_input', action_id: 'q1_notes_input', multiline: true,
            placeholder: { type: 'plain_text', text: 'CC at SOS, stoppages, recirc, Presort cuts, barriers, wins...' } },
        },
        { type: 'divider' },
        { type: 'section', text: { type: 'mrkdwn', text: '*🕙 Q2 — 9:45pm to 12:00am*' } },
        {
          type: 'input', block_id: 'q2_notes', optional: true,
          label: { type: 'plain_text', text: 'Q2 Notes' },
          element: { type: 'plain_text_input', action_id: 'q2_notes_input', multiline: true,
            placeholder: { type: 'plain_text', text: 'CC, stoppages, recirc, issues, wins...' } },
        },
        { type: 'divider' },
        { type: 'section', text: { type: 'mrkdwn', text: '*🕐 Q3 — 12:30am to 2:45am*' } },
        {
          type: 'input', block_id: 'q3_notes', optional: true,
          label: { type: 'plain_text', text: 'Q3 Notes' },
          element: { type: 'plain_text_input', action_id: 'q3_notes_input', multiline: true,
            placeholder: { type: 'plain_text', text: 'CC, stoppages, recirc, issues, wins...' } },
        },
        { type: 'divider' },
        { type: 'section', text: { type: 'mrkdwn', text: '*🕒 Q4 — 3:00am to 5:30am*' } },
        {
          type: 'input', block_id: 'q4_notes', optional: true,
          label: { type: 'plain_text', text: 'Q4 Notes' },
          element: { type: 'plain_text_input', action_id: 'q4_notes_input', multiline: true,
            placeholder: { type: 'plain_text', text: 'CC, stoppages, recirc, day shift handoff notes...' } },
        },
        { type: 'divider' },
        { type: 'section', text: { type: 'mrkdwn', text: '*📊 Shift Stats*' } },
        {
          type: 'input', block_id: 'sl2', optional: true,
          label: { type: 'plain_text', text: 'SL2 %' },
          element: { type: 'plain_text_input', action_id: 'sl2_input',
            placeholder: { type: 'plain_text', text: 'e.g. 100%' } },
        },
        {
          type: 'input', block_id: 'final_cc', optional: true,
          label: { type: 'plain_text', text: 'Final CC (at EOS)' },
          element: { type: 'plain_text_input', action_id: 'final_cc_input',
            placeholder: { type: 'plain_text', text: 'e.g. 541cc' } },
        },
        {
          type: 'input', block_id: 'total_xbelt_dt', optional: true,
          label: { type: 'plain_text', text: 'Total XBelt DT' },
          element: { type: 'plain_text_input', action_id: 'total_xbelt_dt_input',
            placeholder: { type: 'plain_text', text: 'e.g. 10min' } },
        },
        {
          type: 'input', block_id: 'total_xbelt_stoppages', optional: true,
          label: { type: 'plain_text', text: 'Total XBelt Stoppages' },
          element: { type: 'plain_text_input', action_id: 'total_xbelt_stoppages_input',
            placeholder: { type: 'plain_text', text: 'e.g. 3' } },
        },
        {
          type: 'input', block_id: 'total_presort_dt', optional: true,
          label: { type: 'plain_text', text: 'Total Presort DT' },
          element: { type: 'plain_text_input', action_id: 'total_presort_dt_input',
            placeholder: { type: 'plain_text', text: 'e.g. 20min' } },
        },
        {
          type: 'input', block_id: 'pending_tickets', optional: true,
          label: { type: 'plain_text', text: 'Pending TTs (one per line)' },
          element: { type: 'plain_text_input', action_id: 'pending_tickets_input', multiline: true,
            placeholder: { type: 'plain_text', text: 'e.g.\nCR4 Takeaway ripped belt\nPID2 Railing\nDD343 lower chute ripped belt' } },
        },
        {
          type: 'input', block_id: 'safety',
          label: { type: 'plain_text', text: '🟢 Safety Incidents' },
          element: { type: 'plain_text_input', action_id: 'safety_input',
            placeholder: { type: 'plain_text', text: 'e.g. 0' } },
        },
      ],
    },
  });
});

// ─────────────────────────────────────────
//  /shiftreport modal submit
// ─────────────────────────────────────────
app.view('shiftreport_modal', async ({ ack, body, view, client }) => {
  await ack();

  const values           = view.state.values;
  const greeting         = values.greeting.greeting_input.value || 'FHDs';
  const q1Notes          = values.q1_notes.q1_notes_input.value || '';
  const q2Notes          = values.q2_notes.q2_notes_input.value || '';
  const q3Notes          = values.q3_notes.q3_notes_input.value || '';
  const q4Notes          = values.q4_notes.q4_notes_input.value || '';
  const sl2              = values.sl2.sl2_input.value || 'N/A';
  const finalCC          = values.final_cc.final_cc_input.value || 'N/A';
  const totalXbeltDT     = values.total_xbelt_dt.total_xbelt_dt_input.value || 'N/A';
  const totalStoppages   = values.total_xbelt_stoppages.total_xbelt_stoppages_input.value || 'N/A';
  const totalPresortDT   = values.total_presort_dt.total_presort_dt_input.value || 'N/A';
  const pendingTickets   = values.pending_tickets.pending_tickets_input.value || '';
  const safety           = values.safety.safety_input.value;

  await client.chat.postMessage({ channel: SHIFTREPORT_CHANNEL, text: '⏳ Generating *Shift Handoff*... hang tight!' });

  try {
    const now     = new Date();
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const dateStr = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    // Build full shift narrative using Claude
    const allNotes = [
      q1Notes && `Q1 (7:00pm–9:30pm): ${q1Notes}`,
      q2Notes && `Q2 (9:45pm–12:00am): ${q2Notes}`,
      q3Notes && `Q3 (12:30am–2:45am): ${q3Notes}`,
      q4Notes && `Q4 (3:00am–5:30am): ${q4Notes}`,
    ].filter(Boolean).join('\n\n');

    const handoffPrompt = BUILDING_CONTEXT + `
=== TASK ===
Write a shift handoff narrative based ONLY on the notes below. This is addressed to "${greeting}".

Shift notes:
${allNotes}

Total XBelt Stoppages: ${totalStoppages}
Total XBelt DT: ${totalXbeltDT}
Total Presort DT: ${totalPresortDT}

=== CRITICAL RULES ===
- No Reads have NOTHING to do with XBelt stoppages — never connect them
- Do NOT assume what caused an XBelt stoppage unless the user explicitly stated it
- Do NOT assume any RME involvement unless the user stated it
- Do NOT add any details not provided by the user
- Do NOT say "you're taking over with..." or address the reader directly mid-narrative
- Do NOT use "elevated" — use "high" or "heavy"
- End with "Have a great shift." on its own line

=== FORMAT ===
- Write in short paragraphs, one per quarter (Q1, Q2, Q3, Q4)
- Start each paragraph with: "We started the shift..." (Q1), "In Q2,..." "In Q3,..." "In the last quarter,..."
- MAXIMUM 9 sentences total across all paragraphs
- Mention total XBelt DT at the end of the last quarter paragraph if provided
- No headers, no bullets, no markdown
- End with: "Have a great shift."

=== EXAMPLE 1 ===
We started the shift with heavy OB volume (MTN1 and PVD2 cases), but carriers were healthy and there were no major issues during Q1.

In Q2, everything remained under control with no major issues. We saw some sort volume during this period.

In Q3, we had our first XBelt stoppage at Bank 2 upper, followed by a second stoppage at CR7 upper.

In the last quarter, we experienced two additional XBelt stoppages — one at DD131 upper (RME intervention required; chute is currently disabled) and another at Sort Lane K/L upper. Total XBelt DT for the shift was 26 minutes.

Have a great shift.

=== EXAMPLE 2 ===
We started the shift with heavy OB recirc, mainly driven by XAB4, HGR5, and BWI2. It was brought under control within the first hour. During Q1, we had one XBelt stoppage due to Robot 2 lower chute, with 1 minute of downtime.

In Q2, everything remained under control with no major issues. We saw some sort volume during this period.

In Q3, we had our second XBelt stoppage at DD333 lower chute, totaling 4 minutes of downtime, and it was resolved without major impact.

In the last quarter, we had two additional XBelt stoppages due to Bank 5 upper chute (Viper — chute still disabled) and Robot 2 lower chute, bringing total XBelt DT for the shift to 17 minutes.

Have a great shift.
`;

    const handoffResponse = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{ role: 'user', content: handoffPrompt }],
    });

    const narrative = handoffResponse.content[0].text.trim();

    const ticketLines = pendingTickets
      ? pendingTickets.split('\n').filter(Boolean).map(t => '• ' + t.trim()).join('\n')
      : '• None';

    const report = [
      `*Good morning ${greeting}! ☀️*`,
      '',
      narrative,
      '',
      `*Pending TTs:*`,
      ticketLines,
      '',
      `*SL2:* ${sl2}`,
      `*CC:* ${finalCC}`,
      `*XBelt DT:* ${totalXbeltDT} ⏱️`,
      `*XBelt Stoppages:* ${totalStoppages}`,
      `*Presort DT:* ${totalPresortDT}`,
      `🟢 *Safety:* ${safety} incidents`,
      '',
      `_📸 Reply to this message to attach screenshots_`,
      '',
      `_IXD Shift Bot • Generated ${timeStr} — ${dateStr}_`,
    ].join('\n');

    await client.chat.postMessage({ channel: SHIFTREPORT_CHANNEL, text: report, mrkdwn: true });

    // Auto-learn from all shift notes in background
    extractAndUpdateVocab(allNotes);

  } catch (err) {
    console.error('Error:', err);
    await client.chat.postMessage({ channel: SHIFTREPORT_CHANNEL, text: `❌ Error: ${err.message}` });
  }
});

// ─────────────────────────────────────────
//  /qtest — Test mode, posts only to your DM
// ─────────────────────────────────────────
app.command('/qtest', async ({ ack, body, client }) => {
  await ack();

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'qtest_modal',
      title: { type: 'plain_text', text: '🧪 Q Report (Test)' },
      submit: { type: 'plain_text', text: 'Test Report' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '🧪 *Test Mode* — Report will only be sent to your DM. No channels will be notified.' },
        },
        {
          type: 'input', block_id: 'block_label',
          label: { type: 'plain_text', text: 'Select Block' },
          element: { type: 'static_select', action_id: 'block_label_input',
            placeholder: { type: 'plain_text', text: 'Choose Q1, Q2, Q3 or Q4' },
            options: [
              { text: { type: 'plain_text', text: 'Q1 — 7:00pm to 9:30pm' },  value: 'Q1' },
              { text: { type: 'plain_text', text: 'Q2 — 9:45pm to 12:00am' }, value: 'Q2' },
              { text: { type: 'plain_text', text: 'Q3 — 12:30am to 2:45am' }, value: 'Q3' },
              { text: { type: 'plain_text', text: 'Q4 — 3:00am to 5:30am' },  value: 'Q4' },
            ] },
        },
        {
          type: 'input', block_id: 'xbelt_stoppages',
          label: { type: 'plain_text', text: 'XBelt Stoppages (this Q)' },
          element: { type: 'plain_text_input', action_id: 'xbelt_stoppages_input',
            placeholder: { type: 'plain_text', text: 'e.g. 2' } },
        },
        {
          type: 'input', block_id: 'xbelt_dt_total', optional: true,
          label: { type: 'plain_text', text: 'XBelt DT (shift total so far)' },
          element: { type: 'plain_text_input', action_id: 'xbelt_dt_total_input',
            placeholder: { type: 'plain_text', text: 'e.g. 11min' } },
        },
        {
          type: 'input', block_id: 'presort_dt', optional: true,
          label: { type: 'plain_text', text: 'Presort DT (this Q)' },
          element: { type: 'plain_text_input', action_id: 'presort_dt_input',
            placeholder: { type: 'plain_text', text: 'e.g. 16min due to low carriers' } },
        },
        {
          type: 'input', block_id: 'barriers', optional: true,
          label: { type: 'plain_text', text: '⚠️ Barriers / Issues' },
          element: { type: 'plain_text_input', action_id: 'barriers_input', multiline: true,
            placeholder: { type: 'plain_text', text: 'e.g. Heavy OB recirc from XAB4_CASE.' } },
        },
        {
          type: 'input', block_id: 'extra_details', optional: true,
          label: { type: 'plain_text', text: '✅ Wins / Resolutions' },
          element: { type: 'plain_text_input', action_id: 'extra_details_input', multiline: true,
            placeholder: { type: 'plain_text', text: 'e.g. Carriers recovered by end of Q.' } },
        },
        {
          type: 'input', block_id: 'pending_tickets', optional: true,
          label: { type: 'plain_text', text: 'Pending Tickets (one per line)' },
          element: { type: 'plain_text_input', action_id: 'pending_tickets_input', multiline: true,
            placeholder: { type: 'plain_text', text: 'e.g.\nDD208 Missing Roller (M3)' } },
        },
        {
          type: 'input', block_id: 'volume_ib', optional: true,
          label: { type: 'plain_text', text: 'IB Online (non-PR) Carton' },
          element: { type: 'plain_text_input', action_id: 'volume_ib_input',
            placeholder: { type: 'plain_text', text: 'e.g. 22,763' } },
        },
        {
          type: 'input', block_id: 'goal_ib', optional: true,
          label: { type: 'plain_text', text: 'IB Shift Goal (e.g. 60k)' },
          element: { type: 'plain_text_input', action_id: 'goal_ib_input',
            placeholder: { type: 'plain_text', text: 'e.g. 60k or 60,000' } },
        },
        {
          type: 'input', block_id: 'volume_ob', optional: true,
          label: { type: 'plain_text', text: 'OB Volume' },
          element: { type: 'plain_text_input', action_id: 'volume_ob_input',
            placeholder: { type: 'plain_text', text: 'e.g. 25,873' } },
        },
        {
          type: 'input', block_id: 'goal_ob', optional: true,
          label: { type: 'plain_text', text: 'OB Shift Goal (e.g. 78k)' },
          element: { type: 'plain_text_input', action_id: 'goal_ob_input',
            placeholder: { type: 'plain_text', text: 'e.g. 78k or 78,000' } },
        },
      ],
    },
  });
});

// ─────────────────────────────────────────
//  /qtest modal submit — posts to DM only
// ─────────────────────────────────────────
app.view('qtest_modal', async ({ ack, body, view, client }) => {
  await ack();

  const userId       = body.user.id;
  const values       = view.state.values;
  const blockLabel   = values.block_label.block_label_input.selected_option.value;
  const { blockTime, upNext } = BLOCK_SCHEDULE[blockLabel];
  const xbeltStoppages = values.xbelt_stoppages.xbelt_stoppages_input.value;
  const xbeltDTTotal   = values.xbelt_dt_total.xbelt_dt_total_input.value || 'N/A';
  const presortDT      = values.presort_dt.presort_dt_input.value || 'None';
  const barriers       = values.barriers.barriers_input.value || '';
  const extraDetails   = values.extra_details.extra_details_input.value || '';
  const pendingTickets = values.pending_tickets.pending_tickets_input.value || '';
  const volumeIB       = values.volume_ib.volume_ib_input.value || '';
  const goalIB         = values.goal_ib.goal_ib_input.value || '';
  const volumeOB       = values.volume_ob.volume_ob_input.value || '';
  const goalOB         = values.goal_ob.goal_ob_input.value || '';

  // Post to test channel
  const TEST_CHANNEL = 'C0B2TFA8C07'; // Daniel's personal channel

  try {
    const notes = [
      barriers && barriers !== '0' && `Barriers: ${barriers}`,
      extraDetails && extraDetails !== '0' && `Wins/Resolutions: ${extraDetails}`,
      presortDT && presortDT !== 'None' && presortDT !== '0' && `Presort DT: ${presortDT}`,
      xbeltDTTotal !== 'N/A' && `Shift total XBelt DT so far: ${xbeltDTTotal}`,
    ].filter(Boolean).join('\n');

    const qSummary = await generateQSummary(blockLabel, blockTime, notes || 'Clean quarter — no major issues reported.');

    const now     = new Date();
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const dateStr = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const ticketLines = pendingTickets ? pendingTickets.split('\n').filter(Boolean).map(t => '• ' + t.trim()).join('\n') : '• None';

    const report = [
      `🧪 *[TEST] ${blockLabel} Block Report — ${dateStr}*`,
      `_Only visible to you — not posted to any channel_`,
      `*Building:* IXD  |  *Block Time:* ${blockTime}  |  *Up Next:* ${upNext}`,
      '',
      `:alert: *XBelt Stoppages (this Q):* ${xbeltStoppages}`,
      `⏱️ *XBelt DT (shift total):* ${xbeltDTTotal}`,
      `⏱️ *Presort DT (this Q):* ${presortDT}`,
      '',
      `:speaking_head_in_silhouette: *Pending Tickets:*`,
      ticketLines,
      '',
      `📊 *Volume vs Goal:*`,
      buildScoreboard(volumeIB, goalIB, volumeOB, goalOB, blockLabel),
      '',
      `:spiral_note_pad: *${blockLabel} Operational Summary:*`,
      qSummary,
      '',
      `_🧪 Test Mode | Generated ${timeStr}_`,
    ].join('\n');

    // Send to test channel
    await client.chat.postMessage({
      channel: TEST_CHANNEL,
      text: report,
      mrkdwn: true,
    });

    // Test mode — do NOT learn from test notes

  } catch (err) {
    console.error('Error:', err);
    await client.chat.postMessage({
      channel: TEST_CHANNEL,
      text: `❌ Error: ${err.message}`,
    });
  }
});

// ─────────────────────────────────────────
//  /ticket — Post multiple pending tickets
// ─────────────────────────────────────────
app.command('/ticket', async ({ ack, body, client }) => {
  await ack();

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'ticket_modal',
      title: { type: 'plain_text', text: '🎫 Pending Tickets' },
      submit: { type: 'plain_text', text: 'Post Tickets' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'input', block_id: 'target_channel',
          label: { type: 'plain_text', text: '📢 Post To' },
          element: { type: 'conversations_select', action_id: 'target_channel_input',
            placeholder: { type: 'plain_text', text: 'Select a channel' },
            filter: { include: ['public', 'private'], exclude_bot_users: true } },
        },
        {
          type: 'input', block_id: 'ticket_status',
          label: { type: 'plain_text', text: 'Status' },
          element: { type: 'static_select', action_id: 'ticket_status_input',
            placeholder: { type: 'plain_text', text: 'Select status' },
            options: [
              { text: { type: 'plain_text', text: '🔴 Open' },        value: '🔴 Open' },
              { text: { type: 'plain_text', text: '🟡 In Progress' }, value: '🟡 In Progress' },
              { text: { type: 'plain_text', text: '🟢 Resolved' },    value: '🟢 Resolved' },
            ] },
        },
        // Ticket 1
        { type: 'divider' },
        {
          type: 'input', block_id: 'ticket_1_text',
          label: { type: 'plain_text', text: 'Ticket 1' },
          element: { type: 'plain_text_input', action_id: 'ticket_1_text_input', multiline: true,
            placeholder: { type: 'plain_text', text: 'Paste ticket here:\nLink: https://t.corp.amazon.com/...\nTitle: [TEB9-RME] ...' } },
        },
        {
          type: 'input', block_id: 'ticket_1_user', optional: true,
          label: { type: 'plain_text', text: 'Ticket 1 — Tag Person (optional)' },
          element: { type: 'users_select', action_id: 'ticket_1_user_input',
            placeholder: { type: 'plain_text', text: 'Tag a team member' } },
        },
        {
          type: 'input', block_id: 'ticket_1_priority', optional: true,
          label: { type: 'plain_text', text: 'Ticket 1 — Priority' },
          element: { type: 'static_select', action_id: 'ticket_1_priority_input',
            placeholder: { type: 'plain_text', text: 'Select priority' },
            options: [
              { text: { type: 'plain_text', text: ':weewoo: Top Priority' }, value: ':weewoo: Top Priority' },
              { text: { type: 'plain_text', text: '🟡 Medium' }, value: '🟡 Medium' },
              { text: { type: 'plain_text', text: '🟢 Low' }, value: '🟢 Low' },
            ] },
        },
        // Ticket 2
        { type: 'divider' },
        {
          type: 'input', block_id: 'ticket_2_text', optional: true,
          label: { type: 'plain_text', text: 'Ticket 2 (optional)' },
          element: { type: 'plain_text_input', action_id: 'ticket_2_text_input', multiline: true,
            placeholder: { type: 'plain_text', text: 'Paste ticket here...' } },
        },
        {
          type: 'input', block_id: 'ticket_2_user', optional: true,
          label: { type: 'plain_text', text: 'Ticket 2 — Tag Person (optional)' },
          element: { type: 'users_select', action_id: 'ticket_2_user_input',
            placeholder: { type: 'plain_text', text: 'Tag a team member' } },
        },
        {
          type: 'input', block_id: 'ticket_2_priority', optional: true,
          label: { type: 'plain_text', text: 'Ticket 2 — Priority' },
          element: { type: 'static_select', action_id: 'ticket_2_priority_input',
            placeholder: { type: 'plain_text', text: 'Select priority' },
            options: [
              { text: { type: 'plain_text', text: ':weewoo: Top Priority' }, value: ':weewoo: Top Priority' },
              { text: { type: 'plain_text', text: '🟡 Medium' }, value: '🟡 Medium' },
              { text: { type: 'plain_text', text: '🟢 Low' }, value: '🟢 Low' },
            ] },
        },
        // Ticket 3
        { type: 'divider' },
        {
          type: 'input', block_id: 'ticket_3_text', optional: true,
          label: { type: 'plain_text', text: 'Ticket 3 (optional)' },
          element: { type: 'plain_text_input', action_id: 'ticket_3_text_input', multiline: true,
            placeholder: { type: 'plain_text', text: 'Paste ticket here...' } },
        },
        {
          type: 'input', block_id: 'ticket_3_user', optional: true,
          label: { type: 'plain_text', text: 'Ticket 3 — Tag Person (optional)' },
          element: { type: 'users_select', action_id: 'ticket_3_user_input',
            placeholder: { type: 'plain_text', text: 'Tag a team member' } },
        },
        {
          type: 'input', block_id: 'ticket_3_priority', optional: true,
          label: { type: 'plain_text', text: 'Ticket 3 — Priority' },
          element: { type: 'static_select', action_id: 'ticket_3_priority_input',
            placeholder: { type: 'plain_text', text: 'Select priority' },
            options: [
              { text: { type: 'plain_text', text: ':weewoo: Top Priority' }, value: ':weewoo: Top Priority' },
              { text: { type: 'plain_text', text: '🟡 Medium' }, value: '🟡 Medium' },
              { text: { type: 'plain_text', text: '🟢 Low' }, value: '🟢 Low' },
            ] },
        },
        // Ticket 4
        { type: 'divider' },
        {
          type: 'input', block_id: 'ticket_4_text', optional: true,
          label: { type: 'plain_text', text: 'Ticket 4 (optional)' },
          element: { type: 'plain_text_input', action_id: 'ticket_4_text_input', multiline: true,
            placeholder: { type: 'plain_text', text: 'Paste ticket here...' } },
        },
        {
          type: 'input', block_id: 'ticket_4_user', optional: true,
          label: { type: 'plain_text', text: 'Ticket 4 — Tag Person (optional)' },
          element: { type: 'users_select', action_id: 'ticket_4_user_input',
            placeholder: { type: 'plain_text', text: 'Tag a team member' } },
        },
        {
          type: 'input', block_id: 'ticket_4_priority', optional: true,
          label: { type: 'plain_text', text: 'Ticket 4 — Priority' },
          element: { type: 'static_select', action_id: 'ticket_4_priority_input',
            placeholder: { type: 'plain_text', text: 'Select priority' },
            options: [
              { text: { type: 'plain_text', text: ':weewoo: Top Priority' }, value: ':weewoo: Top Priority' },
              { text: { type: 'plain_text', text: '🟡 Medium' }, value: '🟡 Medium' },
              { text: { type: 'plain_text', text: '🟢 Low' }, value: '🟢 Low' },
            ] },
        },
        // Ticket 5
        { type: 'divider' },
        {
          type: 'input', block_id: 'ticket_5_text', optional: true,
          label: { type: 'plain_text', text: 'Ticket 5 (optional)' },
          element: { type: 'plain_text_input', action_id: 'ticket_5_text_input', multiline: true,
            placeholder: { type: 'plain_text', text: 'Paste ticket here...' } },
        },
        {
          type: 'input', block_id: 'ticket_5_user', optional: true,
          label: { type: 'plain_text', text: 'Ticket 5 — Tag Person (optional)' },
          element: { type: 'users_select', action_id: 'ticket_5_user_input',
            placeholder: { type: 'plain_text', text: 'Tag a team member' } },
        },
        {
          type: 'input', block_id: 'ticket_5_priority', optional: true,
          label: { type: 'plain_text', text: 'Ticket 5 — Priority' },
          element: { type: 'static_select', action_id: 'ticket_5_priority_input',
            placeholder: { type: 'plain_text', text: 'Select priority' },
            options: [
              { text: { type: 'plain_text', text: ':weewoo: Top Priority' }, value: ':weewoo: Top Priority' },
              { text: { type: 'plain_text', text: '🟡 Medium' }, value: '🟡 Medium' },
              { text: { type: 'plain_text', text: '🟢 Low' }, value: '🟢 Low' },
            ] },
        },
        { type: 'divider' },
        {
          type: 'input', block_id: 'ticket_notes', optional: true,
          label: { type: 'plain_text', text: '📝 Additional Notes' },
          element: { type: 'plain_text_input', action_id: 'ticket_notes_input', multiline: true,
            placeholder: { type: 'plain_text', text: 'e.g. RME notified, chutes disabled' } },
        },
      ],
    },
  });
});

// ─────────────────────────────────────────
//  /ticket modal submit
// ─────────────────────────────────────────
app.view('ticket_modal', async ({ ack, body, view, client }) => {
  await ack();

  const values        = view.state.values;
  const targetChannel = values.target_channel.target_channel_input.selected_conversation;
  const status        = values.ticket_status.ticket_status_input.selected_option.value;
  const notes         = values.ticket_notes.ticket_notes_input.value || '';

  // Collect all tickets
  const tickets = [];
  for (let i = 1; i <= 5; i++) {
    let ticketText = values[`ticket_${i}_text`]?.[`ticket_${i}_text_input`]?.value;
    if (ticketText) {
      // Clean up JLL ticket format
      // Remove "TEB9 JLL Tickets" lines and timestamp-only lines
      ticketText = ticketText
        .split('\n')
        .filter(line => {
          const trimmed = line.trim();
          // Skip empty lines, "TEB9 JLL Tickets" header, and timestamp-only lines like [8:48 AM]
          return trimmed && 
                 !trimmed.includes('TEB9 JLL Tickets') && 
                 !trimmed.match(/^\[\d{1,2}:\d{2}\s*(AM|PM)\]$/i);
        })
        .join('\n')
        .trim();
      
      const user       = values[`ticket_${i}_user`]?.[`ticket_${i}_user_input`]?.selected_user || '';
      const priority   = values[`ticket_${i}_priority`]?.[`ticket_${i}_priority_input`]?.selected_option?.value || '';
      if (ticketText) tickets.push({ ticketText, user, priority });
    }
  }

  const now     = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  const ticketLines = tickets.map((t) => {
    const header = [
      t.priority ? t.priority : '',
      ':ticketing-simt:',
      t.user ? `<@${t.user}>` : '',
    ].filter(Boolean).join(' ');
    return `${header}\n${t.ticketText}`;
  }).join('\n\n');

  const report = [
    `:ticketing-simt: *Pending Tickets — ${status}*`,
    '',
    ticketLines,
    notes ? `\n📝 *Notes:* ${notes}` : '',
    '',
    `_Posted at ${timeStr} by IXD Shift Bot_`,
  ].filter(Boolean).join('\n');

  await client.chat.postMessage({
    channel: targetChannel,
    text: report,
    mrkdwn: true,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: report },
      },
    ],
  });

  // Auto-post to CF Lead when ticket is resolved
  if (status === '🟢 Resolved') {
    const resolvedLines = tickets.map(t => {
      const header = [':gtg:', t.user ? `<@${t.user}>` : ''].filter(Boolean).join(' ');
      return `${header}\n${t.ticketText}`;
    }).join('\n\n');

    const cfReport = [
      `:gtg: *Ticket Resolved!*`,
      '',
      resolvedLines,
      '',
      `_Resolved at ${timeStr} by IXD Shift Bot_`,
    ].join('\n');

    await client.chat.postMessage({
      channel: CF_LEAD_CHANNEL,
      text: cfReport,
      mrkdwn: true,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: cfReport } }],
    });
  }
});

// ─────────────────────────────────────────
//  :gtg: reaction listener
//  When anyone reacts with :gtg: on any message,
//  bot reposts that message to #teb9-cf-lead
// ─────────────────────────────────────────
app.event('reaction_added', async ({ event, client }) => {
  // Only trigger on :gtg: emoji
  if (event.reaction !== 'gtg') return;

  try {
    // Fetch the original message
    const result = await client.conversations.history({
      channel: event.item.channel,
      latest: event.item.ts,
      limit: 1,
      inclusive: true,
    });

    const originalMsg = result.messages?.[0];
    if (!originalMsg) return;

    // Get the name of the person who reacted
    const reactor = await client.users.info({ user: event.user });
    const reactorName = reactor.user?.real_name || 'Someone';

    // Get channel name
    const channelInfo = await client.conversations.info({ channel: event.item.channel });
    const channelName = channelInfo.channel?.name || 'unknown channel';

    const now     = new Date();
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    const cfPost = [
      `:gtg: *Resolved — posted by ${reactorName}*`,
      `_From #${channelName} at ${timeStr}_`,
      '',
      originalMsg.text,
    ].join('\n');

    await client.chat.postMessage({
      channel: CF_LEAD_CHANNEL,
      text: cfPost,
      mrkdwn: true,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: cfPost } }],
    });

    console.log(`✅ GTG reaction by ${reactorName} — posted to CF Lead`);

  } catch (err) {
    console.error('GTG reaction error:', err.message);
  }
});

// ─────────────────────────────────────────
//  /sos — Start of Shift status post
// ─────────────────────────────────────────
app.command('/sos', async ({ ack, body, client }) => {
  await ack();

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'sos_modal',
      title: { type: 'plain_text', text: '🌅 Start of Shift' },
      submit: { type: 'plain_text', text: 'Post SOS' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        // Channel
        {
          type: 'input', block_id: 'target_channel',
          label: { type: 'plain_text', text: '📢 Post To' },
          element: { type: 'conversations_select', action_id: 'target_channel_input',
            placeholder: { type: 'plain_text', text: 'Select a channel' },
            filter: { include: ['public', 'private'], exclude_bot_users: true } },
        },
        // Schedule option
        {
          type: 'input', block_id: 'post_type',
          label: { type: 'plain_text', text: '⏰ Post Type' },
          element: { type: 'static_select', action_id: 'post_type_input',
            placeholder: { type: 'plain_text', text: 'Post now or schedule?' },
            options: [
              { text: { type: 'plain_text', text: '📤 Post Now' },     value: 'now' },
              { text: { type: 'plain_text', text: '⏰ Schedule' },      value: 'schedule' },
            ] },
        },
        // Time picker (for scheduled posts)
        {
          type: 'input', block_id: 'schedule_time', optional: true,
          label: { type: 'plain_text', text: '🕖 Schedule Time (e.g. 7:00pm)' },
          element: { type: 'plain_text_input', action_id: 'schedule_time_input',
            placeholder: { type: 'plain_text', text: 'e.g. 7:00pm or 19:00' } },
        },
        // PA 1
        {
          type: 'input', block_id: 'pa_1',
          label: { type: 'plain_text', text: '👤 PA on Duty #1' },
          element: { type: 'users_select', action_id: 'pa_1_input',
            placeholder: { type: 'plain_text', text: 'Select PA' } },
        },
        // PA 2
        {
          type: 'input', block_id: 'pa_2', optional: true,
          label: { type: 'plain_text', text: '👤 PA on Duty #2 (optional)' },
          element: { type: 'users_select', action_id: 'pa_2_input',
            placeholder: { type: 'plain_text', text: 'Select second PA' } },
        },
        { type: 'divider' },
        // CC at SOS
        {
          type: 'input', block_id: 'sos_cc',
          label: { type: 'plain_text', text: '🔵 CC at SOS' },
          element: { type: 'plain_text_input', action_id: 'sos_cc_input',
            placeholder: { type: 'plain_text', text: 'e.g. 541cc' } },
        },
        // SL2
        {
          type: 'input', block_id: 'sos_sl2', optional: true,
          label: { type: 'plain_text', text: '📈 SL2 %' },
          element: { type: 'plain_text_input', action_id: 'sos_sl2_input',
            placeholder: { type: 'plain_text', text: 'e.g. 85%' } },
        },
        // XBelt Status
        {
          type: 'input', block_id: 'xbelt_status',
          label: { type: 'plain_text', text: '⚡ XBelt Status' },
          element: { type: 'static_select', action_id: 'xbelt_status_input',
            placeholder: { type: 'plain_text', text: 'Select status' },
            options: [
              { text: { type: 'plain_text', text: '🟢 ON' },                  value: '🟢 ON' },
              { text: { type: 'plain_text', text: '🔴 OFF' },                 value: '🔴 OFF' },
              { text: { type: 'plain_text', text: '🟡 RME Still Working' },   value: '🟡 RME Still Working' },
            ] },
        },
        { type: 'divider' },
        // Top Recirc
        {
          type: 'input', block_id: 'top_recirc', optional: true,
          label: { type: 'plain_text', text: '🔄 Top Recirc at SOS' },
          element: { type: 'plain_text_input', action_id: 'top_recirc_input', multiline: true,
            placeholder: { type: 'plain_text', text: 'e.g. Heavy OB recirc from XAB4, BWI2\nSort recirc from 5LBS' } },
        },
        { type: 'divider' },
        // Pending TTs from previous shift
        {
          type: 'input', block_id: 'pending_tts', optional: true,
          label: { type: 'plain_text', text: ':ticketing-simt: Pending TTs from Previous Shift' },
          element: { type: 'plain_text_input', action_id: 'pending_tts_input', multiline: true,
            placeholder: { type: 'plain_text', text: 'e.g.\nDD208 Missing Roller (M3)\nBANK 6 upper chute jammed' } },
        },
      ],
    },
  });
});

// ─────────────────────────────────────────
//  /sos modal submit
// ─────────────────────────────────────────
app.view('sos_modal', async ({ ack, body, view, client }) => {
  await ack();

  const values        = view.state.values;
  const userId        = body.user.id;
  const targetChannel = values.target_channel.target_channel_input.selected_conversation;
  const postType      = values.post_type.post_type_input.selected_option.value;
  const scheduleTime  = values.schedule_time?.schedule_time_input?.value || '';
  const pa1           = values.pa_1.pa_1_input.selected_user;
  const pa2           = values.pa_2?.pa_2_input?.selected_user || null;
  const cc            = values.sos_cc.sos_cc_input.value;
  const sl2           = values.sos_sl2.sos_sl2_input.value || 'N/A';
  const xbeltStatus   = values.xbelt_status.xbelt_status_input.selected_option.value;
  const topRecirc     = values.top_recirc.top_recirc_input.value || '';
  const pendingTTs    = values.pending_tts.pending_tts_input.value || '';

  const now     = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const dateStr = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  const ccNum = parseInt(cc.replace(/[^0-9]/g, ''), 10) || 0;
  const ccDot = ccNum >= 300 ? '🟢' : ccNum >= 200 ? '🟡' : '🔴';

  const ttLines = pendingTTs
    ? pendingTTs.split('\n').filter(Boolean).map(t => `• ${t.trim()}`).join('\n')
    : 'None';

  const recircLines = topRecirc
    ? topRecirc.split('\n').filter(Boolean).map(r => `• ${r.trim()}`).join('\n')
    : 'None reported';

  const paLine = pa2 ? `<@${pa1}> & <@${pa2}>` : `<@${pa1}>`;

  const report = [
    `🌅 *Start of Shift — TEB9 IXD*`,
    `*Date:* ${dateStr}  |  *Shift:* 7:00pm – 5:30am`,
    '',
    `*👤 PA on Duty:* ${paLine}`,
    '',
    `*SOS Status:*`,
    `:gr-big-red-button: *XBelt:* ${xbeltStatus}`,
    `:package: *CC:* ${cc}`,
    `*SL2:* ${sl2}`,
    '',
    `*🔄 Top Recirc:*`,
    recircLines,
    '',
    `:ticketing-simt: *Pending TTs from Previous Shift:*`,
    ttLines,
    '',
    `_IXD Shift Bot • SOS posted at ${timeStr}_`,
  ].filter(line => line !== undefined).join('\n');

  if (postType === 'now') {
    // Post immediately
    await client.chat.postMessage({
      channel: targetChannel,
      text: report,
      mrkdwn: true,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: report } }],
    });

  } else if (postType === 'schedule' && scheduleTime) {
    // Parse time string (e.g. "7:00pm" or "19:00")
    const parseTime = (timeStr) => {
      const now = new Date();
      const match = timeStr.match(/(\d+):(\d+)\s*(am|pm)?/i);
      if (!match) return null;
      let hours = parseInt(match[1]);
      const mins = parseInt(match[2]);
      const period = match[3]?.toLowerCase();
      if (period === 'pm' && hours < 12) hours += 12;
      if (period === 'am' && hours === 12) hours = 0;
      const scheduled = new Date(now);
      scheduled.setHours(hours, mins, 0, 0);
      // If time already passed today, schedule for tomorrow
      if (scheduled <= now) scheduled.setDate(scheduled.getDate() + 1);
      return Math.floor(scheduled.getTime() / 1000);
    };

    const postAt = parseTime(scheduleTime);
    if (!postAt) {
      await client.chat.postMessage({
        channel: targetChannel,
        text: `❌ Could not parse time "${scheduleTime}". Please use format like *7:00pm* or *19:00*`,
      });
      return;
    }

    // Schedule the message
    const scheduled = await client.chat.scheduleMessage({
      channel: targetChannel,
      text: report,
      post_at: postAt,
      mrkdwn: true,
    });

    // Save scheduled message ID for cancel/edit
    const scheduledData = JSON.parse(fs.existsSync('./scheduled_sos.json')
      ? fs.readFileSync('./scheduled_sos.json', 'utf8') : '{}');
    scheduledData[userId] = {
      scheduled_message_id: scheduled.scheduled_message_id,
      channel: targetChannel,
      post_at: postAt,
      time_str: scheduleTime,
    };
    fs.writeFileSync('./scheduled_sos.json', JSON.stringify(scheduledData, null, 2));

    const postAtDate = new Date(postAt * 1000);
    const postAtStr = postAtDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    // Notify user
    await client.chat.postMessage({
      channel: targetChannel,
      text: `✅ *SOS scheduled for ${postAtStr} tonight!*\nUse \`/sos cancel\` to cancel or \`/sos edit\` to reschedule.`,
      mrkdwn: true,
    });
  }
});

// ─────────────────────────────────────────
//  /sos cancel — Cancel scheduled SOS
// ─────────────────────────────────────────
app.command('/sos', async ({ ack, body, client, payload }) => {
  await ack();
  const text   = body.text?.trim().toLowerCase();
  const userId = body.user_id;

  if (text === 'cancel' || text === 'edit') {
    // Load scheduled data
    if (!fs.existsSync('./scheduled_sos.json')) {
      await client.chat.postEphemeral({
        channel: body.channel_id,
        user: userId,
        text: '❌ No scheduled SOS found.',
      });
      return;
    }

    const scheduledData = JSON.parse(fs.readFileSync('./scheduled_sos.json', 'utf8'));
    const userSchedule  = scheduledData[userId];

    if (!userSchedule) {
      await client.chat.postEphemeral({
        channel: body.channel_id,
        user: userId,
        text: '❌ No scheduled SOS found for you.',
      });
      return;
    }

    try {
      // Cancel the scheduled message
      await client.chat.deleteScheduledMessage({
        channel: userSchedule.channel,
        scheduled_message_id: userSchedule.scheduled_message_id,
      });

      // Remove from file
      delete scheduledData[userId];
      fs.writeFileSync('./scheduled_sos.json', JSON.stringify(scheduledData, null, 2));

      if (text === 'cancel') {
        await client.chat.postEphemeral({
          channel: body.channel_id,
          user: userId,
          text: `✅ Scheduled SOS for *${userSchedule.time_str}* has been cancelled.`,
          mrkdwn: true,
        });
      } else {
        // Edit — reopen the modal
        await client.views.open({
          trigger_id: body.trigger_id,
          view: {
            type: 'modal',
            callback_id: 'sos_modal',
            title: { type: 'plain_text', text: '✏️ Edit SOS' },
            submit: { type: 'plain_text', text: 'Reschedule' },
            close: { type: 'plain_text', text: 'Cancel' },
            blocks: [
              {
                type: 'section',
                text: { type: 'mrkdwn', text: `✅ Previous SOS for *${userSchedule.time_str}* cancelled. Fill in the new details below.` },
              },
            ],
          },
        });
      }
    } catch (err) {
      await client.chat.postEphemeral({
        channel: body.channel_id,
        user: userId,
        text: `❌ Could not cancel: ${err.message}`,
      });
    }
  }
});



// ─────────────────────────────────────────
//  Auto-forward tickets from teb9-4corners-mhe-tt to CF Lead
// ─────────────────────────────────────────
const TICKETS_CHANNEL = 'C04D8LKQKGA'; // teb9-4corners-mhe-tt

app.message(async ({ message, client, logger }) => {
  try {
    // Only process messages in the tickets channel
    if (message.channel !== TICKETS_CHANNEL) return;
    
    // Skip threads
    if (message.thread_ts) return;
    
    // Skip empty messages
    const text = message.text;
    if (!text || !text.trim()) return;

    logger.info(`[AUTO-FORWARD] Message detected: ${text.substring(0, 50)}...`);

    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    const forwardMsg = [
      `:ticketing-simt: *Ticket from teb9-4corners-mhe-tt*`,
      '',
      text,
      '',
      `_Auto-forwarded at ${timeStr}_`,
    ].join('\n');

    await client.chat.postMessage({
      channel: CF_LEAD_CHANNEL,
      text: forwardMsg,
      mrkdwn: true,
    });
    
    logger.info(`[AUTO-FORWARD] ✅ Ticket forwarded successfully!`);
  } catch (err) {
    logger.error(`[AUTO-FORWARD] ❌ Error:`, err);
  }
});


const COFFEE_QUOTES = [
  // Action-oriented (Low CC / Bad situations)
  { text: "Let's take quick action.", tags: ["low-cc", "action"] },
  { text: "Time to hustle. Let's move.", tags: ["low-cc", "action"] },
  { text: "Fast decisions. Execute now.", tags: ["low-cc", "action"] },
  { text: "Pressure's on. Let's handle it.", tags: ["low-cc", "action"] },
  { text: "No time to waste. Move.", tags: ["low-cc", "action"] },
  { text: "Low CC? We know what to do, let's get that bread.", tags: ["low-cc", "action"] },
  
  // Resilience (XBelt down / Equipment issues)
  { text: "We've handled worse. Handle this.", tags: ["xbelt", "resilience"] },
  { text: "Belt don't stop. Neither do we.", tags: ["xbelt", "resilience"] },
  { text: "Equipment fails. We don't.", tags: ["xbelt", "resilience"] },
  { text: "One problem at a time.", tags: ["xbelt", "resilience"] },
  { text: "Keep pushing. We adapt.", tags: ["xbelt", "resilience"] },
  { text: "Problem spotted. Problem solved.", tags: ["xbelt", "resilience"] },
  
  // Momentum (Healthy CC / Good situations)
  { text: "Keep the momentum going.", tags: ["healthy-cc", "momentum"] },
  { text: "Carriers flowing. Keep it there.", tags: ["healthy-cc", "momentum"] },
  { text: "CC's healthy. Let's lock it in.", tags: ["healthy-cc", "momentum"] },
  { text: "This is what smooth looks like.", tags: ["healthy-cc", "momentum"] },
  { text: "Good rhythm. Keep the pace.", tags: ["healthy-cc", "momentum"] },
  { text: "Everything's clicking. Sustain it.", tags: ["healthy-cc", "momentum"] },
  
  // Neutral/General
  { text: "Let's start making money TEB9.", tags: ["general"] },
  { text: "Let's rock.", tags: ["general"] },
  { text: "Are we up TEB9?", tags: ["general"] },
  { text: "Time to earn it.", tags: ["general"] },
  { text: "Let's handle it.", tags: ["general"] },
  { text: "This is what we do.", tags: ["general"] },
  { text: "More coffee. Less problems.", tags: ["general"] },
  { text: "We're basically running this.", tags: ["general"] },
  { text: "Nice start. Better finish.", tags: ["general"] },
  { text: "Team's locked in.", tags: ["general"] },
  { text: "We got this.", tags: ["general"] },
  { text: "Deliver results :deliver_results: That's what counts. (my favorite leadership principle)", tags: ["general"] },
  { text: "How can we do this better? :learn_and_be_curious: (my favorite leadership principle)", tags: ["general"] },
  { text: "Trust the team. Execute. :earn_trust: (my favorite leadership principle)", tags: ["general"] },
  { text: "Think bigger :think_big: But start now. (my favorite leadership principle)", tags: ["general"] },
  { text: "Earn trust by delivering :earn_trust: (my favorite leadership principle)", tags: ["general"] },
  { text: "Right decision or wrong? Commit :have_backbone_disagree_and_commit: (my favorite leadership principle)", tags: ["general"] },
  { text: "Curious minds :learn_and_be_curious: Better solutions. (my favorite leadership principle)", tags: ["general"] },
  { text: "Customer wins when we execute :customer_obsession: (my favorite leadership principle)", tags: ["general"] },
];

// Helper function to get relevant quotes based on keywords
function getRelevantQuote(noteText) {
  if (!noteText) {
    // Random quote if no note
    return COFFEE_QUOTES[Math.floor(Math.random() * COFFEE_QUOTES.length)].text;
  }

  const lowerNote = noteText.toLowerCase();
  let relevantQuotes = COFFEE_QUOTES;

  // Filter based on keywords in the note
  if (lowerNote.includes('cc') || lowerNote.includes('low')) {
    relevantQuotes = COFFEE_QUOTES.filter(q => q.tags.includes('low-cc') || q.tags.includes('action'));
  } else if (lowerNote.includes('xbelt') || lowerNote.includes('belt') || lowerNote.includes('down')) {
    relevantQuotes = COFFEE_QUOTES.filter(q => q.tags.includes('xbelt') || q.tags.includes('resilience'));
  } else if (lowerNote.includes('healthy') || lowerNote.includes('good') || lowerNote.includes('momentum')) {
    relevantQuotes = COFFEE_QUOTES.filter(q => q.tags.includes('healthy-cc') || q.tags.includes('momentum'));
  }

  // If no relevant quotes found, use general quotes
  if (relevantQuotes.length === 0) {
    relevantQuotes = COFFEE_QUOTES;
  }

  return relevantQuotes[Math.floor(Math.random() * relevantQuotes.length)].text;
}

app.command('/coffee', async ({ ack, body, client }) => {
  await ack();

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'coffee_modal',
      title: { type: 'plain_text', text: '☕ Team Motivation' },
      submit: { type: 'plain_text', text: 'Post' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'input', block_id: 'coffee_note',
          label: { type: 'plain_text', text: '📝 What\'s happening?' },
          element: { type: 'plain_text_input', action_id: 'coffee_note_input',
            placeholder: { type: 'plain_text', text: 'e.g., someone dropped a ticket' },
            multiline: false },
          optional: true,
        },
        {
          type: 'input', block_id: 'coffee_person',
          label: { type: 'plain_text', text: '👤 Tag Person (optional)' },
          element: { type: 'users_select', action_id: 'coffee_person_input',
            placeholder: { type: 'plain_text', text: 'Select a person' } },
          optional: true,
        },
        {
          type: 'input', block_id: 'target_channel',
          label: { type: 'plain_text', text: '📢 Post To' },
          element: { type: 'conversations_select', action_id: 'target_channel_input',
            placeholder: { type: 'plain_text', text: 'Select a channel' },
            filter: { include: ['public', 'private'], exclude_bot_users: true } },
        },
      ],
    },
  });
});

// Helper function to check and fix grammar using Claude
async function checkAndFixGrammar(text) {
  if (!text || text.length < 3) return text; // Skip if too short

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: `Fix any typos or grammar in this short phrase, but keep it casual and positive. Just return the corrected phrase, nothing else. If there are no errors, return it as-is.

"${text}"`,
          },
        ],
      }),
    });

    const data = await response.json();
    const corrected = data.content[0].text.trim();
    return corrected || text;
  } catch (err) {
    console.error('Grammar check error:', err);
    return text; // Return original if API fails
  }
}

app.view('coffee_modal', async ({ ack, body, view, client }) => {
  await ack();

  let coffeeNote = view.state.values.coffee_note.coffee_note_input.value || '';
  const taggedPerson = view.state.values.coffee_person.coffee_person_input.selected_user || null;
  const targetChannel = view.state.values.target_channel.target_channel_input.selected_conversation;
  
  // Check and fix grammar before getting quote
  if (coffeeNote) {
    coffeeNote = await checkAndFixGrammar(coffeeNote);
  }
  
  const quote = getRelevantQuote(coffeeNote);

  let message = `☕ *TEB9 IXD*\n`;
  
  if (taggedPerson) {
    message += `<@${taggedPerson}> `;
  }
  if (coffeeNote) {
    message += `${coffeeNote}`;
  }
  message += ` — _"${quote}"_ 💪`;

  await client.chat.postMessage({
    channel: targetChannel,
    text: message,
    mrkdwn: true,
  });
});

// Button handlers removed - buttons no longer used

(async () => {
  await app.start();
  console.log('⚡ IXD Shift Bot is running in Socket Mode!');
  console.log('Commands: /qreport | /shiftreport | /qtest | /ticket | /sos | /coffee');
  console.log('✅ Auto-forwarding tickets from teb9-4corners-mhe-tt to CF Lead');
})();
