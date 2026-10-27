'use strict';

// Where a finished voice command goes. Exact reset phrases are matched here for
// free; everything else is routed by Jev (router.js) to a local answer
// (local.js), a label, or the remote agent (agent.js). Without Jev every
// command goes to the agent, as before the router.
//
// It also keeps the bookkeeping that stops a command from outliving its turn:
// a new wake or a dismissal abandons whatever is still being routed or worked
// out, so a late answer neither reaches the HUD nor speaks over the user.

const { isResetCommand } = require('./conversation');
const { LOCAL_ROUTES, isVietnamese } = require('./local');

const NEW_CONVERSATION_REPLY = 'Starting a new conversation.';
// How much of the agent's last reply Jev sees when judging a follow-up. Jev is
// a third party: send only what the decision needs.
const PREVIOUS_REPLY_CHARS = 200;
const AGENT_DISABLED = 'agent bridge disabled (set FRIDAY_AGENT_URL and FRIDAY_AGENT_KEY)';

/** What she says when the browser agent stops: the page title, or why it could not finish. */
function browseReply(text, result) {
  const vietnamese = isVietnamese(text);
  if (result.status === 'done') {
    const title = String(result.title ?? '').trim();
    if (vietnamese) return title ? `Xong. ${title}.` : 'Xong.';
    return title ? `Done. ${title}.` : 'Done.';
  }
  const reason = result.reason ?? '';
  return vietnamese
    ? `Mình chưa làm xong trên trình duyệt: ${reason}.`
    : `I couldn't finish that in the browser: ${reason}.`;
}

class CommandDispatcher {
  /**
   * router: {enabled, classify(text, previous)}; agent: {enabled, ask(id, text, session)};
   * browser: {enabled, run(text, {onStep}), cancel}; conversation: {warm, begin(), reset()};
   * speech: {say, end, cancel}; runLocal(route, text); send(channel, payload) to the HUD;
   * log and logError for the journal.
   */
  constructor({ router, agent, browser, conversation, speech, runLocal, send, log, logError }) {
    Object.assign(this, { router, agent, browser, conversation, speech, runLocal, send, log, logError });
    this.current = 0; // the command being answered; 0 once abandoned
    this.silenced = 0; // an abandoned command whose agent reply must stay silent
    this.agentCommand = null; // {id, text} the agent is answering
    this.lastExchange = null; // {command, reply} of the agent's last answer
    this.fresh = false; // whether the latest agent run opened a new conversation
  }

  /** Handle one finished command. Never rejects. */
  async handle(id, text) {
    this.current = id;
    this.silenced = 0; // ids restart with the listener, so never match an old one
    try {
      await this.route(id, text);
    } catch (err) {
      this.logError(`command #${id} failed: ${err.message}`);
      if (this.live(id)) this.send('hud:agent', { id, state: 'error', error: err.message, source: 'Friday' });
    }
  }

  /** A new wake or a dismissal: whatever is in flight is dropped, and its agent reply stays silent. */
  abandon() {
    this.silenced = this.current;
    this.current = 0;
  }

  /** True when the agent's reply to `id` must not be spoken. */
  isSilenced(id) {
    return id === this.silenced;
  }

  live(id) {
    return id === this.current;
  }

  async route(id, text) {
    if (isResetCommand(text)) {
      this.startNewConversation(id);
      return;
    }
    if (!this.router.enabled) {
      this.askAgent(id, text);
      return;
    }
    this.send('hud:agent', { id, state: 'working', phase: 'routing' });
    const decision = await this.router.classify(text, this.previousExchange());
    if (!decision || !this.live(id)) return; // a newer command, wake or dismissal took over
    this.logRoute(id, decision);
    const { route, confidence, reason, error } = decision;
    this.send('hud:agent', { id, state: 'working', route, confidence, reason, routeError: error });
    if (route === 'new_conversation') this.startNewConversation(id);
    else if (route === 'cancel') this.cancel(id);
    else if (route === 'simple') this.onSimple(id);
    else if (route === 'browse' && this.browser?.enabled) await this.browse(id, text);
    else if (LOCAL_ROUTES.has(route)) await this.answerLocally(id, text, route);
    else this.askAgent(id, text);
  }

