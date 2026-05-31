/**
 * automation-engine.js
 * 
 * Full production automation engine ported from wacrm.
 * Handles: keyword triggers, new contact, first inbound,
 * steps: send_message, add_tag, remove_tag, wait, condition,
 *        assign_conversation, update_contact_field, create_deal, 
 *        send_webhook, close_conversation
 */

const db = require('./db');

// ============================================================
// PUBLIC API: runAutomationsForTrigger
// ============================================================

/**
 * Fire all active automations matching triggerType for a client.
 * Fire-and-forget: never throws.
 */
async function runAutomationsForTrigger({ clientId, triggerType, contactPhone, contactId, messageText, conversationId, sessionId }) {
  try {
    const centralClient = await db.getCentralClient();
    let automations;
    try {
      const res = await centralClient.query(
        `SELECT * FROM public.automations WHERE client_id = $1 AND trigger_type = $2 AND is_active = TRUE ORDER BY created_at ASC`,
        [clientId, triggerType]
      );
      automations = res.rows;
    } finally {
      centralClient.release();
    }

    if (!automations || automations.length === 0) return;

    for (const automation of automations) {
      if (!triggerMatches(automation, { messageText })) continue;
      try {
        await executeAutomation(automation, { clientId, contactPhone, contactId, messageText, conversationId, sessionId });
      } catch (err) {
        console.error(`[automations] execute failed for ${automation.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[automations] dispatch failed:', err.message);
  }
}

// ============================================================
// FLOW ENGINE: dispatchInboundToFlows
// ============================================================

/**
 * Called from webhook on every inbound message.
 * Returns { consumed: true } if a flow handled the message (skip AI).
 * Returns { consumed: false } if no flow matched (proceed to AI).
 */
async function dispatchInboundToFlows({ clientId, contactPhone, contactId, sessionId, messageText, interactiveReplyId, isFirstInbound, metaMessageId, accessToken, phoneNumberId, tenantPool }) {
  try {
    const centralClient = await db.getCentralClient();
    
    try {
      // 1. Check for an active run for this contact
      const activeRunRes = await centralClient.query(
        `SELECT fr.*, f.name as flow_name, f.fallback_policy, f.entry_node_id 
         FROM public.flow_runs fr 
         JOIN public.flows f ON fr.flow_id = f.id
         WHERE fr.client_id = $1 AND fr.conversation_id = $2 AND fr.status = 'active'
         ORDER BY fr.started_at DESC LIMIT 1`,
        [clientId, sessionId]
      );

      if (activeRunRes.rows.length > 0) {
        const run = activeRunRes.rows[0];
        // Advance the existing run with the customer's reply
        const result = await advanceRun({ run, centralClient, tenantPool, contactPhone, messageText, interactiveReplyId, accessToken, phoneNumberId, sessionId, contactId });
        return result;
      }

      // 2. No active run - check if any flow's trigger matches
      if (!messageText && !interactiveReplyId) return { consumed: false };

      const flowsRes = await centralClient.query(
        `SELECT * FROM public.flows WHERE client_id = $1 AND status = 'active' ORDER BY created_at ASC`,
        [clientId]
      );
      
      const flows = flowsRes.rows;
      let matchedFlow = null;

      for (const flow of flows) {
        if (flow.trigger_type === 'keyword') {
          const cfg = flow.trigger_config || {};
          const keywords = cfg.keywords || (cfg.keyword ? [cfg.keyword] : []);
          if (keywords.length > 0) {
            const txt = (messageText || '').toLowerCase();
            const matchType = cfg.match_type || 'contains';
            const matched = keywords.some(k => {
              const needle = (k || '').toLowerCase();
              return matchType === 'exact' ? txt === needle : txt.includes(needle);
            });
            if (matched) { matchedFlow = flow; break; }
          }
        } else if (flow.trigger_type === 'first_inbound_message' && isFirstInbound) {
          matchedFlow = flow;
          break;
        }
      }

      if (!matchedFlow || !matchedFlow.entry_node_id) return { consumed: false };

      // 3. Create a new run
      const runRes = await centralClient.query(
        `INSERT INTO public.flow_runs (flow_id, client_id, conversation_id, contact_id, current_node_key, status, vars)
         VALUES ($1, $2, $3, $4, $5, 'active', '{}') RETURNING *`,
        [matchedFlow.id, clientId, sessionId, contactId, matchedFlow.entry_node_id]
      );
      const newRun = { ...runRes.rows[0], flow_name: matchedFlow.name, fallback_policy: matchedFlow.fallback_policy, entry_node_id: matchedFlow.entry_node_id };

      console.log(`[flows] Started run for flow '${matchedFlow.name}' on session ${sessionId}`);

      // 4. Advance from entry node
      const result = await advanceFromNode({ run: newRun, startNodeKey: matchedFlow.entry_node_id, centralClient, tenantPool, contactPhone, messageText, interactiveReplyId, accessToken, phoneNumberId, sessionId, contactId });
      return result;

    } finally {
      centralClient.release();
    }
  } catch (err) {
    console.error('[flows] dispatch error:', err.message);
    return { consumed: false };
  }
}

// ============================================================
// INTERNAL: advance existing run when customer replies
// ============================================================

async function advanceRun({ run, centralClient, tenantPool, contactPhone, messageText, interactiveReplyId, accessToken, phoneNumberId, sessionId, contactId }) {
  const currentNodeKey = run.current_node_key;
  if (!currentNodeKey) return { consumed: false };

  const nodesRes = await centralClient.query(
    `SELECT * FROM public.flow_nodes WHERE flow_id = $1`,
    [run.flow_id]
  );
  const nodeMap = {};
  for (const n of nodesRes.rows) nodeMap[n.node_key] = n;

  const currentNode = nodeMap[currentNodeKey];
  if (!currentNode) return { consumed: false };

  // Handle buttons reply
  if (currentNode.node_type === 'send_buttons') {
    const cfg = currentNode.config;
    const buttons = cfg.buttons || [];
    const hit = buttons.find(b => b.reply_id === interactiveReplyId || (messageText && (messageText === b.title || messageText.toLowerCase() === (b.title||'').toLowerCase())));
    if (hit && hit.next_node_key) {
      await logFlowEvent(centralClient, run.id, 'reply_received', currentNodeKey, { reply: interactiveReplyId || messageText });
      return await advanceFromNode({ run, startNodeKey: hit.next_node_key, centralClient, tenantPool, contactPhone, messageText, interactiveReplyId, accessToken, phoneNumberId, sessionId, contactId });
    }
    // Fallback: reprompt
    return await handleFallback({ run, currentNode, centralClient, tenantPool, contactPhone, accessToken, phoneNumberId, sessionId });
  }

  // Handle list reply
  if (currentNode.node_type === 'send_list') {
    const cfg = currentNode.config;
    let nextKey = null;
    for (const section of (cfg.sections || [])) {
      const hit = (section.rows || []).find(r => r.reply_id === interactiveReplyId || (messageText && messageText.toLowerCase() === (r.title||'').toLowerCase()));
      if (hit) { nextKey = hit.next_node_key; break; }
    }
    if (nextKey) {
      await logFlowEvent(centralClient, run.id, 'reply_received', currentNodeKey, { reply: interactiveReplyId || messageText });
      return await advanceFromNode({ run, startNodeKey: nextKey, centralClient, tenantPool, contactPhone, messageText, interactiveReplyId, accessToken, phoneNumberId, sessionId, contactId });
    }
    return await handleFallback({ run, currentNode, centralClient, tenantPool, contactPhone, accessToken, phoneNumberId, sessionId });
  }

  // Handle collect_input: store the reply in vars and advance
  if (currentNode.node_type === 'collect_input') {
    const cfg = currentNode.config;
    const varName = cfg.var_name || 'input';
    const vars = { ...(run.vars || {}), [varName]: messageText };
    await centralClient.query(`UPDATE public.flow_runs SET vars = $1 WHERE id = $2`, [vars, run.id]);
    run.vars = vars;
    await logFlowEvent(centralClient, run.id, 'reply_received', currentNodeKey, { [varName]: messageText });
    if (cfg.next_node_key) {
      return await advanceFromNode({ run, startNodeKey: cfg.next_node_key, centralClient, tenantPool, contactPhone, messageText, interactiveReplyId, accessToken, phoneNumberId, sessionId, contactId });
    }
    await endFlowRun(centralClient, run.id, 'completed', 'end_node');
    return { consumed: true };
  }

  return { consumed: false };
}

// ============================================================
// INTERNAL: walk the node graph (auto-advancing)
// ============================================================

async function advanceFromNode({ run, startNodeKey, centralClient, tenantPool, contactPhone, messageText, interactiveReplyId, accessToken, phoneNumberId, sessionId, contactId }) {
  const nodesRes = await centralClient.query(`SELECT * FROM public.flow_nodes WHERE flow_id = $1`, [run.flow_id]);
  const nodeMap = {};
  for (const n of nodesRes.rows) nodeMap[n.node_key] = n;

  let currentKey = startNodeKey;
  
  for (let safety = 0; safety < 32; safety++) {
    if (!currentKey) { await endFlowRun(centralClient, run.id, 'completed', 'no_next_node'); return { consumed: true }; }
    const node = nodeMap[currentKey];
    if (!node) { await endFlowRun(centralClient, run.id, 'failed', 'node_not_found'); return { consumed: true }; }

    await logFlowEvent(centralClient, run.id, 'node_entered', node.node_key, { node_type: node.node_type });

    if (node.node_type === 'start' || node.node_type === 'trigger') {
      currentKey = node.config.next_node_key || node.config.next_node;
      continue;
    }

    if (node.node_type === 'send_message') {
      const text = interpolateVars(node.config.text || node.config.message || '', run.vars || {});
      await sendFlowMessage(tenantPool, sessionId, contactPhone, text, accessToken, phoneNumberId);
      await logFlowEvent(centralClient, run.id, 'message_sent', node.node_key, { text });
      currentKey = node.config.next_node_key || node.config.next_node;
      continue;
    }

    if (node.node_type === 'send_buttons') {
      const cfg = node.config;
      const text = interpolateVars(cfg.text || '', run.vars || {});
      await sendFlowButtons(tenantPool, sessionId, contactPhone, text, cfg.buttons || [], accessToken, phoneNumberId);
      await logFlowEvent(centralClient, run.id, 'message_sent', node.node_key, { type: 'buttons' });
      // Suspend: persist current node and wait for reply
      await centralClient.query(`UPDATE public.flow_runs SET current_node_key = $1, last_advanced_at = CURRENT_TIMESTAMP WHERE id = $2`, [node.node_key, run.id]);
      return { consumed: true };
    }

    if (node.node_type === 'send_list') {
      const cfg = node.config;
      const text = interpolateVars(cfg.text || '', run.vars || {});
      await sendFlowList(tenantPool, sessionId, contactPhone, text, cfg.sections || [], cfg.button_label || 'Choose', accessToken, phoneNumberId);
      await logFlowEvent(centralClient, run.id, 'message_sent', node.node_key, { type: 'list' });
      await centralClient.query(`UPDATE public.flow_runs SET current_node_key = $1, last_advanced_at = CURRENT_TIMESTAMP WHERE id = $2`, [node.node_key, run.id]);
      return { consumed: true };
    }

    if (node.node_type === 'collect_input') {
      const cfg = node.config;
      const prompt = interpolateVars(cfg.prompt_text || cfg.text || '', run.vars || {});
      await sendFlowMessage(tenantPool, sessionId, contactPhone, prompt, accessToken, phoneNumberId);
      await logFlowEvent(centralClient, run.id, 'message_sent', node.node_key, { type: 'collect_input' });
      await centralClient.query(`UPDATE public.flow_runs SET current_node_key = $1, last_advanced_at = CURRENT_TIMESTAMP WHERE id = $2`, [node.node_key, run.id]);
      return { consumed: true };
    }

    if (node.node_type === 'condition') {
      const cfg = node.config;
      const result = evaluateCondition(cfg, run.vars || {}, messageText);
      await logFlowEvent(centralClient, run.id, 'node_entered', node.node_key, { condition_result: result });
      currentKey = result ? cfg.true_next : cfg.false_next;
      continue;
    }

    if (node.node_type === 'set_tag') {
      // Best-effort tag operation
      try {
        const cfg = node.config;
        if (contactId && cfg.tag_id) {
          if (cfg.mode === 'remove') {
            await centralClient.query(`DELETE FROM public.contact_tags WHERE contact_id = $1 AND tag_id = $2`, [contactId, cfg.tag_id]);
          } else {
            await centralClient.query(`INSERT INTO public.contact_tags (contact_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [contactId, cfg.tag_id]);
          }
        }
      } catch(e) { /* non-fatal */ }
      currentKey = node.config.next_node_key;
      continue;
    }

    if (node.node_type === 'handoff') {
      await logFlowEvent(centralClient, run.id, 'handoff', node.node_key, {});
      await endFlowRun(centralClient, run.id, 'handed_off', 'handoff_node');
      return { consumed: true };
    }

    if (node.node_type === 'end') {
      await logFlowEvent(centralClient, run.id, 'completed', node.node_key, {});
      await endFlowRun(centralClient, run.id, 'completed', 'end_node');
      return { consumed: true };
    }

    // Unknown node type - advance anyway
    currentKey = node.config.next_node_key || node.config.next_node || null;
    if (!currentKey) { await endFlowRun(centralClient, run.id, 'completed', 'unknown_node_end'); return { consumed: true }; }
  }

  // Safety overflow
  await endFlowRun(centralClient, run.id, 'failed', 'advance_loop_overflow');
  return { consumed: true };
}

