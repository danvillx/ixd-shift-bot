// src/utils/claude.js
// Centralized Anthropic API calls for DBot 1.5

const Anthropic = require('@anthropic-ai/sdk');
const { BUILDING_CONTEXT } = require('../prompts/buildingContext');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';

/**
 * Call Claude with the TEB9 building context injected as system prompt.
 * @param {string} userPrompt - The user-facing content to process
 * @param {string} [extraSystem] - Optional additional system instructions
 * @returns {Promise<string>} Claude's text response
 */
async function callClaude(userPrompt, extraSystem = '') {
  const systemPrompt = [BUILDING_CONTEXT, extraSystem].filter(Boolean).join('\n\n');

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  return message.content[0].text;
}

/**
 * Lightweight grammar fix — keeps casual tone, just cleans up typos/errors.
 */
async function fixGrammar(text) {
  return callClaude(
    `Fix any grammar/spelling errors in this message. Keep it casual and authentic. 
Do NOT change the meaning, tone, or structure. Return ONLY the corrected text, nothing else.\n\n"${text}"`,
    'You are a light grammar editor. Preserve the author\'s voice completely.'
  );
}

module.exports = { callClaude, fixGrammar };
