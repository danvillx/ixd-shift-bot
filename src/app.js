// ─────────────────────────────────────────────────────────────
//  DBot 1.5 — TEB9 IXD Amazon Shift Operations Bot
//  Full rebuild merging old app.js + new 1.5 architecture
// ─────────────────────────────────────────────────────────────
require('dotenv').config();
const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

// ── Validate env ──────────────────────────────────────────────
const REQUIRED_ENV = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'ANTHROPIC_API_KEY'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`❌ Missing env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-haiku-4-5-20251001';

// ── Channel IDs ───────────────────────────────────────────────
const QREPORT_CHANNELS    = ['C040FPKF8N9', 'C0B2PG28M0W'];
const CF_LEAD_CHANNEL     = 'C040FPKF8N9';
const SHIFTREPORT_CHANNEL = 'C03AK45DJF8';
const TEST_CHANNEL        = 'C0B2TFA8C07';

// ── Block schedule ────────────────────────────────────────────
const BLOCK_SCHEDULE = {
  Q1: { blockTime: '7:00pm – 9:30pm',  upNext: 'Break 9:30–9:45pm',   isLast: false },
  Q2: { blockTime: '9:45pm – 12:00am', upNext: 'Lunch 12:00–12:30am', isLast: false },
  Q3: { blockTime: '12:30am – 2:45am', upNext: 'Break 2:45–3:00am',   isLast: false },
  Q4: { blockTime: '3:00am – 5:30am',  upNext: 'End of Shift',        isLast: true  },
};

// ── Building context (injected into all AI calls) ─────────────
const BUILDING_CONTEXT = `
You write shift reports for Amazon IXD (TEB9) operations leaders and PAs.

=== CARRIERS / CC ===
- CC = carriers — units on the XBelt
- Low: below 300cc | Healthy: 300–800cc | High: above 800cc
- Low CC causes: high recirc, No Reads, sort volume
- Presort/PIDs/SL2 are cut deliberately to recover carriers — this is normal

=== XBELT / CB ===
- XBelt = CB = main crossbelt conveyor
- Stoppage codes: DD+number, MP1–8, CR1–8, Bank 1–6, Robot 1–5, Sort Lane K/L, IS12, Bypass 1
- XBelt DT = downtime from stoppages only | Presort DT is separate

=== DEPARTMENTS ===
IB (Inbound) — 6 PIDs, Presort North/South, SL2
OB (Outbound) — high recirc sources: XAB4_CASE, BOS3_CASE, BWI2_CASE, MTN1_TOTE, PVD2_CASE, HGR5_CASE
Sort: 5LBS / Mansort / 20LBS | RPND | EOL | MHE | MH2 | Jackpot NS/SS | Viper | RME

=== WRITING RULES ===
ALWAYS: "carriers" not "carrier counts" | "recirc" not "recirculation" | "high/heavy" not "elevated"
ALWAYS: first person plural — "we started", "we had", "we pushed"
NEVER: "environment" | "kickoff" | "carry this momentum" | "required intervention" | "managing the flow"
NEVER: assume XBelt cause, RME involvement, or recirc source unless stated
NEVER: connect No Reads to XBelt stoppages — they are unrelated
`.trim();

// ── Vocab learning system ─────────────────────────────────────
const VOCAB_FILE = path.join(__dirname, '..', 'vocab.json');

function loadVocab() {
  try {
    if (fs.existsSync(VOCAB_FILE)) return JSON.parse(fs.readFileSync(VOCAB_FILE, 'utf8'));
  } catch (e) { console.error('Vocab load error:', e); }
  return { common_phrases: [], equipment_names: [], watch_items: [], ob_sources: [], writing_patterns: [], last_updated: null };
}

function saveVocab(vocab) {
  try { fs.writeFileSync(VOCAB_FILE, JSON.stringify(vocab, null, 2)); }
  catch (e) { console.error('Vocab save error:', e); }
}

function buildVocabContext(vocab) {
  if (!vocab.common_phrases.length && !vocab.equipment_names.length) return '';
  return `