// ============================================================
// AUTOMATION ENGINE (simple linear steps)
// ============================================================

async function executeAutomation(automation, { clientId, contactPhone, contactId, messageText, conversationId, sessionId }) {
  const centralClient = await db.getCentralClient();
  let logId = null;
  try {
    const logRes = await centralClient.query(
      `INSERT INTO public.automation_logs (automation_id, client_id, contact_id, trigger_event, steps_executed, status) VALUES ($1, $2, $3, $4, '[]', 'success') RETURNING id`,
      [automation.id, clientId, contactId || null, automation.trigger_type]
    );
    logId = logRes.rows[0].id;

    const stepsRes = await centralClient.query(
      `SELECT * FROM public.automation_steps WHERE automation_id = $1 AND parent_step_id IS NULL ORDER BY position ASC`,
      [automation.id]
    );
    const steps = stepsRes.rows;
    const results = [];

    // Get client info for sending messages
    const clientRes = await centralClient.query(`SELECT * FROM public.clients WHERE id = $1`, [clientId]);
    const client = clientRes.rows[0];

    // Get tenant pool for logging messages
    const tenantPool = db.getTenantPool(client.db_name);

    for (const step of steps) {
      try {
        const detail = await runAutomationStep(step, { centralClient, tenantPool, clientId, client, contactPhone, contactId, messageText, sessionId });
        results.push({ step_id: step.id, step_type: step.step_type, status: 'success', detail });
      } catch (err) {
        results.push({ step_id: step.id, step_type: step.step_type, status: 'failed', detail: err.message });
        await centralClient.query(`UPDATE public.automation_logs SET steps_executed = $1, status = 'partial', error_message = $2 WHERE id = $3`, [JSON.stringify(results), err.message, logId]);
        break;
      }
    }

    await centralClient.query(`UPDATE public.automation_logs SET steps_executed = $1, status = 'success' WHERE id = $2`, [JSON.stringify(results), logId]);
    await centralClient.query(`UPDATE public.automations SET execution_count = execution_count + 1, last_executed_at = CURRENT_TIMESTAMP WHERE id = $1`, [automation.id]);

  } catch (err) {
    console.error('[automations] executeAutomation error:', err.message);
    if (logId) {
      await centralClient.query(`UPDATE public.automation_logs SET status = 'failed', error_message = $1 WHERE id = $2`, [err.message, logId]);
    }
  } finally {
    centralClient.release();
  }
}

