// src/commands/sos.js
// /sos — Start of Shift report (modal form → AI-generated post)

const { callClaude } = require('../utils/claude');

const SOS_EXTRA_SYSTEM = `
You write Start of Shift (SOS) reports for Amazon IXD operations.
This is the first update the team sees at the top of the shift.
Tone: energetic, focused, sets the tone for the shift.
Format: 4–6 lines, no headers, no bullet lists. First person plural.
Cover: shift start time, initial CC, staffing highlights, any known issues coming in, and the team's focus for the shift.
Do NOT make up details not given. Do NOT use banned phrases.
`.trim();

module.exports = function registerSOS(app) {
  // Open modal on /sos command
  app.command('/sos', async ({ command, ack, client }) => {
    await ack();

    await client.views.open({
      trigger_id: command.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'sos_submit',
        private_metadata: command.channel_id,
        title: { type: 'plain_text', text: '🌅 Start of Shift' },
        submit: { type: 'plain_text', text: 'Post SOS' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'input',
            block_id: 'shift_time',
            label: { type: 'plain_text', text: 'Shift Start Time' },
            element: {
              type: 'plain_text_input',
              action_id: 'value',
              placeholder: { type: 'plain_text', text: 'e.g. 18:00, 6PM, Night shift' },
            },
          },
          {
            type: 'input',
            block_id: 'initial_cc',
            label: { type: 'plain_text', text: 'Initial CC (carriers)' },
            element: {
              type: 'plain_text_input',
              action_id: 'value',
              placeholder: { type: 'plain_text', text: 'e.g. 420, low ~200' },
            },
          },
          {
            type: 'input',
            block_id: 'staffing',
            label: { type: 'plain_text', text: 'Staffing Notes' },
            optional: true,
            element: {
              type: 'plain_text_input',
              action_id: 'value',
              placeholder: { type: 'plain_text', text: 'e.g. Full staff, 2 TAs short, MHE crew solid' },
            },
          },
          {
            type: 'input',
            block_id: 'known_issues',
            label: { type: 'plain_text', text: 'Known Issues / Carryover from Last Shift' },
            optional: true,
            element: {
              type: 'plain_text_input',
              action_id: 'value',
              multiline: true,
              placeholder: { type: 'plain_text', text: 'e.g. Bank 3 offline, Jackpot NS backed up' },
            },
          },
          {
            type: 'input',
            block_id: 'focus',
            label: { type: 'plain_text', text: "Shift Focus / Today's Priority" },
            optional: true,
            element: {
              type: 'plain_text_input',
              action_id: 'value',
              placeholder: { type: 'plain_text', text: 'e.g. Push IB volume, clear recirc backlog' },
            },
          },
        ],
      },
    });
  });

  // Handle modal submission
  app.view('sos_submit', async ({ ack, view, body, client }) => {
    await ack();

    const v = view.state.values;
    const channelId = view.private_metadata;
    const userId = body.user.id;

    const shiftTime = v.shift_time.value.value;
    const initialCC = v.initial_cc.value.value;
    const staffing = v.staffing?.value?.value || '';
    const knownIssues = v.known_issues?.value?.value || '';
    const focus = v.focus?.value?.value || '';

    const rawNotes = [
      `Shift start: ${shiftTime}`,
      `Initial CC: ${initialCC}`,
      staffing && `Staffing: ${staffing}`,
      knownIssues && `Known issues: ${knownIssues}`,
      focus && `Shift focus: ${focus}`,
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const report = await callClaude(
        `Write a Start of Shift report using these notes:\n\n${rawNotes}\n\nReturn only the report.`,
        SOS_EXTRA_SYSTEM
      );

      await client.chat.postMessage({
        channel: channelId,
        text: `🌅 *Start of Shift — ${shiftTime}*\n\n${report}\n\n_Posted by <@${userId}>_`,
      });
    } catch (err) {
      console.error('[/sos] Error:', err);
      await client.chat.postMessage({
        channel: channelId,
        text: `🌅 *Start of Shift — ${shiftTime}*\nCC: ${initialCC}${staffing ? ` | ${staffing}` : ''}${knownIssues ? `\n⚠️ ${knownIssues}` : ''}\n\n_Posted by <@${userId}>_`,
      });
    }
  });
};