=== LEARNED VOCABULARY (from past shifts — use naturally) ===
${vocab.common_phrases.length  ? `Phrases: ${vocab.common_phrases.slice(0, 15).join(', ')}` : ''}
${vocab.equipment_names.length ? `Equipment: ${vocab.equipment_names.slice(0, 15).join(', ')}` : ''}
${vocab.watch_items.length     ? `Watch items: ${vocab.watch_items.slice(0, 8).join(', ')}` : ''}
${vocab.ob_sources.length      ? `OB sources: ${vocab.ob_sources.slice(0, 10).join(', ')}` : ''}
`.trim();
}

async function extractAndUpdateVocab(notes) {
  if (!notes || notes.length < 20) return;
  const vocab = loadVocab();
  try {
    const res = await anthropic.messages.create({
      model: MODEL, max_tokens: 300,
      messages: [{ role: 'user', content: `Extract vocabulary from these shift notes. Return ONLY valid JSON with fields: common_phrases, equipment_names, watch_items, ob_sources, writing_patterns (each an array of max 5 strings).\n\nNotes: "${notes}"` }],
    });
    const clean = res.content[0].text.trim().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const extracted = JSON.parse(clean);
    const merge = (a, b) => Array.isArray(b) ? [...new Set([...a, ...b])].slice(0, 30) : a;
    vocab.common_phrases   = merge(vocab.common_phrases,   extracted.common_phrases);
    vocab.equipment_names  = merge(vocab.equipment_names,  extracted.equipment_names);
    vocab.watch_items      = merge(vocab.watch_items,      extracted.watch_items);
    vocab.ob_sources       = merge(vocab.ob_sources,       extracted.ob_sources);
    vocab.writing_patterns = merge(vocab.writing_patterns, extracted.writing_patterns);
    vocab.last_updated = new Date().toISOString();
    saveVocab(vocab);
    console.log('✅ Vocab updated');
  } catch (e) { console.error('Vocab extract error:', e); }
}

// ── Progress bar scoreboard ───────────────────────────────────
function buildScoreboard(ibActual, ibShiftGoal, obActual, obShiftGoal, blockLabel) {
  const parse = (val) => {
    if (!val) return 0;
    const s = val.toString().trim().toLowerCase().replace(/,/g, '');
    if (s.endsWith('k')) return Math.round(parseFloat(s) * 1000);
    return parseInt(s, 10) || 0;
  };
  const qPace = { Q1: 0.25, Q2: 0.50, Q3: 0.75, Q4: 1.00 };
  const pace = qPace[blockLabel] || 0.25;

  const ib = parse(ibActual), ibSG = parse(ibShiftGoal);
  const ob = parse(obActual), obSG = parse(obShiftGoal);
  const ibQT = Math.round(ibSG * pace), obQT = Math.round(obSG * pace);

  const bar = (actual, qTarget) => {
    if (!qTarget) return '';
    const pct = Math.round((actual / qTarget) * 100);
    const filled = Math.min(Math.round(pct / 5), 20);
    const dot = pct >= 100 ? '🟢' : pct >= 90 ? '🟡' : '🔴';
    return `${'█'.repeat(filled)}${'░'.repeat(20 - filled)} ${pct}% ${dot}`;
  };

  const lines = ['```'];
  lines.push('┌──────────────────────────────────────┐');
  if (ibSG) {
    lines.push(`│ 🦀 IB  ${ib.toLocaleString()} / ${ibQT.toLocaleString()} (${blockLabel} target)`.padEnd(39) + '│');
    const ibBar = bar(ib, ibQT); if (ibBar) lines.push(`│ ${ibBar.padEnd(36)} │`);
    lines.push(`│ Shift Goal: ${ibSG.toLocaleString()}`.padEnd(39) + '│');
    lines.push('│                                      │');
  }
  if (obSG) {
    lines.push(`│ 🦑 OB  ${ob.toLocaleString()} / ${obQT.toLocaleString()} (${blockLabel} target)`.padEnd(39) + '│');
    const obBar = bar(ob, obQT); if (obBar) lines.push(`│ ${obBar.padEnd(36)} │`);
    lines.push(`│ Shift Goal: ${obSG.toLocaleString()}`.padEnd(39) + '│');
  }
  lines.push('└──────────────────────────────────────┘');
  lines.push('```');
  return lines.join('\n');
}

// ── AI helpers ────────────────────────────────────────────────
async function generateQSummary(blockLabel, blockTime, notes) {
  const vocab = loadVocab();
  const vocabCtx = buildVocabContext(vocab);
  const isLast = BLOCK_SCHEDULE[blockLabel].isLast;

  // Match output length to input length — short input = short output
  const noteLength = notes.replace(/\s+/g, ' ').trim().length;
  const isShort = noteLength < 80;

  const lengthRule = isShort
    ? '- The notes are SHORT. Write ONE paragraph, 2–3 sentences MAX. Do NOT pad or add filler.'
    : `- Write 2 short paragraphs, 4–6 sentences TOTAL. Paragraph 1: what happened. Paragraph 2: resolution + one watch item${isLast ? ' for day shift' : ''}.`;

  const prompt = `${BUILDING_CONTEXT}\n\n${vocabCtx}\n\n=== TASK ===\nWrite a Q-block summary for ${blockLabel} (${blockTime}) based ONLY on these notes:\n${notes}\n\n=== LENGTH RULE (STRICT) ===\n${lengthRule}\n${isLast ? '- Include a brief heads up for day shift at the end.' : ''}\n\n=== RULES ===\n- Match the level of detail in the notes exactly — do NOT expand short notes into long summaries\n- No headers, no bullets, no field names like "Barriers:" or "Wins:"\n- NEVER say "carry this momentum", "required intervention", "environment", "kickoff"\n- Do NOT assume anything not in the notes\n- Do NOT invent details, pad sentences, or add generic filler\n- First person plural throughout`;

  const res = await anthropic.messages.create({
    model: MODEL, max_tokens: 200,
    messages: [{ role: 'user', content: prompt }],
  });
  return res.content[0].text.trim();
}
async function fixGrammar(text) {
  if (!text || text.length < 3) return text;
  try {
    const res = await anthropic.messages.create({
      model: MODEL, max_tokens: 100,
      messages: [{ role: 'user', content: `Fix any typos or grammar in this short phrase. Keep it casual. Return ONLY the corrected phrase, nothing else.\n\n"${text}"` }],
    });
    return res.content[0].text.trim() || text;
  } catch { return text; }
}

