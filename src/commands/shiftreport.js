// src/commands/shiftreport.js
// /shiftreport — Full shift handoff report matching TEB9 IXD format

const { callClaude } = require('../utils/claude');
const { getOpenTickets } = require('../utils/ticketStore');

const SHIFTREPORT_EXTRA_SYSTEM = `
You write end-of-shift handoff reports for Amazon IXD operations.
The incoming shift reads this — make it clear, factual, and useful.

FORMAT (follow this exactly):
- Always open with: "Good morning BHDs! ☀️" on its own line
- Then write one paragraph per Q-block that had notable events (Q1, Q2, Q3, Q4). Start each with "In Q[N]," — no bold headers, just flowing paragraphs.
- Each paragraph covers: XBelt events (with exact DD/location/duration if given), Presort DT, recirc activity, any dept issues. Only include what was provided.
- End the narrative with: "Have a great shift." on its own line.

RULES:
- Never bold the Q labels — they're part of flowing prose, not headers
- Do NOT make up any numbers, causes, or events
- Do NOT assume XBelt cause, RME involvement, or recirc source unless stated
- Never say "environment", "kickoff", "carry this momentum", "required intervention", "managing the flow", "elevated"
- Say "carriers" not "carrier counts" — "recirc" not "recirculation" — "high/heavy" not "elevated"
- First person plural throughout: "we started", "we faced", "we had"
- Return ONLY the narrative (from "Good morning BHDs!" through "Have a great shift."). No preamble, no labels.
`.trim();

