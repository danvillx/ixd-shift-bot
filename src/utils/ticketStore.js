// src/utils/ticketStore.js
// In-memory ticket tracker for DBot 1.5
// Tickets persist for the session; Railway restarts clear them (by design for shift ops)

const tickets = new Map();
let ticketCounter = 1;

const STATUS = {
  OPEN: '🔴 Open',
  IN_PROGRESS: '🟡 In Progress',
  RESOLVED: '🟢 Resolved',
  WAITING: '⏳ Waiting',
};

function createTicket({ title, dept, priority = 'Normal', createdBy, channel }) {
  const id = `TKT-${String(ticketCounter++).padStart(3, '0')}`;
  const ticket = {
    id,
    title,
    dept,
    priority,
    status: STATUS.OPEN,
    createdBy,
    channel,
    createdAt: new Date(),
    updatedAt: new Date(),
    notes: [],
  };
  tickets.set(id, ticket);
  return ticket;
}

function getTicket(id) {
  return tickets.get(id.toUpperCase()) || null;
}

function updateTicket(id, updates) {
  const ticket = getTicket(id);
  if (!ticket) return null;
  Object.assign(ticket, updates, { updatedAt: new Date() });
  return ticket;
}

function addNote(id, note, author) {
  const ticket = getTicket(id);
  if (!ticket) return null;
  ticket.notes.push({ note, author, ts: new Date() });
  ticket.updatedAt = new Date();
  return ticket;
}

function getAllTickets() {
  return Array.from(tickets.values());
}

function getOpenTickets() {
  return getAllTickets().filter((t) => t.status !== STATUS.RESOLVED);
}

function formatTicket(ticket) {
  const age = Math.round((Date.now() - ticket.createdAt) / 60000);
  const lines = [
    `*${ticket.id}* — ${ticket.title}`,
    `Status: ${ticket.status} | Dept: ${ticket.dept} | Priority: ${ticket.priority}`,
    `Created by: ${ticket.createdBy} | ${age}m ago`,
  ];
  if (ticket.notes.length) {
    lines.push(`_Last note: "${ticket.notes[ticket.notes.length - 1].note}"_`);
  }
  return lines.join('\n');
}

module.exports = { STATUS, createTicket, getTicket, updateTicket, addNote, getAllTickets, getOpenTickets, formatTicket };