// ── /qreport ──────────────────────────────────────────────────
app.command('/qreport', async ({ ack, body, client }) => {
  await ack();
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal', callback_id: 'qreport_modal',
      title: { type: 'plain_text', text: '📋 Q Block Report' },
      submit: { type: 'plain_text', text: 'Generate Report' },
      close:  { type: 'plain_text', text: 'Cancel' },
      blocks: [
        { type: 'input', block_id: 'channel_1',
          label: { type: 'plain_text', text: '📢 Post To (Channel 1)' },
          element: { type: 'conversations_select', action_id: 'channel_1_input',
            placeholder: { type: 'plain_text', text: 'Select channel' },
            filter: { include: ['public','private'], exclude_bot_users: true } } },
        { type: 'input', block_id: 'channel_2', optional: true,
          label: { type: 'plain_text', text: '📢 Post To (Channel 2 — optional)' },
          element: { type: 'conversations_select', action_id: 'channel_2_input',
            placeholder: { type: 'plain_text', text: 'Optional second channel' },
            filter: { include: ['public','private'], exclude_bot_users: true } } },
        { type: 'input', block_id: 'block_label',
          label: { type: 'plain_text', text: 'Block' },
          element: { type: 'static_select', action_id: 'block_label_input',
            options: [
              { text: { type: 'plain_text', text: 'Q1 — 7:00pm to 9:30pm'  }, value: 'Q1' },
              { text: { type: 'plain_text', text: 'Q2 — 9:45pm to 12:00am' }, value: 'Q2' },
              { text: { type: 'plain_text', text: 'Q3 — 12:30am to 2:45am' }, value: 'Q3' },
              { text: { type: 'plain_text', text: 'Q4 — 3:00am to 5:30am'  }, value: 'Q4' },
            ] } },
        { type: 'input', block_id: 'xbelt_stoppages',
          label: { type: 'plain_text', text: 'XBelt Stoppages (this Q)' },
          element: { type: 'plain_text_input', action_id: 'xbelt_stoppages_input',
            placeholder: { type: 'plain_text', text: 'e.g. 2' } } },
        { type: 'input', block_id: 'xbelt_dt_total', optional: true,
          label: { type: 'plain_text', text: 'XBelt DT (shift total so far)' },
          element: { type: 'plain_text_input', action_id: 'xbelt_dt_total_input',
            placeholder: { type: 'plain_text', text: 'e.g. 10min' } } },
        { type: 'input', block_id: 'presort_dt', optional: true,
          label: { type: 'plain_text', text: 'Presort DT (this Q)' },
          element: { type: 'plain_text_input', action_id: 'presort_dt_input',
            placeholder: { type: 'plain_text', text: 'e.g. 48min' } } },
        { type: 'input', block_id: 'barriers', optional: true,
          label: { type: 'plain_text', text: '⚠️ Barriers / Issues' },
          element: { type: 'plain_text_input', action_id: 'barriers_input', multiline: true,
            placeholder: { type: 'plain_text', text: 'e.g. DD332 lower stopped XBelt 7min, OB recirc heavy PVD2_CASE' } } },
        { type: 'input', block_id: 'extra_details', optional: true,
          label: { type: 'plain_text', text: '✅ Wins / Resolutions' },
          element: { type: 'plain_text_input', action_id: 'extra_details_input', multiline: true,
            placeholder: { type: 'plain_text', text: 'e.g. Carriers recovered by end of Q, OB recirc eased' } } },
        { type: 'input', block_id: 'pending_tickets', optional: true,
          label: { type: 'plain_text', text: 'Pending Tickets (one per line)' },
          element: { type: 'plain_text_input', action_id: 'pending_tickets_input', multiline: true,
            placeholder: { type: 'plain_text', text: 'https://t.corp.amazon.com/... | [TEB9-RME] IS42 blowout' } } },
        { type: 'input', block_id: 'volume_ib', optional: true,
          label: { type: 'plain_text', text: 'IB Volume (actual)' },
          element: { type: 'plain_text_input', action_id: 'volume_ib_input',
            placeholder: { type: 'plain_text', text: 'e.g. 33,862' } } },
        { type: 'input', block_id: 'goal_ib', optional: true,
          label: { type: 'plain_text', text: 'IB Shift Goal' },
          element: { type: 'plain_text_input', action_id: 'goal_ib_input',
            placeholder: { type: 'plain_text', text: 'e.g. 80k or 80,000' } } },
        { type: 'input', block_id: 'volume_ob', optional: true,
          label: { type: 'plain_text', text: 'OB Volume (actual)' },
          element: { type: 'plain_text_input', action_id: 'volume_ob_input',
            placeholder: { type: 'plain_text', text: 'e.g. 44,541' } } },
        { type: 'input', block_id: 'goal_ob', optional: true,
          label: { type: 'plain_text', text: 'OB Shift Goal' },
          element: { type: 'plain_text_input', action_id: 'goal_ob_input',
            placeholder: { type: 'plain_text', text: 'e.g. 100k or 100,000' } } },
        { type: 'input', block_id: 'schedule_time', optional: true,
          label: { type: 'plain_text', text: '⏰ Schedule Post (optional)' },
          element: { type: 'plain_text_input', action_id: 'schedule_time_input',
            placeholder: { type: 'plain_text', text: 'e.g. 9:30pm or 21:30 — leave blank to post now' } } },
      ],
    },
  });
});

