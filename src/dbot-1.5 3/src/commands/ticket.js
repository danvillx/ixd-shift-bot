// src/commands/ticket.js
// /ticket — Ticket management: create, update, list, resolve

const {
  STATUS,
  createTicket,
  getTicket,
  updateTicket,
  addNote,
  getOpenTickets,
  getAllTickets,
  formatTicket,
} = require('../utils/ticketStore');

const DEPARTMENTS = ['IB', 'OB', 'Sort', 'RPND', 'EOL', 'MHE', 'MH2', 'Jackpot', 'Viper', 'RME', 'XBelt', 'General'];
const PRIORITIES = ['Low', 'Normal', 'High', 'Critical'];

// Map status short codes to full STATUS values
const STATUS_MAP = {
  open: STATUS.OPEN,
  'in-progress': STATUS.IN_PROGRESS,
  inprogress: STATUS.IN_PROGRESS,
  waiting: STATUS.WAITING,
  resolved: STATUS.RESOLVED,
  done: STATUS.RESOLVED,
};

module.exports = function registerTicket(app) {
  // /ticket new — open creation modal
  // /ticket list — show open tickets
  // /ticket [TKT-XXX] status [status] — update status
  // /ticket [TKT-XXX] note [text] — add a note
  // /ticket [TKT-XXX] resolve — quick resolve

  app.command('/ticket', async ({ command, ack, client, respond }) => {
    await ack();

    const args = command.text.trim().split(/\s+/);
    const sub = args[0]?.toLowerCase();

    // /ticket (no args) or /ticket list
    if (!sub || sub === 'list') {
      const tickets = getOpenTickets();
      if (!tickets.length) {
        await respond({ response_type: 'ephemeral', text: '✅ No open tickets right now.' });
        return;
      }
      const lines = tickets.map(formatTicket).join('\n\n');
      await respond({
        response_type: 'ephemeral',
        text: `📌 *Open Tickets (${tickets.length}):*\n\n${lines}`,
      });
      return;
    }

    // /ticket all — show all including resolved
    if (sub === 'all') {
      const tickets = getAllTickets();
      if (!tickets.length) {
        await respond({ response_type: 'ephemeral', text: '📭 No tickets this session.' });
        return;
      }
      const lines = tickets.map(formatTicket).join('\n\n');
      await respond({
        response_type: 'ephemeral',
        text: `📋 *All Tickets (${tickets.length}):*\n\n${lines}`,
      });
      return;
    }

    // /ticket new — open modal
    if (sub === 'new') {
      await client.views.open({
        trigger_id: command.trigger_id,
        view: buildTicketModal(command.channel_id),
      });
      return;
    }

    // /ticket TKT-XXX [action] [args...]
    if (sub.startsWith('tkt-')) {
      const ticketId = sub.toUpperCase();
      const action = args[1]?.toLowerCase();
      const rest = args.slice(2).join(' ');

      const ticket = getTicket(ticketId);
      if (!ticket) {
        await respond({ response_type: 'ephemeral', text: `❌ Ticket \`${ticketId}\` not found.` });
        return;
      }

      // /ticket TKT-XXX (no action) — show detail
      if (!action) {
        await respond({ response_type: 'ephemeral', text: formatTicket(ticket) });
        return;
      }

      // /ticket TKT-XXX resolve
      if (action === 'resolve' || action === 'done') {
        updateTicket(ticketId, { status: STATUS.RESOLVED });
        await respond({
          response_type: 'in_channel',
          text: `🟢 *${ticketId} Resolved* — ${ticket.title}\n_Closed by <@${command.user_id}>_`,
        });
        return;
      }

      // /ticket TKT-XXX status [status]
      if (action === 'status') {
        const newStatus = STATUS_MAP[rest.toLowerCase().replace(/\s/g, '')];
        if (!newStatus) {
          await respond({
            response_type: 'ephemeral',
            text: `❓ Unknown status. Options: \`open\`, \`in-progress\`, \`waiting\`, \`resolved\``,
          });
          return;
        }
        updateTicket(ticketId, { status: newStatus });
        await respond({
          response_type: 'in_channel',
          text: `🔄 *${ticketId}* status → ${newStatus}\n_Updated by <@${command.user_id}>_`,
        });
        return;
      }

      // /ticket TKT-XXX note [text]
      if (action === 'note') {
        if (!rest) {
          await respond({ response_type: 'ephemeral', text: '❌ Include a note. `/ticket TKT-001 note belt is back up`' });
          return;
        }
        addNote(ticketId, rest, command.user_id);
        await respond({
          response_type: 'in_channel',
          text: `📝 Note added to *${ticketId}*: _"${rest}"_\n_by <@${command.user_id}>_`,
        });
        return;
      }

      await respond({ response_type: 'ephemeral', text: `❓ Unknown action. Try \`resolve\`, \`status\`, or \`note\`.` });
      return;
    }

    // Unknown — show help
    await respond({
      response_type: 'ephemeral',
      text: [
        '*🎫 /ticket commands:*',
        '`/ticket new` — create a ticket',
        '`/ticket list` — show open tickets',
        '`/ticket all` — show all tickets',
        '`/ticket TKT-001` — view ticket detail',
        '`/ticket TKT-001 resolve` — mark resolved',
        '`/ticket TKT-001 status in-progress` — update status',
        '`/ticket TKT-001 note [text]` — add a note',
      ].join('\n'),
    });
  });

  // Handle ticket creation modal
  app.view('ticket_create_submit', async ({ ack, view, body, client }) => {
    await ack();

    const v = view.state.values;
    const channelId = view.private_metadata;
    const userId = body.user.id;

    const ticket = createTicket({
      title: v.title.value.value,
      dept: v.dept.dept_select.selected_option.value,
      priority: v.priority.priority_select.selected_option.value,
      createdBy: `<@${userId}>`,
      channel: channelId,
    });

    const description = v.description?.desc?.value || '';

    await client.chat.postMessage({
      channel: channelId,
      text: [
        `🎫 *New Ticket: ${ticket.id}*`,
        `${ticket.title}`,
        `Dept: ${ticket.dept} | Priority: ${ticket.priority} | ${ticket.status}`,
        description ? `_${description}_` : '',
        `Created by <@${userId}>`,
      ]
        .filter(Boolean)
        .join('\n'),
    });
  });
};