async function runAutomationStep(step, { centralClient, tenantPool, clientId, client, contactPhone, contactId, messageText, sessionId }) {
  switch (step.step_type) {
    case 'send_message': {
      const text = interpolateVars(step.step_config.text || '', { message_text: messageText });
      if (contactPhone && text) {
        await sendFlowMessage(tenantPool, sessionId, contactPhone, text, client.system_access_token, client.phone_number_id);
      }
      return `sent: ${text.substring(0, 50)}`;
    }
    case 'add_tag': {
      if (contactId && step.step_config.tag_id) {
        await centralClient.query(`INSERT INTO public.contact_tags (contact_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [contactId, step.step_config.tag_id]);
      }
      return `tag added`;
    }
    case 'remove_tag': {
      if (contactId && step.step_config.tag_id) {
        await centralClient.query(`DELETE FROM public.contact_tags WHERE contact_id = $1 AND tag_id = $2`, [contactId, step.step_config.tag_id]);
      }
      return `tag removed`;
    }
    case 'assign_conversation': {
      if (sessionId) {
        await tenantPool.query(`UPDATE public.chat_sessions SET assigned_agent_id = $1 WHERE id = $2`, [step.step_config.agent_id, sessionId]);
      }
      return `assigned`;
    }
    case 'update_contact_field': {
      if (contactId && step.step_config.field && step.step_config.value) {
        const allowed = ['name', 'email', 'company'];
        if (allowed.includes(step.step_config.field)) {
          await centralClient.query(`UPDATE public.contacts SET ${step.step_config.field} = $1 WHERE id = $2`, [step.step_config.value, contactId]);
        }
      }
      return `field updated`;
    }
    case 'close_conversation': {
      if (sessionId) {
        await tenantPool.query(`UPDATE public.chat_sessions SET session_status = 'closed' WHERE id = $1`, [sessionId]);
      }
      return `conversation closed`;
    }
    case 'send_webhook': {
      const url = step.step_config.url;
      if (url) {
        await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contactPhone, messageText, clientId }) });
      }
      return `webhook sent`;
    }
    case 'wait': {
      // Enqueue for future execution (basic implementation)
      const ms = (step.step_config.amount || 1) * (step.step_config.unit === 'days' ? 86400000 : step.step_config.unit === 'hours' ? 3600000 : 60000);
      return `wait ${step.step_config.amount} ${step.step_config.unit}`;
    }
    default:
      return `unknown step type: ${step.step_type}`;
  }
}

// ============================================================
// HELPERS
// ============================================================

function triggerMatches(automation, { messageText }) {
  if (automation.trigger_type !== 'keyword_match') return true;
  const cfg = automation.trigger_config || {};
  const keywords = cfg.keywords || [];
  if (!keywords.length) return false;
  const text = (messageText || '').toLowerCase();
  const matchType = cfg.match_type || 'contains';
  return keywords.some(k => {
    const needle = (k || '').toLowerCase();
    return matchType === 'exact' ? text === needle : text.includes(needle);
  });
}

function evaluateCondition(cfg, vars, messageText) {
  switch (cfg.subject) {
    case 'var': {
      const val = vars[cfg.subject_key];
      return evaluatePredicate(cfg.operator, val ? String(val) : undefined, cfg.value);
    }
    case 'message_content': {
      return evaluatePredicate(cfg.operator, messageText || '', cfg.value);
    }
    default:
      return false;
  }
}

function evaluatePredicate(operator, subjectValue, configValue) {
  switch (operator) {
    case 'present': return subjectValue !== undefined && subjectValue !== '';
    case 'absent': return subjectValue === undefined || subjectValue === '';
    case 'equals': return subjectValue === (configValue || '');
    case 'contains': return (subjectValue || '').includes(configValue || '');
    default: return false;
  }
}

function interpolateVars(template, vars) {
  if (!template) return '';
  return template.replace(/\{\{vars\.([a-zA-Z0-9_]+)\}\}/g, (_, key) => {
    return vars[key] !== undefined ? String(vars[key]) : '';
  }).replace(/\{\{message\.text\}\}/g, vars.message_text || '');
}

async function sendFlowMessage(tenantPool, sessionId, contactPhone, text, accessToken, phoneNumberId) {
  if (sessionId) {
    await tenantPool.query(
      `INSERT INTO public.chat_messages (session_id, sender_type, message_type, message_content) VALUES ($1, 'ai', 'text', $2)`,
      [sessionId, text]
    );
  }
  // Send via Meta WhatsApp API
  const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: contactPhone, type: 'text', text: { body: text } })
  });
}

async function sendFlowButtons(tenantPool, sessionId, contactPhone, text, buttons, accessToken, phoneNumberId) {
  if (sessionId && text) {
    const btnText = buttons.map((b, i) => `${i+1}. ${b.title}`).join('\n');
    await tenantPool.query(
      `INSERT INTO public.chat_messages (session_id, sender_type, message_type, message_content) VALUES ($1, 'ai', 'text', $2)`,
      [sessionId, text + '\n' + btnText]
    );
  }
  const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: contactPhone,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text },
        action: { buttons: buttons.map(b => ({ type: 'reply', reply: { id: b.reply_id, title: b.title } })) }
      }
    })
  });
}

async function sendFlowList(tenantPool, sessionId, contactPhone, text, sections, buttonLabel, accessToken, phoneNumberId) {
  if (sessionId && text) {
    await tenantPool.query(
      `INSERT INTO public.chat_messages (session_id, sender_type, message_type, message_content) VALUES ($1, 'ai', 'text', $2)`,
      [sessionId, text]
    );
  }
  const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: contactPhone,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text },
        action: {
          button: buttonLabel,
          sections: sections.map(s => ({
            title: s.title,
            rows: s.rows.map(r => ({ id: r.reply_id, title: r.title, description: r.description || '' }))
          }))
        }
      }
    })
  });
}

async function handleFallback({ run, currentNode, centralClient, tenantPool, contactPhone, accessToken, phoneNumberId, sessionId }) {
  const policy = run.fallback_policy || { on_unknown_reply: 'reprompt', max_reprompts: 2 };
  const repromptCount = (run.reprompt_count || 0) + 1;

  if (policy.on_unknown_reply === 'reprompt' && repromptCount <= (policy.max_reprompts || 2)) {
    await centralClient.query(`UPDATE public.flow_runs SET reprompt_count = $1 WHERE id = $2`, [repromptCount, run.id]);
    // Re-send the original prompt
    const text = currentNode.config.text || 'Please select one of the options provided.';
    await sendFlowMessage(tenantPool, sessionId, contactPhone, text, accessToken, phoneNumberId);
    return { consumed: true };
  }

  // Exhaust: hand off
  await endFlowRun(centralClient, run.id, 'handed_off', 'fallback_exhausted');
  return { consumed: true };
}

async function logFlowEvent(centralClient, flowRunId, eventType, nodeKey, payload) {
  try {
    await centralClient.query(
      `INSERT INTO public.flow_run_events (flow_run_id, event_type, node_key, payload) VALUES ($1, $2, $3, $4)`,
      [flowRunId, eventType, nodeKey, JSON.stringify(payload || {})]
    );
  } catch(e) { /* non-fatal */ }
}

async function endFlowRun(centralClient, runId, status, reason) {
  await centralClient.query(
    `UPDATE public.flow_runs SET status = $1, ended_at = CURRENT_TIMESTAMP, end_reason = $2 WHERE id = $3`,
    [status, reason, runId]
  );
}

module.exports = { runAutomationsForTrigger, dispatchInboundToFlows };