app.view('qreport_modal', async ({ ack, body, view, client }) => {
  await ack();
  const v = view.state.values;
  const channel1 = v.channel_1.channel_1_input.selected_conversation;
  const channel2 = v.channel_2?.channel_2_input?.selected_conversation || null;
  const targetChannels = [channel1, channel2].filter(Boolean);

  const blockLabel     = v.block_label.block_label_input.selected_option.value;
  const { blockTime, upNext } = BLOCK_SCHEDULE[blockLabel];
  const xbeltStoppages = v.xbelt_stoppages.xbelt_stoppages_input.value;
  const xbeltDTTotal   = v.xbelt_dt_total?.xbelt_dt_total_input?.value || 'N/A';
  const presortDT      = v.presort_dt?.presort_dt_input?.value || 'None';
  const barriers       = v.barriers?.barriers_input?.value || '';
  const extraDetails   = v.extra_details?.extra_details_input?.value || '';
  const pendingTickets = v.pending_tickets?.pending_tickets_input?.value || '';
  const volumeIB       = v.volume_ib?.volume_ib_input?.value || '';
  const goalIB         = v.goal_ib?.goal_ib_input?.value || '';
  const volumeOB       = v.volume_ob?.volume_ob_input?.value || '';
  const goalOB         = v.goal_ob?.goal_ob_input?.value || '';
  const scheduleRaw    = v.schedule_time?.schedule_time_input?.value || '';

  // Parse schedule time if provided
  let postAt = null;
  if (scheduleRaw) {
    try {
      const now = new Date();
      const [timePart, ampm] = scheduleRaw.trim().toLowerCase().replace('.', '').split(/(am|pm)/);
      const [hStr, mStr] = timePart.trim().split(':');
      let hours = parseInt(hStr, 10);
      const mins = parseInt(mStr || '0', 10);
      if (ampm === 'pm' && hours !== 12) hours += 12;
      if (ampm === 'am' && hours === 12) hours = 0;
      const scheduled = new Date(now);
      scheduled.setHours(hours, mins, 0, 0);
      if (scheduled <= now) scheduled.setDate(scheduled.getDate() + 1); // next day if past
      postAt = Math.floor(scheduled.getTime() / 1000);
    } catch { postAt = null; }
  }

  await Promise.all(targetChannels.map(ch =>
    client.chat.postMessage({ channel: ch, text: `⏳ Generating *${blockLabel} Block Report*... hang tight!` })
  ));

  const notes = [
    barriers     && `Barriers: ${barriers}`,
    extraDetails && `Wins/Resolutions: ${extraDetails}`,
    presortDT && presortDT !== 'None' && `Presort DT: ${presortDT}`,
    xbeltDTTotal !== 'N/A' && `Shift total XBelt DT: ${xbeltDTTotal}`,
  ].filter(Boolean).join('\n');

  try {
    const qSummary = await generateQSummary(blockLabel, blockTime, notes || 'Clean quarter — no major issues reported.');
    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    const dateStr = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    const ticketLines = pendingTickets
      ? pendingTickets.split('\n').filter(Boolean).map(t => {
          const [link, ...title] = t.split('|').map(s => s.trim());
          return title.length ? `• Link: ${link}\n• Title: ${title.join(' | ')}` : `• ${link}`;
        }).join('\n')
      : '• None';

    const scoreboardSection = (goalIB || goalOB)
      ? `\n📊 *Volume vs Goal:*\n${buildScoreboard(volumeIB, goalIB, volumeOB, goalOB, blockLabel)}`
      : '';

    const report = [
      `🏭 *${blockLabel} Block Report — ${dateStr}*`,
      `*Building:* IXD  |  *Block Time:* ${blockTime}  |  *Up Next:* ${upNext}`,
      '',
      `❌ *XBelt Stoppages (this Q):* ${xbeltStoppages}`,
      `⏱️ *XBelt DT (shift total):* ${xbeltDTTotal}`,
      `⏱️ *Presort DT (this Q):* ${presortDT}`,
      '',
      `🔵 *Pending Tickets:*`,
      ticketLines,
      scoreboardSection,
      '',
      `📝 *${blockLabel} Operational Summary:*`,
      qSummary,
      '',
      `_IXD Shift Bot • Generated ${timeStr}_`,
    ].join('\n');

    if (postAt) {
      await Promise.all(targetChannels.map(ch =>
        client.chat.scheduleMessage({ channel: ch, text: report, post_at: postAt, mrkdwn: true })
      ));
      const scheduledTime = new Date(postAt * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
      await Promise.all(targetChannels.map(ch =>
        client.chat.postMessage({ channel: ch, text: `⏰ *${blockLabel} Block Report scheduled for ${scheduledTime}*`, mrkdwn: true })
      ));
    } else {
      await Promise.all(targetChannels.map(ch =>
        client.chat.postMessage({ channel: ch, text: report, mrkdwn: true })
      ));
    }
    extractAndUpdateVocab(notes);
  } catch (err) {
    console.error('[/qreport] Error:', err);
    await Promise.all(targetChannels.map(ch =>
      client.chat.postMessage({ channel: ch, text: `❌ Error generating report: ${err.message}` })
    ));
  }
});

// ── /qtest ────────────────────────────────────────────────────
app.command('/qtest', async ({ ack, body, client }) => {
  await ack();
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal', callback_id: 'qtest_modal',
      title: { type: 'plain_text', text: '🧪 Q Report (Test)' },
      submit: { type: 'plain_text', text: 'Test Report' },
      close:  { type: 'plain_text', text: 'Cancel' },
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: '🧪 *Test Mode* — posts only to your DM.' } },
        { type: 'input', block_id: 'block_label',
          label: { type: 'plain_text', text: 'Select Block' },
          element: { type: 'static_select', action_id: 'block_label_input',
            options: [
              { text: { type: 'plain_text', text: 'Q1 — 7:00pm to 9:30pm'  }, value: 'Q1' },
              { text: { type: 'plain_text', text: 'Q2 — 9:45pm to 12:00am' }, value: 'Q2' },
              { text: { type: 'plain_text', text: 'Q3 — 12:30am to 2:45am' }, value: 'Q3' },
              { text: { type: 'plain_text', text: 'Q4 — 3:00am to 5:30am'  }, value: 'Q4' },
            ] } },
        { type: 'input', block_id: 'xbelt_stoppages',
          label: { type: 'plain_text', text: 'XBelt Stoppages (this Q)' },
          element: { type: 'plain_text_input', action_id: 'xbelt_stoppages_input',
            placeholder: { type: 'plain_text', text: 'e.g. 2' } } },
        { type: 'input', block_id: 'xbelt_dt_total', optional: true,
          label: { type: 'plain_text', text: 'XBelt DT (shift total so far)' },
          element: { type: 'plain_text_input', action_id: 'xbelt_dt_total_input',
            placeholder: { type: 'plain_text', text: 'e.g. 11min' } } },
        { type: 'input', block_id: 'presort_dt', optional: true,
          label: { type: 'plain_text', text: 'Presort DT (this Q)' },
          element: { type: 'plain_text_input', action_id: 'presort_dt_input',
            placeholder: { type: 'plain_text', text: 'e.g. 16min due to low carriers' } } },
        { type: 'input', block_id: 'barriers', optional: true,
          label: { type: 'plain_text', text: '⚠️ Barriers / Issues' },
          element: { type: 'plain_text_input', action_id: 'barriers_input', multiline: true,
            placeholder: { type: 'plain_text', text: 'e.g. Heavy OB recirc from XAB4_CASE' } } },
        { type: 'input', block_id: 'extra_details', optional: true,
          label: { type: 'plain_text', text: '✅ Wins / Resolutions' },
          element: { type: 'plain_text_input', action_id: 'extra_details_input', multiline: true,
            placeholder: { type: 'plain_text', text: 'e.g. Carriers recovered by end of Q' } } },
        { type: 'input', block_id: 'pending_tickets', optional: true,
          label: { type: 'plain_text', text: 'Pending Tickets (one per line)' },
          element: { type: 'plain_text_input', action_id: 'pending_tickets_input', multiline: true,
            placeholder: { type: 'plain_text', text: 'e.g. DD208 Missing Roller' } } },
        { type: 'input', block_id: 'volume_ib', optional: true,
          label: { type: 'plain_text', text: 'IB Volume (actual)' },
          element: { type: 'plain_text_input', action_id: 'volume_ib_input',
            placeholder: { type: 'plain_text', text: 'e.g. 22,763' } } },
        { type: 'input', block_id: 'goal_ib', optional: true,
          label: { type: 'plain_text', text: 'IB Shift Goal' },
          element: { type: 'plain_text_input', action_id: 'goal_ib_input',
            placeholder: { type: 'plain_text', text: 'e.g. 60k' } } },
        { type: 'input', block_id: 'volume_ob', optional: true,
          label: { type: 'plain_text', text: 'OB Volume (actual)' },
          element: { type: 'plain_text_input', action_id: 'volume_ob_input',
            placeholder: { type: 'plain_text', text: 'e.g. 25,873' } } },
        { type: 'input', block_id: 'goal_ob', optional: true,
          label: { type: 'plain_text', text: 'OB Shift Goal' },
          element: { type: 'plain_text_input', action_id: 'goal_ob_input',
            placeholder: { type: 'plain_text', text: 'e.g. 78k' } } },
      ],
    },
  });
});