  askAgent(id, text) {
    if (!this.agent.enabled) {
      this.send('hud:agent', { id, state: 'error', error: AGENT_DISABLED });
      return;
    }
    const { session, fresh } = this.conversation.begin();
    this.fresh = fresh;
    this.agentCommand = { id, text };
    this.agent.ask(id, text, session);
  }

  /** The agent answered `id`: remember the exchange so Jev can spot a follow-up. */
  onAgentDone(id, reply) {
    if (this.agentCommand?.id !== id) return;
    this.lastExchange = { command: this.agentCommand.text, reply: reply.slice(0, PREVIOUS_REPLY_CHARS) };
  }

  /** The agent failed on `id`: there is no answer to follow up on. */
  onAgentError(id) {
    if (this.agentCommand?.id === id) this.lastExchange = null;
  }

  /** The agent's last answer while its conversation is warm. */
  previousExchange() {
    return this.lastExchange && this.conversation.warm ? this.lastExchange : null;
  }

  /** Show and speak a reply produced here rather than by the agent. */
  reply(id, text, agentEvent = {}) {
    this.send('hud:reply', { id, text, final: true });
    this.send('hud:agent', { id, state: 'done', ...agentEvent });
    this.speech.say(id, text);
    this.speech.end(id);
  }

  startNewConversation(id) {
    this.conversation.reset();
    this.lastExchange = null;
    this.log(`command #${id}: new conversation`);
    this.reply(id, NEW_CONVERSATION_REPLY, { session: 'reset' });
  }

  /** "Never mind": she stops talking and the command ends; the HUD stays up. */
  cancel(id) {
    this.log(`command #${id}: cancelled`);
    this.speech.cancel();
    this.send('hud:agent', { id, state: 'done' });
  }

  /**
   * A one-fact task (weather, a price, a definition). Only labelled for now:
   * the HUD shows the route and nothing answers it. Plug a quick answerer in here.
   */
  onSimple(id) {
    this.send('hud:agent', { id, state: 'done' });
  }

  async answerLocally(id, text, route) {
    let answer;
    try {
      answer = await this.runLocal(route, text);
    } catch (err) {
      if (!this.live(id)) return;
      this.logError(`command #${id}: ${route} failed: ${err.message}`);
      this.send('hud:agent', { id, state: 'error', error: `${route}: ${err.message}`, source: 'Local' });
      return;
    }
    if (!this.live(id)) return; // a wake, dismissal or newer command took over while it ran
    this.log(`command #${id}: ${route} answered locally`);
    this.reply(id, answer);
  }

  /** Run the goal in the user's Chrome; show each step, then speak the outcome. */
  async browse(id, text) {
    let result;
    try {
      result = await this.browser.run(text, {
        onStep: (step) => {
          if (!this.live(id)) return;
          this.send('hud:agent', { id, state: 'working', tool: step.label, source: 'Browser' });
        },
      });
    } catch (err) {
      if (!this.live(id)) return;
      this.logError(`command #${id}: browse failed: ${err.message}`);
      this.send('hud:agent', { id, state: 'error', error: err.message, source: 'Browser' });
      return;
    }
    if (!this.live(id) || !result) return; // dismissed, superseded, or cancelled mid-run
    const credits = Number.isFinite(result.credits) ? `, ${result.credits} credits left` : '';
    this.log(`command #${id}: browse ${result.status} (${result.actions} actions, ${result.decisions} decisions, ${result.ms} ms${credits})`);
    this.reply(id, browseReply(text, result), { source: 'Browser' });
  }

  logRoute(id, decision) {
    const percent = Math.round(decision.confidence * 100);
    const why = decision.reason ? `, ${decision.reason}` : '';
    const followUp = Number.isFinite(decision.followUp) ? `, follow-up ${decision.followUp.toFixed(2)}` : '';
    const credits = Number.isFinite(decision.credits) ? `, ${decision.credits} credits left` : '';
    this.log(`command #${id}: route ${decision.route} (${percent}%${why}${followUp}, ${decision.ms} ms${credits})`);
    if (decision.error) this.logError(`jev router #${id}: ${decision.error}`);
  }
}

module.exports = { CommandDispatcher, NEW_CONVERSATION_REPLY, PREVIOUS_REPLY_CHARS, browseReply };
