-- WACRM Features Migration for Pagarbook (PostgreSQL)

-- 1. AGENTS / PROFILES (Multi-user per client)
CREATE TABLE IF NOT EXISTS public.agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  full_name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_url TEXT,
  role VARCHAR(50) DEFAULT 'agent',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(client_id, email)
);

-- 2. PIPELINES
CREATE TABLE IF NOT EXISTS public.pipelines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.pipeline_stages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id UUID NOT NULL REFERENCES public.pipelines(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  color TEXT NOT NULL DEFAULT '#3b82f6',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. DEALS
CREATE TABLE IF NOT EXISTS public.deals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  pipeline_id UUID NOT NULL REFERENCES public.pipelines(id) ON DELETE CASCADE,
  stage_id UUID NOT NULL REFERENCES public.pipeline_stages(id),
  contact_id UUID, -- References whatever the user uses for contacts
  conversation_id UUID,
  title TEXT NOT NULL,
  value NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  notes TEXT,
  expected_close_date DATE,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. CONTACT NOTES (Internal Notes on contacts/conversations)
CREATE TABLE IF NOT EXISTS public.contact_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  contact_id UUID, -- The phone number or ID
  conversation_id UUID,
  agent_id UUID REFERENCES public.agents(id) ON DELETE SET NULL,
  note_text TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 5. FLOWS (Visual Automation Builder)
CREATE TABLE IF NOT EXISTS public.flows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('keyword', 'first_inbound_message', 'manual')),
  trigger_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  entry_node_id TEXT,
  fallback_policy JSONB NOT NULL DEFAULT '{"on_unknown_reply":"reprompt","max_reprompts":2,"on_timeout_hours":24,"on_exhaust":"handoff"}'::jsonb,
  execution_count INTEGER NOT NULL DEFAULT 0,
  last_executed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.flow_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id UUID NOT NULL REFERENCES public.flows(id) ON DELETE CASCADE,
  node_key TEXT NOT NULL,
  node_type TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  position_x INTEGER NOT NULL DEFAULT 0,
  position_y INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (flow_id, node_key)
);

CREATE TABLE IF NOT EXISTS public.flow_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id UUID NOT NULL REFERENCES public.flows(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  contact_id UUID,
  conversation_id UUID,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'handed_off', 'timed_out', 'paused_by_agent', 'failed')),
  current_node_key TEXT,
  vars JSONB NOT NULL DEFAULT '{}'::jsonb,
  reprompt_count INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  last_advanced_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  ended_at TIMESTAMP WITH TIME ZONE,
  end_reason TEXT
);

CREATE TABLE IF NOT EXISTS public.flow_run_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_run_id UUID NOT NULL REFERENCES public.flow_runs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  node_key TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