app.view('qtest_modal', async ({ ack, body, view, client }) => {
  await ack();
  const userId = body.user.id;
  const v = view.state.values;
  const blockLabel   = v.block_label.block_label_input.selected_option.value;
  const { blockTime, upNext } = BLOCK_SCHEDULE[blockLabel];
  const xbeltStoppages = v.xbelt_stoppages.xbelt_stoppages_input.value;
  const xbeltDTTotal   = v.xbelt_dt_total?.xbelt_dt_total_input?.value || 'N/A';
  const presortDT      = v.presort_dt?.presort_dt_input?.value || 'None';
  const barriers       = v.barriers?.barriers_input?.value || '';
  const extraDetails   = v.extra_details?.extra_details_input?.value || '';
  const pendingTickets = v.pending_tickets?.pending_tickets_input?.value || '';
  const volumeIB       = v.volume_ib?.volume_ib_input?.value || '';
  const goalIB         = v.goal_ib?.goal_ib_input?.value || '';
  const volumeOB       = v.volume_ob?.volume_ob_input?.value || '';
  const goalOB         = v.goal_ob?.goal_ob_input?.value || '';

  const notes = [
    barriers     && `Barriers: ${barriers}`,
    extraDetails && `Wins/Resolutions: ${extraDetails}`,
    presortDT && presortDT !== 'None' && `Presort DT: ${presortDT}`,
    xbeltDTTotal !== 'N/A' && `Shift total XBelt DT: ${xbeltDTTotal}`,
  ].filter(Boolean).join('\n');

  try {
    const qSummary = await generateQSummary(blockLabel, blockTime, notes || 'Clean quarter — no major issues reported.');
    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    const dateStr = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const ticketLines = pendingTickets ? pendingTickets.split('\n').filter(Boolean).map(t => '• ' + t.trim()).join('\n') : '• None';
    const scoreboardSection = (goalIB || goalOB) ? `\n📊 *Volume vs Goal:*\n${buildScoreboard(volumeIB, goalIB, volumeOB, goalOB, blockLabel)}` : '';

    const report = [
      `🧪 *[TEST] ${blockLabel} Block Report — ${dateStr}*`,
      `_Only visible to you — not posted to any channel_`,
      `*Building:* IXD  |  *Block Time:* ${blockTime}  |  *Up Next:* ${upNext}`,
      '',
      `❌ *XBelt Stoppages (this Q):* ${xbeltStoppages}`,
      `⏱️ *XBelt DT (shift total):* ${xbeltDTTotal}`,
      `⏱️ *Presort DT (this Q):* ${presortDT}`,
      '',
      `🔵 *Pending Tickets:*`,
      ticketLines,
      scoreboardSection,
      '',
      `📝 *${blockLabel} Operational Summary:*`,
      qSummary,
      '',
      `_🧪 Test Mode | Generated ${timeStr}_`,
    ].join('\n');

    await client.chat.postMessage({ channel: TEST_CHANNEL, text: report, mrkdwn: true });
  } catch (err) {
    console.error('[/qtest] Error:', err);
    await client.chat.postMessage({ channel: TEST_CHANNEL, text: `❌ Error: ${err.message}` });
  }
});