function buildTicketModal(channelId) {
  return {
    type: 'modal',
    callback_id: 'ticket_create_submit',
    private_metadata: channelId,
    title: { type: 'plain_text', text: '🎫 New Ticket' },
    submit: { type: 'plain_text', text: 'Create Ticket' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'title',
        label: { type: 'plain_text', text: 'Ticket Title' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          placeholder: { type: 'plain_text', text: 'e.g. Bank 3 offline — CR fault' },
        },
      },
      {
        type: 'input',
        block_id: 'dept',
        label: { type: 'plain_text', text: 'Department' },
        element: {
          type: 'static_select',
          action_id: 'dept_select',
          placeholder: { type: 'plain_text', text: 'Select dept' },
          options: DEPARTMENTS.map((d) => ({
            text: { type: 'plain_text', text: d },
            value: d,
          })),
        },
      },
      {
        type: 'input',
        block_id: 'priority',
        label: { type: 'plain_text', text: 'Priority' },
        element: {
          type: 'static_select',
          action_id: 'priority_select',
          initial_option: { text: { type: 'plain_text', text: 'Normal' }, value: 'Normal' },
          options: PRIORITIES.map((p) => ({
            text: { type: 'plain_text', text: p },
            value: p,
          })),
        },
      },
      {
        type: 'input',
        block_id: 'description',
        label: { type: 'plain_text', text: 'Description (optional)' },
        optional: true,
        element: {
          type: 'plain_text_input',
          action_id: 'desc',
          multiline: true,
          placeholder: { type: 'plain_text', text: 'Details, steps to reproduce, what you need...' },
        },
      },
    ],
  };
}
