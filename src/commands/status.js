// src/commands/status.js
// /dbot — Quick status updates posted to CF Lead channel
// Also handles GTG, G2G, Back Up, Back in Service shortcuts

const CF_LEAD_CHANNEL = 'teb9-cf-lead';   // update if channel ID is known
const DOCK_DYNASTY_CHANNEL = 'teb9-dock-dynasty';

const STATUS_CONFIGS = {
  gtg: {
    emoji: '✅',
    label: 'GTG',
    color: '#2eb886',
    description: 'Good to go — all systems operational',
  },
  g2g: {
    emoji: '✅',
    label: 'G2G',
    color: '#2eb886',
    description: 'Good to go',
  },
  'back-up': {
    emoji: '🟢',
    label: 'Back Up',
    color: '#2eb886',
    description: 'System back up and operational',
  },
  'back-in-service': {
    emoji: '🔄',
    label: 'Back in Service',
    color: '#36a64f',
    description: 'Asset back in service',
  },
  down: {
    emoji: '🔴',
    label: 'DOWN',
    color: '#cc0000',
    description: 'Asset/system offline',
  },
  standby: {
    emoji: '🟡',
    label: 'Standby',
    color: '#daa520',
    description: 'Holding — not yet running',
  },
};

module.exports = function registerStatus(app) {
  app.command('/dbot', async ({ command, ack, client, respond }) => {
    await ack();

    const args = command.text.trim().split(/\s+/);
    const statusKey = args[0]?.toLowerCase().replace(/\s/g, '-');
    const note = args.slice(1).join(' ');

    // /dbot (no args) — show help + current shift info
    if (!statusKey) {
      await respond({
        response_type: 'ephemeral',
        text: [
          '*🤖 DBot 1.5 — TEB9 IXD Shift Bot*',
          '',
          '*Status commands:*',
          '`/dbot gtg [note]` — Post GTG to CF Lead',
          '`/dbot down [note]` — Post DOWN status',
          '`/dbot back-up [note]` — Post Back Up',
          '`/dbot back-in-service [note]` — Post Back in Service',
          '`/dbot standby [note]` — Post Standby',
          '',
          '*Other commands:*',
          '`/qreport [notes]` — Q-block report with AI summary',
          '`/sos` — Start of shift report',
          '`/shiftreport` — Full shift handoff report',
          '`/ticket` — Ticket management',
          '`/coffee [note] [@person]` — Motivation drop',
        ].join('\n'),
      });
      return;
    }

    const config = STATUS_CONFIGS[statusKey];
    if (!config) {
      await respond({
        response_type: 'ephemeral',
        text: `❓ Unknown status \`${statusKey}\`. Try: \`gtg\`, \`down\`, \`back-up\`, \`back-in-service\`, \`standby\``,
      });
      return;
    }

    const messageText = [
      `${config.emoji} *${config.label}*`,
      note ? `_${note}_` : config.description,
      `— <@${command.user_id}> | <!date^${Math.floor(Date.now() / 1000)}^{time}|now>`,
    ].join('\n');

    // Post to CF Lead channel
    try {
      await client.chat.postMessage({
        channel: CF_LEAD_CHANNEL,
        text: messageText,
      });
    } catch (err) {
      // If channel not found, fall back to current channel
      await respond({
        response_type: 'in_channel',
        text: messageText,
      });
      console.warn('[/dbot] Could not post to CF Lead channel:', err.message);
      return;
    }

    // Ephemeral confirmation
    await respond({
      response_type: 'ephemeral',
      text: `✅ Posted *${config.label}* to #${CF_LEAD_CHANNEL}`,
    });
  });
};