// ── /shiftreport ──────────────────────────────────────────────
app.command('/shiftreport', async ({ ack, body, client }) => {
  await ack();
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal', callback_id: 'shiftreport_modal',
      title: { type: 'plain_text', text: '🏭 Shift Handoff' },
      submit: { type: 'plain_text', text: 'Generate Handoff' },
      close:  { type: 'plain_text', text: 'Cancel' },
      blocks: [
        { type: 'divider' },
        { type: 'section', text: { type: 'mrkdwn', text: '*🕖 Q1 — 7:00pm to 9:30pm*' } },
        { type: 'input', block_id: 'q1_notes', optional: true,
          label: { type: 'plain_text', text: 'Q1 Notes' },
          element: { type: 'plain_text_input', action_id: 'q1_notes_input', multiline: true,
            placeholder: { type: 'plain_text', text: 'CC at SOS, stoppages, recirc, barriers, wins...' } } },
        { type: 'divider' },
        { type: 'section', text: { type: 'mrkdwn', text: '*🕙 Q2 — 9:45pm to 12:00am*' } },
        { type: 'input', block_id: 'q2_notes', optional: true,
          label: { type: 'plain_text', text: 'Q2 Notes' },
          element: { type: 'plain_text_input', action_id: 'q2_notes_input', multiline: true,
            placeholder: { type: 'plain_text', text: 'CC, stoppages, recirc, issues, wins...' } } },
        { type: 'divider' },
        { type: 'section', text: { type: 'mrkdwn', text: '*🕐 Q3 — 12:30am to 2:45am*' } },
        { type: 'input', block_id: 'q3_notes', optional: true,
          label: { type: 'plain_text', text: 'Q3 Notes' },
          element: { type: 'plain_text_input', action_id: 'q3_notes_input', multiline: true,
            placeholder: { type: 'plain_text', text: 'CC, stoppages, recirc, issues, wins...' } } },
        { type: 'divider' },
        { type: 'section', text: { type: 'mrkdwn', text: '*🕒 Q4 — 3:00am to 5:30am*' } },
        { type: 'input', block_id: 'q4_notes', optional: true,
          label: { type: 'plain_text', text: 'Q4 Notes' },
          element: { type: 'plain_text_input', action_id: 'q4_notes_input', multiline: true,
            placeholder: { type: 'plain_text', text: 'CC, stoppages, recirc, day shift handoff notes...' } } },
        { type: 'divider' },
        { type: 'section', text: { type: 'mrkdwn', text: '*📊 Shift Stats*' } },
        { type: 'input', block_id: 'sl2', optional: true,
          label: { type: 'plain_text', text: 'SL2 %' },
          element: { type: 'plain_text_input', action_id: 'sl2_input', placeholder: { type: 'plain_text', text: 'e.g. 80%' } } },
        { type: 'input', block_id: 'final_cc', optional: true,
          label: { type: 'plain_text', text: 'Final CC (at EOS)' },
          element: { type: 'plain_text_input', action_id: 'final_cc_input', placeholder: { type: 'plain_text', text: 'e.g. 961cc' } } },
        { type: 'input', block_id: 'total_xbelt_dt', optional: true,
          label: { type: 'plain_text', text: 'Total XBelt DT' },
          element: { type: 'plain_text_input', action_id: 'total_xbelt_dt_input', placeholder: { type: 'plain_text', text: 'e.g. 13min' } } },
        { type: 'input', block_id: 'total_xbelt_stoppages', optional: true,
          label: { type: 'plain_text', text: 'Total XBelt Stoppages' },
          element: { type: 'plain_text_input', action_id: 'total_xbelt_stoppages_input', placeholder: { type: 'plain_text', text: 'e.g. 3' } } },
        { type: 'input', block_id: 'total_presort_dt', optional: true,
          label: { type: 'plain_text', text: 'Total Presort DT' },
          element: { type: 'plain_text_input', action_id: 'total_presort_dt_input', placeholder: { type: 'plain_text', text: 'e.g. 1hr 37min (due to low cc)' } } },
        { type: 'input', block_id: 'pending_tickets', optional: true,
          label: { type: 'plain_text', text: 'Pending TTs (one per line)' },
          element: { type: 'plain_text_input', action_id: 'pending_tickets_input', multiline: true,
            placeholder: { type: 'plain_text', text: 'e.g.\nhttps://t.corp... | [TEB9-RME] IS42 blowout\nhttps://t.corp... | [TEB9-RME] DD336 broken reflector' } } },
        { type: 'input', block_id: 'safety',
          label: { type: 'plain_text', text: '🟢 Safety Incidents' },
          element: { type: 'plain_text_input', action_id: 'safety_input', placeholder: { type: 'plain_text', text: 'e.g. 0' } } },
      ],
    },
  });
});