module.exports = function registerShiftReport(app) {
  app.command('/shiftreport', async ({ command, ack, client }) => {
    await ack();

    await client.views.open({
      trigger_id: command.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'shiftreport_submit',
        private_metadata: command.channel_id,
        title: { type: 'plain_text', text: '📋 Shift Handoff Report' },
        submit: { type: 'plain_text', text: 'Post Report' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'input',
            block_id: 'shift_date',
            label: { type: 'plain_text', text: 'Shift Date' },
            element: {
              type: 'plain_text_input',
              action_id: 'value',
              placeholder: { type: 'plain_text', text: 'e.g. June 3, 2026' },
            },
          },
          {
            type: 'input',
            block_id: 'q1_notes',
            label: { type: 'plain_text', text: 'Q1 Notes' },
            optional: true,
            element: {
              type: 'plain_text_input',
              action_id: 'value',
              multiline: true,
              placeholder: { type: 'plain_text', text: 'e.g. XBelt stopped DD128 upper via Viper 3min, OB recirc heavy driven by XJF1_case from DD124 both chutes down, low cc, 35min Presort DT' },
            },
          },
          {
            type: 'input',
            block_id: 'q2_notes',
            label: { type: 'plain_text', text: 'Q2 Notes' },
            optional: true,
            element: {
              type: 'plain_text_input',
              action_id: 'value',
              multiline: true,
              placeholder: { type: 'plain_text', text: 'e.g. XBelt stopped DD332 lower 7min, OB recirc eased first 30min, PID4 down 11:15pm impacted IB, Presort DT 48min' },
            },
          },
          {
            type: 'input',
            block_id: 'q3_notes',
            label: { type: 'plain_text', text: 'Q3 Notes' },
            optional: true,
            element: {
              type: 'plain_text_input',
              action_id: 'value',
              multiline: true,
              placeholder: { type: 'plain_text', text: 'e.g. No XBelt stoppages, OB recirc continued' },
            },
          },
          {
            type: 'input',
            block_id: 'q4_notes',
            label: { type: 'plain_text', text: 'Q4 Notes' },
            optional: true,
            element: {
              type: 'plain_text_input',
              action_id: 'value',
              multiline: true,
              placeholder: { type: 'plain_text', text: 'e.g. XBelt stopped Bank 4 upper 3min, IS42 down since 11pm ticket open' },
            },
          },
          {
            type: 'input',
            block_id: 'watch_items',
            label: { type: 'plain_text', text: 'Watch Items for Next Shift' },
            optional: true,
            element: {
              type: 'plain_text_input',
              action_id: 'value',
              multiline: true,
              placeholder: { type: 'plain_text', text: 'e.g. Keep eye on HNE1_case, JFK8_case, No Reads/Unknowns' },
            },
          },
          {
            type: 'input',
            block_id: 'pending_tickets',
            label: { type: 'plain_text', text: 'Pending TTs (one per line: "link | Title")' },
            optional: true,
            element: {
              type: 'plain_text_input',
              action_id: 'value',
              multiline: true,
              placeholder: { type: 'plain_text', text: 'https://t.corp... | [TEB9-RME] IS42 blowout\nhttps://t.corp... | [TEB9-RME] DD336 upper broken reflector' },
            },
          },
          {
            type: 'input',
            block_id: 'sl2_pct',
            label: { type: 'plain_text', text: 'SL2 %' },
            optional: true,
            element: {
              type: 'plain_text_input',
              action_id: 'value',
              placeholder: { type: 'plain_text', text: 'e.g. 80%' },
            },
          },
          {
            type: 'input',
            block_id: 'cc_final',
            label: { type: 'plain_text', text: 'Final CC (carriers)' },
            optional: true,
            element: {
              type: 'plain_text_input',
              action_id: 'value',
              placeholder: { type: 'plain_text', text: 'e.g. 961' },
            },
          },
          {
            type: 'input',
            block_id: 'xbelt_dt_total',
            label: { type: 'plain_text', text: 'XBelt DT Total' },
            optional: true,
            element: {
              type: 'plain_text_input',
              action_id: 'value',
              placeholder: { type: 'plain_text', text: 'e.g. 13min' },
            },
          },
          {
            type: 'input',
            block_id: 'xbelt_stoppages_total',
            label: { type: 'plain_text', text: 'XBelt Stoppages Total' },
            optional: true,
            element: {
              type: 'plain_text_input',
              action_id: 'value',
              placeholder: { type: 'plain_text', text: 'e.g. 3' },
            },
          },
          {
            type: 'input',
            block_id: 'presort_dt_total',
            label: { type: 'plain_text', text: 'Presort DT Total' },
            optional: true,
            element: {
              type: 'plain_text_input',
              action_id: 'value',
              placeholder: { type: 'plain_text', text: 'e.g. 1hr 37min (due to low cc)' },
            },
          },
          {
            type: 'input',
            block_id: 'safety',
            label: { type: 'plain_text', text: 'Safety' },
            optional: true,
            element: {
              type: 'plain_text_input',
              action_id: 'value',
              placeholder: { type: 'plain_text', text: 'e.g. 0 incidents' },
            },
          },
        ],
      },
    });
  });

  app.view('shiftreport_submit', async ({ ack, view, body, client }) => {
    await ack();

    const v = view.state.values;
    const channelId = view.private_metadata;
    const userId = body.user.id;

    const shiftDate = v.shift_date.value.value;
    const q1 = v.q1_notes?.value?.value || '';
    const q2 = v.q2_notes?.value?.value || '';
    const q3 = v.q3_notes?.value?.value || '';
    const q4 = v.q4_notes?.value?.value || '';
    const watchItems = v.watch_items?.value?.value || '';
    const pendingTicketsRaw = v.pending_tickets?.value?.value || '';
    const sl2 = v.sl2_pct?.value?.value || '';
    const cc = v.cc_final?.value?.value || '';
    const xbeltDt = v.xbelt_dt_total?.value?.value || '';
    const xbeltStoppages = v.xbelt_stoppages_total?.value?.value || '';
    const presortDt = v.presort_dt_total?.value?.value || '';
    const safety = v.safety?.value?.value || '';

    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

    // Build Q notes for Claude
    const qNotes = [
      q1 && `Q1: ${q1}`,
      q2 && `Q2: ${q2}`,
      q3 && `Q3: ${q3}`,
      q4 && `Q4: ${q4}`,
      watchItems && `Watch items for next shift: ${watchItems}`,
    ].filter(Boolean).join('\n\n');

    // Generate narrative
    let narrative = '';
    try {
      narrative = await callClaude(
        `Write the shift handoff narrative using these Q-block notes:\n\n${qNotes}\n\nReturn only the narrative, starting with "Good morning BHDs! ☀️"`,
        SHIFTREPORT_EXTRA_SYSTEM
      );
    } catch (err) {
      console.error('[/shiftreport] Claude error:', err);
      narrative = `Good morning BHDs! ☀️\n\n${qNotes}\n\nHave a great shift.`;
    }

    // Format pending tickets
    let ticketSection = '';
    if (pendingTicketsRaw) {
      const lines = pendingTicketsRaw
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => {
          const [link, ...titleParts] = line.split('|').map((s) => s.trim());
          const title = titleParts.join(' | ');
          return title ? `• Link: ${link}\n• Title: ${title}` : `• ${link}`;
        });
      ticketSection = `\n\n*Pending TTs:*\n${lines.join('\n')}`;
    }

    // Append any DBot-tracked open tickets
    const dbotTickets = getOpenTickets();
    if (dbotTickets.length) {
      const dbotLines = dbotTickets.map((t) => `• ${t.id}: ${t.title} — ${t.status}`).join('\n');
      ticketSection += `\n${dbotLines}`;
    }

    // Stats footer
    const statsLines = [
      sl2 && `*SL2:* ${sl2}`,
      cc && `*CC:* ${cc}cc`,
      xbeltDt && `*XBelt DT:* ${xbeltDt} 🕐`,
      xbeltStoppages && `*XBelt Stoppages:* ${xbeltStoppages}`,
      presortDt && `*Presort DT:* ${presortDt}`,
      safety && `🟢 *Safety:* ${safety}`,
    ].filter(Boolean);

    const statsSection = statsLines.length ? `\n\n${statsLines.join('\n')}` : '';

    const message = [
      narrative,
      ticketSection,
      statsSection,
      `\n\n📸 _Reply to this message to attach screenshots_`,
      `\n_IXD Shift Bot • Generated ${timeStr} — ${shiftDate}_`,
    ].filter(Boolean).join('');

    await client.chat.postMessage({
      channel: channelId,
      text: message,
    });
  });
};
