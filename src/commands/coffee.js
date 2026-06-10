// src/commands/coffee.js
// /coffee — Context-aware motivation for TEB9 IXD night shift

const { fixGrammar } = require('../utils/claude');

// Quote bank organized by situation
const QUOTES = {
  low_cc: [
    { text: "Low CC? We know what to do. Let's get that bread.", emoji: '🍞' },
    { text: "Slow start. That changes now. Let's push.", emoji: '💪' },
    { text: "Low CC is just an opportunity to ramp hard. Go.", emoji: '🚀' },
    { text: "Fast decisions. Execute now.", emoji: '⚡' },
    { text: "Let's take quick action — CC ain't gonna fix itself.", emoji: '🎯' },
  ],
  high_cc: [
    { text: "CC's heavy. Stay locked in, work smart, keep the pace.", emoji: '🔒' },
    { text: "High CC — everyone doing their job, no second-guessing.", emoji: '🧠' },
    { text: "We've been here before. Stay calm, keep pushing.", emoji: '🧊' },
    { text: "Heavy volume. This is what we trained for.", emoji: '🏋️' },
    { text: "High CC doesn't panic us. We work.", emoji: '💼' },
  ],
  xbelt_down: [
    { text: "Belt don't stop. Neither do we.", emoji: '🔧' },
    { text: "Equipment fails. We don't.", emoji: '🛡️' },
    { text: "We've handled worse. Handle this.", emoji: '💪' },
    { text: "XBelt's down — doesn't mean WE'RE down. Let's go.", emoji: '⚙️' },
    { text: "Use the downtime smart. Stay ready to ramp.", emoji: '🕐' },
  ],
  healthy_cc: [
    { text: "CC's healthy. Let's lock it in.", emoji: '✅' },
    { text: "Keep the momentum going.", emoji: '📈' },
    { text: "Everything's clicking. Sustain it.", emoji: '🎯' },
    { text: "Good flow right now. Don't let up.", emoji: '💧' },
    { text: "Smooth ops. Keep it that way.", emoji: '🟢' },
  ],
  general: [
    { text: "Another shift. Another chance to outperform.", emoji: '⭐' },
    { text: "The night shift keeps the lights on.", emoji: '🌙' },
    { text: "We don't clock out til it's done right.", emoji: '✔️' },
    { text: "Grind now. Feel it later.", emoji: '💯' },
  ],
};

// Leadership principles with custom Slack emojis
const LP_QUOTES = [
  { text: "Think bigger. But start now.", principle: 'Think Big', emoji: ':think_big:' },
  { text: "Who are we doing this for? The customer. Always.", principle: 'Customer Obsession', emoji: ':customer_obsession:' },
  { text: "Deliver the result. Not the excuse.", principle: 'Deliver Results', emoji: ':deliver_results:' },
  { text: "Be curious. Figure it out.", principle: 'Learn and Be Curious', emoji: ':learn_and_be_curious:' },
  { text: "Say what needs to be said. Then commit.", principle: 'Have Backbone', emoji: ':have_backbone_disagree_and_commit:' },
  { text: "Earn the trust shift by shift.", principle: 'Earn Trust', emoji: ':earn_trust:' },
];

function detectSituation(note) {
  if (!note) return 'general';
  const n = note.toLowerCase();
  if (n.includes('xbelt') || n.includes('belt down') || n.includes('cb down') || n.includes('stoppage')) return 'xbelt_down';
  if (n.includes('low cc') || n.includes('cc dropping') || n.includes('slow') || n.includes('dead')) return 'low_cc';
  if (n.includes('high cc') || n.includes('heavy') || n.includes('backed up') || n.includes('slammed')) return 'high_cc';
  if (n.includes('healthy') || n.includes('good cc') || n.includes('smooth') || n.includes('rolling')) return 'healthy_cc';
  return 'general';
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function buildCoffeeMessage(situation, note, fixedNote, tag) {
  // 30% chance to use an LP quote
  const useLP = Math.random() < 0.3;

  let quoteBlock;
  if (useLP) {
    const lp = pickRandom(LP_QUOTES);
    quoteBlock = `${lp.emoji} *${lp.text}* _(my fav leadership principle: ${lp.principle})_`;
  } else {
    const q = pickRandom(QUOTES[situation] || QUOTES.general);
    quoteBlock = `${q.emoji} *${q.text}*`;
  }

  const parts = ['☕ *DBot Coffee Drop*', ''];

  if (fixedNote) {
    parts.push(`> ${fixedNote}`);
    parts.push('');
  }

  parts.push(quoteBlock);

  if (tag) {
    parts.push('');
    parts.push(`Sending it to ${tag} 👊`);
  }

  return parts.join('\n');
}

module.exports = function registerCoffee(app) {
  app.command('/coffee', async ({ command, ack, respond, client }) => {
    await ack();

    // Parse args: /coffee [note...] [@mention]
    const rawArgs = command.text.trim();

    // Extract @mention if present
    const mentionMatch = rawArgs.match(/<@([A-Z0-9]+)(?:\|[^>]+)?>/);
    const tag = mentionMatch ? `<@${mentionMatch[1]}>` : null;
    const rawNote = rawArgs.replace(/<@[^>]+>/g, '').trim();

    const situation = detectSituation(rawNote);

    // Auto-correct the note if provided
    let fixedNote = null;
    if (rawNote) {
      try {
        fixedNote = await fixGrammar(rawNote);
      } catch {
        fixedNote = rawNote; // fallback if API fails
      }
    }

    const message = buildCoffeeMessage(situation, rawNote, fixedNote, tag);

    await respond({
      response_type: 'in_channel',
      text: message,
    });
  });
};