app.view('shiftreport_modal', async ({ ack, body, view, client }) => {
  await ack();
  const v = view.state.values;
  const q1Notes        = v.q1_notes?.q1_notes_input?.value || '';
  const q2Notes        = v.q2_notes?.q2_notes_input?.value || '';
  const q3Notes        = v.q3_notes?.q3_notes_input?.value || '';
  const q4Notes        = v.q4_notes?.q4_notes_input?.value || '';
  const sl2            = v.sl2?.sl2_input?.value || 'N/A';
  const finalCC        = v.final_cc?.final_cc_input?.value || 'N/A';
  const totalXbeltDT   = v.total_xbelt_dt?.total_xbelt_dt_input?.value || 'N/A';
  const totalStoppages = v.total_xbelt_stoppages?.total_xbelt_stoppages_input?.value || 'N/A';
  const totalPresortDT = v.total_presort_dt?.total_presort_dt_input?.value || 'N/A';
  const pendingTickets = v.pending_tickets?.pending_tickets_input?.value || '';
  const safety         = v.safety.safety_input.value;

  await client.chat.postMessage({ channel: SHIFTREPORT_CHANNEL, text: '⏳ Generating *Shift Handoff*... hang tight!' });

  try {
    const allNotes = [
      q1Notes && `Q1 (7:00pm–9:30pm): ${q1Notes}`,
      q2Notes && `Q2 (9:45pm–12:00am): ${q2Notes}`,
      q3Notes && `Q3 (12:30am–2:45am): ${q3Notes}`,
      q4Notes && `Q4 (3:00am–5:30am): ${q4Notes}`,
    ].filter(Boolean).join('\n\n');

    const vocab = loadVocab();
    const vocabCtx = buildVocabContext(vocab);

    const handoffPrompt = `${BUILDING_CONTEXT}\n\n${vocabCtx}\n\n
=== TASK ===
Write a shift handoff narrative based ONLY on the notes below.

Shift notes:
${allNotes}

Total XBelt Stoppages: ${totalStoppages}
Total XBelt DT: ${totalXbeltDT}
Total Presort DT: ${totalPresortDT}

=== FORMAT ===
- Open with: "Good morning BHDs! ☀️" on its own line
- One paragraph per Q that had events. Start Q1 with "We started the shift..." then "In Q2,...", "In Q3,...", "In the last quarter,..."
- Mention total XBelt DT at end of last quarter paragraph if provided
- End with: "Have a great shift." on its own line
- Max 9 sentences total across all paragraphs
- No headers, no bullets, no markdown

=== RULES ===
- No Reads have NOTHING to do with XBelt stoppages — never connect them
- Do NOT assume XBelt cause or RME involvement unless stated
- Do NOT add details not in the notes
- NEVER say "elevated", "environment", "kickoff", "carry this momentum", "required intervention"`;

    const res = await anthropic.messages.create({
      model: MODEL, max_tokens: 500,
      messages: [{ role: 'user', content: handoffPrompt }],
    });
    const narrative = res.content[0].text.trim();

    const ticketLines = pendingTickets
      ? pendingTickets.split('\n').filter(Boolean).map(t => {
          const [link, ...title] = t.split('|').map(s => s.trim());
          return title.length ? `• Link: ${link}\n• Title: ${title.join(' | ')}` : `• ${t.trim()}`;
        }).join('\n')
      : '• None';

    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    const dateStr = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    const report = [
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
    extractAndUpdateVocab(allNotes);
  } catch (err) {
    console.error('[/shiftreport] Error:', err);
    await client.chat.postMessage({ channel: SHIFTREPORT_CHANNEL, text: `❌ Error: ${err.message}` });
  }
});

// ── /coffee ───────────────────────────────────────────────────
const COFFEE_QUOTES = [
  { text: "Let's take quick action.", tags: ['low-cc','action'] },
  { text: "Fast decisions. Execute now.", tags: ['low-cc','action'] },
  { text: "Pressure's on. Let's handle it.", tags: ['low-cc','action'] },
  { text: "Low CC? We know what to do, let's get that bread.", tags: ['low-cc','action'] },
  { text: "We've handled worse. Handle this.", tags: ['xbelt','resilience'] },
  { text: "Belt don't stop. Neither do we.", tags: ['xbelt','resilience'] },
  { text: "Equipment fails. We don't.", tags: ['xbelt','resilience'] },
  { text: "Keep pushing. We adapt.", tags: ['xbelt','resilience'] },
  { text: "Keep the momentum going.", tags: ['healthy-cc','momentum'] },
  { text: "CC's healthy. Let's lock it in.", tags: ['healthy-cc','momentum'] },
  { text: "Everything's clicking. Sustain it.", tags: ['healthy-cc','momentum'] },
  { text: "Carriers flowing. Keep it there.", tags: ['healthy-cc','momentum'] },
  { text: "Let's start making money TEB9.", tags: ['general'] },
  { text: "Are we up TEB9?", tags: ['general'] },
  { text: "More coffee. Less problems.", tags: ['general'] },
  { text: "We're basically running this.", tags: ['general'] },
  { text: "Team's locked in.", tags: ['general'] },
  { text: "Think bigger :think_big: But start now. (my favorite leadership principle)", tags: ['general'] },
  { text: "Deliver results :deliver_results: That's what counts. (my favorite leadership principle)", tags: ['general'] },
  { text: "Customer wins when we execute :customer_obsession: (my favorite leadership principle)", tags: ['general'] },
  { text: "Trust the team. Execute. :earn_trust: (my favorite leadership principle)", tags: ['general'] },
  { text: "Right decision or wrong? Commit :have_backbone_disagree_and_commit: (my favorite leadership principle)", tags: ['general'] },
  { text: "Curious minds :learn_and_be_curious: Better solutions. (my favorite leadership principle)", tags: ['general'] },
];

function getRelevantQuote(noteText) {
  if (!noteText) return COFFEE_QUOTES[Math.floor(Math.random() * COFFEE_QUOTES.length)].text;
  const n = noteText.toLowerCase();
  let pool = COFFEE_QUOTES;
  if (n.includes('xbelt') || n.includes('belt') || n.includes('down')) pool = COFFEE_QUOTES.filter(q => q.tags.includes('xbelt') || q.tags.includes('resilience'));
  else if (n.includes('low cc') || n.includes('cc dropping') || n.includes('low') || n.includes('slow')) pool = COFFEE_QUOTES.filter(q => q.tags.includes('low-cc') || q.tags.includes('action'));
  else if (n.includes('healthy') || n.includes('good') || n.includes('smooth')) pool = COFFEE_QUOTES.filter(q => q.tags.includes('healthy-cc') || q.tags.includes('momentum'));
  if (!pool.length) pool = COFFEE_QUOTES;
  return pool[Math.floor(Math.random() * pool.length)].text;
}

app.command('/coffee', async ({ ack, body, client }) => {
  await ack();
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal', callback_id: 'coffee_modal',
      title: { type: 'plain_text', text: '☕ Team Motivation' },
      submit: { type: 'plain_text', text: 'Post' },
      close:  { type: 'plain_text', text: 'Cancel' },
      blocks: [
        { type: 'input', block_id: 'coffee_note', optional: true,
          label: { type: 'plain_text', text: "📝 What's happening?" },
          element: { type: 'plain_text_input', action_id: 'coffee_note_input',
            placeholder: { type: 'plain_text', text: 'e.g. cc dropping, xbelt down, smooth ops' } } },
        { type: 'input', block_id: 'coffee_person', optional: true,
          label: { type: 'plain_text', text: '👤 Tag Person (optional)' },
          element: { type: 'users_select', action_id: 'coffee_person_input',
            placeholder: { type: 'plain_text', text: 'Select a person' } } },
        { type: 'input', block_id: 'target_channel',
          label: { type: 'plain_text', text: '📢 Post To' },
          element: { type: 'conversations_select', action_id: 'target_channel_input',
            placeholder: { type: 'plain_text', text: 'Select channel' },
            filter: { include: ['public','private'], exclude_bot_users: true } } },
      ],
    },
  });
});

app.view('coffee_modal', async ({ ack, body, view, client }) => {
  await ack();
  let coffeeNote    = view.state.values.coffee_note.coffee_note_input.value || '';
  const taggedUser  = view.state.values.coffee_person.coffee_person_input.selected_user || null;
  const targetCh    = view.state.values.target_channel.target_channel_input.selected_conversation;

  if (coffeeNote) coffeeNote = await fixGrammar(coffeeNote);
  const quote = getRelevantQuote(coffeeNote);

  let msg = `☕ *TEB9 IXD*\n`;
  if (taggedUser) msg += `<@${taggedUser}> `;
  if (coffeeNote) msg += `${coffeeNote}`;
  msg += ` — _"${quote}"_ 💪`;

  await client.chat.postMessage({ channel: targetCh, text: msg, mrkdwn: true });
});

