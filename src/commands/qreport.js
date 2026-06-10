// src/commands/qreport.js
// /qreport — Q-block report with modal input and Claude AI summary
// Matches real DBot output format from TEB9 IXD

const { callClaude } = require('../utils/claude');

const QREPORT_EXTRA_SYSTEM = `
You write Q-block operational summaries for Amazon IXD shift operations.
A Q-block is a ~3-hour operational block (Q1, Q2, Q3, Q4).

Write ONLY the "Q[N] Operational Summary:" section — 2 short paragraphs max.
- First paragraph: what happened this Q (XBelt events, Presort DT, recirc, any dept issues). First person plural. Specific, factual, no fluff.
- Second paragraph: outlook for next block. What to watch, what's in good shape.

Rules:
- Do NOT make up any numbers or events not given
- Do NOT assume XBelt cause, RME involvement, or recirc source unless stated
- Never say "environment", "kickoff", "carry this momentum", "required intervention", "managing the flow", "elevated"
- Say "carriers" not "carrier counts" — say "recirc" not "recirculation" — say "high/heavy" not "elevated"
- First person plural throughout: "we faced", "we had", "we pushed"
- Casual, floor-level tone — not corporate
- Return ONLY the two paragraphs. No label, no header, no preamble.
`.trim();

module.exports = function registerQReport(app) {
  app.command('/qreport', async ({ command, ack, client }) => {
    await ack();

    await client.views.open({
      trigger_id: command.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'qreport_submit',
        private_metadata: command.channel_id,
        title: { type: 'plain_text', text: '📊 Q-Block Report' },
        submit: { type: 'plain_text', text: 'Post Report' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'input',
            block_id: 'q_number',
            label: { type: 'plain_text', text: 'Q Block #' },
            element: {
              type: 'static_select',
              action_id: 'value',
              placeholder: { type: 'plain_text', text: 'Select Q block' },
              options: ['Q1', 'Q2', 'Q3', 'Q4'].map((q) => ({
                text: { type: 'plain_text', text: q },
                value: q,
              })),
            },
          },
          {
            type: 'input',
            block_id: 'block_time',
            label: { type: 'plain_text', text: 'Block Time Range' },
            element: {
              type: 'plain_text_input',
              action_id: 'value',
              placeholder: { type: 'plain_text', text: 'e.g. 9:45pm – 12:00am' },
            },
          },
          {
            type: 'input',
            block_id: 'up_next',
            label: { type: 'plain_text', text: 'Up Next' },
            element: {
              type: 'plain_text_input',
              action_id: 'value',
              placeholder: { type: 'plain_text', text: 'e.g. Lunch 12:00–12:30am' },
            },
          },
          {
            type: 'input',
            block_id: 'xbelt_stoppages',
            label: { type: 'plain_text', text: 'XBelt Stoppages (this Q)' },
            element: {
              type: 'plain_text_input',
              action_id: 'value',
              placeholder: { type: 'plain_text', text: 'e.g. 2' },
            },
          },
          {
            type: 'input',
            block_id: 'xbelt_dt_shift',
            label: { type: 'plain_text', text: 'XBelt DT (shift total so far)' },
            element: {
              type: 'plain_text_input',
              action_id: 'value',
              placeholder: { type: 'plain_text', text: 'e.g. 10min' },
            },
          },
          {
            type: 'input',
            block_id: 'presort_dt',
            label: { type: 'plain_text', text: 'Presort DT (this Q)' },
            element: {
              type: 'plain_text_input',
              action_id: 'value',
              placeholder: { type: 'plain_text', text: 'e.g. 48min' },
            },
          },
          {
            type: 'input',
            block_id: 'ib_volume',
            label: { type: 'plain_text', text: 'IB Volume vs Goal' },
            optional: true,
            element: {
              type: 'plain_text_input',
              action_id: 'value',
              placeholder: { type: 'plain_text', text: 'e.g. 33,862 / 40,000 (85%) — Shift Goal: 80,000' },
            },
          },
          {
            type: 'input',
            block_id: 'ob_volume',
            label: { type: 'plain_text', text: 'OB Volume vs Goal' },
            optional: true,
            element: {
              type: 'plain_text_input',
              action_id: 'value',
              placeholder: { type: 'plain_text', text: 'e.g. 44,541 / 50,000 (89%) — Shift Goal: 100,000' },
            },
          },
          {
            type: 'input',
            block_id: 'pending_tickets',
            label: { type: 'plain_text', text: 'Pending Tickets (one per line: "TT-link | Title")' },
            optional: true,
            element: {
              type: 'plain_text_input',
              action_id: 'value',
              multiline: true,
              placeholder: { type: 'plain_text', text: 'https://t.corp... | [TEB9-RME] IS42 blowout\nhttps://t.corp... | [TEB9-RME] DD334 upper misaligned PE' },
            },
          },
          {
            type: 'input',
            block_id: 'ops_notes',
            label: { type: 'plain_text', text: 'Operational Notes (for AI summary)' },
            element: {
              type: 'plain_text_input',
              action_id: 'value',
              multiline: true,
              placeholder: { type: 'plain_text', text: 'e.g. XBelt stopped DD332 lower 7min, OB recirc reduced first 30min, PID4 went down at 11:15 impacting IB' },
            },
          },
        ],
      },
    });
  });

  app.view('qreport_submit', async ({ ack, view, body, client }) => {
    await ack();

    const v = view.state.values;
    const channelId = view.private_metadata;
    const userId = body.user.id;

    const qNum = v.q_number.value.selected_option.value;
    const blockTime = v.block_time.value.value;
    const upNext = v.up_next.value.value;
    const xbeltStoppages = v.xbelt_stoppages.value.value;
    const xbeltDtShift = v.xbelt_dt_shift.value.value;
    const presortDt = v.presort_dt.value.value;
    const ibVolume = v.ib_volume?.value?.value || null;
    const obVolume = v.ob_volume?.value?.value || null;
    const pendingTicketsRaw = v.pending_tickets?.value?.value || null;
    const opsNotes = v.ops_notes.value.value;

    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    const dateStr = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    // Generate AI summary
    let summary = '';
    try {
      summary = await callClaude(
        `Write the Q-block operational summary for ${qNum}.\n\nNotes from the floor:\n${opsNotes}\n\nContext: XBelt stoppages this Q: ${xbeltStoppages}, XBelt DT shift total: ${xbeltDtShift}, Presort DT this Q: ${presortDt}`,
        QREPORT_EXTRA_SYSTEM
      );
    } catch (err) {
      console.error('[/qreport] Claude error:', err);
      summary = opsNotes; // fallback to raw notes
    }

    // Format pending tickets
    let ticketSection = '';
    if (pendingTicketsRaw) {
      const lines = pendingTicketsRaw
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [link, ...titleParts] = line.split('|').map((s) => s.trim());
          const title = titleParts.join(' | ');
          return title ? `• Link: ${link}\n• Title: ${title}` : `• ${link}`;
        });
      ticketSection = `\n\n🔵 *Pending Tickets:*\n${lines.join('\n')}`;
    }

    // Format volume section
    let volumeSection = '';
    if (ibVolume || obVolume) {
      volumeSection = '\n\n📊 *Volume vs Goal:*';
      if (ibVolume) volumeSection += `\n🔴 IB  ${ibVolume}`;
      if (obVolume) volumeSection += `\n🔵 OB  ${obVolume}`;
    }

    const message = [
      `📊 *${qNum} Block Report — ${dateStr}*`,
      `Building: IXD  |  Block Time: ${blockTime}  |  Up Next: ${upNext}`,
      ``,
      `❌ *XBelt Stoppages (this Q):* ${xbeltStoppages}`,
      `🕐 *XBelt DT (shift total):* ${xbeltDtShift}`,
      `🕐 *Presort DT (this Q):* ${presortDt}`,
      ticketSection,
      volumeSection,
      ``,
      `⬛ *${qNum} Operational Summary:*`,
      summary,
      ``,
      `_IXD Shift Bot • Generated ${timeStr}_`,
    ]
      .filter((l) => l !== null && l !== undefined)
      .join('\n');

    await client.chat.postMessage({
      channel: channelId,
      text: message,
    });
  });
};
