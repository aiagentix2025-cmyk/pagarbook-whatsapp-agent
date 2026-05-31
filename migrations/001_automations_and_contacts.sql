-- ============================================================
-- STEP 1: Missing tables for Automations + Contacts + Tags
-- ============================================================

-- Contacts table (CRM contacts for each client)
CREATE TABLE IF NOT EXISTS public.contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  name TEXT,
  email TEXT,
  company TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(client_id, phone)
);
CREATE INDEX IF NOT EXISTS idx_contacts_client ON public.contacts(client_id);
CREATE INDEX IF NOT EXISTS idx_contacts_phone ON public.contacts(client_id, phone);

-- Tags
CREATE TABLE IF NOT EXISTS public.tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#6366f1',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(client_id, name)
);

-- Contact Tags (many-to-many)
CREATE TABLE IF NOT EXISTS public.contact_tags (
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES public.tags(id) ON DELETE CASCADE,
  PRIMARY KEY (contact_id, tag_id)
);

-- Automations
CREATE TABLE IF NOT EXISTS public.automations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN (
    'keyword_match', 'new_contact', 'first_inbound_message',
    'tag_added', 'conversation_assigned', 'scheduled'
  )),
  trigger_config JSONB NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  execution_count INTEGER NOT NULL DEFAULT 0,
  last_executed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_automations_client ON public.automations(client_id);
CREATE INDEX IF NOT EXISTS idx_automations_active_trigger ON public.automations(trigger_type) WHERE is_active = TRUE;

-- Automation Steps
CREATE TABLE IF NOT EXISTS public.automation_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id UUID NOT NULL REFERENCES public.automations(id) ON DELETE CASCADE,
  parent_step_id UUID REFERENCES public.automation_steps(id) ON DELETE CASCADE,
  branch TEXT CHECK (branch IN ('yes', 'no')),
  step_type TEXT NOT NULL CHECK (step_type IN (
    'send_message', 'send_template', 'add_tag', 'remove_tag',
    'assign_conversation', 'update_contact_field', 'create_deal',
    'send_webhook', 'close_conversation', 'wait', 'condition'
  )),
  step_config JSONB NOT NULL DEFAULT '{}',
  position INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_automation_steps_automation ON public.automation_steps(automation_id, position);

-- Automation Logs
CREATE TABLE IF NOT EXISTS public.automation_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id UUID NOT NULL REFERENCES public.automations(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  trigger_event TEXT NOT NULL,
  steps_executed JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('success', 'partial', 'failed')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_automation_logs_automation ON public.automation_logs(automation_id, created_at DESC);

-- Automation Pending (wait steps queue)
CREATE TABLE IF NOT EXISTS public.automation_pending_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id UUID NOT NULL REFERENCES public.automations(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  log_id UUID REFERENCES public.automation_logs(id) ON DELETE CASCADE,
  parent_step_id UUID REFERENCES public.automation_steps(id) ON DELETE SET NULL,
  branch TEXT CHECK (branch IN ('yes', 'no')),
  next_step_position INTEGER NOT NULL,
  context JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
  run_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_automation_pending_due ON public.automation_pending_executions(run_at) WHERE status = 'pending';

-- Add client_id to flow tables if missing (our VPS uses client_id, wacrm uses user_id)
-- flows already has client_id per our schema check
-- Add last_prompt_message_id to flow_runs
ALTER TABLE public.flow_runs ADD COLUMN IF NOT EXISTS last_prompt_message_id TEXT;

-- Conversations (link contacts to chat sessions)
CREATE TABLE IF NOT EXISTS public.conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  chat_session_id TEXT,  -- links to existing chat_sessions.id
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'closed')),
  assigned_agent_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_conversations_client ON public.conversations(client_id);
CREATE INDEX IF NOT EXISTS idx_conversations_contact ON public.conversations(contact_id);