// ── /sos ──────────────────────────────────────────────────────
app.command('/sos', async ({ ack, body, client }) => {
  await ack();
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal', callback_id: 'sos_modal',
      private_metadata: body.channel_id,
      title: { type: 'plain_text', text: '🌅 Start of Shift' },
      submit: { type: 'plain_text', text: 'Post SOS' },
      close:  { type: 'plain_text', text: 'Cancel' },
      blocks: [
        { type: 'input', block_id: 'shift_time',
          label: { type: 'plain_text', text: 'Shift Start Time' },
          element: { type: 'plain_text_input', action_id: 'value',
            placeholder: { type: 'plain_text', text: 'e.g. 6PM, 18:00, Night shift' } } },
        { type: 'input', block_id: 'initial_cc',
          label: { type: 'plain_text', text: 'Initial CC (carriers)' },
          element: { type: 'plain_text_input', action_id: 'value',
            placeholder: { type: 'plain_text', text: 'e.g. 420, low ~200' } } },
        { type: 'input', block_id: 'staffing', optional: true,
          label: { type: 'plain_text', text: 'Staffing Notes' },
          element: { type: 'plain_text_input', action_id: 'value',
            placeholder: { type: 'plain_text', text: 'e.g. Full staff, 2 TAs short' } } },
        { type: 'input', block_id: 'known_issues', optional: true,
          label: { type: 'plain_text', text: 'Known Issues / Carryover' },
          element: { type: 'plain_text_input', action_id: 'value', multiline: true,
            placeholder: { type: 'plain_text', text: 'e.g. Bank 3 offline, IS42 ticket open' } } },
        { type: 'input', block_id: 'focus', optional: true,
          label: { type: 'plain_text', text: "Shift Focus" },
          element: { type: 'plain_text_input', action_id: 'value',
            placeholder: { type: 'plain_text', text: 'e.g. Push IB volume, clear recirc backlog' } } },
      ],
    },
  });
});

app.view('sos_modal', async ({ ack, view, body, client }) => {
  await ack();
  const v = view.state.values;
  const channelId  = view.private_metadata;
  const userId     = body.user.id;
  const shiftTime  = v.shift_time.value.value;
  const initialCC  = v.initial_cc.value.value;
  const staffing   = v.staffing?.value?.value || '';
  const issues     = v.known_issues?.value?.value || '';
  const focus      = v.focus?.value?.value || '';

  const rawNotes = [`Shift start: ${shiftTime}`, `Initial CC: ${initialCC}`,
    staffing && `Staffing: ${staffing}`, issues && `Known issues: ${issues}`, focus && `Focus: ${focus}`
  ].filter(Boolean).join('\n');

  try {
    const res = await anthropic.messages.create({
      model: MODEL, max_tokens: 300,
      system: BUILDING_CONTEXT + '\nWrite a Start of Shift (SOS) report. Energetic, focused, 4–6 lines, no headers, first person plural. Return only the report.',
      messages: [{ role: 'user', content: rawNotes }],
    });
    await client.chat.postMessage({
      channel: channelId,
      text: `🌅 *Start of Shift — ${shiftTime}*\n\n${res.content[0].text.trim()}\n\n_Posted by <@${userId}>_`,
    });
  } catch {
    await client.chat.postMessage({
      channel: channelId,
      text: `🌅 *Start of Shift — ${shiftTime}*\nCC: ${initialCC}${staffing ? ` | ${staffing}` : ''}${issues ? `\n⚠️ ${issues}` : ''}\n\n_Posted by <@${userId}>_`,
    });
  }
});

// ── /dbot — status updates to CF Lead ────────────────────────
const STATUS_MAP = {
  gtg:              { emoji: '✅', label: 'GTG' },
  g2g:              { emoji: '✅', label: 'G2G' },
  'back-up':        { emoji: '🟢', label: 'Back Up' },
  'back-in-service':{ emoji: '🔄', label: 'Back in Service' },
  down:             { emoji: '🔴', label: 'DOWN' },
  standby:          { emoji: '🟡', label: 'Standby' },
};

app.command('/dbot', async ({ command, ack, client, respond }) => {
  await ack();
  const args = command.text.trim().split(/\s+/);
  const statusKey = args[0]?.toLowerCase().replace(/\s/g, '-');
  const note = args.slice(1).join(' ');

  if (!statusKey) {
    await respond({ response_type: 'ephemeral', text: [
      '*🤖 DBot 1.5 — TEB9 IXD*',
      '`/dbot gtg|down|back-up|back-in-service|standby [note]` — Post status to CF Lead',
      '`/qreport` — Q-block report | `/qtest` — test mode',
      '`/sos` — Start of shift | `/shiftreport` — Shift handoff',
      '`/coffee` — Motivation drop',
    ].join('\n') });
    return;
  }

  const cfg = STATUS_MAP[statusKey];
  if (!cfg) {
    await respond({ response_type: 'ephemeral', text: `❓ Unknown status. Try: \`gtg\`, \`down\`, \`back-up\`, \`back-in-service\`, \`standby\`` });
    return;
  }

  const msg = `${cfg.emoji} *${cfg.label}*${note ? `\n_${note}_` : ''}\n— <@${command.user_id}>`;
  try {
    await client.chat.postMessage({ channel: CF_LEAD_CHANNEL, text: msg, mrkdwn: true });
    await respond({ response_type: 'ephemeral', text: `✅ Posted *${cfg.label}* to #teb9-cf-lead` });
  } catch {
    await respond({ response_type: 'in_channel', text: msg });
  }
});



// ── Startup ───────────────────────────────────────────────────
(async () => {
  await app.start();
  console.log(`
╔════════════════════════════════════════╗
║   🤖 DBot 1.5 — TEB9 IXD Shift Bot    ║
║   Status: ONLINE ✅  (Socket Mode)     ║
╚════════════════════════════════════════╝

Commands: /qreport | /qtest | /shiftreport | /sos | /coffee | /dbot
Auto-forwarding: teb9-4corners-mhe-tt → CF Lead
`);
})();
